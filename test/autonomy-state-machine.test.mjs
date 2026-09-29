import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ACTORS, CONTRACT_EXITS, DISPATCH_CONSISTENT, EVENTS, resumeFromCrash, STATES, stateMachineSpec, TERMINAL_STATES,
  transition, TRANSITIONS,
} from '../src/autonomy/state-machine.mjs';
import { fsmGraph, fsmProperties } from './autonomy/harness/fsm-oracle.mjs';
import { ALL_EVIDENCE } from './autonomy/harness/scenarios.mjs';

const ev = (type, actor = 'automation', extra = {}) => ({ type, actor, evidence: ALL_EVIDENCE, ...extra });

test('state set is normalized: 15 states, 3 terminal, no AMBIGUOUS waiting state', () => {
  assert.equal(STATES.length, 15);
  assert.deepEqual([...TERMINAL_STATES].sort(), ['COMPLETE', 'DISCARDED', 'IGNORED']);
  assert.ok(!STATES.includes('AMBIGUOUS'));
  for (const s of STATES) assert.ok(DISPATCH_CONSISTENT[s], `${s} has dispatch-consistency rule`);
});

test('exhaustive attempt enumeration: every FSM safety property holds', () => {
  const r = fsmProperties(transition);
  assert.equal(r.attempts, STATES.length * 2 * EVENTS.length * ACTORS.length * 4);
  assert.deepEqual(r.failures, []);
  assert.ok(r.accepted > 0);
});

test('graph properties: reachability, no trap states, no replay path, owner-parked items cannot escape', () => {
  const g = fsmGraph(transition);
  assert.deepEqual(g.failures, []);
  assert.equal(g.nodes, 16);
});

test('every normative contract exit exists', () => {
  for (const exit of CONTRACT_EXITS) {
    const r = transition(exit.from, ev(exit.event, exit.actor, { retryTarget: exit.retryTarget }));
    assert.equal(r.ok, true, `${exit.from.state}-${exit.event}`);
    assert.equal(r.to, exit.to);
  }
});

test('illegal transitions fail closed and leave state unchanged', () => {
  const cases = [
    [{ state: 'EXECUTING', dispatched: false }, ev('AUTO_RESOLVE'), 'illegal_transition'],
    [{ state: 'COMPLETE', dispatched: true }, ev('SYSTEM_HALT'), 'terminal_state'],
    [{ state: 'IGNORED', dispatched: false }, ev('OWNER_RELEASED', 'owner'), 'terminal_state'],
    [{ state: 'RETRY_WAIT', dispatched: false }, ev('AUTO_RESOLVE'), 'illegal_transition'],
    [{ state: 'WAITING_APPROVAL', dispatched: false }, ev('OWNER_APPROVED', 'automation'), 'actor_not_authorized'],
    [{ state: 'WAITING_APPROVAL', dispatched: false }, ev('OWNER_APPROVED', 'generator'), 'actor_not_authorized'],
    [{ state: 'HALTED', dispatched: false }, ev('OWNER_CLEARED_HALT', 'automation'), 'actor_not_authorized'],
    [{ state: 'HALTED', dispatched: true }, ev('OWNER_CLEARED_HALT', 'owner'), 'guard_failed'],
    [{ state: 'VERIFYING', dispatched: true }, ev('AUTO_IGNORE'), 'illegal_transition'],
    [{ state: 'VERIFYING', dispatched: true }, ev('AUTO_RETRY', 'automation', { retryTarget: 'read' }), 'guard_failed'],
    [{ state: 'RETRY_WAIT', dispatched: true }, ev('RETRY_READY'), 'inconsistent_item_state'],
    [{ state: 'NOT_A_STATE', dispatched: false }, ev('AUTO_RESOLVE'), 'unknown_state'],
    [{ state: 'PLANNED' }, ev('AUTO_RESOLVE'), 'dispatch_flag_missing'],
    [{ state: 'PLANNED', dispatched: false }, ev('MAKE_IT_SO'), 'unknown_event'],
    [{ state: 'PLANNED', dispatched: false }, ev('AUTO_RESOLVE', 'root'), 'unknown_actor'],
  ];
  for (const [item, event, reason] of cases) {
    const r = transition(item, event);
    assert.equal(r.ok, false, `${item.state}-${event.type}`);
    assert.equal(r.reason, reason, `${item.state}-${event.type}`);
    assert.equal(r.to, item.state);
  }
});

