// Exhaustive / compositional oracle for the Batch 0 decision model.
//
// Proof shape:
//   decide(o) = compose(g_1(pi_1(o)), ..., g_5(pi_5(o)))   where pi_i is gate i's declared projection
//   (1) every gate is enumerated over its ENTIRE projection domain (plus the derived dispatched flag);
//       a Proxy fails the run if a gate reads an undeclared dimension, so the projection claim is checked.
//   (2) compose is enumerated over the product of every distinct verdict class each gate can emit.
//   => decide is total over the full product space (0 undefined decisions), and every property
//      expressed as "some gate forces severity >= X" holds everywhere because compose is max.
//   (3) end-to-end invariant predicates are additionally checked on every gate-domain point lifted to a
//       full observation, on the Section 12 kernel, and on a seeded random sample of the full space.

import {
  composeVerdicts, createDecider, DEFAULT_POLICY, DIMENSIONS, DIMENSION_KEYS, evaluateGate, GATES,
} from '../../../src/autonomy/decision-model.mjs';
import { OUTCOMES, SEVERITY } from '../../../src/autonomy/decision-outcomes.mjs';
import { BASELINES, POST_DISPATCH_BASELINES } from '../../../src/autonomy/fault-catalog.mjs';
import { checkDecisionInvariants } from '../../../src/autonomy/invariants.mjs';

export const POLICIES = Object.freeze([
  Object.freeze({ externalReadbackAuthoritative: false }),
  Object.freeze({ externalReadbackAuthoritative: true }),
]);

function* product(keys, domains) {
  if (keys.length === 0) { yield {}; return; }
  const [head, ...rest] = keys;
  for (const value of domains[head]) {
    for (const tail of product(rest, domains)) yield { [head]: value, ...tail };
  }
}

function fillFor(point) {
  const dispatched = point.effect !== undefined ? point.effect !== 'none' : point.__dispatched;
  const lane = point.opClass;
  if (dispatched) {
    return lane === 'read_only' ? { ...BASELINES.read_only, effect: 'success' } : { ...POST_DISPATCH_BASELINES[lane] };
  }
  return { ...BASELINES[lane] };
}

export function gateDomain(gate) {
  const keys = [...gate.dims];
  const hasEffect = keys.includes('effect');
  const points = [];
  for (const p of product(keys, DIMENSIONS)) {
    if (hasEffect) points.push(p);
    else for (const dispatched of [false, true]) points.push({ ...p, __dispatched: dispatched });
  }
  return points.map((p) => {
    const full = { ...fillFor(p), ...p };
    delete full.__dispatched;
    if (!hasEffect && p.__dispatched === false) full.effect = 'none';
    return Object.freeze(full);
  });
}

function guarded(observation, allowed) {
  return new Proxy(observation, {
    get(target, prop) {
      if (typeof prop === 'string' && !allowed.has(prop)) throw new Error(`gate read undeclared dimension ${prop}`);
      return target[prop];
    },
  });
}

const verdictClass = (v) => (v.outcome === null ? 'PASS' : `${v.outcome}|${v.haltScope ?? ''}|${v.retryTarget ?? ''}`);

export function exhaustGates(gates = GATES) {
  const report = [];
  const classes = {};
  for (const gate of gates) {
    const allowed = new Set([...gate.dims, 'effect']);
    const seen = new Map();
    let points = 0;
    const problems = [];
    for (const policy of gate.usesPolicy ? POLICIES : [DEFAULT_POLICY]) {
      for (const o of gateDomain(gate)) {
        points += 1;
        let v;
        try {
          v = evaluateGate(gate, guarded(o, allowed), policy);
        } catch (error) {
          problems.push(`${gate.id}: ${error.message}`);
          continue;
        }
        const dispatched = o.effect !== 'none';
        if (v.outcome !== null && !OUTCOMES.includes(v.outcome)) problems.push(`${gate.id}: undefined outcome ${v.outcome}`);
        if (v.outcome === 'SYSTEM_HALT' && !['component', 'lane', 'system'].includes(v.haltScope)) problems.push(`${gate.id}: halt without scope`);
        if (v.outcome === 'AUTO_RETRY' && !['plan', 'read', 'operation'].includes(v.retryTarget)) problems.push(`${gate.id}: retry without target`);
        if (v.outcome === 'AUTO_RETRY' && o.retryBudget !== 'available') problems.push(`${gate.id}: retry with exhausted budget`);
        if (gate.id === 'EFFECT' && dispatched && v.outcome === null) problems.push('EFFECT: post-dispatch PASS');
        if (dispatched && ['AUTO_IGNORE', 'OWNER_APPROVAL_REQUIRED', 'OWNER_ATTESTATION_REQUIRED'].includes(v.outcome)) {
          problems.push(`${gate.id}: post-dispatch ${v.outcome}`);
        }
        const cls = verdictClass(v);
        if (!seen.has(cls)) seen.set(cls, { verdict: v, dispatched, example: o });
      }
    }
    classes[gate.id] = [...seen.values()];
    report.push({ gate: gate.id, dims: [...gate.dims], points, verdictClasses: seen.size, problems: [...new Set(problems)] });
  }
  return { report, classes };
}

