import { createHash } from 'node:crypto';

import { analyzeRuntime } from './runtime-health.mjs';
import { normalizeState } from './state-store.mjs';
import { deferMissedStaticAssignments } from './deferred-lifecycle.mjs';
import { classifyMissedAssignment } from './d1-deferred-lifecycle.mjs';
import { evaluateEligibility } from '../cloudflare/src/eligibility.mjs';

const INFLIGHT_BLOCK_REASON = Object.freeze({
  prepared: 'inflight_prepared',
  publishing: 'inflight_publishing',
  needs_reconciliation: 'inflight_needs_reconciliation',
});

const PARITY_FIELDS = Object.freeze([
  'assignment_id',
  'assignment_version',
  'content_id',
  'content_revision',
  'content_digest',
  'target_account',
  'policy_version',
  'resolved_at',
  'scheduled_date',
  'scheduled_time',
  'timezone',
  'slot_label',
]);

function sha256(value) {
  return createHash('sha256')
    .update(Buffer.from(typeof value === 'string' ? value : JSON.stringify(value), 'utf8'))
    .digest('hex');
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
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

function canonicalInstant(value, label) {
  const text = requiredString(value, label);
  const ms = Date.parse(text);
  if (!Number.isFinite(ms) || new Date(ms).toISOString() !== text) {
    throw new Error(label + ' must be canonical ISO-8601 UTC');
  }
  return text;
}

function nullableString(value) {
  return value == null ? null : String(value);
}

function canonicalRow(row) {
  const normalized = {
    assignment_id: requiredString(row?.assignment_id, 'assignment_id'),
    assignment_version: positiveInteger(row?.assignment_version, 'assignment_version'),
    content_id: requiredString(row?.content_id, 'content_id'),
    content_revision: positiveInteger(row?.content_revision, 'content_revision'),
    content_digest: requiredString(row?.content_digest, 'content_digest'),
    target_account: requiredString(row?.target_account, 'target_account'),
    policy_version: positiveInteger(row?.policy_version, 'policy_version'),
    resolved_at: canonicalInstant(row?.resolved_at, 'resolved_at'),
    scheduled_date: requiredString(row?.scheduled_date, 'scheduled_date'),
    scheduled_time: requiredString(row?.scheduled_time, 'scheduled_time'),
    timezone: requiredString(row?.timezone, 'timezone'),
    slot_label: nullableString(row?.slot_label),
    lifecycle_state: row?.lifecycle_state == null
      ? 'scheduled'
      : requiredString(row.lifecycle_state, 'lifecycle_state'),
  };

  if (!/^[a-f0-9]{64}$/.test(normalized.content_digest)) {
    throw new Error('content_digest must be lowercase sha256 hex');
  }
  if (!['scheduled', 'deferred'].includes(normalized.lifecycle_state)) {
    throw new Error('lifecycle_state is invalid');
  }

  return Object.freeze(normalized);
}

function rowOrder(a, b) {
  return (
    Date.parse(a.resolved_at) - Date.parse(b.resolved_at) ||
    a.content_id.localeCompare(b.content_id) ||
    a.assignment_version - b.assignment_version
  );
}

function assertCanonicalOrder(rows, label) {
  const sorted = [...rows].sort(rowOrder);
  if (JSON.stringify(rows) !== JSON.stringify(sorted)) {
    throw new Error(label + ' rows are not in canonical resolved-at order');
  }
}

export function staticParityRows(shadowModel) {
  if (
    !shadowModel ||
    !Array.isArray(shadowModel.assignments) ||
    !Array.isArray(shadowModel.revisions)
  ) {
    throw new Error('static shadow model is required');
  }

  const revisions = new Map(
    shadowModel.revisions.map((row) => [
      row.content_id + '\u0000' + row.revision,
      row,
    ]),
  );

  const rows = shadowModel.assignments.map((assignment) => {
    const revision = revisions.get(
      assignment.content_id + '\u0000' + assignment.content_revision,
    );
    if (!revision) {
      throw new Error('static assignment revision is missing: ' + assignment.content_id);
    }
    if (revision.content_digest !== assignment.content_digest) {
      throw new Error('static assignment/revision digest drift: ' + assignment.content_id);
    }

    return canonicalRow({
      ...assignment,
      lifecycle_state: 'scheduled',
    });
  });

  assertCanonicalOrder(rows, 'static');
  return Object.freeze(rows);
}

export function dynamicParityRows(rows) {
  if (!Array.isArray(rows)) throw new Error('dynamic rows are required');

  const normalized = rows.map((row) => {
    if (row?.assignment_status !== 'active') {
      throw new Error('dynamic parity query returned a non-active assignment');
    }
    if (row?.content_status !== 'active') {
      throw new Error('dynamic parity query returned non-active content');
    }
    if (Number(row?.current_revision) !== Number(row?.content_revision)) {
      throw new Error('dynamic active assignment is not bound to current content revision');
    }
    if (row?.revision_digest !== row?.content_digest) {
      throw new Error('dynamic assignment/revision digest drift: ' + row?.content_id);
    }
    return canonicalRow(row);
  });

  assertCanonicalOrder(normalized, 'dynamic');
  return Object.freeze(normalized);
}

export function assertExactStaticDynamicRows(staticRows, dynamicRows) {
  if (staticRows.length !== dynamicRows.length) {
    throw new Error(
      'static/dynamic assignment count mismatch: ' +
      staticRows.length + ' != ' + dynamicRows.length,
    );
  }

  const mismatches = [];
  for (let i = 0; i < staticRows.length; i += 1) {
    const expected = staticRows[i];
    const actual = dynamicRows[i];

    for (const field of PARITY_FIELDS) {
      if (expected[field] !== actual[field]) {
        mismatches.push({
          index: i,
          contentId: expected.content_id,
          field,
          static: expected[field],
          dynamic: actual[field],
        });
      }
    }
  }

  if (mismatches.length > 0) {
    const sample = mismatches.slice(0, 8);
    throw new Error(
      'static/dynamic exact row parity failed: ' + JSON.stringify(sample),
    );
  }

  const staticHash = sha256(staticRows.map((row) =>
    Object.fromEntries(PARITY_FIELDS.map((field) => [field, row[field]])),
  ));
  const dynamicHash = sha256(dynamicRows.map((row) =>
    Object.fromEntries(PARITY_FIELDS.map((field) => [field, row[field]])),
  ));

  if (staticHash !== dynamicHash) {
    throw new Error('static/dynamic canonical row hashes differ');
  }

  return Object.freeze({
    count: staticRows.length,
    canonicalRowsHash: staticHash,
  });
}

// Guarded intake legitimately adds assignments after the static baseline was
// accepted. Each such assignment must be reconstructable from durable intake
// evidence: the intake item (digest and exact slot), the guarded mutation item
// (resulting revision and version, applied readback), a COMPLETE applied
// operation and a complete intake operation. The reconstructed rows join the
// static baseline as the expected set, so exact-row and decision parity still
// cover every active assignment.
export const GUARDED_INTAKE_EVIDENCE_SQL = [
  'SELECT',
  '  mi.item_key,',
  '  mi.resulting_content_revision,',
  '  mi.resulting_assignment_version,',
  '  mi.readback_status,',
  '  mi.readback_digest,',
  '  mo.operation_id,',
  '  mo.operation_kind,',
  '  mo.state AS operation_state,',
  '  mo.effect_state,',
  '  io.operation_id AS intake_operation_id,',
  '  io.status AS intake_status,',
  '  io.target_account AS intake_target_account,',
  '  io.policy_version AS intake_policy_version,',
  '  ii.content_digest AS intake_content_digest,',
  '  ii.resolved_at AS intake_resolved_at,',
  '  ii.scheduled_date AS intake_scheduled_date,',
  '  ii.scheduled_time AS intake_scheduled_time,',
  '  ii.timezone AS intake_timezone,',
  '  ii.slot_label AS intake_slot_label',
  'FROM mutation_operation_items mi',
  'JOIN mutation_operations mo ON mo.operation_id = mi.operation_id',
  'LEFT JOIN queue_intake_operations io',
  '  ON io.resulting_runtime_generation = mo.resulting_runtime_generation',
  ' AND io.resulting_runtime_revision_digest = mo.resulting_runtime_revision_digest',
  'LEFT JOIN queue_intake_items ii',
  '  ON ii.operation_id = io.operation_id AND ii.content_id = mi.item_key',
  "WHERE mo.operation_kind = 'intake'",
  'ORDER BY mi.item_key;',
].join('\n');

// Only an operation proven to have changed nothing can be set aside. Anything
// dispatched, ambiguous or applied must trace exactly, so unknown never passes.
const PROVEN_NOT_APPLIED = new Set(['none', 'not_applied']);

function guardedItemProblem(item) {
  if (item.operation_state !== 'COMPLETE' || item.effect_state !== 'applied') {
    return 'operation ' + item.operation_id + ' is not COMPLETE/applied';
  }
  if (item.readback_status !== 'applied' || !/^[a-f0-9]{64}$/.test(String(item.readback_digest ?? ''))) {
    return 'item readback is not applied with a digest';
  }
  if (item.intake_status !== 'complete' || item.intake_content_digest == null) {
    return 'has no complete intake operation and item';
  }
  return null;
}

export function traceGuardedIntakeRows({ staticRows, dynamicRows, guardedItems }) {
  if (!Array.isArray(staticRows) || staticRows.length === 0) throw new Error('static rows are required');
  if (!Array.isArray(dynamicRows)) throw new Error('dynamic rows are required');
  if (!Array.isArray(guardedItems)) throw new Error('guarded intake evidence is required');

  const staticIds = new Set(staticRows.map((row) => row.content_id));
  const items = new Map();
  let notApplied = 0;
  for (const item of guardedItems) {
    const key = requiredString(item?.item_key, 'guarded intake item_key');
    if (PROVEN_NOT_APPLIED.has(item.effect_state)) {
      notApplied += 1;
      continue;
    }
    if (items.has(key)) throw new Error('duplicate guarded intake item: ' + key);
    if (staticIds.has(key)) throw new Error('guarded intake item shadows a static assignment: ' + key);
    items.set(key, item);
  }

  const dynamicIds = new Set(dynamicRows.map((row) => row.content_id));
  const missing = staticRows.filter((row) => !dynamicIds.has(row.content_id)).map((row) => row.content_id);
  if (missing.length > 0) {
    throw new Error('static assignments missing from the dynamic runtime: ' + missing.slice(0, 8).join(','));
  }

  // Every guarded intake item that may have changed the runtime must be
  // COMPLETE/applied and still an active assignment.
  for (const [key, item] of items) {
    const problem = guardedItemProblem(item);
    if (problem) throw new Error('guarded intake item ' + key + ' ' + problem);
    if (!dynamicIds.has(key)) {
      throw new Error('applied guarded intake item is not an active assignment: ' + key);
    }
  }

  const traced = [];
  for (const row of dynamicRows) {
    if (staticIds.has(row.content_id)) continue;
    const item = items.get(row.content_id);
    if (!item) {
      throw new Error('active assignment outside the static baseline has no guarded intake evidence: ' + row.content_id);
    }
    traced.push(canonicalRow({
      assignment_id: item.item_key,
      assignment_version: item.resulting_assignment_version,
      content_id: item.item_key,
      content_revision: item.resulting_content_revision,
      content_digest: item.intake_content_digest,
      target_account: item.intake_target_account,
      policy_version: item.intake_policy_version,
      resolved_at: item.intake_resolved_at,
      scheduled_date: item.intake_scheduled_date,
      scheduled_time: item.intake_scheduled_time,
      timezone: item.intake_timezone,
      slot_label: item.intake_slot_label,
      // Like static rows, expected rows carry the lifecycle intake created.
      lifecycle_state: 'scheduled',
    }));
  }

  const expectedRows = [...staticRows, ...traced].sort(rowOrder);
  return Object.freeze({
    expectedRows: Object.freeze(expectedRows),
    staticCount: staticRows.length,
    guardedIntakeCount: traced.length,
    guardedNotAppliedCount: notApplied,
    guardedOperations: Object.freeze([...new Set(traced.map((row) => items.get(row.content_id).operation_id))].sort()),
  });
}

function queueFromRows(rows) {
  return rows.map((row) => ({
    id: row.content_id,
    scheduledAt: row.resolved_at,
    scheduledDate: row.scheduled_date,
    scheduledTime: row.scheduled_time,
    timezone: row.timezone,
    slot: row.slot_label,
  }));
}

function publicationMap(publicationRows) {
  if (!Array.isArray(publicationRows)) {
    throw new Error('publication_state rows are required');
  }
  const map = new Map();
  for (const row of publicationRows) {
    const id = requiredString(row?.post_id, 'publication_state post_id');
    if (map.has(id)) throw new Error('duplicate publication_state post_id: ' + id);
    map.set(id, row);
  }
  return map;
}

function deferralMap(deferralRows) {
  if (!Array.isArray(deferralRows)) throw new Error('deferral rows are required');
  const map = new Map();
  for (const row of deferralRows) {
    const id = requiredString(row?.content_id, 'deferral content_id');
    if (map.has(id)) throw new Error('duplicate queue_deferrals content_id: ' + id);
    map.set(id, row);
  }
  return map;
}

export function assertLedgerStateParity({
  ledger,
  dynamicRows,
  publicationRows,
  deferralRows,
}) {
  const state = normalizeState(clone(ledger));
  const publications = publicationMap(publicationRows);
  const deferrals = deferralMap(deferralRows);
  const assignments = new Map(dynamicRows.map((row) => [row.content_id, row]));

  if (publications.size !== dynamicRows.length) {
    throw new Error(
      'publication_state coverage mismatch: ' +
      publications.size + ' != ' + dynamicRows.length,
    );
  }

  let observedInflight = null;

  for (const row of dynamicRows) {
    const publication = publications.get(row.content_id);
    if (!publication) {
      throw new Error('publication_state missing ' + row.content_id);
    }

    const status = publication.status;
    if (status === 'posted') {
      const record = state.posted?.[row.content_id];
      if (!record || record.tweetId !== publication.tweet_id) {
        throw new Error('posted ledger/publication_state mismatch: ' + row.content_id);
      }
    } else if (status === 'skipped') {
      const record = state.skipped?.[row.content_id];
      if (
        !record ||
        record.at !== publication.skipped_at ||
        record.reason !== publication.skip_reason
      ) {
        throw new Error('skipped ledger/publication_state mismatch: ' + row.content_id);
      }
    } else if (['prepared', 'publishing', 'needs_reconciliation'].includes(status)) {
      if (observedInflight) {
        throw new Error('multiple publication_state inflight rows');
      }
      observedInflight = publication;
      if (
        !state.inflight ||
        state.inflight.postId !== row.content_id ||
        state.inflight.status !== status ||
        state.inflight.attemptId !== publication.attempt_id
      ) {
        throw new Error('inflight ledger/publication_state mismatch: ' + row.content_id);
      }
    } else if (status === 'scheduled') {
      if (state.posted?.[row.content_id] || state.skipped?.[row.content_id]) {
        throw new Error('scheduled publication_state is resolved in ledger: ' + row.content_id);
      }
      if (state.inflight?.postId === row.content_id) {
        throw new Error('scheduled publication_state is inflight in ledger: ' + row.content_id);
      }
    } else {
      throw new Error('unsupported publication_state status: ' + status);
    }
  }

  if (Boolean(state.inflight) !== Boolean(observedInflight)) {
    throw new Error('ledger/publication_state inflight coverage mismatch');
  }

  for (const [postId, record] of Object.entries(state.posted ?? {})) {
    const publication = publications.get(postId);
    if (!publication || publication.status !== 'posted' || publication.tweet_id !== record.tweetId) {
      throw new Error('ledger posted record lacks matching publication_state: ' + postId);
    }
  }

  for (const [postId, record] of Object.entries(state.skipped ?? {})) {
    const publication = publications.get(postId);
    if (
      !publication ||
      publication.status !== 'skipped' ||
      publication.skipped_at !== record.at ||
      publication.skip_reason !== record.reason
    ) {
      throw new Error('ledger skipped record lacks matching publication_state: ' + postId);
    }
  }

  const pendingDeferrals = [...deferrals.values()]
    .filter((row) => row.state === 'pending_replacement');
  const ledgerDeferred = state.deferred ?? {};

  if (pendingDeferrals.length !== Object.keys(ledgerDeferred).length) {
    throw new Error(
      'ledger/D1 pending deferral count mismatch: ' +
      Object.keys(ledgerDeferred).length + ' != ' + pendingDeferrals.length,
    );
  }

  for (const row of pendingDeferrals) {
    const record = ledgerDeferred[row.content_id];
    const assignment = assignments.get(row.content_id);
    if (!record || !assignment) {
      throw new Error('pending deferral lacks ledger/assignment coverage: ' + row.content_id);
    }
    if (
      assignment.lifecycle_state !== 'deferred' ||
      record.assignmentId !== row.assignment_id ||
      Number(record.assignmentVersion) !== Number(row.assignment_version) ||
      Number(record.policyVersion) !== Number(row.policy_version) ||
      record.resolvedAt !== row.prior_resolved_at ||
      record.reason !== row.reason
    ) {
      throw new Error('pending deferral identity mismatch: ' + row.content_id);
    }
  }

  return Object.freeze({
    publicationStateCount: publications.size,
    postedCount: Object.keys(state.posted ?? {}).length,
    skippedCount: Object.keys(state.skipped ?? {}).length,
    deferredCount: Object.keys(state.deferred ?? {}).length,
    inflight: state.inflight
      ? { postId: state.inflight.postId, status: state.inflight.status }
      : null,
  });
}

function emptyLedger() {
  return {
    version: 1,
    posted: {},
    skipped: {},
    deferred: {},
    spend: 0,
    inflight: null,
  };
}

export function buildObservationInstants(
  rows,
  {
    graceMinutes = 20,
  } = {},
) {
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error('parity rows are required');
  }
  if (!Number.isFinite(graceMinutes) || graceMinutes < 0) {
    throw new Error('graceMinutes must be non-negative');
  }

  const graceMs = graceMinutes * 60_000;
  const instants = [];
  const firstMs = Date.parse(rows[0].resolved_at);
  const lastMs = Date.parse(rows.at(-1).resolved_at);

  instants.push({
    label: 'window-before-first',
    at: new Date(firstMs - graceMs - 1).toISOString(),
  });

  for (const row of rows) {
    const ms = Date.parse(row.resolved_at);
    instants.push(
      { label: row.content_id + ':due-minus-1ms', at: new Date(ms - 1).toISOString() },
      { label: row.content_id + ':due-exact', at: new Date(ms).toISOString() },
      { label: row.content_id + ':grace-exact', at: new Date(ms + graceMs).toISOString() },
      { label: row.content_id + ':grace-plus-1ms', at: new Date(ms + graceMs + 1).toISOString() },
    );
  }

  instants.push({
    label: 'window-after-last',
    at: new Date(lastMs + graceMs + 60_000).toISOString(),
  });

  const seen = new Set();
  for (const entry of instants) {
    if (seen.has(entry.at)) {
      throw new Error('observation instants unexpectedly overlap: ' + entry.at);
    }
    seen.add(entry.at);
  }

  return Object.freeze(instants);
}

