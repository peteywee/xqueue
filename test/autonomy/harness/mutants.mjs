// Mutation analysis for the Batch 0 model: does the test oracle actually detect a wrong model?
//
// Each mutant is a deliberately broken variant of the decision model or FSM. A mutant is KILLED
// when the kill suite (the same checks the tests run) reports any failure. A surviving mutant is
// classified EQUIVALENT only by mechanical proof:
//   * decision mutants: the mutated gate's verdict equals the original on its ENTIRE projection
//     domain, OR every differing point, lifted with minimal-severity context (all other gates PASS,
//     or EFFECT=AUTO_RESOLVE post-dispatch), yields an identical decision (reasons excluded). Because
//     composition is max-severity, minimal context maximizes visibility, so no context can expose it.
//   * FSM mutants: identical results on every (state, dispatched, event, actor, retryTarget) attempt,
//     with full evidence and with each evidence key removed.
// Any other survivor is a TEST GAP and is reported as unresolved.

import {
  composeVerdicts, createDecider, DEFAULT_POLICY, GATES, makeGateEvaluator,
} from '../../../src/autonomy/decision-model.mjs';
import { OUTCOMES, SEVERITY } from '../../../src/autonomy/decision-outcomes.mjs';
import { createTransition, resumeFromCrash as realResumeFromCrash, STATES, TRANSITIONS, transition as realTransition } from '../../../src/autonomy/state-machine.mjs';
import { exhaustComposition, exhaustGates, exhaustKernel, gateDomain, POLICIES } from './oracle.mjs';
import { fsmGraph, fsmProperties, resumeProperties, allAttempts } from './fsm-oracle.mjs';
import { checkInvalidObservations, runAllScenarios, sampleNearBaseline } from './runner.mjs';
import { ALL_EVIDENCE } from './scenarios.mjs';

const BY_SEVERITY = [...OUTCOMES].sort((a, b) => SEVERITY[a] - SEVERITY[b]);

function withVerdict(original, outcome) {
  return (o, p) => {
    const v = original(o, p);
    const next = { ...v, outcome, reason: `${v.reason}__mutant` };
    if (outcome === 'SYSTEM_HALT') next.haltScope = v.haltScope ?? 'lane';
    else delete next.haltScope;
    if (outcome === 'AUTO_RETRY') { next.retryTarget = v.retryTarget ?? 'plan'; next.exhaustTo = v.exhaustTo ?? 'AUTO_DEFER'; }
    else { delete next.retryTarget; delete next.exhaustTo; }
    return Object.freeze(next);
  };
}

function replaceRule(gates, gateIndex, ruleIndex, replacement) {
  return gates.map((g, gi) => {
    if (gi !== gateIndex) return g;
    const rules = g.rules.flatMap((r, ri) => (ri === ruleIndex ? (replacement ? [replacement] : []) : [r]));
    return { ...g, rules };
  });
}

