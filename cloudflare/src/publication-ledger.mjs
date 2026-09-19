const SNAPSHOT_KEY = 'state.snapshot_json';

const READ_STATE_CURSOR_SQL = `
SELECT
  status,
  attempt_id,
  generation
FROM publication_state
WHERE post_id = ?1
LIMIT 1
`;

const UPDATE_BEGIN_SNAPSHOT_SQL = `
UPDATE runtime_metadata
SET value = ?1, updated_at = ?2
WHERE key = '${SNAPSHOT_KEY}'
  AND value = ?3
  AND EXISTS (
    SELECT 1
    FROM publication_state
    WHERE post_id = ?4
      AND status = 'scheduled'
      AND generation = ?5
  )
`;

const UPDATE_OUTCOME_SNAPSHOT_SQL = `
UPDATE runtime_metadata
SET value = ?1, updated_at = ?2
WHERE key = '${SNAPSHOT_KEY}'
  AND value = ?3
  AND EXISTS (
    SELECT 1
    FROM publication_state
    WHERE post_id = ?4
      AND status = 'publishing'
      AND attempt_id = ?5
      AND generation = ?6
  )
`;

const UPDATE_PUBLISHING_SQL = `
UPDATE publication_state
SET
  status = 'publishing',
  attempt_id = ?1,
  publishing_at = ?2,
  updated_at = ?2,
  last_error = NULL,
  failed_at = NULL,
  generation = generation + 1
WHERE post_id = ?3
  AND status = 'scheduled'
  AND generation = ?4
  AND changes() = 1
`;

const UPDATE_POSTED_SQL = `
UPDATE publication_state
SET
  status = 'posted',
  tweet_id = ?1,
  posted_at = ?2,
  updated_at = ?2,
  last_error = NULL,
  failed_at = NULL,
  ledger_record_json = ?3,
  generation = generation + 1
WHERE post_id = ?4
  AND status = 'publishing'
  AND attempt_id = ?5
  AND generation = ?6
  AND changes() = 1
`;

const UPDATE_CONFIRMED_NOT_POSTED_SQL = `
UPDATE publication_state
SET
  status = 'scheduled',
  attempt_id = NULL,
  publishing_at = NULL,
  updated_at = ?1,
  last_error = ?2,
  failed_at = NULL,
  ledger_record_json = ?3,
  generation = generation + 1
WHERE post_id = ?4
  AND status = 'publishing'
  AND attempt_id = ?5
  AND generation = ?6
  AND changes() = 1
`;

const UPDATE_RECONCILIATION_SQL = `
UPDATE publication_state
SET
  status = 'needs_reconciliation',
  failed_at = ?1,
  updated_at = ?1,
  last_error = ?2,
  ledger_record_json = ?3,
  generation = generation + 1
WHERE post_id = ?4
  AND status = 'publishing'
  AND attempt_id = ?5
  AND generation = ?6
  AND changes() = 1
`;

const INSERT_EVENT_SQL = `
INSERT INTO publication_events (
  post_id,
  event_type,
  event_at,
  detail
)
SELECT ?1, ?2, ?3, ?4
WHERE changes() = 1
`;

const DIRECT_CHANGES_SQL = 'SELECT changes() AS direct_changes';

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function firstResult(result) {
  return result?.results?.[0] ?? null;
}

function directChanges(result) {
  const value = Number(firstResult(result)?.direct_changes);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error('D1 direct change count is missing or invalid');
  }
  return value;
}

function assertExactlyOne(result, label) {
  if (directChanges(result) !== 1) {
    throw new Error(`${label} did not change exactly one row`);
  }
}

function positiveGeneration(value, label = 'publication_state generation') {
  const generation = Number(value);
  if (!Number.isSafeInteger(generation) || generation < 1) {
    throw new Error(`${label} is missing or invalid`);
  }
  return generation;
}

function isoNow(now) {
  if (Object.prototype.toString.call(now) !== '[object Date]') {
    throw new Error('now must be a Date');
  }
  const ms = now.getTime();
  if (!Number.isFinite(ms)) throw new Error('now must be valid');
  return now.toISOString();
}

