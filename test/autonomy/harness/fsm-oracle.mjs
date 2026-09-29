// FSM property oracle. Every check takes a transition function so it can be run against mutants.

import {
  ACTORS, CONTRACT_EXITS, DISPATCH_CONSISTENT, EVENTS, STATES, TERMINAL_STATES, TRANSITIONS,
} from '../../../src/autonomy/state-machine.mjs';
import { ALL_EVIDENCE } from './scenarios.mjs';

const OWNER_PARKED = ['HALTED', 'QUARANTINED', 'WAITING_ATTESTATION', 'WAITING_APPROVAL'];
const RETRY_TARGETS = [undefined, 'plan', 'read', 'operation'];
const NOT_APPLIED_EDGES = new Set(['AUTO_RETRY', 'AUTO_DEFER', 'QUARANTINE', 'OWNER_RECONCILED_NOT_APPLIED']);

export function* allAttempts() {
  for (const state of STATES) for (const dispatched of [false, true]) for (const type of EVENTS) {
    for (const actor of ACTORS) for (const retryTarget of RETRY_TARGETS) {
      yield { item: { state, dispatched }, event: { type, actor, evidence: ALL_EVIDENCE, retryTarget } };
    }
  }
}

export function resumeProperties(resumeFromCrash) {
  const failures = [];
  let attempts = 0;
  for (const state of STATES) {
    for (const dispatched of [false, true]) {
      attempts += 1;
      const r = resumeFromCrash({ state, dispatched });
      const consistent = DISPATCH_CONSISTENT[state].includes(dispatched);
      if (!consistent) {
        if (r.ok || r.reason !== 'inconsistent_item_state') {
          failures.push(`resume accepted inconsistent checkpoint ${state}(${dispatched})`);
        }
        continue;
      }
      if (!r.ok) {
        failures.push(`resume rejected valid checkpoint ${state}(${dispatched}): ${r.reason}`);
        continue;
      }
      const expected = state === 'EXECUTING' ? { state: 'VERIFYING', dispatched: true } : { state, dispatched };
      if (JSON.stringify(r.item) !== JSON.stringify(expected)) {
        failures.push(`resume changed valid checkpoint incorrectly ${state}(${dispatched})`);
      }
    }
  }
  attempts += 2;
  const missing = resumeFromCrash({ state: 'PLANNED' });
  if (missing.ok || missing.reason !== 'dispatch_flag_missing') failures.push('resume accepted checkpoint without dispatch flag');
  const unknown = resumeFromCrash({ state: 'NOT_A_STATE', dispatched: false });
  if (unknown.ok || unknown.reason !== 'unknown_state') failures.push('resume accepted unknown state');
  return { attempts, failures: [...new Set(failures)] };
}

