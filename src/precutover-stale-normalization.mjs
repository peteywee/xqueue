import { deferMissedStaticAssignments } from './deferred-lifecycle.mjs';
import {
  classifyMissedAssignment,
  MISSED_REASON,
} from './d1-deferred-lifecycle.mjs';


export const PRECUTOVER_NORMALIZATION_CANDIDATES_SQL = [
  'SELECT',
  ' a.assignment_id,a.assignment_version,a.content_id,a.content_revision,a.content_digest,',
  ' a.target_account,a.policy_version,a.resolved_at,a.scheduled_date,a.scheduled_time,',
  ' a.timezone,a.slot_label,a.status AS assignment_status,a.lifecycle_state,',
  ' a.generation AS assignment_generation,p.status AS publication_status,',
  ' p.generation AS publication_generation,d.state AS deferral_state',
  'FROM queue_assignments a',
  'JOIN publication_state p ON p.post_id=a.content_id',
  'LEFT JOIN queue_deferrals d ON d.content_id=a.content_id',
  "WHERE a.status='active'",
  " AND a.lifecycle_state='scheduled'",
  " AND p.status='scheduled'",
  ' AND p.attempt_id IS NULL',
  ' AND d.content_id IS NULL',
  'ORDER BY a.resolved_at,a.content_id,a.assignment_version;',
].join(' ');

function sqlText(value) {
  if (value === null || value === undefined) return 'NULL';
  return "'" + String(value).replaceAll("'", "''") + "'";
}

function positiveInt(value, label) {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 1) {
    throw new Error(label + ' must be a positive integer');
  }
  return n;
}

function canonicalIso(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(label + ' is required');
  }
  const ms = Date.parse(value);
  if (!Number.isFinite(ms) || new Date(ms).toISOString() !== value) {
    throw new Error(label + ' must be canonical ISO-8601 UTC');
  }
  return value;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function exactCandidateKey(row) {
  return [
    row?.content_id,
    row?.assignment_id,
    Number(row?.assignment_version),
    Number(row?.policy_version),
    row?.resolved_at,
  ].join('|');
}

function validateCandidate(row) {
  if (!row || typeof row !== 'object') {
    throw new Error('D1 deferral candidate is required');
  }
  if (row.assignment_status !== 'active') {
    throw new Error('D1 candidate assignment must be active');
  }
  if (row.lifecycle_state !== 'scheduled') {
    throw new Error('D1 candidate lifecycle must be scheduled');
  }
  if (row.publication_status !== 'scheduled') {
    throw new Error('D1 candidate publication state must be scheduled');
  }
  if (row.deferral_state != null) {
    throw new Error('D1 candidate must not already have deferral state');
  }
  canonicalIso(row.resolved_at, 'resolved_at');
  positiveInt(row.assignment_version, 'assignment version');
  positiveInt(row.assignment_generation, 'assignment generation');
  positiveInt(row.policy_version, 'policy version');
  positiveInt(row.content_revision, 'content revision');
  positiveInt(row.publication_generation, 'publication generation');
  return row;
}

export function planPrecutoverStaleNormalization({
  queue,
  ledger,
  candidates,
  now = new Date(),
  graceMinutes = 20,
  policyVersion = 2,
} = {}) {
  if (!Array.isArray(queue)) throw new Error('queue must be an array');
  if (!ledger || typeof ledger !== 'object' || Array.isArray(ledger)) {
    throw new Error('ledger must be an object');
  }
  if (!Array.isArray(candidates)) throw new Error('candidates must be an array');

  const candidateRows = candidates.map(validateCandidate);
  const d1Missed = candidateRows.filter((row) =>
    classifyMissedAssignment(row, { now, graceMinutes }).action === 'defer'
  );

  const nextLedger = clone(ledger);
  const staticResult = deferMissedStaticAssignments(queue, nextLedger, {
    now,
    graceMinutes,
    policyVersion,
    reason: MISSED_REASON,
  });

  const byContent = new Map(candidateRows.map((row) => [row.content_id, row]));
  const planned = staticResult.deferred.map((record) => {
    const row = byContent.get(record.postId);
    if (!row) {
      throw new Error(
        'static missed assignment has no exact D1 scheduled candidate: ' +
        record.postId,
      );
    }

    if (
      row.assignment_id !== record.assignmentId ||
      Number(row.assignment_version) !== Number(record.assignmentVersion) ||
      Number(row.policy_version) !== Number(record.policyVersion) ||
      row.resolved_at !== record.resolvedAt
    ) {
      throw new Error(
        'static/D1 missed assignment identity mismatch for ' + record.postId,
      );
    }

    return Object.freeze({
      contentId: row.content_id,
      contentRevision: Number(row.content_revision),
      assignmentId: row.assignment_id,
      assignmentVersion: Number(row.assignment_version),
      assignmentGeneration: Number(row.assignment_generation),
      policyVersion: Number(row.policy_version),
      contentDigest: row.content_digest,
      targetAccount: row.target_account,
      resolvedAt: row.resolved_at,
      scheduledDate: row.scheduled_date,
      scheduledTime: row.scheduled_time,
      timezone: row.timezone,
      slotLabel: row.slot_label ?? null,
      publicationGeneration: Number(row.publication_generation),
      deferredAt: record.at,
      reason: record.reason,
    });
  });

  const staticIds = planned.map((item) => item.contentId).sort();
  const d1Ids = d1Missed.map((row) => row.content_id).sort();
  if (JSON.stringify(staticIds) !== JSON.stringify(d1Ids)) {
    throw new Error(
      'static/D1 missed assignment set mismatch: ' +
      JSON.stringify({ staticIds, d1Ids }),
    );
  }

  return Object.freeze({
    format: 1,
    observedAt: now.toISOString(),
    graceMinutes,
    sourceLedger: Object.freeze(clone(ledger)),
    nextLedger: Object.freeze(clone(nextLedger)),
    sourceLedgerRaw: JSON.stringify(ledger),
    nextLedgerRaw: JSON.stringify(nextLedger),
    items: Object.freeze(planned),
  });
}

