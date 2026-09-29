// Shared runners used by the tests, the mutation analysis, and the evidence generator.

import { decide as defaultDecide, DEFAULT_POLICY, DIMENSIONS, DIMENSION_KEYS } from '../../../src/autonomy/decision-model.mjs';
import { transition as defaultTransition } from '../../../src/autonomy/state-machine.mjs';
import { BASELINES } from '../../../src/autonomy/fault-catalog.mjs';
import { checkDecisionInvariants } from '../../../src/autonomy/invariants.mjs';
import { ALL_EVIDENCE, SCENARIOS } from './scenarios.mjs';
import { POLICIES, rng } from './oracle.mjs';

export function runScenario(scenario, decide = defaultDecide, transition = defaultTransition) {
  const items = [];
  for (const it of scenario.items) {
    const problems = [];
    let d;
    try {
      d = scenario.policy ? decide(it.observations, scenario.policy) : decide(it.observations);
    } catch (error) {
      items.push({ label: it.label ?? null, ok: false, problems: [`decide threw: ${error.message}`] });
      continue;
    }
    const policy = scenario.policy ?? DEFAULT_POLICY;
    const e = it.expect;
    if (d.outcome !== e.outcome) problems.push(`outcome ${d.outcome} != ${e.outcome}`);
    if (e.haltScope && d.haltScope !== e.haltScope) problems.push(`haltScope ${d.haltScope} != ${e.haltScope}`);
    if (e.retryTarget && d.retryTarget !== e.retryTarget) problems.push(`retryTarget ${d.retryTarget} != ${e.retryTarget}`);
    if (d.unrelatedWorkContinues !== e.unrelated) problems.push(`unrelated ${d.unrelatedWorkContinues} != ${e.unrelated}`);
    if (d.ownerNotification !== e.notify) problems.push(`notify ${d.ownerNotification} != ${e.notify}`);
    let t;
    try {
      t = transition(it.start, { type: d.outcome, actor: 'automation', evidence: ALL_EVIDENCE, retryTarget: d.retryTarget ?? undefined });
    } catch (error) {
      t = { ok: false, reason: `threw ${error.message}` };
    }
    if (!t.ok || t.to !== e.final) problems.push(`fsm ${t.ok ? t.to : t.reason} != ${e.final}`);
    for (const v of checkDecisionInvariants(it.observations, d, policy)) problems.push(`${v.id}: ${v.message}`);
    items.push({
      label: it.label ?? null,
      ok: problems.length === 0,
      problems,
      decision: d,
      transition: t.ok ? { from: t.from, to: t.to } : { from: it.start.state, to: null, reason: t.reason },
    });
  }
  const attempts = [];
  for (const a of scenario.fsmAttempts) {
    const evidence = { ...ALL_EVIDENCE };
    for (const k of a.evidenceOmit ?? []) delete evidence[k];
    let r;
    try {
      r = transition(a.from, { ...a.event, evidence });
    } catch (error) {
      r = { ok: false, reason: `threw ${error.message}` };
    }
    const ok = r.ok === a.expectOk && (!a.expectTo || r.to === a.expectTo);
    attempts.push({ from: a.from, event: a.event.type, actor: a.event.actor, expectOk: a.expectOk, ok, result: r.ok ? r.to : r.reason });
  }
  return { id: scenario.id, ok: items.every((i) => i.ok) && attempts.every((a) => a.ok), items, attempts };
}

export function runAllScenarios(decide = defaultDecide, transition = defaultTransition) {
  return SCENARIOS.map((s) => runScenario(s, decide, transition));
}

// Near-baseline sampler: each dimension keeps its lane baseline with probability 1 - pFault.
// Produces a realistic mix of outcomes (uniform sampling is ~98% SYSTEM_HALT).
export function sampleNearBaseline(n, seed = 7, pFault = 0.12, decide = defaultDecide) {
  const next = rng(seed);
  const lanes = Object.keys(BASELINES);
  const outcomes = {};
  const violations = new Map();
  for (let i = 0; i < n; i += 1) {
    const lane = lanes[Math.floor(next() * lanes.length)];
    const o = { ...BASELINES[lane] };
    for (const key of DIMENSION_KEYS) {
      if (key === 'opClass') continue;
      if (next() < pFault) o[key] = DIMENSIONS[key][Math.floor(next() * DIMENSIONS[key].length)];
    }
    const policy = POLICIES[Math.floor(next() * 2)];
    let d;
    try {
      d = decide(o, policy);
    } catch (error) {
      violations.set('THROW', { id: 'THROW', message: error.message, example: o });
      continue;
    }
    outcomes[d.outcome] = (outcomes[d.outcome] ?? 0) + 1;
    for (const v of checkDecisionInvariants(o, d, policy)) {
      if (!violations.has(v.id)) violations.set(v.id, { ...v, example: o, outcome: d.outcome });
    }
  }
  return { sampled: n, seed, pFault, outcomes, violations: [...violations.values()] };
}

export const INVALID_OBSERVATIONS = Object.freeze([
  null,
  [],
  'publication',
  {},
  { ...BASELINES.publication, haltFence: 'probably_fine' },
  { ...BASELINES.publication, extraKey: 'x' },
  (() => { const o = { ...BASELINES.publication }; delete o.authority; return o; })(),
  { ...BASELINES.publication, authority: undefined },
  { ...BASELINES.publication, canonical: null },
  Object.assign(Object.create({ injected: true }), BASELINES.publication),
]);

export function checkInvalidObservations(decide = defaultDecide) {
  const failures = [];
  for (const o of INVALID_OBSERVATIONS) {
    let d;
    try {
      d = decide(o);
    } catch (error) {
      failures.push(`threw on invalid observation: ${error.message}`);
      continue;
    }
    if (d.outcome !== 'SYSTEM_HALT') failures.push(`invalid observation produced ${d.outcome}`);
  }
  for (const policy of [null, {}, { externalReadbackAuthoritative: 'yes' }, { externalReadbackAuthoritative: true, extra: 1 }]) {
    let d;
    try {
      d = decide(BASELINES.publication, policy);
    } catch (error) {
      failures.push(`threw on invalid policy: ${error.message}`);
      continue;
    }
    if (d.outcome !== 'SYSTEM_HALT') failures.push(`invalid policy produced ${d.outcome}`);
  }
  return failures;
}
