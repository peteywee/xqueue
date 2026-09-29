import test from 'node:test';
import assert from 'node:assert/strict';

import { decide, DEFAULT_POLICY } from '../src/autonomy/decision-model.mjs';
import { OUTCOME_CONTRACTS } from '../src/autonomy/decision-outcomes.mjs';
import { observe, observePost, fault } from '../src/autonomy/fault-catalog.mjs';
import { DECISION_INVARIANTS, INVARIANTS } from '../src/autonomy/invariants.mjs';
import { transition, TRANSITIONS, STATES } from '../src/autonomy/state-machine.mjs';
import { fsmGraph, fsmProperties } from './autonomy/harness/fsm-oracle.mjs';
import { ALL_EVIDENCE } from './autonomy/harness/scenarios.mjs';

// A deliberately WRONG decision for an observation, used to prove each predicate is not vacuous.
function wrong(observation, outcome, extra = {}) {
  const real = decide(observation);
  const c = OUTCOME_CONTRACTS[outcome];
  return {
    ...real, outcome, haltScope: outcome === 'SYSTEM_HALT' ? 'lane' : null,
    retryTarget: outcome === 'AUTO_RETRY' ? 'operation' : null, retryAllowed: outcome === 'AUTO_RETRY',
    canonicalChange: c.canonicalChange, ownerActionRequired: c.ownerResponseRequired, ownerNotification: c.ownerNotification,
    unrelatedWorkContinues: outcome === 'SYSTEM_HALT' ? 'other_lanes_only' : 'yes', externalSideEffectAllowed: false, ...extra,
  };
}

const WITNESSES = {
  'INV-01': [observePost('canonical_mutation', { effect: 'ambiguous', readback: 'unavailable' }), 'AUTO_RESOLVE'],
  'INV-02': [observePost('publication', { effect: 'ambiguous', readback: 'unavailable' }), 'AUTO_RETRY'],
  'INV-03': [observe('canonical_mutation', fault('approval_forged')), 'QUARANTINE'],
  'INV-04': [observe('canonical_mutation', fault('unsupported_experiential_claim')), 'AUTO_RESOLVE'],
  'INV-05': [observe('staging', fault('package_malformed')), 'QUARANTINE', { unrelatedWorkContinues: 'no' }],
  'INV-06': [observe('publication', fault('duplicate_assignment_slot')), 'QUARANTINE'],
  'INV-09': [observe('canonical_mutation', { idempotency: 'missing' }), 'AUTO_RESOLVE'],
  'INV-10': [observePost('publication', { effect: 'ambiguous', readback: 'not_performed' }), 'AUTO_DEFER'],
  'INV-11': [observe('publication', fault('halt_generation_changed')), 'AUTO_RESOLVE'],
  'INV-12': [observe('canonical_mutation', fault('stale_runtime_generation')), 'AUTO_RESOLVE'],
  'INV-13': [observe('publication', fault('lease_contended')), 'AUTO_RESOLVE'],
  'INV-14': [observe('staging', fault('exact_duplicate_package')), 'AUTO_RESOLVE'],
  'INV-17': [observe('publication', fault('conflicting_canonical_record')), 'QUARANTINE'],
  'INV-18': [observePost('canonical_mutation', { effect: 'ambiguous', readback: 'unavailable' }), 'AUTO_RETRY'],
  'INV-19': [observe('staging'), 'AUTO_RESOLVE', { externalSideEffectAllowed: true }],
  'INV-20': [observe('canonical_mutation', fault('approval_missing')), 'AUTO_RESOLVE'],
  'INV-23': [observePost('publication', { dispatchPreconditions: 'unverified' }), 'AUTO_RESOLVE'],
  'INV-24': [observePost('publication', fault('approval_missing')), 'OWNER_APPROVAL_REQUIRED'],
  'INV-27': [observe('publication'), 'AUTO_RETRY', { retryAllowed: false }],
  'INV-28': [observePost('publication', fault('authority_changed')), 'AUTO_RESOLVE'],
  'INV-29': [observe('canonical_mutation', { readback: 'unavailable' }), 'AUTO_RESOLVE'],
  'INV-30': [observePost('publication'), 'SYSTEM_HALT'],
};