export function exhaustComposition(classes, compose = composeVerdicts) {
  const gateIds = Object.keys(classes);
  let combos = 0;
  const problems = [];
  const rank = { component: 0, lane: 1, system: 2 };
  const recurse = (index, chosen) => {
    if (index === gateIds.length) {
      combos += 1;
      const verdicts = chosen.map((c) => c.verdict);
      const result = compose(verdicts);
      if (!OUTCOMES.includes(result?.outcome)) { problems.push('undefined composition'); return; }
      const maxSev = Math.max(...verdicts.map((v) => (v.outcome === null ? 0 : SEVERITY[v.outcome])));
      if (SEVERITY[result.outcome] !== maxSev) problems.push(`composition not max: ${result.outcome}`);
      const halts = verdicts.filter((v) => v.outcome === 'SYSTEM_HALT');
      if (halts.length) {
        const widest = halts.reduce((a, v) => (rank[v.haltScope] > rank[a] ? v.haltScope : a), 'component');
        if (result.haltScope !== widest) problems.push('halt scope not widest');
      }
      return;
    }
    for (const c of classes[gateIds[index]]) recurse(index + 1, [...chosen, c]);
  };
  recurse(0, []);
  return { combos, problems: [...new Set(problems)] };
}

export function liftAndCheck(decide = createDecider(), gates = GATES) {
  let checked = 0;
  const violations = new Map();
  for (const gate of gates) {
    for (const policy of POLICIES) {
      for (const o of gateDomain(gate)) {
        checked += 1;
        const d = decide(o, policy);
        for (const v of checkDecisionInvariants(o, d, policy)) {
          if (!violations.has(v.id)) violations.set(v.id, { ...v, example: o, policy, outcome: d.outcome });
        }
      }
    }
  }
  return { checked, violations: [...violations.values()] };
}

// Section 12 kernel (the prompt's example dimensions), with an independent expected-outcome function
// that re-expresses the global decision tree. Mapped onto the canonical_mutation lane.
export const KERNEL_DIMENSIONS = Object.freeze({
  canonical_trustworthy: [true, false],
  external_side_effect: ['none', 'conclusive', 'ambiguous'],
  retry_safe: [true, false],
  item_local: [true, false],
  owner_authority_required: [true, false],
});

export function kernelObservation(k) {
  const o = { ...BASELINES.canonical_mutation };
  if (!k.canonical_trustworthy) { o.canonical = 'corrupt'; o.faultScope = k.item_local ? 'item' : 'system'; }
  if (k.external_side_effect === 'conclusive') { o.effect = 'success'; o.readback = 'proves_applied'; }
  if (k.external_side_effect === 'ambiguous') { o.effect = 'ambiguous'; o.readback = 'unavailable'; }
  if (!k.retry_safe) o.idempotency = 'missing';
  if (k.owner_authority_required) o.approval = 'missing';
  return o;
}

export function kernelExpected(k) {
  // Global tree, re-expressed independently of the gate code.
  if (k.external_side_effect !== 'none') {
    if (!k.canonical_trustworthy) return 'SYSTEM_HALT';
    if (k.external_side_effect === 'ambiguous') return 'SYSTEM_HALT';
    if (!k.retry_safe) return 'SYSTEM_HALT';
    if (k.owner_authority_required) return 'SYSTEM_HALT';
    return 'AUTO_RESOLVE';
  }
  if (!k.canonical_trustworthy) return k.item_local ? 'QUARANTINE' : 'SYSTEM_HALT';
  if (!k.retry_safe) return 'QUARANTINE';
  if (k.owner_authority_required) return 'OWNER_APPROVAL_REQUIRED';
  return 'AUTO_RESOLVE';
}

export function exhaustKernel(decide = createDecider()) {
  const rows = [];
  for (const k of product(Object.keys(KERNEL_DIMENSIONS), KERNEL_DIMENSIONS)) {
    const o = kernelObservation(k);
    const d = decide(o, DEFAULT_POLICY);
    const expected = kernelExpected(k);
    rows.push({ ...k, expected, actual: d.outcome, ok: expected === d.outcome, reason: d.primaryReason,
      invariantViolations: checkDecisionInvariants(o, d, DEFAULT_POLICY).map((v) => v.id) });
  }
  return rows;
}

// Seeded PRNG (mulberry32) so samples are reproducible.
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function sampleFullSpace(n, seed = 20260929, decide = createDecider()) {
  const next = rng(seed);
  const violations = new Map();
  const outcomes = Object.fromEntries(OUTCOMES.map((o) => [o, 0]));
  let determinismFailures = 0;
  for (let i = 0; i < n; i += 1) {
    const o = {};
    for (const key of DIMENSION_KEYS) o[key] = DIMENSIONS[key][Math.floor(next() * DIMENSIONS[key].length)];
    const policy = POLICIES[Math.floor(next() * 2)];
    const d = decide(o, policy);
    outcomes[d.outcome] += 1;
    if (i % 97 === 0) {
      const reversed = Object.fromEntries(Object.entries(o).reverse());
      if (JSON.stringify(decide(reversed, policy)) !== JSON.stringify(d)) determinismFailures += 1;
    }
    for (const v of checkDecisionInvariants(o, d, policy)) {
      if (!violations.has(v.id)) violations.set(v.id, { ...v, example: o, policy, outcome: d.outcome });
    }
  }
  return { sampled: n, seed, outcomes, determinismFailures, violations: [...violations.values()] };
}