test('missing or blank evidence rejects every evidence-bearing transition', () => {
  let checked = 0;
  for (const row of TRANSITIONS) {
    for (const from of row.from) {
      for (const dispatched of DISPATCH_CONSISTENT[from]) {
        const item = { state: from, dispatched };
        const retryTarget = row.event === 'AUTO_RETRY' && from === 'VERIFYING' ? 'operation' : undefined;
        const base = { type: row.event, actor: row.actor, evidence: ALL_EVIDENCE, retryTarget };
        const full = transition(item, base);
        if (!full.ok || full.to !== row.to) continue;
        for (const key of row.evidence) {
          checked += 1;
          const missing = { ...ALL_EVIDENCE };
          delete missing[key];
          assert.equal(transition(item, { ...base, evidence: missing }).ok, false, `${from}-${row.event} without ${key}`);
          assert.equal(transition(item, { ...base, evidence: { ...ALL_EVIDENCE, [key]: '   ' } }).ok, false, `${from} blank ${key}`);
        }
      }
    }
  }
  assert.ok(checked > 40);
});

test('crash recovery validates checkpoint consistency before resuming', () => {
  for (const state of STATES) {
    for (const dispatched of [false, true]) {
      const r = resumeFromCrash({ state, dispatched });
      if (!DISPATCH_CONSISTENT[state].includes(dispatched)) {
        assert.equal(r.ok, false, `${state}/${dispatched}`);
        assert.equal(r.reason, 'inconsistent_item_state', `${state}/${dispatched}`);
        continue;
      }
      assert.equal(r.ok, true, `${state}/${dispatched}`);
      if (state === 'EXECUTING') {
        assert.deepEqual(r.item, { state: 'VERIFYING', dispatched: true });
      } else {
        assert.deepEqual(r.item, { state, dispatched });
      }
    }
  }
  assert.equal(resumeFromCrash({ state: 'PLANNED' }).reason, 'dispatch_flag_missing');
  assert.equal(resumeFromCrash({ state: 'nope', dispatched: false }).reason, 'unknown_state');
});

test('halting mid-execution marks the item possibly dispatched, so only owner reconciliation can release it', () => {
  const halted = transition({ state: 'EXECUTING', dispatched: false }, ev('SYSTEM_HALT'));
  assert.deepEqual(halted.item, { state: 'HALTED', dispatched: true });
  assert.equal(transition(halted.item, ev('OWNER_CLEARED_HALT', 'owner')).ok, false);
  assert.equal(transition(halted.item, ev('OWNER_RECONCILED_NOT_APPLIED', 'owner')).to, 'DEFERRED');
});

test('owner-parked items are not swept into HALTED by a lane halt', () => {
  for (const state of ['QUARANTINED', 'WAITING_ATTESTATION', 'WAITING_APPROVAL']) {
    assert.equal(transition({ state, dispatched: false }, ev('SYSTEM_HALT')).ok, false, state);
  }
});

test('machine-readable spec covers every state with inbound/outbound rules and properties', () => {
  const spec = stateMachineSpec();
  assert.deepEqual(spec.states, [...STATES]);
  for (const s of STATES) {
    const p = spec.perState[s];
    assert.ok(Array.isArray(p.inbound) && Array.isArray(p.outbound), s);
    assert.ok('canonicalMutation' in p && 'externalSideEffects' in p && 'automaticRetry' in p && 'unrelatedWorkProceeds' in p, s);
    if (s !== 'RECEIVED') assert.ok(p.inbound.length > 0, `${s} has inbound`);
    if (!p.terminal) assert.ok(p.outbound.length > 0, `${s} has outbound`);
    else assert.equal(p.outbound.length, 0, `${s} terminal has no outbound`);
  }
});
