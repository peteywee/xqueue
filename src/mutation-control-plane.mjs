import { createHash } from 'node:crypto';

import { decide } from './autonomy/decision-model.mjs';
import { fault, observe, observePost } from './autonomy/fault-catalog.mjs';

export const MUTATION_RETRY_BUDGETS = Object.freeze({
  plan: 3,
  read: 3,
  operation: 2,
});

export const MUTATION_KINDS = Object.freeze([
  'intake',
  'revise',
  'rebind',
  'cancel',
  'reschedule',
  'foundation_probe',
]);

export const MUTATION_ERROR_MAP = Object.freeze({
  D1_READ_UNAVAILABLE: 'state_read_failure',
  HALT_GENERATION_CHANGED: 'halt_generation_changed',
  MUTATION_LANE_HALTED: 'halt_set',
  MUTATION_LANE_CONTENDED: 'lease_contended',
  MUTATION_LANE_LOST: 'lease_lost',
  STALE_RUNTIME: 'stale_runtime_generation',
  STALE_ASSIGNMENT: 'stale_assignment_version',
  DUPLICATE_SLOT: 'duplicate_assignment_slot',
  ALREADY_COMMITTED: 'completed_elsewhere',
  CHECKPOINT_STALE: 'checkpoint_stale',
  CHECKPOINT_CORRUPT: 'checkpoint_corrupt',
  D1_BATCH_APPLIED: 'internal_effect_applied',
  D1_BATCH_AMBIGUOUS: 'internal_effect_ambiguous',
  D1_BATCH_TRANSIENT_NOT_APPLIED: 'internal_effect_transient_not_applied',
  D1_BATCH_PERMANENT_NOT_APPLIED: 'internal_effect_permanent_not_applied',
});

const SHA_RE = /^[a-f0-9]{64}$/;

function requiredString(value, label) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(label + ' is required');
  }
  return value;
}

function positiveInteger(value, label) {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 1) throw new Error(label + ' must be a positive integer');
  return n;
}

function nonNegativeInteger(value, label) {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 0) throw new Error(label + ' must be a non-negative integer');
  return n;
}

function sha(value, label) {
  const v = String(value ?? '').toLowerCase();
  if (!SHA_RE.test(v)) throw new Error(label + ' must be sha256 hex');
  return v;
}

function canonical(value) {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('mutation material contains non-finite number');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (typeof value === 'object') {
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
      throw new Error('mutation material must contain plain objects only');
    }
    return '{' + Object.keys(value).sort().map((key) => {
      if (value[key] === undefined) throw new Error('mutation material contains undefined');
      return JSON.stringify(key) + ':' + canonical(value[key]);
    }).join(',') + '}';
  }
  throw new Error('mutation material is not JSON-safe');
}

function sha256Canonical(value) {
  return createHash('sha256').update(Buffer.from(canonical(value), 'utf8')).digest('hex');
}

function normalizeHaltState(state) {
  if (!state || typeof state !== 'object') throw new Error('mutation halt state is required');
  return Object.freeze({
    halted: Number(state.halted) === 1,
    generation: positiveInteger(state.generation, 'mutation halt generation'),
  });
}

function normalizeLaneState(state) {
  if (!state || typeof state !== 'object') throw new Error('mutation lane state is required');
  return Object.freeze({
    generation: positiveInteger(state.generation, 'mutation lane generation'),
    active_operation_id: state.active_operation_id == null ? null : requiredString(state.active_operation_id, 'active operation id'),
  });
}

function normalizeRuntimeState(state) {
  if (!state || typeof state !== 'object') throw new Error('runtime state is required');
  return Object.freeze({
    generation: positiveInteger(state.generation, 'runtime generation'),
    revision_digest: sha(state.revision_digest, 'runtime revision digest'),
  });
}