test('catalog: every candidate invariant is present; modifications and additions carry justification', () => {
  assert.equal(INVARIANTS.filter((i) => i.origin === 'candidate').length, 21);
  assert.equal(INVARIANTS.filter((i) => i.origin === 'modified').length, 1);
  for (const inv of INVARIANTS.filter((i) => i.origin !== 'candidate')) assert.ok(inv.justification, inv.id);
  assert.equal(new Set(INVARIANTS.map((i) => i.id)).size, INVARIANTS.length);
  for (const inv of INVARIANTS) assert.ok(inv.check, `${inv.id} declares how it is checked`);
});

test('every decision predicate holds on the real model and is NOT vacuous (fires on a wrong decision)', () => {
  const ids = DECISION_INVARIANTS.map((i) => i.id);
  assert.deepEqual(Object.keys(WITNESSES).sort(), [...ids].sort(), 'one witness per decision invariant');
  for (const inv of DECISION_INVARIANTS) {
    const [o, outcome, extra] = WITNESSES[inv.id];
    assert.equal(inv.predicate(o, decide(o), DEFAULT_POLICY), null, `${inv.id} holds on real decision`);
    assert.notEqual(inv.predicate(o, wrong(o, outcome, extra), DEFAULT_POLICY), null, `${inv.id} detects a wrong decision`);
  }
});

test('INV-07 determinism: same observation and policy always yield byte-identical decisions', () => {
  const o = observe('canonical_mutation', fault('sensitive_material'), { approval: 'missing' });
  const results = new Set(Array.from({ length: 50 }, () => JSON.stringify(decide(o))));
  assert.equal(results.size, 1);
});

test('INV-08 every completed mutation has durable evidence: COMPLETE only via outcome_evidence or reconciliation_record', () => {
  const into = TRANSITIONS.filter((t) => t.to === 'COMPLETE');
  assert.ok(into.length >= 2);
  for (const t of into) assert.ok(t.evidence.includes('outcome_evidence') || t.evidence.includes('reconciliation_record'), t.event);
  assert.ok(!TRANSITIONS.some((t) => t.to === 'COMPLETE' && t.from.includes('EXECUTING')));
});

test('INV-15 restart cannot replay: dispatched->undispatched only with not-applied proof; no replay path in the graph', () => {
  assert.deepEqual(fsmProperties(transition).failures, []);
  assert.deepEqual(fsmGraph(transition).failures, []);
});

test('INV-21 quarantine never becomes silent loss: no automatic exit, discard is owner-only with a tombstone', () => {
  const exits = TRANSITIONS.filter((t) => t.from.includes('QUARANTINED'));
  for (const t of exits) assert.equal(t.actor, 'owner', t.event);
  const discard = exits.find((t) => t.to === 'DISCARDED');
  assert.ok(discard.evidence.includes('discard_record'));
  assert.ok(!STATES.includes('DELETED'));
});

test('INV-22 SYSTEM_HALT is cleared only by the owner, never by any automated actor', () => {
  for (const t of TRANSITIONS.filter((x) => x.from.includes('HALTED'))) assert.equal(t.actor, 'owner', t.event);
  for (const actor of ['automation', 'generator']) {
    for (const dispatched of [false, true]) {
      for (const type of ['OWNER_CLEARED_HALT', 'OWNER_RECONCILED_APPLIED', 'OWNER_RECONCILED_NOT_APPLIED', 'AUTO_RESOLVE', 'RETRY_READY']) {
        assert.equal(transition({ state: 'HALTED', dispatched }, { type, actor, evidence: ALL_EVIDENCE }).ok, false, `${actor}/${type}`);
      }
    }
  }
});

test('INV-25 every retry and deferral re-enters PLANNED (fresh fence read), never EXECUTING', () => {
  for (const t of TRANSITIONS.filter((x) => x.from.includes('RETRY_WAIT') || x.from.includes('DEFERRED'))) {
    assert.ok(['PLANNED', 'HALTED'].includes(t.to), `${t.event}->${t.to}`);
    if (t.to === 'PLANNED') assert.ok(t.evidence.includes('fresh_fence_read'));
  }
});

test('INV-26 owner waiting states have no automatic or time-based exit', () => {
  for (const state of ['WAITING_ATTESTATION', 'WAITING_APPROVAL']) {
    for (const t of TRANSITIONS.filter((x) => x.from.includes(state))) assert.equal(t.actor, 'owner', `${state} ${t.event}`);
    for (const type of ['DEFER_ELAPSED', 'RETRY_READY', 'AUTO_RESOLVE', 'AUTO_IGNORE', 'SYSTEM_HALT']) {
      assert.equal(transition({ state, dispatched: false }, { type, actor: 'automation', evidence: ALL_EVIDENCE }).ok, false);
    }
  }
});
