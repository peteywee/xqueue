import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createIntakeMutationControlPlan,
  decideIntakeMutationPreflight,
  intakeMutationCheckpointEvidence,
  verifyIntakeMutationCompletion,
} from '../src/mutation-intake-adapter.mjs';

const RUNTIME_DIGEST = 'a'.repeat(64);
const BASELINE_HASH = 'b'.repeat(64);
const BATCH_DIGEST = 'c'.repeat(64);
const INTAKE_PLAN_DIGEST = 'd'.repeat(64);

function intake(overrides = {}) {
  return {
    operation_id: overrides.operation_id ?? 'intake-' + INTAKE_PLAN_DIGEST.slice(0, 24),
    plan_digest: overrides.plan_digest ?? INTAKE_PLAN_DIGEST,
    batch_digest: BATCH_DIGEST,
    expected_frontier_generation: overrides.frontier_generation ?? 5,
    expected_frontier_resolved_at: '2026-09-29T10:00:00.000Z',
    proposed_frontier_resolved_at: overrides.proposed ?? '2026-09-30T10:00:00.000Z',
    baseline_assignment_hash: BASELINE_HASH,
    expected_runtime_generation: 11,
    expected_runtime_revision_digest: RUNTIME_DIGEST,
    target_account: 'x-primary',
    policy_version: overrides.policy_version ?? 2,
    items: [
      { content_id: 'I-1' },
      { content_id: 'I-2' },
    ],
  };
}

function states() {
  return {
    haltState: { halted: 0, generation: 4 },
    laneState: { generation: 7, active_operation_id: null },
    runtimeState: { generation: 11, revision_digest: RUNTIME_DIGEST },
  };
}

test('intake mapping keeps logical mutation identity stable across intake replans', () => {
  const s = states();
  const a = createIntakeMutationControlPlan({ intakePlan: intake(), ...s });
  const b = createIntakeMutationControlPlan({
    intakePlan: intake({
      operation_id: 'intake-' + 'e'.repeat(24),
      plan_digest: 'e'.repeat(64),
      frontier_generation: 6,
      proposed: '2026-10-01T10:00:00.000Z',
      policy_version: 3,
    }),
    ...s,
  });
  assert.equal(a.operation_id, b.operation_id);
  assert.equal(a.operation_digest, b.operation_digest);
  assert.notEqual(a.plan_digest, b.plan_digest);
});

test('intake mapping binds batch/account identity and expected resulting versions', () => {
  const p = createIntakeMutationControlPlan({ intakePlan: intake(), ...states() });
  assert.equal(p.operation_kind, 'intake');
  assert.equal(p.plan_context.intake_plan_digest, INTAKE_PLAN_DIGEST);
  assert.deepEqual(p.items.map((x) => ({
    key: x.item_key,
    content: x.resulting_content_revision,
    assignment: x.resulting_assignment_version,
  })), [
    { key: 'I-1', content: 1, assignment: 1 },
    { key: 'I-2', content: 1, assignment: 1 },
  ]);
});

test('intake mapping refuses a runtime snapshot that does not match the intake plan', () => {
  assert.throws(() => createIntakeMutationControlPlan({
    intakePlan: intake(),
    ...states(),
    runtimeState: { generation: 12, revision_digest: RUNTIME_DIGEST },
  }), /runtime snapshot does not match/);
});

test('intake preflight uses the mutation lane and fails closed on a blocking halt', () => {
  const s = states();
  const p = createIntakeMutationControlPlan({ intakePlan: intake(), ...s });
  assert.equal(decideIntakeMutationPreflight(p, s).outcome, 'AUTO_RESOLVE');
  const halted = decideIntakeMutationPreflight(p, {
    ...s,
    haltState: { halted: 1, generation: p.expected_halt_generation },
  });
  assert.equal(halted.outcome, 'AUTO_DEFER');
  assert.equal(halted.primaryReason, 'mutation_lane_halted');
});

test('checkpoint evidence is bound to operation and expected lane generation', () => {
  const p = createIntakeMutationControlPlan({ intakePlan: intake(), ...states() });
  const e = intakeMutationCheckpointEvidence(p, 'bookmark_12345', '2026-09-29T10:05:00.000Z');
  assert.deepEqual(e, {
    operation_id: p.operation_id,
    checkpoint_bookmark: 'bookmark_12345',
    checkpoint_verified_at: '2026-09-29T10:05:00.000Z',
    expected_lane_generation: p.expected_lane_generation,
  });
  assert.throws(() => intakeMutationCheckpointEvidence(p, 'bad', '2026-09-29T10:05:00.000Z'), /invalid/);
});

test('completion requires exact operation, runtime generation and both item versions', () => {
  const p = createIntakeMutationControlPlan({ intakePlan: intake(), ...states() });
  const observed = {
    operation_id: p.operation_id,
    runtime_generation: 12,
    runtime_revision_digest: 'f'.repeat(64),
    items: p.items.map((item) => ({
      item_key: item.item_key,
      readback_status: 'applied',
      resulting_content_revision: 1,
      resulting_assignment_version: 1,
    })),
  };
  assert.deepEqual(verifyIntakeMutationCompletion(p, observed), { ok: true, reason: null });
  observed.items[1] = { ...observed.items[1], resulting_assignment_version: 2 };
  assert.equal(verifyIntakeMutationCompletion(p, observed).ok, false);
});
