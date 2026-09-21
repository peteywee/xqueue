import { createHash } from 'node:crypto';

function requiredString(value, label) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(label + ' is required');
  }
  return value.trim();
}

function positiveInteger(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) {
    throw new Error(label + ' must be a positive integer');
  }
  return number;
}

function canonicalIso(value, label) {
  const text = requiredString(value, label);
  const ms = Date.parse(text);
  if (!Number.isFinite(ms) || new Date(ms).toISOString() !== text) {
    throw new Error(label + ' must be canonical ISO-8601 UTC');
  }
  return text;
}

function sqlText(value) {
  if (value === null || value === undefined) return 'NULL';
  return "'" + String(value).replaceAll("'", "''") + "'";
}

function sha256(value) {
  return createHash('sha256').update(Buffer.from(String(value), 'utf8')).digest('hex');
}

function parseSnapshot(raw) {
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new Error('runtime snapshot is required');
  }
  let ledger;
  try {
    ledger = JSON.parse(raw);
  } catch {
    throw new Error('runtime snapshot is invalid JSON');
  }
  if (!ledger || typeof ledger !== 'object' || Array.isArray(ledger)) {
    throw new Error('runtime snapshot must be an object');
  }
  return ledger;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

export function planOwnerReconciliation({
  publicationState,
  publicationFence,
  snapshotRaw,
  outcome,
  tweetId = null,
  reason,
  determinedAt = new Date().toISOString(),
}) {
  if (!publicationState || typeof publicationState !== 'object') {
    throw new Error('publication state is required');
  }
  if (publicationState.status !== 'needs_reconciliation') {
    throw new Error('publication state is not awaiting reconciliation');
  }

  const postId = requiredString(publicationState.post_id, 'post_id');
  const attemptId = requiredString(publicationState.attempt_id, 'attempt_id');
  const generation = positiveInteger(publicationState.generation, 'state generation');
  const at = canonicalIso(determinedAt, 'determinedAt');
  const normalizedReason = requiredString(reason, 'reason');

  if (!['confirmed_posted', 'confirmed_not_posted'].includes(outcome)) {
    throw new Error('outcome must be confirmed_posted or confirmed_not_posted');
  }

  const normalizedTweetId = outcome === 'confirmed_posted'
    ? requiredString(tweetId, 'tweet_id')
    : null;
  if (outcome === 'confirmed_not_posted' && tweetId != null) {
    throw new Error('tweet_id is invalid for confirmed_not_posted');
  }

  if (!publicationFence || typeof publicationFence !== 'object') {
    throw new Error('immutable publication fence is required');
  }
  if (
    publicationFence.attempt_id !== attemptId ||
    publicationFence.post_id !== postId
  ) {
    throw new Error('publication fence identity does not match reconciliation state');
  }

  const ledger = parseSnapshot(snapshotRaw);
  const inflight = ledger.inflight;
  if (
    !inflight ||
    inflight.postId !== postId ||
    inflight.attemptId !== attemptId ||
    inflight.status !== 'needs_reconciliation'
  ) {
    throw new Error('runtime snapshot does not contain the exact ambiguous attempt');
  }

  const material = {
    postId,
    attemptId,
    expectedStateGeneration: generation,
    outcome,
    tweetId: normalizedTweetId,
    reason: normalizedReason,
    determinedAt: at,
    fenceStateGeneration: positiveInteger(
      publicationFence.state_generation,
      'fence state generation',
    ),
  };
  const digest = sha256(JSON.stringify(material));
  const determinationId = 'reconcile-' + digest.slice(0, 32);

  const next = clone(ledger);
  const publicationFenceEvidence =
    inflight.publicationFence ?? {
      attemptId,
      stateGeneration: Number(publicationFence.state_generation),
      leaseName: publicationFence.lease_name,
      leaseGeneration: Number(publicationFence.lease_generation),
      leaseOwnerToken: publicationFence.lease_owner_token,
      leaseAcquisitionId: publicationFence.lease_acquisition_id,
      leaseAcquiredAtMs: Number(publicationFence.lease_acquired_at_ms),
      leaseExpiresAtMs: Number(publicationFence.lease_expires_at_ms),
      assignmentId: publicationFence.assignment_id,
      assignmentVersion: Number(publicationFence.assignment_version),
      policyVersion: Number(publicationFence.policy_version),
      contentDigest: publicationFence.content_digest,
    };

  let durableRecord;
  if (outcome === 'confirmed_posted') {
    durableRecord = {
      tweetId: normalizedTweetId,
      at,
      cost: Number(inflight.cost ?? 0),
      contentHash: inflight.contentHash,
      attemptId,
      publicationFence: publicationFenceEvidence,
      reconciled: true,
      reconciliationDeterminationId: determinationId,
      stateGeneration: generation + 1,
    };

    next.posted ??= {};
    next.posted[postId] = {
      tweetId: normalizedTweetId,
      at,
      cost: Number(inflight.cost ?? 0),
      contentHash: inflight.contentHash,
      attemptId,
      publicationFence: publicationFenceEvidence,
      reconciled: true,
      reconciliationDeterminationId: determinationId,
    };
    next.spend = +(
      Number(next.spend ?? 0) + Number(inflight.cost ?? 0)
    ).toFixed(4);
    next.inflight = null;
  } else {
    durableRecord = {
      at,
      attemptId,
      classification: 'confirmed_not_posted',
      reason: normalizedReason,
      contentHash: inflight.contentHash,
      cost: Number(inflight.cost ?? 0),
      automaticRetryAllowed: false,
      reconciled: true,
      reconciliationDeterminationId: determinationId,
      publicationFence: publicationFenceEvidence,
      stateGeneration: generation + 1,
    };
    next.inflight = null;
  }

  return Object.freeze({
    format: 1,
    determination_id: determinationId,
    post_id: postId,
    attempt_id: attemptId,
    expected_state_generation: generation,
    resulting_state_generation: generation + 1,
    outcome,
    tweet_id: normalizedTweetId,
    reason: normalizedReason,
    actor_class: 'owner',
    determined_at: at,
    source_snapshot_raw: snapshotRaw,
    resulting_snapshot_raw: JSON.stringify(next),
    durable_record_json: JSON.stringify(durableRecord),
    publication_fence: Object.freeze({ ...publicationFence }),
  });
}