function staticProjection(rows, ledger, now, graceMinutes) {
  const queue = queueFromRows(rows);
  const state = normalizeState(clone(ledger));
  const policyVersions = new Set(rows.map((row) => row.policy_version));
  if (policyVersions.size !== 1) {
    throw new Error('static parity requires one current policy version');
  }

  const deferral = deferMissedStaticAssignments(queue, state, {
    now,
    graceMinutes,
    policyVersion: rows[0].policy_version,
  });
  const health = analyzeRuntime(queue, state, { now, graceMinutes });
  const blockReason = state.inflight
    ? INFLIGHT_BLOCK_REASON[state.inflight.status] ?? 'inflight_invalid'
    : null;
  const selected = blockReason
    ? []
    : health.due.slice(0, 1).map((post) => post.id);

  return {
    health: {
      ok: health.ok,
      postedCount: health.postedCount,
      skippedCount: health.skippedCount,
      deferredCount: health.deferredCount ?? 0,
      unresolvedCount: health.unresolvedCount,
      due: health.due.map((post) => post.id),
      overdue: health.overdue.map((post) => post.id),
      next: health.next?.id ?? null,
      inflight: health.inflight
        ? { postId: health.inflight.postId, status: health.inflight.status }
        : null,
      graceMinutes: health.graceMinutes,
    },
    selection: {
      blocked: blockReason !== null,
      blockReason,
      selected,
    },
    safeToPublish: health.ok && blockReason === null && selected.length === 1,
    failures: blockReason ? [blockReason] : [],
    projectedDeferrals: deferral.deferred.map((row) => row.postId),
  };
}

