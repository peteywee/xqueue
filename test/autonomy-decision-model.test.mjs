import test from 'node:test';
import assert from 'node:assert/strict';

import {
  OUTCOMES, OUTCOME_CONTRACTS, SEVERITY, maxSeverity,
} from '../src/autonomy/decision-outcomes.mjs';
import {
  composeVerdicts, decide, DEFAULT_POLICY, DIMENSIONS, DIMENSION_KEYS, fullSpaceSize, GATES, LANES,
} from '../src/autonomy/decision-model.mjs';
import { BASELINES, POST_DISPATCH_BASELINES, FAULT_CATALOG, observe, observePost } from '../src/autonomy/fault-catalog.mjs';
import { checkInvalidObservations } from './autonomy/harness/runner.mjs';

const CONTRACT_FIELDS = [
  'meaning', 'entryConditions', 'prohibitedEntryConditions', 'canonicalChange', 'externalSideEffect', 'retryPermitted',
  'unrelatedWorkContinues', 'ownerNotification', 'ownerResponseRequired', 'exitEvidence', 'fsmTargets',
  'illegalTransitions', 'idempotency', 'recovery',
];

test('exactly the eight required outcomes exist, each with a complete contract', () => {
  assert.deepEqual([...OUTCOMES].sort(), [
    'AUTO_DEFER', 'AUTO_IGNORE', 'AUTO_RESOLVE', 'AUTO_RETRY', 'OWNER_APPROVAL_REQUIRED', 'OWNER_ATTESTATION_REQUIRED',
    'QUARANTINE', 'SYSTEM_HALT',
  ]);
  for (const outcome of OUTCOMES) {
    const contract = OUTCOME_CONTRACTS[outcome];
    for (const field of CONTRACT_FIELDS) assert.ok(field in contract, `${outcome} missing ${field}`);
    assert.equal(typeof SEVERITY[outcome], 'number');
  }
  assert.equal(new Set(Object.values(SEVERITY)).size, OUTCOMES.length, 'severity is a total order');
});

test('owner-facing outcomes notify and require a response; automatic outcomes do not', () => {
  for (const o of ['QUARANTINE', 'OWNER_ATTESTATION_REQUIRED', 'OWNER_APPROVAL_REQUIRED', 'SYSTEM_HALT']) {
    assert.equal(OUTCOME_CONTRACTS[o].ownerNotification, true, o);
    assert.equal(OUTCOME_CONTRACTS[o].ownerResponseRequired, true, o);
  }
  for (const o of ['AUTO_RESOLVE', 'AUTO_RETRY', 'AUTO_DEFER', 'AUTO_IGNORE']) {
    assert.equal(OUTCOME_CONTRACTS[o].ownerResponseRequired, false, o);
  }
  assert.equal(OUTCOME_CONTRACTS.AUTO_RETRY.retryPermitted, true);
  for (const o of OUTCOMES.filter((x) => x !== 'AUTO_RETRY')) assert.equal(OUTCOME_CONTRACTS[o].retryPermitted, false, o);
});

test('maxSeverity rejects unknown outcomes instead of treating them as safe', () => {
  assert.equal(maxSeverity(['AUTO_RESOLVE', 'QUARANTINE', 'AUTO_DEFER']), 'QUARANTINE');
  assert.throws(() => maxSeverity(['AUTO_RESOLVE', 'MAYBE_FINE']));
});

test('every lane baseline is all-pass and every post-dispatch baseline records a proven success', () => {
  for (const [lane, o] of Object.entries(BASELINES)) {
    const d = decide(o);
    assert.equal(d.outcome, 'AUTO_RESOLVE', lane);
    assert.equal(d.primaryReason, 'all_gates_pass', lane);
  }
  for (const [lane, o] of Object.entries(POST_DISPATCH_BASELINES)) {
    assert.equal(decide(o).outcome, 'AUTO_RESOLVE', lane);
  }
});

test('invalid observations and policies fail closed to SYSTEM_HALT', () => {
  assert.deepEqual(checkInvalidObservations(decide), []);
  const d = decide({ ...BASELINES.publication, haltFence: 'looks_fine' });
  assert.equal(d.outcome, 'SYSTEM_HALT');
  assert.equal(d.haltScope, 'component');
  assert.match(d.primaryReason, /^invalid_observation:invalid_value:haltFence/);
});

test('decisions are deterministic, key-order independent, and never mutate their input', () => {
  const o = observePost('canonical_mutation', { effect: 'ambiguous', readback: 'proves_applied' });
  const snapshot = JSON.stringify(o);
  const a = decide(o);
  const b = decide(Object.fromEntries(Object.entries(o).reverse()));
  const c = decide(JSON.parse(snapshot));
  assert.equal(JSON.stringify(a), JSON.stringify(b));
  assert.equal(JSON.stringify(a), JSON.stringify(c));
  assert.equal(JSON.stringify(o), snapshot);
  assert.ok(Object.isFrozen(a));
});

test('reasons are complete, sorted and unique so decisions are explainable', () => {
  const d = decide(observe('publication', { haltFence: 'generation_changed', versionFence: 'stale_runtime' }));
  assert.equal(d.outcome, 'AUTO_RETRY');
  assert.deepEqual([...d.reasons], [...new Set(d.reasons)].sort());
  assert.ok(d.reasons.includes('halt_generation_changed_after_plan'));
  assert.ok(d.reasons.includes('runtime_generation_stale'));
});