export function renderOwnerReconciliationSql(plan) {
  if (!plan || plan.actor_class !== 'owner') {
    throw new Error('owner reconciliation plan is required');
  }

  const eventType = plan.outcome === 'confirmed_posted'
    ? 'reconciled_posted'
    : 'reconciled_not_posted';

  const eventDetail = JSON.stringify({
    determinationId: plan.determination_id,
    attemptId: plan.attempt_id,
    outcome: plan.outcome,
    tweetId: plan.tweet_id,
    reason: plan.reason,
    stateGeneration: plan.resulting_state_generation,
    ownerDetermination: true,
  });

  const noExistingDetermination = [
    'NOT EXISTS (SELECT 1 FROM publication_reconciliation_determinations existing ',
    'WHERE existing.post_id=' + sqlText(plan.post_id) + ' ',
    'AND existing.attempt_id=' + sqlText(plan.attempt_id) + ')',
  ].join('');

  const exactAmbiguousState = [
    'EXISTS (SELECT 1 FROM publication_state state ',
    'WHERE state.post_id=' + sqlText(plan.post_id) + ' ',
    "AND state.status='needs_reconciliation' ",
    'AND state.attempt_id=' + sqlText(plan.attempt_id) + ' ',
    'AND state.generation=' + plan.expected_state_generation + ')',
  ].join('');

  const exactFence = [
    'EXISTS (SELECT 1 FROM publication_fences fence ',
    'WHERE fence.attempt_id=' + sqlText(plan.attempt_id) + ' ',
    'AND fence.post_id=' + sqlText(plan.post_id) + ')',
  ].join('');

  const exactResultSnapshot = [
    "EXISTS (SELECT 1 FROM runtime_metadata snapshot WHERE snapshot.key='state.snapshot_json' ",
    'AND snapshot.value=' + sqlText(plan.resulting_snapshot_raw) + ')',
  ].join('');

  const snapshotUpdate = [
    'UPDATE runtime_metadata SET ',
    'value=' + sqlText(plan.resulting_snapshot_raw) + ',',
    'updated_at=' + sqlText(plan.determined_at) + ' ',
    "WHERE key='state.snapshot_json' ",
    'AND value=' + sqlText(plan.source_snapshot_raw) + ' ',
    'AND ' + exactAmbiguousState + ' ',
    'AND ' + exactFence + ' ',
    'AND ' + noExistingDetermination + ';',
  ].join('');

  const stateUpdate = plan.outcome === 'confirmed_posted'
    ? [
        'UPDATE publication_state SET ',
        "status='posted',",
        'tweet_id=' + sqlText(plan.tweet_id) + ',',
        'posted_at=' + sqlText(plan.determined_at) + ',',
        'updated_at=' + sqlText(plan.determined_at) + ',',
        'last_error=NULL,failed_at=NULL,reconciled=1,',
        'ledger_record_json=' + sqlText(plan.durable_record_json) + ',',
        'generation=generation+1 ',
        'WHERE post_id=' + sqlText(plan.post_id) + ' ',
        "AND status='needs_reconciliation' ",
        'AND attempt_id=' + sqlText(plan.attempt_id) + ' ',
        'AND generation=' + plan.expected_state_generation + ' ',
        'AND ' + exactResultSnapshot + ' ',
        'AND ' + exactFence + ' ',
        'AND ' + noExistingDetermination + ';',
      ].join('')
    : [
        'UPDATE publication_state SET ',
        "status='scheduled',",
        'tweet_id=NULL,attempt_id=NULL,publishing_at=NULL,',
        'updated_at=' + sqlText(plan.determined_at) + ',',
        'last_error=' + sqlText(plan.reason) + ',',
        'failed_at=NULL,reconciled=1,',
        'ledger_record_json=' + sqlText(plan.durable_record_json) + ',',
        'generation=generation+1 ',
        'WHERE post_id=' + sqlText(plan.post_id) + ' ',
        "AND status='needs_reconciliation' ",
        'AND attempt_id=' + sqlText(plan.attempt_id) + ' ',
        'AND generation=' + plan.expected_state_generation + ' ',
        'AND ' + exactResultSnapshot + ' ',
        'AND ' + exactFence + ' ',
        'AND ' + noExistingDetermination + ';',
      ].join('');

  const resultingStateGuard = [
    'EXISTS (SELECT 1 FROM publication_state state ',
    'WHERE state.post_id=' + sqlText(plan.post_id) + ' ',
    'AND state.generation=' + plan.resulting_state_generation + ' ',
    'AND state.reconciled=1 ',
    'AND ' + (
      plan.outcome === 'confirmed_posted'
        ? "state.status='posted' AND state.tweet_id=" + sqlText(plan.tweet_id) +
          ' AND state.attempt_id=' + sqlText(plan.attempt_id)
        : "state.status='scheduled' AND state.attempt_id IS NULL AND state.tweet_id IS NULL"
    ) + ')',
  ].join('');

  const determinationInsert = [
    'INSERT INTO publication_reconciliation_determinations (',
    'determination_id,post_id,attempt_id,expected_state_generation,outcome,',
    'tweet_id,reason,actor_class,determined_at',
    ') SELECT ',
    [
      sqlText(plan.determination_id),
      sqlText(plan.post_id),
      sqlText(plan.attempt_id),
      String(plan.expected_state_generation),
      sqlText(plan.outcome),
      sqlText(plan.tweet_id),
      sqlText(plan.reason),
      sqlText('owner'),
      sqlText(plan.determined_at),
    ].join(','),
    ' WHERE ' + exactResultSnapshot + ' ',
    'AND ' + resultingStateGuard + ' ',
    'AND ' + exactFence + ' ',
    'AND ' + noExistingDetermination + ';',
  ].join('');

  const eventInsert = [
    'INSERT INTO publication_events (post_id,event_type,event_at,detail) SELECT ',
    sqlText(plan.post_id) + ',',
    sqlText(eventType) + ',',
    sqlText(plan.determined_at) + ',',
    sqlText(eventDetail) + ' ',
    'WHERE EXISTS (SELECT 1 FROM publication_reconciliation_determinations d ',
    'WHERE d.determination_id=' + sqlText(plan.determination_id) + ' ',
    'AND d.post_id=' + sqlText(plan.post_id) + ' ',
    'AND d.attempt_id=' + sqlText(plan.attempt_id) + ' ',
    'AND d.outcome=' + sqlText(plan.outcome) + ') ',
    'AND NOT EXISTS (SELECT 1 FROM publication_events e ',
    'WHERE e.post_id=' + sqlText(plan.post_id) + ' ',
    'AND e.event_type=' + sqlText(eventType) + ' ',
    'AND e.detail=' + sqlText(eventDetail) + ');',
  ].join('');

  return [
    'BEGIN IMMEDIATE;',
    snapshotUpdate,
    stateUpdate,
    determinationInsert,
    eventInsert,
    'COMMIT;',
  ].join('\n');
}