function dynamicProjectedLedger(
  rows,
  ledger,
  publicationRows,
  deferralRows,
  now,
  graceMinutes,
) {
  const state = normalizeState(clone(ledger));
  state.deferred ??= {};

  const publications = publicationMap(publicationRows);
  const deferrals = deferralMap(deferralRows);
  const projected = [];

  for (const row of rows) {
    if (
      state.posted?.[row.content_id] ||
      state.skipped?.[row.content_id] ||
      state.deferred?.[row.content_id]
    ) {
      continue;
    }

    const publication = publications.get(row.content_id);
    if (!publication) {
      throw new Error('dynamic projection missing publication_state: ' + row.content_id);
    }

    const deferral = deferrals.get(row.content_id) ?? null;
    const classification = classifyMissedAssignment(
      {
        ...row,
        publication_status: publication.status,
        deferral_state: deferral?.state ?? null,
      },
      { now, graceMinutes },
    );

    if (classification.action === 'defer') {
      state.deferred[row.content_id] = {
        at: now.toISOString(),
        reason: classification.reason,
        assignmentId: row.assignment_id,
        assignmentVersion: row.assignment_version,
        policyVersion: row.policy_version,
        resolvedAt: row.resolved_at,
        scheduledDate: row.scheduled_date,
        scheduledTime: row.scheduled_time,
        timezone: row.timezone,
        slot: row.slot_label,
      };
      projected.push(row.content_id);
    }
  }

  return { state, projected };
}