test('retry budget exhaustion escalates to the declared target, never to another retry', () => {
  const stale = decide(observe('publication', { versionFence: 'stale_runtime', retryBudget: 'exhausted' }));
  assert.equal(stale.outcome, 'AUTO_DEFER');
  const unreadable = decide(observe('publication', { canonical: 'unreadable', retryBudget: 'exhausted' }));
  assert.equal(unreadable.outcome, 'SYSTEM_HALT');
  assert.equal(unreadable.haltScope, 'lane');
  for (const o of [stale, unreadable]) assert.equal(o.retryAllowed, false);
});

test('composition takes the maximum severity and the widest halt scope', () => {
  const r = composeVerdicts([
    { outcome: 'SYSTEM_HALT', reason: 'a', haltScope: 'component', reasons: ['a'] },
    { outcome: 'QUARANTINE', reason: 'b', reasons: ['b'] },
    { outcome: 'SYSTEM_HALT', reason: 'c', haltScope: 'system', reasons: ['c'] },
    { outcome: null, reasons: [] },
  ]);
  assert.equal(r.outcome, 'SYSTEM_HALT');
  assert.equal(r.haltScope, 'system');
  assert.equal(composeVerdicts([{ outcome: null, reasons: [] }]).outcome, 'AUTO_RESOLVE');
});

test('only a pre-dispatch AUTO_RESOLVE on the publication lane may authorize an external side effect', () => {
  assert.equal(decide(BASELINES.publication).externalSideEffectAllowed, true);
  for (const lane of ['canonical_mutation', 'staging', 'read_only']) {
    assert.equal(decide(BASELINES[lane]).externalSideEffectAllowed, false, lane);
  }
  assert.equal(decide(POST_DISPATCH_BASELINES.publication).externalSideEffectAllowed, false);
});

test('read-only effects remain component-scoped even when readback contradicts the observed effect', () => {
  const cases = [
    { effect: 'success', readback: 'proves_not_applied' },
    { effect: 'failure_transient', readback: 'proves_applied' },
    { effect: 'failure_permanent', readback: 'proves_applied' },
    { effect: 'ambiguous', readback: 'contradictory' },
  ];
  for (const patch of cases) {
    const d = decide(observe('read_only', patch));
    assert.equal(d.outcome, 'SYSTEM_HALT', JSON.stringify(patch));
    assert.equal(d.haltScope, 'component', JSON.stringify(patch));
    assert.equal(d.primaryReason, 'read_only_component_produced_effect', JSON.stringify(patch));
    assert.ok(!d.reasons.includes('outcome_contradiction'), JSON.stringify(patch));
  }
});

test('lane capability matrix: mutation and staging lanes can never carry an external effect', () => {
  assert.equal(LANES.canonical_mutation.allowedTarget, 'internal');
  assert.equal(LANES.staging.allowedTarget, 'internal');
  assert.equal(LANES.read_only.allowedTarget, null);
  for (const lane of ['canonical_mutation', 'staging']) {
    const d = decide(observe(lane, { effectTarget: 'external' }));
    assert.equal(d.outcome, 'SYSTEM_HALT', lane);
    assert.equal(d.primaryReason, 'lane_capability_violation');
  }
});

test('external readback is evidence, not authority, under the default (current) owner policy', () => {
  assert.equal(DEFAULT_POLICY.externalReadbackAuthoritative, false);
  const o = observePost('publication', { effect: 'ambiguous', readback: 'proves_applied' });
  assert.equal(decide(o).outcome, 'SYSTEM_HALT');
  assert.equal(decide(o, { externalReadbackAuthoritative: true }).outcome, 'AUTO_RESOLVE');
});

test('a blocking halt defers both publication and canonical mutation without inventing an owner-approval gate', () => {
  const mutation = decide(observe('canonical_mutation', { haltFence: 'blocking' }));
  assert.equal(mutation.outcome, 'AUTO_DEFER');
  assert.equal(mutation.primaryReason, 'mutation_lane_halted');
  assert.equal(decide(observe('publication', { haltFence: 'blocking' })).outcome, 'AUTO_DEFER');
});

test('a mutation-lane halt observed after dispatch does not erase a proven applied result', () => {
  const mutation = decide(observePost('canonical_mutation', { haltFence: 'blocking' }));
  assert.equal(mutation.outcome, 'AUTO_RESOLVE');
  assert.equal(mutation.primaryReason, 'outcome_proven_applied');
});

test('schema is finite and the full product space is the size the compositional proof claims', () => {
  assert.equal(DIMENSION_KEYS.length, 21);
  let n = 1;
  for (const key of DIMENSION_KEYS) n *= DIMENSIONS[key].length;
  assert.equal(fullSpaceSize(), n);
  assert.equal(n, 148635648000);
  const declared = new Set(GATES.flatMap((g) => g.dims));
  for (const key of DIMENSION_KEYS) assert.ok(declared.has(key) || key === 'effect', `dimension ${key} read by no gate`);
});

test('every catalogued fault maps only onto schema values', () => {
  for (const [name, entry] of Object.entries(FAULT_CATALOG)) {
    for (const [key, value] of Object.entries(entry.patch)) {
      assert.ok(DIMENSIONS[key]?.includes(value), `${name}: ${key}=${value}`);
    }
  }
});