function normalizeItems(items) {
  if (!Array.isArray(items) || items.length === 0) throw new Error('mutation items are required');
  const seen = new Set();
  return Object.freeze(items.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error(`mutation item ${index + 1} must be an object`);
    const itemKey = requiredString(item.item_key, `mutation item ${index + 1} item_key`);
    if (seen.has(itemKey)) throw new Error('duplicate mutation item_key: ' + itemKey);
    seen.add(itemKey);
    return Object.freeze({
      item_key: itemKey,
      expected_content_revision: item.expected_content_revision == null ? null : positiveInteger(item.expected_content_revision, 'expected content revision'),
      expected_assignment_version: item.expected_assignment_version == null ? null : positiveInteger(item.expected_assignment_version, 'expected assignment version'),
      resulting_content_revision: item.resulting_content_revision == null ? null : positiveInteger(item.resulting_content_revision, 'resulting content revision'),
      resulting_assignment_version: item.resulting_assignment_version == null ? null : positiveInteger(item.resulting_assignment_version, 'resulting assignment version'),
    });
  }));
}

export function createMutationPlan({
  kind,
  mutation,
  items,
  haltState,
  laneState,
  runtimeState,
  retryBudgets = MUTATION_RETRY_BUDGETS,
  planContext = null,
}) {
  if (!MUTATION_KINDS.includes(kind)) throw new Error('unsupported mutation kind');
  const normalizedItems = normalizeItems(items);
  const halt = normalizeHaltState(haltState);
  const lane = normalizeLaneState(laneState);
  const runtime = normalizeRuntimeState(runtimeState);

  const operationMaterial = Object.freeze({
    format: 1,
    kind,
    mutation,
    items: normalizedItems,
  });
  const operationDigest = sha256Canonical(operationMaterial);
  const operationId = `mutation-${kind}-${operationDigest.slice(0, 24)}`;

  if (planContext !== null) canonical(planContext);

  const planMaterial = Object.freeze({
    operation_digest: operationDigest,
    plan_context: planContext,
    expected_halt_generation: halt.generation,
    expected_lane_generation: lane.generation,
    expected_runtime_generation: runtime.generation,
    expected_runtime_revision_digest: runtime.revision_digest,
    items: normalizedItems,
  });

  const budgets = Object.freeze({
    plan: nonNegativeInteger(retryBudgets.plan, 'plan retry budget'),
    read: nonNegativeInteger(retryBudgets.read, 'read retry budget'),
    operation: nonNegativeInteger(retryBudgets.operation, 'operation retry budget'),
  });

  return Object.freeze({
    operation_id: operationId,
    operation_kind: kind,
    operation_digest: operationDigest,
    plan_digest: sha256Canonical(planMaterial),
    plan_context: planContext,
    expected_halt_generation: halt.generation,
    expected_lane_generation: lane.generation,
    expected_runtime_generation: runtime.generation,
    expected_runtime_revision_digest: runtime.revision_digest,
    retry_budgets: budgets,
    items: normalizedItems,
  });
}

export function buildMutationPreflightObservation(plan, {
  haltState,
  laneState,
  runtimeState,
  authority = 'bound',
} = {}) {
  let o = observe('canonical_mutation');
  const patches = [];

  if (!haltState) patches.push(fault('halt_unreadable'));
  else {
    const halt = normalizeHaltState(haltState);
    if (halt.generation !== plan.expected_halt_generation) patches.push(fault('halt_generation_changed'));
    else if (halt.halted) patches.push(fault('halt_set'));
  }

  if (!laneState) patches.push(fault('state_read_failure'));
  else {
    const lane = normalizeLaneState(laneState);
    if (lane.active_operation_id && lane.active_operation_id !== plan.operation_id) {
      patches.push(fault('lease_contended'));
    } else if (lane.generation !== plan.expected_lane_generation) {
      patches.push(fault('lease_lost'));
    }
  }

  if (!runtimeState) patches.push(fault('state_read_failure'));
  else {
    const runtime = normalizeRuntimeState(runtimeState);
    if (
      runtime.generation !== plan.expected_runtime_generation ||
      runtime.revision_digest !== plan.expected_runtime_revision_digest
    ) patches.push(fault('stale_runtime_generation'));
  }

  if (!['bound', 'changed', 'not_bound', 'unknown'].includes(authority)) {
    patches.push(fault('unmapped_adapter_error'));
  } else if (authority !== 'bound') {
    patches.push({ authority });
  }

  o = Object.freeze(Object.assign({}, o, ...patches));
  return o;
}

export function decideMutationPreflight(plan, current) {
  return decide(buildMutationPreflightObservation(plan, current));
}