export function fsmProperties(transition) {
  const failures = [];
  const accepted = [];
  let attempts = 0;
  for (const { item, event } of allAttempts()) {
    attempts += 1;
    const r = transition(item, event);
    if (!r.ok) {
      if (r.to !== item.state) failures.push(`rejection changed state ${item.state}`);
      continue;
    }
    accepted.push({ item, event, r });
    const tag = `${item.state}(${item.dispatched})-${event.type}/${event.actor}->${r.to}`;
    if (TERMINAL_STATES.includes(item.state)) failures.push(`terminal exit ${tag}`);
    if (event.actor === 'generator') failures.push(`generator accepted ${tag}`);
    if (OWNER_PARKED.includes(item.state) && event.actor !== 'owner') failures.push(`automation exited owner-parked state ${tag}`);
    if (r.to === 'EXECUTING' && !(item.state === 'PLANNED' && item.dispatched === false)) failures.push(`EXECUTING entered improperly ${tag}`);
    if (r.to === 'COMPLETE' && !((item.state === 'VERIFYING' && event.actor === 'automation') ||
      (item.state === 'HALTED' && event.type === 'OWNER_RECONCILED_APPLIED'))) failures.push(`COMPLETE entered improperly ${tag}`);
    if (['RETRY_WAIT', 'DEFERRED'].includes(item.state) && !['PLANNED', 'HALTED'].includes(r.to)) failures.push(`retry/defer exit not via PLANNED ${tag}`);
    if (r.to === 'IGNORED' && item.dispatched) failures.push(`dispatched item ignored ${tag}`);
    if (item.state === 'VERIFYING' && ['QUARANTINED', 'DEFERRED', 'RETRY_WAIT'].includes(r.to)) {
      const needs = r.to === 'RETRY_WAIT' ? 'readback_not_applied' : 'conclusive_not_applied';
      const without = { ...event, evidence: { ...ALL_EVIDENCE, [needs]: '' } };
      if (transition(item, without).ok) failures.push(`VERIFYING->${r.to} without ${needs}`);
    }
    if (item.dispatched && r.item.dispatched === false && !NOT_APPLIED_EDGES.has(event.type)) failures.push(`dispatch flag cleared without not-applied proof ${tag}`);
    if (item.state === 'EXECUTING' && r.to === 'HALTED' && r.item.dispatched !== true) failures.push(`halt from EXECUTING lost dispatch flag ${tag}`);
    if (r.to === 'DISCARDED' && event.actor !== 'owner') failures.push(`non-owner discard ${tag}`);
    if (!DISPATCH_CONSISTENT[r.to]?.includes(r.item.dispatched)) failures.push(`inconsistent result item ${tag} dispatched=${r.item.dispatched}`);
    if (item.state === 'VERIFYING' && r.to === 'RETRY_WAIT' && !['operation', 'plan'].includes(event.retryTarget)) {
      failures.push(`VERIFYING retry with target ${event.retryTarget}`);
    }
    if (event.type.startsWith('OWNER_RECONCILED') && !item.dispatched) failures.push(`reconciliation of never-dispatched item ${tag}`);
    if (event.type === 'OWNER_CLEARED_HALT' && r.to !== 'RECEIVED') failures.push(`halt clear skips re-inspection ${tag}`);
    // Missing evidence always rejects.
    const row = TRANSITIONS.find((t) => t.event === event.type && t.from.includes(item.state) && t.to === r.to && t.actor === event.actor);
    for (const key of row?.evidence ?? []) {
      const without = { ...event, evidence: { ...ALL_EVIDENCE } };
      delete without.evidence[key];
      if (transition(item, without).ok) failures.push(`accepted without evidence ${key}: ${tag}`);
    }
  }
  for (const exit of CONTRACT_EXITS) {
    const r = transition(exit.from, { type: exit.event, actor: exit.actor, evidence: ALL_EVIDENCE, retryTarget: exit.retryTarget });
    if (!r.ok || r.to !== exit.to) failures.push(`contract exit missing ${exit.from.state}-${exit.event}->${exit.to} (${r.ok ? r.to : r.reason})`);
  }
  return { attempts, accepted: accepted.length, failures: [...new Set(failures)], edges: accepted };
}

// Graph checks over (state, dispatched) nodes.
export function fsmGraph(transition) {
  const { edges } = fsmProperties(transition);
  const adj = new Map();
  const node = (i) => `${i.state}|${i.dispatched}`;
  for (const e of edges) {
    const from = node(e.item);
    if (!adj.has(from)) adj.set(from, []);
    adj.get(from).push({ to: node(e.r.item), event: e.event.type, fromState: e.item.state });
  }
  const reach = (start, avoid = () => false) => {
    const seen = new Set([start]);
    const stack = [start];
    while (stack.length) {
      const n = stack.pop();
      for (const e of adj.get(n) ?? []) {
        if (avoid(e) || seen.has(e.to)) continue;
        seen.add(e.to);
        stack.push(e.to);
      }
    }
    return seen;
  };
  const failures = [];
  const fromStart = reach('RECEIVED|false');
  for (const s of STATES) {
    if (![...fromStart].some((n) => n.startsWith(`${s}|`))) failures.push(`unreachable state ${s}`);
  }
  for (const n of fromStart) {
    const [s] = n.split('|');
    if (TERMINAL_STATES.includes(s)) continue;
    const r = reach(n);
    if (![...r].some((m) => TERMINAL_STATES.includes(m.split('|')[0]))) failures.push(`trap node ${n}`);
  }
  // Replay safety: once an item may have dispatched, it cannot reach EXECUTING again except through
  // verification (VERIFYING) or an owner reconciliation.
  for (const start of ['EXECUTING|false']) {
    for (const e of adj.get(start) ?? []) {
      if (e.to.startsWith('VERIFYING|')) continue;
      const r = reach(e.to, (edge) => edge.fromState === 'VERIFYING' || edge.event.startsWith('OWNER_RECONCILED'));
      if ([...r].some((m) => m.startsWith('EXECUTING|'))) failures.push(`replay path from EXECUTING via ${e.event}`);
    }
  }
  // Owner-parked items never re-enter the pipeline without an owner event.
  for (const parked of ['QUARANTINED|false', 'WAITING_ATTESTATION|false', 'WAITING_APPROVAL|false']) {
    const r = reach(parked, (edge) => edge.event.startsWith('OWNER_'));
    for (const m of r) if (m !== parked) failures.push(`parked ${parked} escapes to ${m} without owner`);
  }
  return { nodes: fromStart.size, failures };
}