export function decisionMutants() {
  const mutants = [];
  GATES.forEach((gate, gi) => {
    gate.rules.forEach((rule, ri) => {
      const sample = (() => {
        for (const o of gateDomain(gate)) {
          for (const p of POLICIES) {
            const phase = o.effect === 'none' ? 'pre' : 'post';
            if ((rule.phase === 'both' || rule.phase === phase) && rule.when(o, p)) return rule.verdict(o, p);
          }
        }
        return null;
      })();
      const outcome = sample?.outcome;
      mutants.push({ id: `drop:${rule.id}`, kind: 'decision', gateIndex: gi, gates: replaceRule(GATES, gi, ri, null) });
      if (outcome) {
        const lower = BY_SEVERITY.filter((x) => SEVERITY[x] < SEVERITY[outcome]);
        const targets = new Set();
        if (lower.length) { targets.add(lower[lower.length - 1]); targets.add('AUTO_RESOLVE'); }
        if (outcome === 'AUTO_RESOLVE') targets.add('SYSTEM_HALT');
        for (const t of targets) {
          if (t === outcome) continue;
          mutants.push({
            id: `verdict:${rule.id}->${t}`, kind: 'decision', gateIndex: gi,
            gates: replaceRule(GATES, gi, ri, { ...rule, verdict: withVerdict(rule.verdict, t) }),
          });
        }
        if (outcome === 'AUTO_RETRY' && sample.retryTarget !== 'operation') {
          mutants.push({
            id: `target:${rule.id}->operation`, kind: 'decision', gateIndex: gi,
            gates: replaceRule(GATES, gi, ri, { ...rule, verdict: (o, p) => ({ ...rule.verdict(o, p), retryTarget: 'operation' }) }),
          });
        }
        if (outcome === 'SYSTEM_HALT' && sample.haltScope !== 'component') {
          mutants.push({
            id: `scope:${rule.id}->component`, kind: 'decision', gateIndex: gi,
            gates: replaceRule(GATES, gi, ri, { ...rule, verdict: (o, p) => ({ ...rule.verdict(o, p), haltScope: 'component' }) }),
          });
        }
      }
      if (rule.phase !== 'both') {
        mutants.push({ id: `phase:${rule.id}->both`, kind: 'decision', gateIndex: gi, gates: replaceRule(GATES, gi, ri, { ...rule, phase: 'both' }) });
      } else {
        mutants.push({ id: `phase:${rule.id}->pre`, kind: 'decision', gateIndex: gi, gates: replaceRule(GATES, gi, ri, { ...rule, phase: 'pre' }) });
      }
    });
  });
  // Whole-model mutants.
  const naive = GATES.map((g) => ({ ...g, rules: g.rules.filter((r) => r.phase !== 'post').map((r) => ({ ...r, phase: 'both' })) }));
  mutants.push({ id: 'model:naive-phase-blind-composition', kind: 'decision', gateIndex: null, gates: naive });
  mutants.push({
    id: 'compose:min-severity', kind: 'decision', gateIndex: null,
    compose: (verdicts) => {
      const live = verdicts.filter((v) => v.outcome !== null);
      if (!live.length) return composeVerdicts([]);
      return live.reduce((a, v) => (SEVERITY[v.outcome] < SEVERITY[a.outcome] ? v : a));
    },
  });
  mutants.push({
    id: 'compose:first-verdict-wins', kind: 'decision', gateIndex: null,
    compose: (verdicts) => verdicts.find((v) => v.outcome !== null) ?? composeVerdicts([]),
  });
  mutants.push({
    id: 'compose:halt-scope-narrowest', kind: 'decision', gateIndex: null,
    compose: (verdicts) => {
      const r = composeVerdicts(verdicts);
      return r.outcome === 'SYSTEM_HALT' ? { ...r, haltScope: 'component' } : r;
    },
  });
  mutants.push({ id: 'model:retry-budget-ignored', kind: 'decision', gateIndex: null, evaluate: makeGateEvaluator({ budget: false }) });
  mutants.push({ id: 'model:no-validation', kind: 'decision', gateIndex: null, validate: false });
  mutants.push({ id: 'model:default-policy-trusts-external-readback', kind: 'decision', gateIndex: null,
    defaultPolicy: { externalReadbackAuthoritative: true } });
  return mutants;
}

