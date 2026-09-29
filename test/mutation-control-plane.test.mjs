import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createMutationPlan,
  decideMutationPreflight,
  decideMutationError,
  consumeRetry,
  verifyMutationCompletion,
} from '../src/mutation-control-plane.mjs';

const RUNTIME_DIGEST = 'a'.repeat(64);

function plan(overrides = {}) {
  return createMutationPlan({
    kind: 'foundation_probe',
    mutation: { action: 'probe', value: 1 },
    items: [{ item_key: 'item-1', expected_content_revision: 1, resulting_content_revision: 2 }],
    haltState: { halted: 0, generation: overrides.haltGeneration ?? 4 },
    laneState: { generation: overrides.laneGeneration ?? 7, active_operation_id: null },
    runtimeState: { generation: overrides.runtimeGeneration ?? 11, revision_digest: RUNTIME_DIGEST },
  });
}

function current(p, overrides = {}) {
  return {
    haltState: { halted: overrides.halted ? 1 : 0, generation: overrides.haltGeneration ?? p.expected_halt_generation },
    laneState: { generation: overrides.laneGeneration ?? p.expected_lane_generation, active_operation_id: overrides.activeOperationId ?? null },
    runtimeState: { generation: overrides.runtimeGeneration ?? p.expected_runtime_generation, revision_digest: overrides.runtimeDigest ?? p.expected_runtime_revision_digest },
    authority: overrides.authority ?? 'bound',
  };
}

test('logical mutation identity is stable across replans while plan digest fences the snapshot', () => {
  const a = plan();
  const b = plan({ laneGeneration: 8, runtimeGeneration: 12 });
  assert.equal(a.operation_id, b.operation_id);
  assert.equal(a.operation_digest, b.operation_digest);
  assert.notEqual(a.plan_digest, b.plan_digest);
});

test('preflight clean resolves; blocked lane defers; stale fences replan', () => {
  const p = plan();
  assert.equal(decideMutationPreflight(p, current(p)).outcome, 'AUTO_RESOLVE');
  const halted = decideMutationPreflight(p, current(p, { halted: true }));
  assert.equal(halted.outcome, 'AUTO_DEFER');
  assert.equal(halted.primaryReason, 'mutation_lane_halted');
  assert.equal(decideMutationPreflight(p, current(p, { runtimeGeneration: 12 })).outcome, 'AUTO_RETRY');
  assert.equal(decideMutationPreflight(p, current(p, { laneGeneration: 8 })).outcome, 'AUTO_RETRY');
});

test('post-dispatch D1 outcomes map through Batch 0 semantics', () => {
  assert.equal(decideMutationError('D1_BATCH_APPLIED', { postDispatch: true }).outcome, 'AUTO_RESOLVE');
  assert.equal(decideMutationError('D1_BATCH_AMBIGUOUS', { postDispatch: true }).outcome, 'SYSTEM_HALT');
  const transient = decideMutationError('D1_BATCH_TRANSIENT_NOT_APPLIED', { postDispatch: true });
  assert.equal(transient.outcome, 'AUTO_RETRY');
  assert.equal(transient.retryTarget, 'operation');
  assert.equal(decideMutationError('D1_BATCH_PERMANENT_NOT_APPLIED', { postDispatch: true }).outcome, 'QUARANTINE');
});

test('unmapped adapter failures fail closed before and after dispatch', () => {
  const pre = decideMutationError('SOMETHING_NEW');
  assert.equal(pre.outcome, 'SYSTEM_HALT');
  assert.equal(pre.haltScope, 'system');
  const post = decideMutationError('SOMETHING_NEW', { postDispatch: true });
  assert.equal(post.outcome, 'SYSTEM_HALT');
  assert.equal(post.haltScope, 'system');
});

test('retry budget is finite and exhaustion changes the model decision', () => {
  let counts = { plan: 0, read: 0, operation: 0 };
  let consumed = consumeRetry(counts, 'operation', { plan: 3, read: 3, operation: 1 });
  assert.equal(consumed.retryBudget, 'available');
  consumed = consumeRetry(consumed.counts, 'operation', { plan: 3, read: 3, operation: 1 });
  assert.equal(consumed.retryBudget, 'exhausted');
  const decision = decideMutationError('D1_BATCH_TRANSIENT_NOT_APPLIED', {
    postDispatch: true,
    retryBudget: consumed.retryBudget,
  });
  assert.equal(decision.outcome, 'SYSTEM_HALT');
});

test('completion requires exact operation, runtime generation and affected-version readback', () => {
  const p = plan();
  const good = verifyMutationCompletion(p, {
    operation_id: p.operation_id,
    runtime_generation: p.expected_runtime_generation + 1,
    runtime_revision_digest: 'b'.repeat(64),
    items: [{ item_key: 'item-1', readback_status: 'applied', resulting_content_revision: 2 }],
  });
  assert.deepEqual(good, { ok: true, reason: null });
  assert.equal(verifyMutationCompletion(p, {
    operation_id: p.operation_id,
    runtime_generation: p.expected_runtime_generation + 1,
    runtime_revision_digest: 'b'.repeat(64),
    items: [{ item_key: 'item-1', readback_status: 'applied', resulting_content_revision: 3 }],
  }).reason, 'content_revision_mismatch:item-1');
});
