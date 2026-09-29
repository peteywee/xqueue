#!/usr/bin/env node
// Batch 0 evidence generator. Pure local: no network, no Cloudflare, no X, no credentials.
//
//   node scripts/autonomy-batch0-evidence.mjs --out <dir> [--history <mutation-run-1.json>] [--skip-mutation]
//
// Writes machine-readable evidence for the Batch 0 decision/failure model. Every number it emits is
// computed from a run, with numerator and denominator, so the package can be reproduced.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { OUTCOMES, OUTCOME_CONTRACTS } from '../src/autonomy/decision-outcomes.mjs';
import { decide, DEFAULT_POLICY, DIMENSIONS, fullSpaceSize, GATES } from '../src/autonomy/decision-model.mjs';
import { INVARIANTS, DECISION_INVARIANTS } from '../src/autonomy/invariants.mjs';
import { STATES, stateMachineSpec, transition, TRANSITIONS } from '../src/autonomy/state-machine.mjs';
import { FAULT_CATALOG } from '../src/autonomy/fault-catalog.mjs';
import { HAPPY_REQUIRED, REQUIRED_SCENARIOS, SCENARIOS } from '../test/autonomy/harness/scenarios.mjs';
import { runAllScenarios, sampleNearBaseline } from '../test/autonomy/harness/runner.mjs';
import {
  exhaustComposition, exhaustGates, exhaustKernel, liftAndCheck, sampleFullSpace,
} from '../test/autonomy/harness/oracle.mjs';
import { fsmGraph, fsmProperties } from '../test/autonomy/harness/fsm-oracle.mjs';
import { DISPATCH_FAULTS, explore, VERIFY_FAULTS } from '../test/autonomy/harness/sim.mjs';
import { runMutationAnalysis } from '../test/autonomy/harness/mutants.mjs';

function arg(name, fallback = null) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

const out = arg('--out');
if (!out) {
  console.error('usage: autonomy-batch0-evidence.mjs --out <dir> [--history <file>] [--skip-mutation]');
  process.exit(2);
}
mkdirSync(out, { recursive: true });
const write = (name, value) => writeFileSync(join(out, name), typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`);
const pct = (num, den) => ({ numerator: num, denominator: den, percent: den === 0 ? 0 : Math.floor((num / den) * 10000) / 100 });

// ------------------------------------------------------------------ scenarios / chaos matrix
const scenarioResults = runAllScenarios();
const matrix = [];
for (const [index, s] of SCENARIOS.entries()) {
  const r = scenarioResults[index];
  s.items.forEach((it, j) => {
    const d = r.items[j].decision;
    matrix.push({
      scenario_id: s.items.length > 1 ? `${s.id}#${it.label ?? j}` : s.id,
      family: s.family,
      polarity: s.polarity,
      covers: s.covers.join('|'),
      title: s.title,
      starting_state: `${it.start.state}${it.start.dispatched ? '(dispatched)' : ''}`,
      observations: Object.entries(it.observations).filter(([k, v]) => {
        const base = { publication: 'external' };
        void base;
        return true;
      }).map(([k, v]) => `${k}=${v}`).join(';'),
      injected_fault: s.injected_fault,
      policy: s.policy ? 'externalReadbackAuthoritative=true' : 'default',
      decision_outcome: d?.outcome ?? null,
      primary_reason: d?.primaryReason ?? null,
      expected_outcome: it.expect.outcome,
      expected_transition: `${it.start.state} --${it.expect.outcome}--> ${it.expect.final}`,
      actual_transition: r.items[j].transition?.to ? `${r.items[j].transition.from} --> ${r.items[j].transition.to}` : `REJECTED ${r.items[j].transition?.reason}`,
      canonical_state_change: d ? OUTCOME_CONTRACTS[d.outcome].canonicalChange : null,
      external_side_effect: d ? (d.externalSideEffectAllowed ? 'may_dispatch_next' : 'none') : null,
      retry_allowed: d?.retryAllowed ?? null,
      retry_target: d?.retryTarget ?? null,
      halt_scope: d?.haltScope ?? null,
      owner_notification: d?.ownerNotification ?? null,
      owner_action_required: d?.ownerActionRequired ?? null,
      unrelated_work_continues: d?.unrelatedWorkContinues ?? null,
      required_evidence: d ? d.requiredEvidence.join(' | ') : null,
      expected_final_state: it.expect.final,
      pass: r.items[j].ok && r.attempts.every((a) => a.ok),
    });
  });
}
write('07-chaos-test-matrix.json', { generated_by: 'scripts/autonomy-batch0-evidence.mjs', rows: matrix });
const csvCols = Object.keys(matrix[0]);
const csvEscape = (v) => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
write('07-chaos-test-matrix.csv', `${[csvCols.join(','), ...matrix.map((row) => csvCols.map((c) => csvEscape(row[c])).join(','))].join('\n')}\n`);
write('chaos-results.json', {
  scenarios: SCENARIOS.length,
  items: matrix.length,
  passed_scenarios: scenarioResults.filter((r) => r.ok).length,
  failed: scenarioResults.filter((r) => !r.ok).map((r) => ({ id: r.id, items: r.items.filter((i) => !i.ok), attempts: r.attempts.filter((a) => !a.ok) })),
  fsm_attempts: scenarioResults.flatMap((r) => r.attempts.map((a) => ({ scenario: r.id, ...a }))),
  by_family: Object.fromEntries(Object.keys(REQUIRED_SCENARIOS).map((f) => {
    const fam = SCENARIOS.map((s, i) => [s, scenarioResults[i]]).filter(([s]) => s.family === f);
    return [f, { scenarios: fam.length, passed: fam.filter(([, r]) => r.ok).length,
      happy: fam.filter(([s]) => s.polarity === 'happy').length, negative: fam.filter(([s]) => s.polarity === 'negative').length }];
  })),
});