async function sha256Hex(text) {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

async function readPublicationStateCursor(db, postId) {
  if (!db || typeof db.prepare !== 'function') {
    throw new Error('D1 binding DB is unavailable');
  }

  const row = await db
    .prepare(READ_STATE_CURSOR_SQL)
    .bind(postId)
    .first();

  if (!row) {
    throw new Error('publication_state row is missing');
  }

  return {
    status: row.status,
    attemptId: row.attempt_id ?? null,
    generation: positiveGeneration(row.generation),
  };
}

export async function readPublicationSnapshot(db) {
  if (!db || typeof db.prepare !== 'function') {
    throw new Error('D1 binding DB is unavailable');
  }

  const row = await db
    .prepare(
      `SELECT value FROM runtime_metadata WHERE key = '${SNAPSHOT_KEY}' LIMIT 1`,
    )
    .first();

  if (!row || typeof row.value !== 'string' || row.value.length === 0) {
    throw new Error('D1 publication snapshot is missing');
  }

  let ledger;
  try {
    ledger = JSON.parse(row.value);
  } catch {
    throw new Error('D1 publication snapshot is invalid JSON');
  }

  if (!ledger || typeof ledger !== 'object' || Array.isArray(ledger)) {
    throw new Error('D1 publication snapshot is not an object');
  }

  return {
    raw: row.value,
    ledger,
  };
}

export async function beginPublishingFence(
  db,
  snapshot,
  {
    post,
    text,
    cost,
    now = new Date(),
    attemptId = crypto.randomUUID(),
  },
) {
  if (!snapshot || typeof snapshot.raw !== 'string' || !snapshot.ledger) {
    throw new Error('exact source snapshot is required');
  }
  if (!post?.id || typeof post.id !== 'string') {
    throw new Error('post id is required');
  }
  if (typeof text !== 'string' || text.length === 0) {
    throw new Error('publication text is required');
  }
  if (!Number.isFinite(cost) || cost < 0) {
    throw new Error('publication cost is invalid');
  }
  if (snapshot.ledger.inflight) {
    throw new Error('publication snapshot already has an inflight attempt');
  }
  if (typeof attemptId !== 'string' || attemptId.length < 8) {
    throw new Error('attemptId is invalid');
  }

  const cursor = await readPublicationStateCursor(db, post.id);
  if (cursor.status !== 'scheduled' || cursor.attemptId !== null) {
    throw new Error('publication_state row is not an exact scheduled candidate');
  }

  const expectedGeneration = cursor.generation;
  const nextGeneration = expectedGeneration + 1;
  const at = isoNow(now);
  const contentHash = await sha256Hex(text);
  const next = cloneJson(snapshot.ledger);

  next.inflight = {
    attemptId,
    postId: post.id,
    title: post.title ?? post.id,
    contentHash,
    cost,
    startedAt: at,
    status: 'publishing',
    publishStartedAt: at,
  };

  const nextRaw = JSON.stringify(next);
  const eventDetail = JSON.stringify({
    attemptId,
    contentHash,
    cost,
    stateGeneration: nextGeneration,
  });

  const results = await db.batch([
    db
      .prepare(UPDATE_BEGIN_SNAPSHOT_SQL)
      .bind(nextRaw, at, snapshot.raw, post.id, expectedGeneration),
    db.prepare(DIRECT_CHANGES_SQL),
    db
      .prepare(UPDATE_PUBLISHING_SQL)
      .bind(attemptId, at, post.id, expectedGeneration),
    db.prepare(DIRECT_CHANGES_SQL),
    db.prepare(INSERT_EVENT_SQL).bind(post.id, 'publishing', at, eventDetail),
    db.prepare(DIRECT_CHANGES_SQL),
  ]);

  assertExactlyOne(results?.[1], 'publication snapshot fence');
  assertExactlyOne(results?.[3], 'publication_state publishing fence');
  assertExactlyOne(results?.[5], 'publication publishing event');

  return {
    raw: nextRaw,
    ledger: next,
    attempt: next.inflight,
    publicationStateGeneration: nextGeneration,
  };
}

export async function persistPublicationOutcome(
  db,
  snapshot,
  {
    post,
    outcome,
    now = new Date(),
  },
) {
  if (!snapshot || typeof snapshot.raw !== 'string' || !snapshot.ledger) {
    throw new Error('publishing snapshot is required');
  }
  if (!post?.id || typeof post.id !== 'string') {
    throw new Error('post id is required');
  }

  const attempt = snapshot.ledger.inflight;
  if (!attempt || attempt.postId !== post.id || attempt.status !== 'publishing') {
    throw new Error('matching publishing attempt is required');
  }

  const expectedGeneration = positiveGeneration(
    snapshot.publicationStateGeneration,
    'publishing snapshot generation',
  );
  const nextGeneration = expectedGeneration + 1;
  const at = isoNow(now);
  const next = cloneJson(snapshot.ledger);
  const classification = outcome?.classification;
  const reason = typeof outcome?.reason === 'string'
    ? outcome.reason
    : 'unknown_publication_outcome';

  let stateStatement;
  let eventType;
  let eventDetail;

  if (classification === 'confirmed_posted') {
    const tweetId = typeof outcome?.postId === 'string'
      ? outcome.postId.trim()
      : '';

    if (!tweetId) {
      throw new Error('confirmed publication outcome is missing post id');
    }

    const record = {
      tweetId,
      at,
      cost: attempt.cost,
      contentHash: attempt.contentHash,
      attemptId: attempt.attemptId,
    };
    const durableRecord = {
      ...record,
      stateGeneration: nextGeneration,
    };

    next.posted ??= {};
    next.posted[post.id] = record;
    next.spend = +(
      (Number(next.spend ?? 0) + Number(attempt.cost ?? 0))
    ).toFixed(4);
    next.inflight = null;

    stateStatement = db
      .prepare(UPDATE_POSTED_SQL)
      .bind(
        tweetId,
        at,
        JSON.stringify(durableRecord),
        post.id,
        attempt.attemptId,
        expectedGeneration,
      );

    eventType = 'posted';
    eventDetail = JSON.stringify({
      attemptId: attempt.attemptId,
      tweetId,
      classification,
      reason,
      stateGeneration: nextGeneration,
    });
  } else if (classification === 'confirmed_not_posted') {
    const record = {
      at,
      attemptId: attempt.attemptId,
      classification,
      reason,
      contentHash: attempt.contentHash,
      cost: attempt.cost,
      automaticRetryAllowed: false,
      stateGeneration: nextGeneration,
    };

    next.inflight = null;

    stateStatement = db
      .prepare(UPDATE_CONFIRMED_NOT_POSTED_SQL)
      .bind(
        at,
        reason,
        JSON.stringify(record),
        post.id,
        attempt.attemptId,
        expectedGeneration,
      );

    eventType = 'confirmed_not_posted';
    eventDetail = JSON.stringify(record);
  } else {
    next.inflight = {
      ...next.inflight,
      status: 'needs_reconciliation',
      failedAt: at,
      lastError: reason,
    };
    const durableRecord = {
      ...next.inflight,
      stateGeneration: nextGeneration,
    };

    stateStatement = db
      .prepare(UPDATE_RECONCILIATION_SQL)
      .bind(
        at,
        reason,
        JSON.stringify(durableRecord),
        post.id,
        attempt.attemptId,
        expectedGeneration,
      );

    eventType = 'needs_reconciliation';
    eventDetail = JSON.stringify({
      attemptId: attempt.attemptId,
      classification: classification ?? 'invalid',
      reason,
      automaticRetryAllowed: false,
      stateGeneration: nextGeneration,
    });
  }

  const nextRaw = JSON.stringify(next);

  const results = await db.batch([
    db
      .prepare(UPDATE_OUTCOME_SNAPSHOT_SQL)
      .bind(
        nextRaw,
        at,
        snapshot.raw,
        post.id,
        attempt.attemptId,
        expectedGeneration,
      ),
    db.prepare(DIRECT_CHANGES_SQL),
    stateStatement,
    db.prepare(DIRECT_CHANGES_SQL),
    db.prepare(INSERT_EVENT_SQL).bind(post.id, eventType, at, eventDetail),
    db.prepare(DIRECT_CHANGES_SQL),
  ]);

  assertExactlyOne(results?.[1], 'publication outcome snapshot');
  assertExactlyOne(results?.[3], 'publication_state outcome');
  assertExactlyOne(results?.[5], 'publication outcome event');

  return {
    raw: nextRaw,
    ledger: next,
    classification,
    publicationStateGeneration: nextGeneration,
    reconciliationRequired:
      classification !== 'confirmed_posted' &&
      classification !== 'confirmed_not_posted',
  };
}

export const publicationLedgerSql = Object.freeze({
  readStateCursor: READ_STATE_CURSOR_SQL,
  updateBeginSnapshot: UPDATE_BEGIN_SNAPSHOT_SQL,
  updateOutcomeSnapshot: UPDATE_OUTCOME_SNAPSHOT_SQL,
  updatePublishing: UPDATE_PUBLISHING_SQL,
  updatePosted: UPDATE_POSTED_SQL,
  updateConfirmedNotPosted: UPDATE_CONFIRMED_NOT_POSTED_SQL,
  updateReconciliation: UPDATE_RECONCILIATION_SQL,
  insertEvent: INSERT_EVENT_SQL,
  directChanges: DIRECT_CHANGES_SQL,
});
