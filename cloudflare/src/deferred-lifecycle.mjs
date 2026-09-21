import {
  buildDynamicRuntimeSnapshot,
  readDynamicRuntimeRows,
  readRuntimeState,
} from './dynamic-runtime-integrity.mjs';
import {
  nextRuntimeRevision,
  renderRuntimeRevisionInsertSql,
} from '../../src/continuous-queue-runtime-write.mjs';

// deferred-lifecycle.mjs — durable missed-slot -> deferred transition.
//
// This is scheduling lifecycle only. It never publishes, never calls X, and
// never creates a replacement assignment (#54 owns replacement scheduling).

export const MISSED_REASON = 'missed_slot_grace_expired';

const CANDIDATES_SQL = `
SELECT
  a.assignment_id,
  a.assignment_version,
  a.content_id,
  a.content_revision,
  a.content_digest,
  a.target_account,
  a.policy_version,
  a.resolved_at,
  a.scheduled_date,
  a.scheduled_time,
  a.timezone,
  a.slot_label,
  a.status AS assignment_status,
  a.lifecycle_state,
  a.generation AS assignment_generation,
  p.status AS publication_status,
  p.generation AS publication_generation,
  d.state AS deferral_state
FROM queue_assignments a
LEFT JOIN publication_state p
  ON p.post_id = a.content_id
LEFT JOIN queue_deferrals d
  ON d.content_id = a.content_id
WHERE
  a.status = 'active'
  AND a.lifecycle_state = 'scheduled'
ORDER BY a.resolved_at, a.content_id, a.assignment_version
`;

const UPDATE_ASSIGNMENT_SQL = `
UPDATE queue_assignments
SET
  lifecycle_state = 'deferred',
  updated_at = ?1,
  generation = generation + 1
WHERE
  assignment_id = ?2
  AND assignment_version = ?3
  AND content_id = ?4
  AND content_digest = ?5
  AND policy_version = ?6
  AND resolved_at = ?7
  AND status = 'active'
  AND lifecycle_state = 'scheduled'
  AND generation = ?8
`;

const INSERT_DEFERRAL_SQL = `
INSERT INTO queue_deferrals (
  content_id,
  content_revision,
  assignment_id,
  assignment_version,
  assignment_generation,
  policy_version,
  content_digest,
  target_account,
  prior_resolved_at,
  prior_scheduled_date,
  prior_scheduled_time,
  prior_timezone,
  prior_slot_label,
  reason,
  deferred_at,
  state,
  generation,
  replacement_assignment_version
)
SELECT
  ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8,
  ?9, ?10, ?11, ?12, ?13, ?14, ?15,
  'pending_replacement', 1, NULL
WHERE changes() = 1
`;

const INSERT_ASSIGNMENT_EVENT_SQL = `
INSERT INTO queue_assignment_events (
  assignment_id,
  assignment_version,
  event_type,
  event_at,
  detail
)
SELECT ?1, ?2, 'deferred', ?3, ?4
WHERE changes() = 1
`;

const INSERT_DEFERRAL_EVENT_SQL = `
INSERT INTO queue_deferral_events (
  content_id,
  assignment_id,
  assignment_version,
  event_type,
  event_at,
  detail
)
SELECT ?1, ?2, ?3, 'deferred', ?4, ?5
WHERE changes() = 1
`;

const DIRECT_CHANGES_SQL = 'SELECT changes() AS direct_changes';

const READBACK_SQL = `
SELECT
  a.assignment_id,
  a.assignment_version,
  a.content_id,
  a.content_digest,
  a.policy_version,
  a.resolved_at,
  a.lifecycle_state,
  a.generation AS assignment_generation,
  d.content_revision,
  d.assignment_generation AS prior_assignment_generation,
  d.target_account,
  d.prior_resolved_at,
  d.prior_scheduled_date,
  d.prior_scheduled_time,
  d.prior_timezone,
  d.prior_slot_label,
  d.reason,
  d.deferred_at,
  d.state AS deferral_state,
  d.generation AS deferral_generation
FROM queue_assignments a
JOIN queue_deferrals d
  ON d.content_id = a.content_id
 AND d.assignment_id = a.assignment_id
 AND d.assignment_version = a.assignment_version
WHERE
  a.assignment_id = ?1
  AND a.assignment_version = ?2
LIMIT 1
`;

function isoNow(now) {
  if (Object.prototype.toString.call(now) !== '[object Date]') {
    throw new Error('now must be a Date');
  }
  const ms = now.getTime();
  if (!Number.isFinite(ms)) throw new Error('now must be valid');
  return now.toISOString();
}