// Required bullet coverage
const bulletRows = [];
for (const [family, bullets] of Object.entries(REQUIRED_SCENARIOS)) {
  for (const bullet of bullets) {
    const covering = SCENARIOS.map((s, i) => [s, scenarioResults[i]]).filter(([s]) => s.covers.includes(bullet));
    bulletRows.push({
      family, bullet, happy_bullet: HAPPY_REQUIRED.includes(bullet),
      scenarios: covering.map(([s]) => s.id),
      covered_passing: covering.some(([, r]) => r.ok),
      covered_by_passing_negative: covering.some(([s, r]) => s.polarity === 'negative' && r.ok),
    });
  }
}
const requiredBullets = bulletRows.length;
const coveredBullets = bulletRows.filter((b) => b.covered_passing).length;
const negativeBullets = bulletRows.filter((b) => !b.happy_bullet);
const negativeCovered = negativeBullets.filter((b) => b.covered_by_passing_negative).length;
const familiesCovered = Object.keys(REQUIRED_SCENARIOS).filter((f) => bulletRows.filter((b) => b.family === f).every((b) => b.covered_passing)).length;
const happyCount = SCENARIOS.filter((s) => s.polarity === 'happy').length;
const negativeCount = SCENARIOS.filter((s) => s.polarity === 'negative').length;

// ------------------------------------------------------------------ exhaustive decision space
const gates = exhaustGates();
const composition = exhaustComposition(gates.classes);
const lifted = liftAndCheck();
const kernel = exhaustKernel();
const uniform = sampleFullSpace(200000);
const near = sampleNearBaseline(100000, 7, 0.12);
const dense = sampleNearBaseline(100000, 8, 0.3);
const gatePoints = gates.report.reduce((n, r) => n + r.points, 0);
const gatePointsClean = gates.report.reduce((n, r) => n + (r.problems.length ? 0 : r.points), 0);
const decisionSpaceRequired = gatePoints + composition.combos + kernel.length;
const decisionSpaceVerified = gatePointsClean + (composition.problems.length ? 0 : composition.combos) + kernel.filter((k) => k.ok && !k.invariantViolations.length).length;

// ------------------------------------------------------------------ FSM
const fsmP = fsmProperties(transition);
const fsmG = fsmGraph(transition);
const spec = stateMachineSpec();
write('05-state-machine.json', {
  generated_by: 'src/autonomy/state-machine.mjs#stateMachineSpec',
  ...spec,
  transitions: TRANSITIONS.map((t) => ({ event: t.event, from: [...t.from], to: t.to, actor: t.actor, evidence: [...t.evidence], guard: t.guard ? t.note || 'guarded' : null })),
});
const statesWithRules = STATES.filter((s) => {
  const p = spec.perState[s];
  return (p.terminal || p.outbound.length > 0) && (s === 'RECEIVED' || p.inbound.length > 0) && 'canonicalMutation' in p;
}).length;

