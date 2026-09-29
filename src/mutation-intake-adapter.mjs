import {
  createMutationPlan,
  decideMutationPreflight,
  verifyMutationCompletion,
} from './mutation-control-plane.mjs';

const SHA_RE = /^[a-f0-9]{64}$/;
const BOOKMARK_RE = /^[A-Za-z0-9_-]{8,}$/;

function requiredString(value, label) {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(label + ' is required');
  return value;
}

function positiveInteger(value, label) {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 1) throw new Error(label + ' must be a positive integer');
  return n;
}

function digest(value, label) {
  const v = String(value ?? '').toLowerCase();
  if (!SHA_RE.test(v)) throw new Error(label + ' must be sha256 hex');
  return v;
}

function canonicalInstant(value, label) {
  const text = requiredString(value, label);
  const ms = Date.parse(text);
  if (!Number.isFinite(ms) || new Date(ms).toISOString() !== text) {
    throw new Error(label + ' must be canonical ISO-8601 UTC with milliseconds');
  }
  return text;
}

export function createIntakeMutationControlPlan({
  intakePlan,
  haltState,
  laneState,
  runtimeState,
  retryBudgets,
}) {
  if (!intakePlan || typeof intakePlan !== 'object') throw new Error('intakePlan is required');
  const intakePlanDigest = digest(intakePlan.plan_digest, 'intake plan digest');
  const batchDigest = digest(intakePlan.batch_digest, 'intake batch digest');
  const targetAccount = requiredString(intakePlan.target_account, 'intake target account');
  const expectedRuntimeGeneration = positiveInteger(
    intakePlan.expected_runtime_generation,
    'intake expected runtime generation',
  );
  const expectedRuntimeDigest = digest(
    intakePlan.expected_runtime_revision_digest,
    'intake expected runtime revision digest',
  );
  if (!Array.isArray(intakePlan.items) || intakePlan.items.length === 0) {
    throw new Error('intake plan items are required');
  }

  if (
    Number(runtimeState?.generation) !== expectedRuntimeGeneration ||
    String(runtimeState?.revision_digest ?? '').toLowerCase() !== expectedRuntimeDigest
  ) {
    throw new Error('intake runtime snapshot does not match its plan fence');
  }

  const items = intakePlan.items.map((item, index) => ({
    item_key: requiredString(item?.content_id, `intake item ${index + 1} content_id`),
    expected_content_revision: null,
    expected_assignment_version: null,
    resulting_content_revision: 1,
    resulting_assignment_version: 1,
  }));

  const planContext = Object.freeze({
    intake_plan_digest: intakePlanDigest,
    intake_operation_id: requiredString(intakePlan.operation_id, 'intake operation id'),
    expected_frontier_generation: positiveInteger(
      intakePlan.expected_frontier_generation,
      'intake expected frontier generation',
    ),
    expected_frontier_resolved_at: requiredString(
      intakePlan.expected_frontier_resolved_at,
      'intake expected frontier resolved_at',
    ),
    proposed_frontier_resolved_at: requiredString(
      intakePlan.proposed_frontier_resolved_at,
      'intake proposed frontier resolved_at',
    ),
    baseline_assignment_hash: digest(
      intakePlan.baseline_assignment_hash,
      'intake baseline assignment hash',
    ),
    policy_version: positiveInteger(intakePlan.policy_version, 'intake policy version'),
  });

  return createMutationPlan({
    kind: 'intake',
    mutation: Object.freeze({ batch_digest: batchDigest, target_account: targetAccount }),
    items,
    haltState,
    laneState,
    runtimeState,
    retryBudgets,
    planContext,
  });
}

export function decideIntakeMutationPreflight(controlPlan, current) {
  return decideMutationPreflight(controlPlan, current);
}

export function intakeMutationCheckpointEvidence(controlPlan, bookmark, recordedAt) {
  requiredString(controlPlan?.operation_id, 'mutation operation id');
  const value = requiredString(bookmark, 'checkpoint bookmark');
  if (!BOOKMARK_RE.test(value)) throw new Error('checkpoint bookmark is invalid');
  return Object.freeze({
    operation_id: controlPlan.operation_id,
    checkpoint_bookmark: value,
    checkpoint_verified_at: canonicalInstant(recordedAt, 'recordedAt'),
    expected_lane_generation: positiveInteger(
      controlPlan.expected_lane_generation,
      'expected lane generation',
    ),
  });
}

export function verifyIntakeMutationCompletion(controlPlan, observed) {
  return verifyMutationCompletion(controlPlan, observed);
}