function dynamicProjection(
  rows,
  ledger,
  publicationRows,
  deferralRows,
  now,
  graceMinutes,
) {
  const queue = queueFromRows(rows);
  const { state, projected } = dynamicProjectedLedger(
    rows,
    ledger,
    publicationRows,
    deferralRows,
    now,
    graceMinutes,
  );
  const result = evaluateEligibility(queue, state, {
    now,
    graceMinutes,
    maxPublications: 1,
  });

  return {
    ...result,
    health: {
      ...result.health,
      deferredCount: result.health.deferredCount ?? 0,
      inflight: result.health.inflight
        ? {
            postId: result.health.inflight.postId,
            status: result.health.inflight.status,
          }
        : null,
    },
    projectedDeferrals: projected,
  };
}

function projectionComparable(value) {
  return {
    health: value.health,
    selection: value.selection,
    safeToPublish: value.safeToPublish,
    failures: value.failures,
    projectedDeferrals: value.projectedDeferrals,
  };
}

export function compareProjectionAtInstant({
  staticRows,
  dynamicRows,
  ledger,
  publicationRows,
  deferralRows,
  at,
  graceMinutes = 20,
}) {
  const now = new Date(canonicalInstant(at, 'observation instant'));
  const left = staticProjection(staticRows, ledger, now, graceMinutes);
  const right = dynamicProjection(
    dynamicRows,
    ledger,
    publicationRows,
    deferralRows,
    now,
    graceMinutes,
  );

  const staticComparable = projectionComparable(left);
  const dynamicComparable = projectionComparable(right);

  if (JSON.stringify(staticComparable) !== JSON.stringify(dynamicComparable)) {
    throw new Error(
      'static/dynamic projection mismatch at ' + at + ': ' +
      JSON.stringify({
        static: staticComparable,
        dynamic: dynamicComparable,
      }),
    );
  }

  return Object.freeze({
    at,
    next: left.health.next,
    due: Object.freeze([...left.health.due]),
    overdue: Object.freeze([...left.health.overdue]),
    selected: Object.freeze([...left.selection.selected]),
    safeToPublish: left.safeToPublish,
    projectedDeferrals: Object.freeze([...left.projectedDeferrals]),
  });
}