export function classifyReconciliationReadback(plan, readback) {
  if (!plan || !readback) return 'missing';

  const determination = readback.determination;
  const state = readback.publicationState;
  const snapshotRaw = readback.snapshotRaw;
  const events = Array.isArray(readback.events) ? readback.events : [];

  if (
    !determination ||
    determination.determination_id !== plan.determination_id ||
    determination.post_id !== plan.post_id ||
    determination.attempt_id !== plan.attempt_id ||
    Number(determination.expected_state_generation) !== plan.expected_state_generation ||
    determination.outcome !== plan.outcome ||
    (determination.tweet_id ?? null) !== (plan.tweet_id ?? null) ||
    determination.reason !== plan.reason ||
    determination.actor_class !== 'owner'
  ) {
    return 'conflict';
  }

  if (
    !state ||
    Number(state.generation) !== plan.resulting_state_generation ||
    Number(state.reconciled) !== 1 ||
    snapshotRaw !== plan.resulting_snapshot_raw
  ) {
    return 'conflict';
  }

  if (plan.outcome === 'confirmed_posted') {
    if (state.status !== 'posted' || state.tweet_id !== plan.tweet_id) return 'conflict';
  } else if (
    state.status !== 'scheduled' ||
    state.attempt_id != null ||
    state.tweet_id != null
  ) {
    return 'conflict';
  }

  const eventType = plan.outcome === 'confirmed_posted'
    ? 'reconciled_posted'
    : 'reconciled_not_posted';
  if (!events.some((event) => event.event_type === eventType)) {
    return 'conflict';
  }

  return 'complete';
}