export function fsmMutants() {
  const mutants = [];
  TRANSITIONS.forEach((row, i) => {
    const label = `${row.event}:${row.from.join('/')}->${row.to}`;
    if (row.evidence.length) {
      mutants.push({ id: `fsm:no-evidence:${label}`, kind: 'fsm', table: TRANSITIONS.map((r, j) => (j === i ? { ...r, evidence: [] } : r)) });
    }
    if (row.guard) {
      mutants.push({ id: `fsm:no-guard:${label}`, kind: 'fsm', table: TRANSITIONS.map((r, j) => (j === i ? { ...r, guard: null } : r)) });
    }
    if (row.actor === 'owner') {
      mutants.push({ id: `fsm:automation-actor:${label}`, kind: 'fsm', table: TRANSITIONS.map((r, j) => (j === i ? { ...r, actor: 'automation' } : r)) });
    }
    mutants.push({ id: `fsm:drop-row:${label}`, kind: 'fsm', table: TRANSITIONS.filter((_, j) => j !== i) });
  });
  const add = (id, extra) => mutants.push({ id, kind: 'fsm', table: [...TRANSITIONS, extra] });
  add('fsm:add:EXECUTING-AUTO_RESOLVE->COMPLETE', { event: 'AUTO_RESOLVE', from: ['EXECUTING'], to: 'COMPLETE', actor: 'automation', evidence: [], guard: null });
  add('fsm:add:QUARANTINED-SYSTEM_HALT->HALTED', { event: 'SYSTEM_HALT', from: ['QUARANTINED', 'WAITING_APPROVAL'], to: 'HALTED', actor: 'automation', evidence: ['halt_record'], guard: null });
  add('fsm:add:RETRY_WAIT-RETRY_READY->EXECUTING', { event: 'DEFER_ELAPSED', from: ['RETRY_WAIT'], to: 'EXECUTING', actor: 'automation', evidence: [], guard: null });
  add('fsm:add:HALTED-automation-clear', { event: 'OWNER_CLEARED_HALT', from: ['HALTED'], to: 'RECEIVED', actor: 'automation', evidence: ['halt_clear_generation'], guard: (i) => i.dispatched === false });
  add('fsm:add:generator-approval', { event: 'OWNER_APPROVED', from: ['WAITING_APPROVAL'], to: 'PLANNED', actor: 'generator', evidence: ['approval_exact_digest'], guard: null });
  add('fsm:add:VERIFYING-AUTO_IGNORE->IGNORED', { event: 'AUTO_IGNORE', from: ['VERIFYING'], to: 'IGNORED', actor: 'automation', evidence: ['ignore_basis'], guard: null });
  add('fsm:add:WAITING_APPROVAL-timeout', { event: 'DEFER_ELAPSED', from: ['WAITING_APPROVAL'], to: 'PLANNED', actor: 'automation', evidence: [], guard: null });
  add('fsm:add:QUARANTINED-delete', { event: 'AUTO_IGNORE', from: ['QUARANTINED'], to: 'IGNORED', actor: 'automation', evidence: [], guard: null });
  mutants.push({ id: 'fsm:halt-from-executing-does-not-mark-dispatched', kind: 'fsm', table: TRANSITIONS, haltFromExecutingMarksDispatched: false });
  mutants.push({
    id: 'fsm:owner-clear-returns-to-PLANNED', kind: 'fsm',
    table: TRANSITIONS.map((r) => (r.event === 'OWNER_CLEARED_HALT' ? { ...r, to: 'PLANNED' } : r)),
  });
  mutants.push({
    id: 'fsm:resume-skips-dispatch-consistency', kind: 'fsm', table: TRANSITIONS,
    resume: (item) => {
      const from = item?.state;
      if (!STATES.includes(from)) return Object.freeze({ ok: false, from: from ?? null, to: from ?? null, reason: 'unknown_state' });
      if (from === 'EXECUTING') {
        return Object.freeze({ ok: true, from, to: 'VERIFYING', item: Object.freeze({ state: 'VERIFYING', dispatched: true }) });
      }
      return Object.freeze({ ok: true, from, to: from, item: Object.freeze({ ...item }) });
    },
  });
  return mutants;
}

function decisionKillSuite(decide, mutant) {
  try {
    if (mutant.gates) {
      const g = exhaustGates(mutant.gates);
      if (g.report.some((r) => r.problems.length)) return 'gate structural properties';
    }
    if (mutant.compose) {
      const g = exhaustGates();
      if (exhaustComposition(g.classes, mutant.compose).problems.length) return 'composition properties';
    }
    if (runAllScenarios(decide, realTransition).some((s) => !s.ok)) return 'scenario matrix';
    if (exhaustKernel(decide).some((r) => !r.ok || r.invariantViolations.length)) return 'section-12 kernel';
    if (checkInvalidObservations(decide).length) return 'invalid observations';
    if (sampleNearBaseline(4000, 11, 0.12, decide).violations.length) return 'near-baseline invariants';
    if (sampleNearBaseline(4000, 12, 0.3, decide).violations.length) return 'near-baseline invariants (dense)';
  } catch (error) {
    return `threw: ${error.message}`;
  }
  return null;
}