export function proveBoundaryObservationParity({
  staticRows,
  dynamicRows,
  publicationRows,
  deferralRows,
  graceMinutes = 20,
}) {
  const exact = assertExactStaticDynamicRows(staticRows, dynamicRows);
  const ledger = emptyLedger();
  const syntheticPublicationRows = dynamicRows.map((row) => ({
    post_id: row.content_id,
    status: 'scheduled',
    tweet_id: null,
    attempt_id: null,
    skipped_at: null,
    skip_reason: null,
  }));
  const instants = buildObservationInstants(staticRows, { graceMinutes });
  const observations = instants.map((entry) => ({
    label: entry.label,
    ...compareProjectionAtInstant({
      staticRows,
      dynamicRows,
      ledger,
      publicationRows: syntheticPublicationRows,
      deferralRows: [],
      at: entry.at,
      graceMinutes,
    }),
  }));

  return Object.freeze({
    assignmentCount: exact.count,
    canonicalRowsHash: exact.canonicalRowsHash,
    observationCount: observations.length,
    observationDigest: sha256(observations),
    firstObservation: observations[0],
    lastObservation: observations.at(-1),
  });
}

export function proveLiveParity({
  staticRows,
  dynamicRows,
  ledger,
  publicationRows,
  deferralRows,
  now = new Date(),
  graceMinutes = 20,
}) {
  const exact = assertExactStaticDynamicRows(staticRows, dynamicRows);
  const state = assertLedgerStateParity({
    ledger,
    dynamicRows,
    publicationRows,
    deferralRows,
  });

  const observation = compareProjectionAtInstant({
    staticRows,
    dynamicRows,
    ledger,
    publicationRows,
    deferralRows,
    at: now.toISOString(),
    graceMinutes,
  });

  return Object.freeze({
    assignmentCount: exact.count,
    canonicalRowsHash: exact.canonicalRowsHash,
    state,
    observation,
  });
}