function snapshotExactExists(item) {
  return [
    'EXISTS (SELECT 1 FROM queue_assignments a ',
    'WHERE a.assignment_id=' + sqlText(item.assignmentId) + ' ',
    'AND a.assignment_version=' + item.assignmentVersion + ' ',
    'AND a.content_id=' + sqlText(item.contentId) + ' ',
    'AND a.content_digest=' + sqlText(item.contentDigest) + ' ',
    'AND a.policy_version=' + item.policyVersion + ' ',
    'AND a.resolved_at=' + sqlText(item.resolvedAt) + ' ',
    "AND a.status='active' AND a.lifecycle_state='scheduled' ",
    'AND a.generation=' + item.assignmentGeneration + ') ',
    'AND EXISTS (SELECT 1 FROM publication_state p ',
    'WHERE p.post_id=' + sqlText(item.contentId) + ' ',
    "AND p.status='scheduled' AND p.attempt_id IS NULL ",
    'AND p.generation=' + item.publicationGeneration + ') ',
    'AND NOT EXISTS (SELECT 1 FROM queue_deferrals d ',
    'WHERE d.content_id=' + sqlText(item.contentId) + ')',
  ].join('');
}

function itemSql(item) {
  const detail = JSON.stringify({
    contentId: item.contentId,
    contentRevision: item.contentRevision,
    assignmentId: item.assignmentId,
    assignmentVersion: item.assignmentVersion,
    assignmentGeneration: item.assignmentGeneration,
    policyVersion: item.policyVersion,
    contentDigest: item.contentDigest,
    targetAccount: item.targetAccount,
    priorResolvedAt: item.resolvedAt,
    priorScheduledDate: item.scheduledDate,
    priorScheduledTime: item.scheduledTime,
    priorTimezone: item.timezone,
    priorSlotLabel: item.slotLabel,
    reason: item.reason,
    deferredAt: item.deferredAt,
    preCutoverNormalization: true,
  });

  return [
    'UPDATE queue_assignments SET ',
    "lifecycle_state='deferred',",
    'updated_at=' + sqlText(item.deferredAt) + ',',
    'generation=generation+1 ',
    'WHERE assignment_id=' + sqlText(item.assignmentId) + ' ',
    'AND assignment_version=' + item.assignmentVersion + ' ',
    'AND content_id=' + sqlText(item.contentId) + ' ',
    'AND content_digest=' + sqlText(item.contentDigest) + ' ',
    'AND policy_version=' + item.policyVersion + ' ',
    'AND resolved_at=' + sqlText(item.resolvedAt) + ' ',
    "AND status='active' AND lifecycle_state='scheduled' ",
    'AND generation=' + item.assignmentGeneration + ';',

    'INSERT INTO queue_deferrals (',
    'content_id,content_revision,assignment_id,assignment_version,assignment_generation,',
    'policy_version,content_digest,target_account,prior_resolved_at,prior_scheduled_date,',
    'prior_scheduled_time,prior_timezone,prior_slot_label,reason,deferred_at,state,generation,',
    'replacement_assignment_version',
    ') SELECT ',
    [
      sqlText(item.contentId),
      item.contentRevision,
      sqlText(item.assignmentId),
      item.assignmentVersion,
      item.assignmentGeneration,
      item.policyVersion,
      sqlText(item.contentDigest),
      sqlText(item.targetAccount),
      sqlText(item.resolvedAt),
      sqlText(item.scheduledDate),
      sqlText(item.scheduledTime),
      sqlText(item.timezone),
      sqlText(item.slotLabel),
      sqlText(item.reason),
      sqlText(item.deferredAt),
      sqlText('pending_replacement'),
      '1',
      'NULL',
    ].join(','),
    ' WHERE EXISTS (SELECT 1 FROM queue_assignments a ',
    'WHERE a.assignment_id=' + sqlText(item.assignmentId) + ' ',
    'AND a.assignment_version=' + item.assignmentVersion + ' ',
    "AND a.lifecycle_state='deferred' ",
    'AND a.generation=' + (item.assignmentGeneration + 1) + ') ',
    'AND NOT EXISTS (SELECT 1 FROM queue_deferrals d ',
    'WHERE d.content_id=' + sqlText(item.contentId) + ');',

    'INSERT INTO queue_assignment_events ',
    '(assignment_id,assignment_version,event_type,event_at,detail) SELECT ',
    [
      sqlText(item.assignmentId),
      item.assignmentVersion,
      sqlText('deferred'),
      sqlText(item.deferredAt),
      sqlText(detail),
    ].join(','),
    ' WHERE EXISTS (SELECT 1 FROM queue_deferrals d ',
    'WHERE d.content_id=' + sqlText(item.contentId) + ' ',
    'AND d.assignment_id=' + sqlText(item.assignmentId) + ' ',
    'AND d.assignment_version=' + item.assignmentVersion + ' ',
    'AND d.deferred_at=' + sqlText(item.deferredAt) + ') ',
    'AND NOT EXISTS (SELECT 1 FROM queue_assignment_events e ',
    'WHERE e.assignment_id=' + sqlText(item.assignmentId) + ' ',
    'AND e.assignment_version=' + item.assignmentVersion + ' ',
    "AND e.event_type='deferred' AND e.detail=" + sqlText(detail) + ');',

    'INSERT INTO queue_deferral_events ',
    '(content_id,assignment_id,assignment_version,event_type,event_at,detail) SELECT ',
    [
      sqlText(item.contentId),
      sqlText(item.assignmentId),
      item.assignmentVersion,
      sqlText('deferred'),
      sqlText(item.deferredAt),
      sqlText(detail),
    ].join(','),
    ' WHERE EXISTS (SELECT 1 FROM queue_deferrals d ',
    'WHERE d.content_id=' + sqlText(item.contentId) + ' ',
    'AND d.assignment_id=' + sqlText(item.assignmentId) + ' ',
    'AND d.assignment_version=' + item.assignmentVersion + ' ',
    'AND d.deferred_at=' + sqlText(item.deferredAt) + ') ',
    'AND NOT EXISTS (SELECT 1 FROM queue_deferral_events e ',
    'WHERE e.content_id=' + sqlText(item.contentId) + ' ',
    'AND e.assignment_id=' + sqlText(item.assignmentId) + ' ',
    'AND e.assignment_version=' + item.assignmentVersion + ' ',
    "AND e.event_type='deferred' AND e.detail=" + sqlText(detail) + ');',
  ].join('\n');
}