// ------------------------------------------------------------------ simulation
const combos = [];
for (const d0 of DISPATCH_FAULTS) for (const v0 of VERIFY_FAULTS) for (const d1 of DISPATCH_FAULTS) for (const v1 of VERIFY_FAULTS) {
  combos.push([{ dispatch: d0, verify: v0 }, { dispatch: d1, verify: v1 }]);
}
const shapes = {
  same_input: (f) => [{ key: 'k1', digest: 'd1', faults: f[0] }, { key: 'k1', digest: 'd1', faults: f[1] }],
  different_inputs: (f) => [{ key: 'k1', digest: 'd1', faults: f[0] }, { key: 'k2', digest: 'd2', faults: f[1] }],
  conflicting_identity: (f) => [{ key: 'k1', digest: 'd1', faults: f[0] }, { key: 'k1', digest: 'd9', faults: f[1] }],
};
const simRows = [];
let simStates = 0;
let simViolationStates = 0;
for (const lane of ['canonical_mutation', 'publication']) {
  for (const [shape, make] of Object.entries(shapes)) {
    let states = 0;
    const violations = new Set();
    const ends = {};
    for (const f of combos) {
      const r = explore({ lane, crashes: true, actors: make(f) });
      states += r.states;
      for (const v of r.violations) violations.add(v);
      for (const w of r.terminals) {
        const sig = w.actors.map((a) => a.item.state).join(',');
        ends[sig] = (ends[sig] ?? 0) + 1;
      }
    }
    simStates += states;
    if (violations.size) simViolationStates += 1;
    simRows.push({ lane, shape, fault_combinations: combos.length, crash_points: true, explored_states: states, violations: [...violations], terminal_distribution: ends });
  }
}
write('simulation-results.json', {
  description: 'Exhaustive state-graph exploration of two concurrent actors with injected dispatch/verify faults and crash points, driven by decide() + transition().',
  total_explored_states: simStates, runs: simRows,
});

// ------------------------------------------------------------------ invariants
const decisionInvIds = new Set(DECISION_INVARIANTS.map((i) => i.id));
const allDecisionViolations = [...lifted.violations, ...uniform.violations, ...near.violations, ...dense.violations,
  ...kernel.flatMap((k) => k.invariantViolations.map((id) => ({ id })))];
const scenarioInvViolations = scenarioResults.flatMap((r) => r.items.flatMap((i) => i.problems.filter((p) => /^INV-/.test(p)).map((p) => ({ id: p.slice(0, 6) }))));
const fsmInvariantChecks = {
  'INV-08': fsmP.failures.length === 0 && !TRANSITIONS.some((t) => t.to === 'COMPLETE' && t.from.includes('EXECUTING')),
  'INV-15': fsmP.failures.length === 0 && fsmG.failures.length === 0 && simRows.every((r) => r.violations.length === 0),
  'INV-16': simRows.every((r) => r.violations.length === 0),
  'INV-21': TRANSITIONS.filter((t) => t.from.includes('QUARANTINED')).every((t) => t.actor === 'owner'),
  'INV-22': TRANSITIONS.filter((t) => t.from.includes('HALTED')).every((t) => t.actor === 'owner'),
  'INV-25': TRANSITIONS.filter((t) => t.from.includes('RETRY_WAIT') || t.from.includes('DEFERRED')).every((t) => ['PLANNED', 'HALTED'].includes(t.to)),
  'INV-26': TRANSITIONS.filter((t) => t.from.includes('WAITING_ATTESTATION') || t.from.includes('WAITING_APPROVAL')).every((t) => t.actor === 'owner'),
  'INV-07': uniform.determinismFailures === 0,
};
const invariantRows = INVARIANTS.map((inv) => {
  let verified;
  let method;
  if (decisionInvIds.has(inv.id)) {
    const failed = [...allDecisionViolations, ...scenarioInvViolations].some((v) => v.id === inv.id);
    verified = !failed;
    method = 'executable predicate on 50,528 lifted gate-domain points, 48 kernel rows, 400,000 seeded samples, all scenarios; non-vacuity witness in test/autonomy-invariants.test.mjs';
    if (inv.id === 'INV-14') verified = verified && simRows.every((r) => r.violations.length === 0);
  } else {
    verified = fsmInvariantChecks[inv.id] === true;
    method = inv.check;
  }
  return { id: inv.id, origin: inv.origin, statement: inv.statement, justification: inv.justification ?? null, check: inv.check, method, verified };
});
write('06-invariants.json', { generated_by: 'src/autonomy/invariants.mjs', invariants: invariantRows });
write('invariant-results.json', {
  total: invariantRows.length,
  verified: invariantRows.filter((r) => r.verified).length,
  failed: invariantRows.filter((r) => !r.verified).map((r) => r.id),
  rows: invariantRows,
});

// ------------------------------------------------------------------ mutation
let mutation = null;
if (!process.argv.includes('--skip-mutation')) {
  const m = runMutationAnalysis();
  const history = arg('--history') ? JSON.parse(readFileSync(arg('--history'), 'utf8')) : null;
  mutation = {
    total: m.total, killed: m.killed, proven_equivalent: m.equivalent, survived: m.survived,
    survivors: m.survivors.map((s) => s.id),
    equivalent_ids: m.results.filter((r) => r.status === 'equivalent').map((r) => r.id),
    killed_by: Object.entries(m.results.filter((r) => r.status === 'killed').reduce((acc, r) => {
      const k = r.killedBy.replace(/:.*$/, '');
      acc[k] = (acc[k] ?? 0) + 1;
      return acc;
    }, {})).map(([suite, count]) => ({ suite, count })),
    history,
  };
  write('mutation-results.json', mutation);
}