function fsmKillSuite(transition, resume = realResumeFromCrash) {
  try {
    if (runAllScenarios(undefined, transition).some((s) => !s.ok)) return 'scenario matrix';
    if (fsmProperties(transition).failures.length) return 'fsm properties';
    if (fsmGraph(transition).failures.length) return 'fsm graph';
    if (resumeProperties(resume).failures.length) return 'crash-resume properties';
  } catch (error) {
    return `threw: ${error.message}`;
  }
  return null;
}

const semantic = (d) => JSON.stringify({ ...d, reasons: undefined, primaryReason: undefined });

function decisionEquivalent(mutant, mutantDecide) {
  const original = createDecider();
  const gates = mutant.gateIndex === null ? GATES : [GATES[mutant.gateIndex]];
  for (const gate of gates) {
    for (const policy of POLICIES) {
      for (const o of gateDomain(gate)) {
        let a;
        let b;
        try { a = semantic(original(o, policy)); b = semantic(mutantDecide(o, policy)); } catch { return false; }
        if (a !== b) return false;
      }
    }
  }
  return true;
}

function fsmEquivalent(mutantTransition, mutantResume = realResumeFromCrash) {
  for (const { item, event } of allAttempts()) {
    const variants = [event, ...Object.keys(ALL_EVIDENCE).map((k) => {
      const evidence = { ...ALL_EVIDENCE };
      delete evidence[k];
      return { ...event, evidence };
    })];
    for (const ev of variants) {
      const a = JSON.stringify(realTransition(item, ev));
      let b;
      try { b = JSON.stringify(mutantTransition(item, ev)); } catch { return false; }
      if (a !== b) return false;
    }
  }
  const resumeCases = [
    ...STATES.flatMap((state) => [false, true].map((dispatched) => ({ state, dispatched }))),
    { state: 'PLANNED' },
    { state: 'NOT_A_STATE', dispatched: false },
  ];
  for (const item of resumeCases) {
    const a = JSON.stringify(realResumeFromCrash(item));
    let b;
    try { b = JSON.stringify(mutantResume(item)); } catch { return false; }
    if (a !== b) return false;
  }
  return true;
}

export function runMutationAnalysis() {
  const results = [];
  for (const m of decisionMutants()) {
    const decide = createDecider({
      gates: m.gates ?? GATES, compose: m.compose ?? composeVerdicts, evaluate: m.evaluate,
      validate: m.validate ?? true, defaultPolicy: m.defaultPolicy ?? DEFAULT_POLICY,
    });
    const killedBy = decisionKillSuite(decide, m);
    let status = killedBy ? 'killed' : 'survived';
    if (!killedBy && m.gateIndex !== null && decisionEquivalent(m, decide)) status = 'equivalent';
    results.push({ id: m.id, kind: 'decision', status, killedBy });
  }
  for (const m of fsmMutants()) {
    const transition = createTransition({ table: m.table, haltFromExecutingMarksDispatched: m.haltFromExecutingMarksDispatched ?? true });
    const killedBy = fsmKillSuite(transition, m.resume ?? realResumeFromCrash);
    let status = killedBy ? 'killed' : 'survived';
    if (!killedBy && fsmEquivalent(transition, m.resume ?? realResumeFromCrash)) status = 'equivalent';
    results.push({ id: m.id, kind: 'fsm', status, killedBy });
  }
  const total = results.length;
  const killed = results.filter((r) => r.status === 'killed').length;
  const equivalent = results.filter((r) => r.status === 'equivalent').length;
  const survivors = results.filter((r) => r.status === 'survived');
  return { total, killed, equivalent, survived: survivors.length, survivors, results };
}