export function mutationObservationForError(errorClass, {
  postDispatch = false,
  readback = null,
  versionFence = null,
  retryBudget = null,
} = {}) {
  const mapped = MUTATION_ERROR_MAP[errorClass] ?? 'unmapped_adapter_error';
  const patches = [fault(mapped)];
  if (postDispatch && mapped !== 'internal_effect_applied' && mapped !== 'internal_effect_ambiguous' &&
      mapped !== 'internal_effect_transient_not_applied' && mapped !== 'internal_effect_permanent_not_applied') {
    patches.push({ effect: 'ambiguous', effectTarget: 'internal', readback: readback ?? 'unavailable' });
  } else if (readback !== null) {
    patches.push({ readback });
  }
  if (versionFence !== null) patches.push({ versionFence });
  if (retryBudget !== null) patches.push({ retryBudget });
  return Object.freeze(Object.assign({}, postDispatch ? observePost('canonical_mutation') : observe('canonical_mutation'), ...patches));
}

export function decideMutationError(errorClass, options = {}) {
  return decide(mutationObservationForError(errorClass, options));
}

export function consumeRetry(counts, target, budgets = MUTATION_RETRY_BUDGETS) {
  if (!['plan', 'read', 'operation'].includes(target)) throw new Error('unknown retry target');
  const current = {
    plan: nonNegativeInteger(counts?.plan ?? 0, 'plan retry count'),
    read: nonNegativeInteger(counts?.read ?? 0, 'read retry count'),
    operation: nonNegativeInteger(counts?.operation ?? 0, 'operation retry count'),
  };
  const max = {
    plan: nonNegativeInteger(budgets.plan, 'plan retry budget'),
    read: nonNegativeInteger(budgets.read, 'read retry budget'),
    operation: nonNegativeInteger(budgets.operation, 'operation retry budget'),
  };
  const next = { ...current, [target]: current[target] + 1 };
  return Object.freeze({
    counts: Object.freeze(next),
    retryBudget: next[target] <= max[target] ? 'available' : 'exhausted',
    target,
    limit: max[target],
  });
}

export function verifyMutationCompletion(plan, observed) {
  if (!observed || typeof observed !== 'object') return Object.freeze({ ok: false, reason: 'missing_readback' });
  if (observed.operation_id !== plan.operation_id) return Object.freeze({ ok: false, reason: 'operation_id_mismatch' });
  if (Number(observed.runtime_generation) !== plan.expected_runtime_generation + 1) {
    return Object.freeze({ ok: false, reason: 'runtime_generation_mismatch' });
  }
  if (!SHA_RE.test(String(observed.runtime_revision_digest ?? ''))) {
    return Object.freeze({ ok: false, reason: 'runtime_digest_invalid' });
  }
  if (!Array.isArray(observed.items) || observed.items.length !== plan.items.length) {
    return Object.freeze({ ok: false, reason: 'item_count_mismatch' });
  }
  for (const expected of plan.items) {
    const actual = observed.items.find((x) => x?.item_key === expected.item_key);
    if (!actual) return Object.freeze({ ok: false, reason: 'item_missing:' + expected.item_key });
    if (actual.readback_status !== 'applied') return Object.freeze({ ok: false, reason: 'item_not_applied:' + expected.item_key });
    if (expected.resulting_content_revision !== null && Number(actual.resulting_content_revision) !== expected.resulting_content_revision) {
      return Object.freeze({ ok: false, reason: 'content_revision_mismatch:' + expected.item_key });
    }
    if (expected.resulting_assignment_version !== null && Number(actual.resulting_assignment_version) !== expected.resulting_assignment_version) {
      return Object.freeze({ ok: false, reason: 'assignment_version_mismatch:' + expected.item_key });
    }
  }
  return Object.freeze({ ok: true, reason: null });
}

export function mutationControlEvidence({ retryBudgets = MUTATION_RETRY_BUDGETS } = {}) {
  return Object.freeze({
    format: 1,
    lane: 'mutation',
    externalPublicationCapability: false,
    retryBudgets: Object.freeze({ ...retryBudgets }),
    requiredCompletionReadback: Object.freeze([
      'operation_id',
      'runtime_generation',
      'runtime_revision_digest',
      'affected_content_assignment_versions',
    ]),
  });
}