function graceMs(graceMinutes) {
  if (!Number.isFinite(graceMinutes) || graceMinutes < 0) {
    throw new Error('graceMinutes must be a non-negative finite number');
  }
  return graceMinutes * 60_000;
}

function canonicalMs(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label} is required`);
  }
  const ms = Date.parse(value);
  if (!Number.isFinite(ms) || new Date(ms).toISOString() !== value) {
    throw new Error(`${label} must be canonical ISO-8601 UTC with milliseconds`);
  }
  return ms;
}

function positiveInt(value, label) {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  return n;
}

function firstResult(result) {
  return result?.results?.[0] ?? null;
}

function directChanges(result) {
  const n = Number(firstResult(result)?.direct_changes);
  if (!Number.isSafeInteger(n) || n < 0) {
    throw new Error('D1 direct change count is missing or invalid');
  }
  return n;
}

export function classifyMissedAssignment(
  row,
  {
    now = new Date(),
    graceMinutes = 20,
  } = {},
) {
  const nowIso = isoNow(now);
  const nowMs = Date.parse(nowIso);
  const resolvedMs = canonicalMs(row?.resolved_at, 'resolved_at');
  const grace = graceMs(graceMinutes);

  if (row?.deferral_state === 'pending_replacement') {
    return Object.freeze({ action: 'already_deferred', reason: null });
  }

  if (nowMs <= resolvedMs + grace) {
    return Object.freeze({ action: 'current', reason: null });
  }

  if (row?.publication_status === 'needs_reconciliation') {
    return Object.freeze({
      action: 'protected',
      reason: 'needs_reconciliation_requires_determination',
    });
  }

  if (row?.publication_status == null) {
    return Object.freeze({
      action: 'protected',
      reason: 'publication_state_missing',
    });
  }

  if (['prepared', 'publishing'].includes(row.publication_status)) {
    return Object.freeze({
      action: 'protected',
      reason: `publication_${row.publication_status}`,
    });
  }

  if (['posted', 'skipped'].includes(row.publication_status)) {
    return Object.freeze({ action: 'resolved', reason: row.publication_status });
  }

  if (row.publication_status !== 'scheduled') {
    return Object.freeze({
      action: 'protected',
      reason: 'publication_state_invalid',
    });
  }

  return Object.freeze({ action: 'defer', reason: MISSED_REASON });
}

function exactReadback(row, readback, deferredAt, reason) {
  return Boolean(
    readback &&
    readback.assignment_id === row.assignment_id &&
    Number(readback.assignment_version) === Number(row.assignment_version) &&
    readback.content_id === row.content_id &&
    readback.content_digest === row.content_digest &&
    Number(readback.policy_version) === Number(row.policy_version) &&
    readback.resolved_at === row.resolved_at &&
    readback.lifecycle_state === 'deferred' &&
    Number(readback.assignment_generation) === Number(row.assignment_generation) + 1 &&
    Number(readback.prior_assignment_generation) === Number(row.assignment_generation) &&
    readback.prior_resolved_at === row.resolved_at &&
    readback.reason === reason &&
    readback.deferred_at === deferredAt &&
    readback.deferral_state === 'pending_replacement' &&
    Number(readback.deferral_generation) === 1
  );
}

async function readback(db, row) {
  return await db
    .prepare(READBACK_SQL)
    .bind(row.assignment_id, Number(row.assignment_version))
    .first();
}

async function transitionAssignmentToDeferred(
  db,
  row,
  {
    now = new Date(),
    reason = MISSED_REASON,
  } = {},
) {
  if (!db || typeof db.prepare !== 'function' || typeof db.batch !== 'function') {
    throw new Error('D1 binding DB is unavailable');
  }
  if (typeof reason !== 'string' || reason.length === 0) {
    throw new Error('deferral reason is required');
  }

  const at = isoNow(now);
  const assignmentVersion = positiveInt(row.assignment_version, 'assignment version');
  const assignmentGeneration = positiveInt(row.assignment_generation, 'assignment generation');
  const policyVersion = positiveInt(row.policy_version, 'policy version');
  const contentRevision = positiveInt(row.content_revision, 'content revision');

  const detail = JSON.stringify({
    contentId: row.content_id,
    contentRevision,
    assignmentId: row.assignment_id,
    assignmentVersion,
    assignmentGeneration,
    policyVersion,
    contentDigest: row.content_digest,
    targetAccount: row.target_account,
    priorResolvedAt: row.resolved_at,
    priorScheduledDate: row.scheduled_date,
    priorScheduledTime: row.scheduled_time,
    priorTimezone: row.timezone,
    priorSlotLabel: row.slot_label ?? null,
    reason,
    deferredAt: at,
  });

  try {
    const results = await db.batch([
      db.prepare(UPDATE_ASSIGNMENT_SQL).bind(
        at,
        row.assignment_id,
        assignmentVersion,
        row.content_id,
        row.content_digest,
        policyVersion,
        row.resolved_at,
        assignmentGeneration,
      ),
      db.prepare(DIRECT_CHANGES_SQL),
      db.prepare(INSERT_DEFERRAL_SQL).bind(
        row.content_id,
        contentRevision,
        row.assignment_id,
        assignmentVersion,
        assignmentGeneration,
        policyVersion,
        row.content_digest,
        row.target_account,
        row.resolved_at,
        row.scheduled_date,
        row.scheduled_time,
        row.timezone,
        row.slot_label ?? null,
        reason,
        at,
      ),
      db.prepare(DIRECT_CHANGES_SQL),
      db.prepare(INSERT_ASSIGNMENT_EVENT_SQL).bind(
        row.assignment_id,
        assignmentVersion,
        at,
        detail,
      ),
      db.prepare(DIRECT_CHANGES_SQL),
      db.prepare(INSERT_DEFERRAL_EVENT_SQL).bind(
        row.content_id,
        row.assignment_id,
        assignmentVersion,
        at,
        detail,
      ),
      db.prepare(DIRECT_CHANGES_SQL),
    ]);

    if (
      directChanges(results?.[1]) !== 1 ||
      directChanges(results?.[3]) !== 1 ||
      directChanges(results?.[5]) !== 1 ||
      directChanges(results?.[7]) !== 1
    ) {
      throw new Error('deferral CAS/event transition did not change exactly one row per step');
    }
  } catch {
    // Never blindly repeat an ambiguous scheduling mutation. Exact readback is
    // the only authority for deciding whether the transition actually landed.
  }

  const observed = await readback(db, row);
  if (exactReadback(row, observed, at, reason)) {
    return Object.freeze({
      status: 'deferred',
      reason,
      contentId: row.content_id,
      assignmentId: row.assignment_id,
      assignmentVersion,
      deferredAt: at,
    });
  }

  if (
    observed &&
    observed.lifecycle_state === 'deferred' &&
    observed.deferral_state === 'pending_replacement'
  ) {
    return Object.freeze({
      status: 'already_deferred',
      reason: observed.reason ?? reason,
      contentId: row.content_id,
    });
  }

  throw new Error(
    `deferral outcome for ${row.content_id} is ambiguous or conflicted; manual reconciliation required`,
  );
}

export async function deferOneMissedAssignment(
  db,
  row,
  {
    now = new Date(),
    graceMinutes = 20,
  } = {},
) {
  const classification = classifyMissedAssignment(row, { now, graceMinutes });
  if (classification.action !== 'defer') {
    return Object.freeze({
      status: classification.action,
      reason: classification.reason,
      contentId: row?.content_id ?? null,
    });
  }

  return transitionAssignmentToDeferred(db, row, {
    now,
    reason: MISSED_REASON,
  });
}

export function publicationDeferralHandoff(result) {
  if (!result || typeof result !== 'object') return null;

  if (
    result.status === 'needs_reconciliation' ||
    result.evidence?.outcome?.classification === 'needs_reconciliation'
  ) {
    return null;
  }

  if (result.deferRecommended === true && typeof result.deferReason === 'string') {
    return result.deferReason;
  }

  const outcome = result.evidence?.outcome;
  if (
    outcome?.classification === 'confirmed_not_posted' &&
    outcome?.deferRecommended === true &&
    typeof outcome.deferReason === 'string'
  ) {
    return outcome.deferReason;
  }

  return null;
}

async function promoteRuntimeRevisionIfNeeded(db, recordedAt) {
  const current = await readRuntimeState(db);
  if (!current) {
    throw new Error('runtime revision state is missing; refusing deferred lifecycle mutation');
  }

  const rows = await readDynamicRuntimeRows(db);
  const snapshot = await buildDynamicRuntimeSnapshot(rows);

  const currentGeneration = positiveInt(
    current.generation,
    'runtime revision generation',
  );
  if (
    snapshot.revision_digest === current.revision_digest &&
    snapshot.active_assignment_count === Number(current.active_assignment_count) &&
    snapshot.approved_unscheduled_count === Number(current.approved_unscheduled_count) &&
    snapshot.media_required_count === Number(current.media_required_count) &&
    snapshot.media_ready_count === Number(current.media_ready_count)
  ) {
    return Object.freeze({
      status: 'unchanged',
      generation: currentGeneration,
      revisionDigest: current.revision_digest,
      deferredCount: snapshot.deferred_count,
    });
  }

  const sourceOperationId =
    `deferred-lifecycle:${snapshot.revision_digest.slice(0, 24)}`;
  const revision = nextRuntimeRevision({
    currentState: current,
    snapshot,
    sourceOperationId,
    recordedAt,
  });
  const sql = renderRuntimeRevisionInsertSql(revision);

  try {
    const statement = db.prepare(sql);
    if (!statement || typeof statement.run !== 'function') {
      throw new Error('D1 run interface is unavailable');
    }
    await statement.run();
  } catch {
    // Ambiguous runtime-revision write: read back exact latest state before
    // deciding whether a retry would be safe.
  }

  const observed = await readRuntimeState(db);
  if (
    Number(observed?.generation) === revision.generation &&
    observed?.revision_digest === revision.revision_digest &&
    Number(observed?.active_assignment_count) === revision.active_assignment_count &&
    Number(observed?.approved_unscheduled_count) === revision.approved_unscheduled_count &&
    Number(observed?.media_required_count) === revision.media_required_count &&
    Number(observed?.media_ready_count) === revision.media_ready_count
  ) {
    return Object.freeze({
      status: 'promoted',
      generation: revision.generation,
      revisionDigest: revision.revision_digest,
      deferredCount: snapshot.deferred_count,
      sourceOperationId,
    });
  }

  throw new Error(
    'deferred lifecycle changed runtime truth but canonical revision promotion is ambiguous; publication must remain fail-closed',
  );
}

export async function deferConfirmedPublicationHandoff(
  db,
  row,
  publicationResult,
  {
    now = new Date(),
  } = {},
) {
  const reason = publicationDeferralHandoff(publicationResult);
  if (!reason) {
    return Object.freeze({
      status: 'not_applicable',
      reason: null,
      contentId: row?.content_id ?? null,
    });
  }

  if (row?.publication_status === 'needs_reconciliation') {
    return Object.freeze({
      status: 'protected',
      reason: 'needs_reconciliation_requires_determination',
      contentId: row?.content_id ?? null,
    });
  }

  if (row?.publication_status !== 'scheduled') {
    return Object.freeze({
      status: 'protected',
      reason: 'publication_state_not_scheduled',
      contentId: row?.content_id ?? null,
    });
  }

  const transition = await transitionAssignmentToDeferred(db, row, {
    now,
    reason,
  });
  const runtimeRevision = await promoteRuntimeRevisionIfNeeded(
    db,
    isoNow(now),
  );

  return Object.freeze({
    ...transition,
    runtimeRevision,
  });
}

export async function deferMissedAssignments(
  db,
  {
    now = new Date(),
    graceMinutes = 20,
  } = {},
) {
  isoNow(now);
  graceMs(graceMinutes);

  const result = await db.prepare(CANDIDATES_SQL).all();
  const rows = Array.isArray(result) ? result : (result?.results ?? []);
  const outcomes = [];

  for (const row of rows) {
    const classification = classifyMissedAssignment(row, { now, graceMinutes });

    if (classification.action === 'defer') {
      outcomes.push(await deferOneMissedAssignment(db, row, { now, graceMinutes }));
      continue;
    }

    if (classification.action !== 'current') {
      outcomes.push(Object.freeze({
        status: classification.action,
        reason: classification.reason,
        contentId: row.content_id,
      }));
    }
  }

  const runtimeRevision = await promoteRuntimeRevisionIfNeeded(
    db,
    isoNow(now),
  );

  return Object.freeze({
    outcomes: Object.freeze(outcomes),
    runtimeRevision,
  });
}

export const deferredLifecycleSql = Object.freeze({
  candidates: CANDIDATES_SQL,
  updateAssignment: UPDATE_ASSIGNMENT_SQL,
  insertDeferral: INSERT_DEFERRAL_SQL,
  insertAssignmentEvent: INSERT_ASSIGNMENT_EVENT_SQL,
  insertDeferralEvent: INSERT_DEFERRAL_EVENT_SQL,
  directChanges: DIRECT_CHANGES_SQL,
  readback: READBACK_SQL,
});
