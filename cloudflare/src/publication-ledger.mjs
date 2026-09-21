const SNAPSHOT_KEY = 'state.snapshot_json';

const READ_STATE_CURSOR_SQL = `
SELECT
  status,
  attempt_id,
  generation,
  scheduled_at
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
  AND EXISTS (
    SELECT 1
    FROM publication_fences
    WHERE attempt_id = ?6
      AND post_id = ?4
      AND state_generation = ?7
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
  AND EXISTS (
    SELECT 1
    FROM publication_fences
    WHERE attempt_id = ?1
      AND post_id = ?3
      AND state_generation = ?5
  )
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

const INSERT_PUBLICATION_FENCE_SQL = `
INSERT OR IGNORE INTO publication_fences (
  attempt_id,
  post_id,
  state_generation,
  lease_name,
  lease_generation,
  lease_owner_token,
  lease_acquisition_id,
  lease_acquired_at_ms,
  lease_expires_at_ms,
  assignment_id,
  assignment_version,
  policy_version,
  content_digest,
  recorded_at
)
SELECT
  ?1, ?2, ?3, ?4, ?5, ?6, ?7,
  ?8, ?9, ?10, ?11, ?12, ?13, ?14
WHERE EXISTS (
  SELECT 1
  FROM publication_leases lease
  WHERE lease.lease_name = ?4
    AND lease.generation = ?5
    AND lease.owner_token = ?6
    AND lease.acquisition_id = ?7
    AND lease.acquired_at_ms = ?8
    AND lease.expires_at_ms = ?9
    AND lease.expires_at_ms > ?15
)
AND EXISTS (
  SELECT 1
  FROM queue_assignments assignment
  WHERE assignment.assignment_id = ?10
    AND assignment.assignment_version = ?11
    AND assignment.content_id = ?2
    AND assignment.policy_version = ?12
    AND assignment.content_digest = ?13
    AND assignment.status = 'active'
    AND assignment.lifecycle_state = 'scheduled'
    AND assignment.resolved_at = (
      SELECT state.scheduled_at
      FROM publication_state state
      WHERE state.post_id = ?2
        AND state.status = 'scheduled'
        AND state.attempt_id IS NULL
        AND state.generation = ?16
      LIMIT 1
    )
)
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

function requiredString(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(label + ' is required');
  }
  return value;
}

function positiveInteger(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) {
    throw new Error(label + ' must be a positive integer');
  }
  return number;
}

function nonNegativeInteger(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new Error(label + ' must be a non-negative integer');
  }
  return number;
}

function exactDigest(value, label) {
  const digest = requiredString(value, label).toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(digest)) {
    throw new Error(label + ' must be sha256 hex');
  }
  return digest;
}

function normalizeLeaseHandle(lease) {
  if (!lease || typeof lease !== 'object') {
    throw new Error('verified lease handle is required');
  }
  const normalized = {
    leaseName: requiredString(lease.leaseName, 'lease name'),
    generation: positiveInteger(lease.generation, 'lease generation'),
    ownerToken: requiredString(lease.ownerToken, 'lease owner token'),
    acquisitionId: requiredString(lease.acquisitionId, 'lease acquisition id'),
    acquiredAtMs: nonNegativeInteger(lease.acquiredAtMs, 'lease acquiredAtMs'),
    expiresAtMs: nonNegativeInteger(lease.expiresAtMs, 'lease expiresAtMs'),
  };
  if (normalized.leaseName !== 'publisher') {
    throw new Error('lease name must be publisher');
  }
  if (normalized.ownerToken.length < 8 || normalized.acquisitionId.length < 8) {
    throw new Error('lease holder identity is invalid');
  }
  if (normalized.expiresAtMs <= normalized.acquiredAtMs) {
    throw new Error('lease expiry is invalid');
  }
  return Object.freeze(normalized);
}