// ------------------------------------------------------------------ coverage + confidence
const outcomesComplete = OUTCOMES.filter((o) => {
  const c = OUTCOME_CONTRACTS[o];
  return ['meaning', 'entryConditions', 'prohibitedEntryConditions', 'canonicalChange', 'externalSideEffect', 'retryPermitted',
    'unrelatedWorkContinues', 'ownerNotification', 'ownerResponseRequired', 'exitEvidence', 'fsmTargets', 'illegalTransitions',
    'idempotency', 'recovery'].every((f) => f in c);
}).length;

const coverage = {
  full_space: {
    dimensions: Object.keys(DIMENSIONS).length,
    cardinality: fullSpaceSize(),
    method: 'compositional: every gate exhaustively enumerated over its declared projection (proxy-enforced) + composition exhaustively enumerated over the product of gate verdict classes',
  },
  gates: gates.report,
  composition: { combinations: composition.combos, problems: composition.problems },
  lifted_end_to_end: { checked: lifted.checked, violations: lifted.violations.length },
  kernel_section12: { combinations: kernel.length, matches_independent_tree: kernel.filter((k) => k.ok).length, rows: kernel },
  samples: {
    uniform: { ...uniform, violations: uniform.violations.length },
    near_baseline: { ...near, violations: near.violations.length },
    near_baseline_dense: { ...dense, violations: dense.violations.length },
  },
  decision_space: pct(decisionSpaceVerified, decisionSpaceRequired),
  scenarios: {
    total: SCENARIOS.length, items: matrix.length, happy: happyCount, negative: negativeCount,
    negative_to_happy_ratio: Math.floor((negativeCount / happyCount) * 100) / 100,
    passing: scenarioResults.filter((r) => r.ok).length,
  },
  required_bullets: pct(coveredBullets, requiredBullets),
  required_negative_bullets: pct(negativeCovered, negativeBullets.length),
  bullet_rows: bulletRows,
  families: pct(familiesCovered, Object.keys(REQUIRED_SCENARIOS).length),
  fsm: {
    attempts_enumerated: fsmP.attempts, accepted: fsmP.accepted, rejected: fsmP.attempts - fsmP.accepted,
    property_failures: fsmP.failures, graph_nodes: fsmG.nodes, graph_failures: fsmG.failures,
  },
  simulation: { explored_states: simStates, runs_with_violations: simViolationStates },
  fault_catalog_entries: Object.keys(FAULT_CATALOG).length,
  gates_declared: GATES.map((g) => ({ id: g.id, rules: g.rules.length, dims: [...g.dims] })),
  default_policy: DEFAULT_POLICY,
};
write('coverage-summary.json', coverage);

const components = {
  outcomes_defined: pct(outcomesComplete, 8),
  fsm_states_with_transition_rules: pct(statesWithRules, STATES.length),
  illegal_transition_handling: pct(fsmP.attempts - fsmP.failures.length, fsmP.attempts),
  invariants_verified: pct(invariantRows.filter((r) => r.verified).length, invariantRows.length),
  chaos_families_covered: pct(familiesCovered, Object.keys(REQUIRED_SCENARIOS).length),
  decision_space_coverage: coverage.decision_space,
  required_scenario_coverage: coverage.required_bullets,
  negative_path_coverage: coverage.required_negative_bullets,
  scenario_pass_rate: pct(scenarioResults.filter((r) => r.ok).length, SCENARIOS.length),
  simulation_safety: pct(simRows.filter((r) => r.violations.length === 0).length, simRows.length),
};
if (mutation) components.mutation_kill_rate_non_equivalent = pct(mutation.killed, mutation.total - mutation.proven_equivalent);
write('model-metrics.json', {
  definition: 'Each component is numerator/denominator from this run, truncated (never rounded up) to 2 decimals. The package-level overall confidence is the MINIMUM of all components plus deliverables and test pass rate computed by the packager.',
  components,
  negative_to_happy: { negative: negativeCount, happy: happyCount },
  contradictions: scenarioResults.filter((r) => !r.ok).length + composition.problems.length + gates.report.reduce((n, r) => n + r.problems.length, 0),
  undefined_decisions: [...gates.report.flatMap((r) => r.problems.filter((p) => /undefined/.test(p))), ...composition.problems.filter((p) => /undefined/.test(p))].length,
});

console.log(JSON.stringify({ out, components }, null, 2));
void decide;