export function renderPrecutoverStaleNormalizationSql(plan) {
  if (!plan || !Array.isArray(plan.items)) {
    throw new Error('normalization plan is required');
  }
  if (plan.items.length === 0) return '';

  const allExact = plan.items.map(snapshotExactExists).join(' AND ');
  return [
    'BEGIN IMMEDIATE;',
    'UPDATE runtime_metadata SET ',
    'value=' + sqlText(plan.nextLedgerRaw) + ',',
    'updated_at=' + sqlText(plan.observedAt) + ' ',
    "WHERE key='state.snapshot_json' ",
    'AND value=' + sqlText(plan.sourceLedgerRaw) + ' ',
    'AND ' + allExact + ';',
    ...plan.items.map(itemSql),
    'COMMIT;',
  ].join('\n');
}

export function verifyPrecutoverNormalizationReadback(plan, {
  snapshotRaw,
  assignments = [],
  deferrals = [],
} = {}) {
  if (!plan) return false;
  if (snapshotRaw !== plan.nextLedgerRaw) return false;

  const assignmentById = new Map(
    assignments.map((row) => [exactCandidateKey(row), row]),
  );
  const deferralByContent = new Map(
    deferrals.map((row) => [row.content_id, row]),
  );

  return plan.items.every((item) => {
    const key = [
      item.contentId,
      item.assignmentId,
      item.assignmentVersion,
      item.policyVersion,
      item.resolvedAt,
    ].join('|');
    const assignment = assignmentById.get(key);
    const deferral = deferralByContent.get(item.contentId);

    return Boolean(
      assignment &&
      assignment.lifecycle_state === 'deferred' &&
      Number(assignment.assignment_generation) === item.assignmentGeneration + 1 &&
      deferral &&
      deferral.assignment_id === item.assignmentId &&
      Number(deferral.assignment_version) === item.assignmentVersion &&
      deferral.reason === item.reason &&
      deferral.deferred_at === item.deferredAt &&
      deferral.state === 'pending_replacement'
    );
  });
}