function normalizeAssignmentHandle(assignment) {
  if (!assignment || typeof assignment !== 'object') {
    throw new Error('verified assignment handle is required');
  }
  const normalized = {
    assignmentId: requiredString(assignment.assignment_id, 'assignment id'),
    assignmentVersion: positiveInteger(
      assignment.assignment_version,
      'assignment version',
    ),
    contentId: requiredString(assignment.content_id, 'assignment content id'),
    policyVersion: positiveInteger(assignment.policy_version, 'policy version'),
    contentDigest: exactDigest(assignment.content_digest, 'content digest'),
    resolvedAt: requiredString(assignment.resolved_at, 'assignment resolved_at'),
  };
  const ms = Date.parse(normalized.resolvedAt);
  if (!Number.isFinite(ms) || new Date(ms).toISOString() !== normalized.resolvedAt) {
    throw new Error('assignment resolved_at must be canonical UTC');
  }
  return Object.freeze(normalized);
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
    scheduledAt:
      typeof row.scheduled_at === 'string' ? row.scheduled_at : null,
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
    lease,
    assignment,
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
  const nowMs = now.getTime();
  const contentHash = await sha256Hex(text);
  const verifiedLease = normalizeLeaseHandle(lease);
  const verifiedAssignment = normalizeAssignmentHandle(assignment);

  if (verifiedAssignment.contentId !== post.id) {
    throw new Error('assignment content identity does not match selected post');
  }
  if (verifiedAssignment.contentDigest !== contentHash) {
    throw new Error('assignment content digest does not match publication text');
  }
  if (cursor.scheduledAt !== verifiedAssignment.resolvedAt) {
    throw new Error('assignment resolved_at does not match publication_state');
  }

  const publicationFence = Object.freeze({
    attemptId,
    stateGeneration: nextGeneration,
    leaseName: verifiedLease.leaseName,
    leaseGeneration: verifiedLease.generation,
    leaseOwnerToken: verifiedLease.ownerToken,
    leaseAcquisitionId: verifiedLease.acquisitionId,
    leaseAcquiredAtMs: verifiedLease.acquiredAtMs,
    leaseExpiresAtMs: verifiedLease.expiresAtMs,
    assignmentId: verifiedAssignment.assignmentId,
    assignmentVersion: verifiedAssignment.assignmentVersion,
    policyVersion: verifiedAssignment.policyVersion,
    contentDigest: verifiedAssignment.contentDigest,
  });

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
    publicationFence,
  };

  const nextRaw = JSON.stringify(next);
  const eventDetail = JSON.stringify({
    attemptId,
    contentHash,
    cost,
    stateGeneration: nextGeneration,
    publicationFence,
  });

  const results = await db.batch([
    db
      .prepare(INSERT_PUBLICATION_FENCE_SQL)
      .bind(
        attemptId,
        post.id,
        nextGeneration,
        verifiedLease.leaseName,
        verifiedLease.generation,
        verifiedLease.ownerToken,
        verifiedLease.acquisitionId,
        verifiedLease.acquiredAtMs,
        verifiedLease.expiresAtMs,
        verifiedAssignment.assignmentId,
        verifiedAssignment.assignmentVersion,
        verifiedAssignment.policyVersion,
        verifiedAssignment.contentDigest,
        at,
        nowMs,
        expectedGeneration,
      ),
    db.prepare(DIRECT_CHANGES_SQL),
    db
      .prepare(UPDATE_BEGIN_SNAPSHOT_SQL)
      .bind(
        nextRaw,
        at,
        snapshot.raw,
        post.id,
        expectedGeneration,
        attemptId,
        nextGeneration,
      ),
    db.prepare(DIRECT_CHANGES_SQL),
    db
      .prepare(UPDATE_PUBLISHING_SQL)
      .bind(attemptId, at, post.id, expectedGeneration, nextGeneration),
    db.prepare(DIRECT_CHANGES_SQL),
    db.prepare(INSERT_EVENT_SQL).bind(post.id, 'publishing', at, eventDetail),
    db.prepare(DIRECT_CHANGES_SQL),
  ]);

  assertExactlyOne(results?.[1], 'publication identity fence');
  assertExactlyOne(results?.[3], 'publication snapshot fence');
  assertExactlyOne(results?.[5], 'publication_state publishing fence');
  assertExactlyOne(results?.[7], 'publication publishing event');

  return {
    raw: nextRaw,
    ledger: next,
    attempt: next.inflight,
    publicationFence,
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
  const publicationFence = snapshot.publicationFence ?? attempt.publicationFence;
  if (
    !publicationFence ||
    publicationFence.attemptId !== attempt.attemptId ||
    publicationFence.stateGeneration !== expectedGeneration
  ) {
    throw new Error('matching immutable publication fence is required');
  }
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
      publicationFence,
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
      publicationFence,
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
      publicationFence,
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
      publicationFence,
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
      publicationFence,
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
  insertPublicationFence: INSERT_PUBLICATION_FENCE_SQL,
  directChanges: DIRECT_CHANGES_SQL,
});
