import test from 'node:test';
import assert from 'node:assert/strict';

import { decide } from '../src/autonomy/decision-model.mjs';
import { observe, observePost, fault } from '../src/autonomy/fault-catalog.mjs';
import { SCENARIOS } from './autonomy/harness/scenarios.mjs';
import { runScenario } from './autonomy/harness/runner.mjs';

for (const scenario of SCENARIOS.filter((s) => s.family === 'compound')) {
  test(`${scenario.id} [compound] ${scenario.title}`, () => {
    const result = runScenario(scenario);
    const problems = [
      ...result.items.filter((i) => !i.ok).map((i) => `${i.label ?? 'item'}: ${i.problems.join('; ')}`),
      ...result.attempts.filter((a) => !a.ok).map((a) => `fsm attempt ${a.from.state}-${a.event}/${a.actor}: ${a.result}`),
    ];
    assert.deepEqual(problems, []);
  });
}

test('blast radius: an item-local defect never blocks its siblings; canonical corruption blocks everyone', () => {
  const bad = decide(observe('staging', fault('package_malformed')));
  const good = decide(observe('staging'));
  assert.equal(bad.outcome, 'QUARANTINE');
  assert.equal(bad.unrelatedWorkContinues, 'yes');
  assert.equal(good.outcome, 'AUTO_RESOLVE');
  for (const lane of ['publication', 'canonical_mutation', 'staging']) {
    const d = decide(observe(lane, fault('runtime_digest_mismatch')));
    assert.equal(d.outcome, 'SYSTEM_HALT', lane);
    assert.equal(d.unrelatedWorkContinues, 'no', lane);
  }
});

test('lane isolation: a provider outage halts only the staging lane; ingested publication is unaffected (CQ-12)', () => {
  const staging = decide(observePost('staging', { effect: 'failure_transient', readback: 'proves_not_applied', retryBudget: 'exhausted' }));
  assert.equal(staging.outcome, 'SYSTEM_HALT');
  assert.equal(staging.haltScope, 'lane');
  assert.equal(staging.lane, 'staging');
  assert.equal(staging.unrelatedWorkContinues, 'other_lanes_only');
  assert.equal(decide(observe('publication')).outcome, 'AUTO_RESOLVE');
});

test('naive-composition trap: pre-dispatch owner requests are never the answer after a dispatch', () => {
  const traps = [
    observePost('publication', fault('approval_missing')),
    observePost('publication', fault('unsupported_experiential_claim')),
    observePost('publication', fault('sensitive_material'), { approval: 'missing' }),
    observePost('canonical_mutation', fault('approval_digest_mismatch')),
  ];
  for (const o of traps) {
    const d = decide(o);
    assert.equal(d.outcome, 'SYSTEM_HALT', JSON.stringify(o));
    assert.equal(d.primaryReason, 'item_invariant_changed_after_dispatch');
  }
});

test('ambiguity is never downgraded by retry budget, policy on internal targets, or fresh fences', () => {
  for (const retryBudget of ['available', 'exhausted']) {
    for (const readback of ['unavailable', 'contradictory', 'not_performed']) {
      for (const lane of ['publication', 'canonical_mutation', 'staging']) {
        const d = decide(observePost(lane, { effect: 'ambiguous', readback, retryBudget }));
        assert.equal(d.outcome, 'SYSTEM_HALT', `${lane}/${readback}/${retryBudget}`);
        assert.equal(d.retryAllowed, false);
      }
    }
  }
});
