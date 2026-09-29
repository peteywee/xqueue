// Batch 0 — Autonomous decision model (pure, deterministic, no I/O).
//
// decide(observation, policy) -> decision
//
// Structure (compositional, so it can be verified exhaustively):
//   1. validate the observation against a closed, finite schema (unknown => SYSTEM_HALT)
//   2. evaluate five independent gates, each reading a declared projection of the observation
//      plus the derived `dispatched` flag (effect !== 'none'):
//         SYSTEM   canonical trust, fault scope, halt fence, authority, checkpoint
//         FENCE    runtime/assignment version fence, lease/concurrency
//         EFFECT   side-effect outcome, target, readback, dispatch preconditions, idempotency
//         INPUT    input structure/identity, classification certainty
//         CONTENT  claims, sensitivity, authority assertions, meaning drift, approval
//   3. each gate returns its single strongest verdict (or PASS)
//   4. compose = maximum severity across gate verdicts
//
// Post-dispatch semantics live INSIDE each gate (the `post` rules). A naive composition
// that applies pre-dispatch verdicts after an effect may have happened is unsafe: it can
// downgrade an authority breach to an owner request. Batch 0 keeps that naive composition as
// a documented mutant and proves the test oracle kills it.

import { OUTCOME_CONTRACTS, OUTCOMES, SEVERITY } from './decision-outcomes.mjs';

export const DIMENSIONS = Object.freeze({
  opClass: Object.freeze(['publication', 'canonical_mutation', 'staging', 'read_only']),
  canonical: Object.freeze(['trusted', 'unreadable', 'corrupt']),
  faultScope: Object.freeze(['none', 'item', 'system', 'unknown']),
  haltFence: Object.freeze(['satisfied', 'blocking', 'generation_changed', 'unreadable']),
  authority: Object.freeze(['bound', 'changed', 'not_bound', 'unknown']),
  checkpoint: Object.freeze(['none', 'valid', 'stale', 'corrupt']),
  versionFence: Object.freeze([
    'current',
    'stale_runtime',
    'stale_assignment',
    'assignment_missing',
    'assignment_multiplicity',
    'not_applicable',
  ]),
  concurrency: Object.freeze(['none', 'contended', 'completed_elsewhere', 'lease_lost']),
  effect: Object.freeze(['none', 'success', 'failure_transient', 'failure_permanent', 'ambiguous']),
  effectTarget: Object.freeze(['internal', 'external']),
  readback: Object.freeze(['not_performed', 'proves_applied', 'proves_not_applied', 'unavailable', 'contradictory']),
  dispatchPreconditions: Object.freeze(['verified', 'unverified']),
  idempotency: Object.freeze(['present', 'missing']),
  retryBudget: Object.freeze(['available', 'exhausted']),
  input: Object.freeze(['valid', 'malformed', 'hostile', 'unsupported', 'duplicate', 'conflicting', 'vanished']),
  classification: Object.freeze(['deterministic', 'uncertain']),
  claims: Object.freeze([
    'none',
    'supported',
    'unsupported_experiential',
    'unsupported_factual',
    'stale_current_fact',
    'contradicted',
  ]),
  sensitivity: Object.freeze(['none', 'sensitive', 'restricted']),
  generatedAuthorityClaim: Object.freeze(['none', 'attempted']),
  meaningDrift: Object.freeze(['none', 'detected']),
  approval: Object.freeze(['not_required', 'owner_exact_digest', 'missing', 'digest_mismatch', 'synthesized']),
});

export const DIMENSION_KEYS = Object.freeze(Object.keys(DIMENSIONS));

export const DEFAULT_POLICY = Object.freeze({
  // RUNBOOK: reconciling an ambiguous external publication outcome is owner-reserved.
  // Automation readback of X is attached as evidence, never used as authority, while false.
  externalReadbackAuthoritative: false,
});

// Lane capability matrix. A plan or effect outside its lane's capability is a component defect.
export const LANES = Object.freeze({
  publication: Object.freeze({ lane: 'publication', mutating: true, allowedTarget: 'external' }),
  canonical_mutation: Object.freeze({ lane: 'mutation', mutating: true, allowedTarget: 'internal' }),
  staging: Object.freeze({ lane: 'staging', mutating: false, allowedTarget: 'internal' }),
  read_only: Object.freeze({ lane: 'read', mutating: false, allowedTarget: null }),
});

const mutating = (o) => LANES[o.opClass].mutating;
const itemBearing = (o) => o.opClass !== 'read_only';
const promoting = (o) => o.opClass === 'publication' || o.opClass === 'canonical_mutation';
const readScope = (o) => (o.opClass === 'read_only' ? 'component' : 'lane');
const corruptScope = (o) => (o.opClass === 'read_only' ? 'component' : 'system');

const v = (outcome, reason, extra = {}) => Object.freeze({ outcome, reason, ...extra });
const retry = (reason, retryTarget, exhaustTo, exhaustScope = 'lane') =>
  v('AUTO_RETRY', reason, { retryTarget, exhaustTo, exhaustScope });
const halt = (reason, haltScope) => v('SYSTEM_HALT', reason, { haltScope });

// Rule: { id, phase: 'pre'|'post'|'both', when(o, policy), verdict | verdictFn(o, policy) }
const rule = (id, phase, when, verdict) => Object.freeze({ id, phase, when, verdict });

// ---------------------------------------------------------------------------
// SYSTEM gate
// ---------------------------------------------------------------------------
const SYSTEM_RULES = Object.freeze([
  rule('S-inconsistent-scope', 'both', (o) => o.canonical === 'trusted' && o.faultScope !== 'none', () =>
    halt('inconsistent_observation_fault_scope_without_fault', 'component')),
  rule('S-corrupt-item', 'pre', (o) => o.canonical === 'corrupt' && o.faultScope === 'item', () =>
    v('QUARANTINE', 'canonical_record_corrupt_item_local')),
  rule('S-corrupt-system', 'pre', (o) => o.canonical === 'corrupt' && o.faultScope !== 'item', (o) =>
    halt('canonical_corrupt_system_or_unknown_scope', corruptScope(o))),
  rule('S-corrupt-post', 'post', (o) => o.canonical === 'corrupt', (o) =>
    halt('canonical_corrupt_after_dispatch', corruptScope(o))),
  rule('S-unreadable-pre', 'pre', (o) => o.canonical === 'unreadable', (o) =>
    retry('canonical_read_failed', 'read', 'SYSTEM_HALT', readScope(o))),
  rule('S-unreadable-post', 'post', (o) => o.canonical === 'unreadable', () =>
    halt('outcome_unrecordable_canonical_unreadable', 'lane')),
  rule('S-authority-unknown', 'both', (o) => mutating(o) && o.authority === 'unknown', () =>
    halt('authority_unknown', 'system')),
  rule('S-authority-not-bound', 'both', (o) => mutating(o) && o.authority === 'not_bound', () =>
    halt('authority_not_bound_to_component', 'component')),
  rule('S-authority-changed-pre', 'pre', (o) => mutating(o) && o.authority === 'changed', () =>
    retry('authority_changed_after_plan', 'plan', 'SYSTEM_HALT')),
  rule('S-authority-changed-post', 'post', (o) => mutating(o) && o.authority === 'changed', () =>
    halt('authority_changed_after_dispatch', 'lane')),
  rule('S-halt-unreadable', 'pre', (o) => mutating(o) && o.haltFence === 'unreadable', () =>
    halt('halt_state_unreadable', 'lane')),
  rule('S-halt-generation-changed', 'pre', (o) => mutating(o) && o.haltFence === 'generation_changed', () =>
    retry('halt_generation_changed_after_plan', 'plan', 'SYSTEM_HALT')),
  rule('S-publication-halted', 'pre', (o) => o.opClass === 'publication' && o.haltFence === 'blocking', () =>
    v('AUTO_DEFER', 'publication_halted')),
  rule('S-mutation-lane-halted', 'pre', (o) => o.opClass === 'canonical_mutation' && o.haltFence === 'blocking', () =>
    v('AUTO_DEFER', 'mutation_lane_halted')),
  rule('S-checkpoint-corrupt-mutating', 'both', (o) => mutating(o) && o.checkpoint === 'corrupt', () =>
    halt('checkpoint_corrupt', 'lane')),
  rule('S-checkpoint-corrupt-nonmutating', 'pre', (o) => !mutating(o) && o.checkpoint === 'corrupt', () =>
    retry('checkpoint_corrupt_restart_nonmutating', 'plan', 'AUTO_DEFER')),
  rule('S-checkpoint-corrupt-nonmutating-post', 'post', (o) => !mutating(o) && o.checkpoint === 'corrupt', () =>
    halt('checkpoint_corrupt_after_dispatch', 'lane')),
  rule('S-checkpoint-stale-pre', 'pre', (o) => o.checkpoint === 'stale', () =>
    retry('checkpoint_stale', 'plan', 'AUTO_DEFER')),
  rule('S-checkpoint-stale-post', 'post', (o) => o.checkpoint === 'stale', () =>
    halt('stale_checkpoint_with_dispatch', 'lane')),
]);

// ---------------------------------------------------------------------------
// FENCE gate
// ---------------------------------------------------------------------------
const FENCE_RULES = Object.freeze([
  rule('F-multiplicity', 'both', (o) => mutating(o) && o.versionFence === 'assignment_multiplicity', () =>
    halt('assignment_multiplicity', 'system')),
  rule('F-missing-pre', 'pre', (o) => mutating(o) && o.versionFence === 'assignment_missing', () =>
    v('QUARANTINE', 'current_assignment_missing')),
  rule('F-superseded-pre', 'pre', (o) => mutating(o) && o.versionFence === 'stale_assignment', () =>
    v('AUTO_IGNORE', 'assignment_superseded')),
  rule('F-stale-runtime-pre', 'pre', (o) => mutating(o) && o.versionFence === 'stale_runtime', () =>
    retry('runtime_generation_stale', 'plan', 'AUTO_DEFER')),
  rule('F-no-fence-pre', 'pre', (o) => mutating(o) && o.versionFence === 'not_applicable', () =>
    v('QUARANTINE', 'fence_evidence_missing')),
  rule('F-assignment-changed-post', 'post', (o) =>
    mutating(o) && ['stale_assignment', 'assignment_missing', 'not_applicable'].includes(o.versionFence), () =>
    halt('assignment_fence_broken_after_dispatch', 'lane')),
  rule('F-completed-elsewhere-pre', 'pre', (o) => itemBearing(o) && o.concurrency === 'completed_elsewhere', () =>
    v('AUTO_IGNORE', 'idempotency_identity_already_committed')),
  rule('F-contended-pre', 'pre', (o) => itemBearing(o) && o.concurrency === 'contended', () =>
    v('AUTO_DEFER', 'lease_contended')),
  rule('F-lease-lost-pre', 'pre', (o) => itemBearing(o) && o.concurrency === 'lease_lost', () =>
    retry('lease_lost_before_dispatch', 'plan', 'AUTO_DEFER')),
  rule('F-lease-post', 'post', (o) => itemBearing(o) && ['contended', 'lease_lost'].includes(o.concurrency), () =>
    halt('lease_lost_after_dispatch', 'lane')),
  rule('F-concurrent-completion-post', 'post', (o) => itemBearing(o) && o.concurrency === 'completed_elsewhere', () =>
    halt('concurrent_completion_after_dispatch_possible_duplicate', 'lane')),
]);

// ---------------------------------------------------------------------------
// EFFECT gate
// ---------------------------------------------------------------------------
const capabilityViolation = (o) => {
  const allowed = LANES[o.opClass].allowedTarget;
  return allowed === null ? o.effect !== 'none' : o.effectTarget !== allowed;
};

const EFFECT_RULES = Object.freeze([
  // Pre-dispatch
  rule('E-capability-pre', 'pre', (o) => o.opClass !== 'read_only' && capabilityViolation(o), () =>
    halt('lane_capability_violation', 'component')),
  rule('E-idempotency-pre', 'pre', (o) => itemBearing(o) && o.idempotency === 'missing', () =>
    v('QUARANTINE', 'idempotency_identity_missing')),
  rule('E-resume-already-applied', 'pre', (o) => itemBearing(o) && o.readback === 'proves_applied', () =>
    v('AUTO_IGNORE', 'already_applied_by_prior_run')),
  rule('E-resume-readback-unavailable', 'pre', (o) => itemBearing(o) && o.readback === 'unavailable', () =>
    retry('resume_readback_unavailable', 'read', 'SYSTEM_HALT')),
  rule('E-resume-readback-contradictory', 'pre', (o) => itemBearing(o) && o.readback === 'contradictory', () =>
    halt('resume_readback_contradictory', 'lane')),

  // Post-dispatch (read_only is handled solely by E-read-only-effect at component scope)
  rule('E-read-only-effect', 'post', (o) => o.opClass === 'read_only', () =>
    halt('read_only_component_produced_effect', 'component')),
  rule('E-capability-post', 'post', (o) => itemBearing(o) && o.opClass !== 'read_only' && capabilityViolation(o), () =>
    halt('lane_capability_violation_after_dispatch', 'lane')),
  rule('E-unverified-preconditions', 'post', (o) => itemBearing(o) && o.dispatchPreconditions !== 'verified', () =>
    halt('effect_without_verified_preconditions', 'lane')),
  rule('E-no-idempotency-post', 'post', (o) => itemBearing(o) && o.idempotency !== 'present', () =>
    halt('effect_without_idempotency_identity', 'lane')),
  rule('E-contradiction', 'post', (o) => itemBearing(o) && (
    o.readback === 'contradictory' ||
    (o.effect === 'success' && o.readback === 'proves_not_applied') ||
    (['failure_transient', 'failure_permanent'].includes(o.effect) && o.readback === 'proves_applied')
  ), () => halt('outcome_contradiction', 'lane')),

  // success
  rule('E-success-internal-proven', 'post', (o) => itemBearing(o) &&
    o.effect === 'success' && o.effectTarget === 'internal' && o.readback === 'proves_applied', () =>
    v('AUTO_RESOLVE', 'outcome_proven_applied')),
  rule('E-success-internal-unverified', 'post', (o) => itemBearing(o) &&
    o.effect === 'success' && o.effectTarget === 'internal' && ['not_performed', 'unavailable'].includes(o.readback), () =>
    halt('verification_unavailable_or_not_performed', 'lane')),
  rule('E-success-external', 'post', (o) => itemBearing(o) &&
    o.effect === 'success' && o.effectTarget === 'external' && ['not_performed', 'proves_applied', 'unavailable'].includes(o.readback), () =>
    v('AUTO_RESOLVE', 'external_conclusive_success')),

  // explicit failures (conclusive not applied)
  rule('E-failure-internal-unverified', 'post', (o) => itemBearing(o) &&
    ['failure_transient', 'failure_permanent'].includes(o.effect) && o.effectTarget === 'internal' &&
    ['not_performed', 'unavailable'].includes(o.readback), () =>
    halt('failure_not_verified_by_readback', 'lane')),
  // A CAS rejection because the runtime generation advanced is a stale fence, not a store fault:
  // re-plan, and defer (never halt) if contention persists (Batch 0 finding F-03).
  rule('E-cas-conflict-internal', 'post', (o) => itemBearing(o) &&
    o.effect === 'failure_transient' && o.effectTarget === 'internal' && o.readback === 'proves_not_applied' &&
    o.versionFence === 'stale_runtime', () =>
    retry('cas_conflict_runtime_generation_advanced', 'plan', 'AUTO_DEFER')),
  rule('E-transient-internal', 'post', (o) => itemBearing(o) &&
    o.effect === 'failure_transient' && o.effectTarget === 'internal' && o.readback === 'proves_not_applied' &&
    o.versionFence !== 'stale_runtime', () =>
    retry('internal_transient_failure_proven_not_applied', 'operation', 'SYSTEM_HALT')),
  rule('E-permanent-internal', 'post', (o) => itemBearing(o) &&
    o.effect === 'failure_permanent' && o.effectTarget === 'internal' && o.readback === 'proves_not_applied', () =>
    v('QUARANTINE', 'internal_permanent_rejection')),
  rule('E-transient-external', 'post', (o) => itemBearing(o) &&
    o.effect === 'failure_transient' && o.effectTarget === 'external' &&
    ['not_performed', 'proves_not_applied', 'unavailable'].includes(o.readback), () =>
    v('AUTO_DEFER', 'external_confirmed_not_applied')),
  rule('E-permanent-external', 'post', (o) => itemBearing(o) &&
    o.effect === 'failure_permanent' && o.effectTarget === 'external' &&
    ['not_performed', 'proves_not_applied', 'unavailable'].includes(o.readback), () =>
    v('QUARANTINE', 'external_permanent_rejection')),

  // ambiguous
  rule('E-ambiguous-internal-applied', 'post', (o) => itemBearing(o) &&
    o.effect === 'ambiguous' && o.effectTarget === 'internal' && o.readback === 'proves_applied', () =>
    v('AUTO_RESOLVE', 'ambiguity_resolved_readback_applied')),
  rule('E-ambiguous-internal-not-applied', 'post', (o) => itemBearing(o) &&
    o.effect === 'ambiguous' && o.effectTarget === 'internal' && o.readback === 'proves_not_applied', () =>
    retry('ambiguity_resolved_readback_not_applied', 'operation', 'SYSTEM_HALT')),
  rule('E-ambiguous-external-authoritative-applied', 'post', (o, p) => itemBearing(o) &&
    o.effect === 'ambiguous' && o.effectTarget === 'external' && p.externalReadbackAuthoritative === true &&
    o.readback === 'proves_applied', () =>
    v('AUTO_RESOLVE', 'ambiguity_resolved_external_readback_applied')),
  rule('E-ambiguous-external-authoritative-not-applied', 'post', (o, p) => itemBearing(o) &&
    o.effect === 'ambiguous' && o.effectTarget === 'external' && p.externalReadbackAuthoritative === true &&
    o.readback === 'proves_not_applied', () =>
    v('AUTO_DEFER', 'ambiguity_resolved_external_readback_not_applied')),
  // Catch-all. Must exclude readback-resolved cases: gates take the STRONGEST matching verdict,
  // so an unqualified catch-all would override every resolution (Batch 0 finding F-02).
  rule('E-ambiguous-unresolved', 'post', (o, p) => {
    if (!itemBearing(o)) return false;
    if (o.effect !== 'ambiguous') return false;
    const trusted = o.effectTarget === 'internal' || p.externalReadbackAuthoritative === true;
    return !(trusted && ['proves_applied', 'proves_not_applied'].includes(o.readback));
  }, () => halt('needs_reconciliation', 'lane')),
]);

// ---------------------------------------------------------------------------
// INPUT gate
// ---------------------------------------------------------------------------
const INPUT_VERDICTS = Object.freeze({
  malformed: v('QUARANTINE', 'input_malformed'),
  hostile: v('QUARANTINE', 'input_hostile', { securityNotice: true }),
  unsupported: v('QUARANTINE', 'input_unsupported'),
  conflicting: v('QUARANTINE', 'input_identity_conflict'),
  vanished: v('QUARANTINE', 'input_vanished_before_capture'),
  duplicate: v('AUTO_IGNORE', 'input_duplicate'),
});

const INPUT_RULES = Object.freeze([
  rule('I-input-pre', 'pre', (o) => itemBearing(o) && o.input !== 'valid', (o) => INPUT_VERDICTS[o.input]),
  rule('I-classification-pre', 'pre', (o) => itemBearing(o) && o.classification === 'uncertain', () =>
    v('QUARANTINE', 'classification_uncertain')),
  rule('I-changed-post', 'post', (o) => itemBearing(o) && (o.input !== 'valid' || o.classification !== 'deterministic'), () =>
    halt('item_invariant_changed_after_dispatch', 'lane')),
]);

// ---------------------------------------------------------------------------
// CONTENT gate
// ---------------------------------------------------------------------------
const approved = (o) => o.approval === 'owner_exact_digest';
const CONTENT_RULES = Object.freeze([
  rule('C-approval-synthesized', 'both', (o) => itemBearing(o) && o.approval === 'synthesized', () =>
    halt('approval_synthesized', 'system')),
  rule('C-authority-claim', 'pre', (o) => itemBearing(o) && o.generatedAuthorityClaim === 'attempted', () =>
    v('QUARANTINE', 'generated_content_asserts_authority', { securityNotice: true })),
  rule('C-restricted', 'pre', (o) => itemBearing(o) && o.sensitivity === 'restricted', () =>
    v('QUARANTINE', 'restricted_material')),
  rule('C-contradicted', 'pre', (o) => promoting(o) && o.claims === 'contradicted', () =>
    v('QUARANTINE', 'claim_contradicted_by_evidence')),
  rule('C-experiential', 'pre', (o) => promoting(o) && o.claims === 'unsupported_experiential', () =>
    v('OWNER_ATTESTATION_REQUIRED', 'unsupported_experiential_claim')),
  rule('C-factual', 'pre', (o) => promoting(o) && o.claims === 'unsupported_factual', () =>
    v('OWNER_ATTESTATION_REQUIRED', 'unsupported_factual_claim')),
  rule('C-stale-fact', 'pre', (o) => promoting(o) && o.claims === 'stale_current_fact', () =>
    v('OWNER_ATTESTATION_REQUIRED', 'current_fact_without_fresh_evidence')),
  rule('C-approval-missing', 'pre', (o) => promoting(o) && ['missing', 'not_required'].includes(o.approval), () =>
    v('OWNER_APPROVAL_REQUIRED', 'exact_digest_approval_missing')),
  rule('C-approval-mismatch', 'pre', (o) => promoting(o) && o.approval === 'digest_mismatch', () =>
    v('OWNER_APPROVAL_REQUIRED', 'approval_digest_mismatch')),
  rule('C-sensitive', 'pre', (o) => promoting(o) && o.sensitivity === 'sensitive' && !approved(o), () =>
    v('OWNER_APPROVAL_REQUIRED', 'sensitive_material_requires_approval')),
  rule('C-meaning-drift', 'pre', (o) => promoting(o) && o.meaningDrift === 'detected' && !approved(o), () =>
    v('OWNER_APPROVAL_REQUIRED', 'generated_meaning_drift')),
  rule('C-changed-post', 'post', (o) =>
    itemBearing(o) && (
      o.generatedAuthorityClaim !== 'none' || o.sensitivity === 'restricted' ||
      (promoting(o) && (!['none', 'supported'].includes(o.claims) || !approved(o)))
    ), () => halt('item_invariant_changed_after_dispatch', 'lane')),
]);

export const GATES = Object.freeze([
  Object.freeze({
    id: 'SYSTEM',
    dims: Object.freeze(['opClass', 'canonical', 'faultScope', 'haltFence', 'authority', 'checkpoint', 'retryBudget']),
    rules: SYSTEM_RULES,
  }),
  Object.freeze({
    id: 'FENCE',
    dims: Object.freeze(['opClass', 'versionFence', 'concurrency', 'retryBudget']),
    rules: FENCE_RULES,
  }),
  Object.freeze({
    id: 'EFFECT',
    dims: Object.freeze(['opClass', 'effect', 'effectTarget', 'readback', 'dispatchPreconditions', 'idempotency', 'retryBudget', 'versionFence']),
    rules: EFFECT_RULES,
    usesPolicy: true,
  }),
  Object.freeze({
    id: 'INPUT',
    dims: Object.freeze(['opClass', 'input', 'classification']),
    rules: INPUT_RULES,
  }),
  Object.freeze({
    id: 'CONTENT',
    dims: Object.freeze(['opClass', 'claims', 'sensitivity', 'generatedAuthorityClaim', 'meaningDrift', 'approval']),
    rules: CONTENT_RULES,
  }),
]);

const HALT_SCOPE_RANK = Object.freeze({ component: 0, lane: 1, system: 2 });
const RETRY_TARGET_RANK = Object.freeze({ operation: 0, read: 1, plan: 2 }); // higher = more conservative

function applyBudget(verdict, observation) {
  if (verdict.outcome !== 'AUTO_RETRY' || observation.retryBudget === 'available') return verdict;
  const escalated = { outcome: verdict.exhaustTo, reason: `${verdict.reason}__retry_budget_exhausted` };
  if (verdict.exhaustTo === 'SYSTEM_HALT') escalated.haltScope = verdict.exhaustScope ?? 'lane';
  return Object.freeze(escalated);
}

function stronger(a, b) {
  if (!a) return b;
  if (SEVERITY[b.outcome] > SEVERITY[a.outcome]) return b;
  if (SEVERITY[b.outcome] < SEVERITY[a.outcome]) return a;
  if (a.outcome === 'SYSTEM_HALT' && HALT_SCOPE_RANK[b.haltScope] > HALT_SCOPE_RANK[a.haltScope]) return b;
  if (a.outcome === 'AUTO_RETRY' && RETRY_TARGET_RANK[b.retryTarget] > RETRY_TARGET_RANK[a.retryTarget]) return b;
  return a;
}

export function makeGateEvaluator({ budget = true } = {}) {
  return function evaluate(gate, observation, policy = DEFAULT_POLICY) {
  const dispatched = observation.effect !== 'none';
  const phase = dispatched ? 'post' : 'pre';
  let best = null;
  const reasons = [];
  for (const r of gate.rules) {
    if (r.phase !== 'both' && r.phase !== phase) continue;
    if (!r.when(observation, policy)) continue;
    const raw = r.verdict(observation, policy);
    const verdict = budget ? applyBudget(raw, observation) : raw;
    reasons.push(verdict.reason);
    best = stronger(best, verdict);
  }
  if (!best) return Object.freeze({ gate: gate.id, outcome: null, reasons: Object.freeze([]) });
  return Object.freeze({ gate: gate.id, ...best, reasons: Object.freeze(reasons) });
  };
}

export const evaluateGate = makeGateEvaluator();

export function composeVerdicts(verdicts) {
  let best = null;
  const reasons = [];
  let securityNotice = false;
  for (const verdict of verdicts) {
    if (!verdict || verdict.outcome === null) continue;
    for (const reason of verdict.reasons ?? [verdict.reason]) reasons.push(reason);
    if (verdict.securityNotice) securityNotice = true;
    best = stronger(best, verdict);
  }
  if (!best) {
    return Object.freeze({ outcome: 'AUTO_RESOLVE', reason: 'all_gates_pass', reasons: ['all_gates_pass'], securityNotice });
  }
  return Object.freeze({ ...best, reasons: [...new Set(reasons)].sort(), securityNotice });
}

export function validateObservation(observation) {
  if (observation === null || typeof observation !== 'object' || Array.isArray(observation)) {
    return { ok: false, reason: 'observation_not_object' };
  }
  if (Object.getPrototypeOf(observation) !== Object.prototype && Object.getPrototypeOf(observation) !== null) {
    return { ok: false, reason: 'observation_not_plain_object' };
  }
  const keys = Object.keys(observation);
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(DIMENSIONS, key)) return { ok: false, reason: `unknown_dimension:${key}` };
  }
  for (const key of DIMENSION_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(observation, key)) return { ok: false, reason: `missing_dimension:${key}` };
    if (!DIMENSIONS[key].includes(observation[key])) return { ok: false, reason: `invalid_value:${key}` };
  }
  return { ok: true };
}

export function validatePolicy(policy) {
  if (policy === null || typeof policy !== 'object' || Array.isArray(policy)) return { ok: false, reason: 'policy_not_object' };
  const keys = Object.keys(policy);
  if (keys.length !== 1 || keys[0] !== 'externalReadbackAuthoritative') return { ok: false, reason: 'policy_shape' };
  if (typeof policy.externalReadbackAuthoritative !== 'boolean') return { ok: false, reason: 'policy_value' };
  return { ok: true };
}

function buildDecision(verdict, observation) {
  const outcome = verdict.outcome;
  const contract = OUTCOME_CONTRACTS[outcome];
  const lane = observation && LANES[observation.opClass] ? LANES[observation.opClass].lane : 'unknown';
  const dispatched = observation ? observation.effect !== 'none' : false;
  const haltScope = outcome === 'SYSTEM_HALT' ? verdict.haltScope ?? 'system' : null;
  let unrelatedWorkContinues = 'yes';
  if (outcome === 'SYSTEM_HALT') unrelatedWorkContinues = haltScope === 'system' ? 'no' : 'other_lanes_only';
  const externalSideEffectAllowed =
    outcome === 'AUTO_RESOLVE' && !dispatched && observation?.opClass === 'publication';
  return Object.freeze({
    outcome,
    primaryReason: verdict.reason,
    reasons: Object.freeze([...(verdict.reasons ?? [verdict.reason])]),
    lane,
    phase: dispatched ? 'post_dispatch' : 'pre_dispatch',
    haltScope,
    retryTarget: outcome === 'AUTO_RETRY' ? verdict.retryTarget : null,
    canonicalChange: contract.canonicalChange,
    externalSideEffectAllowed,
    retryAllowed: outcome === 'AUTO_RETRY',
    ownerNotification: contract.ownerNotification || verdict.securityNotice === true,
    ownerActionRequired: contract.ownerResponseRequired,
    unrelatedWorkContinues,
    requiredEvidence: contract.exitEvidence,
  });
}

export function createDecider({
  gates = GATES, compose = composeVerdicts, evaluate = evaluateGate, validate = true, defaultPolicy = DEFAULT_POLICY,
} = {}) {
  return function decide(observation, policy = defaultPolicy) {
    const obsCheck = validate ? validateObservation(observation) : { ok: true };
    if (!obsCheck.ok) {
      return buildDecision({ outcome: 'SYSTEM_HALT', reason: `invalid_observation:${obsCheck.reason}`, haltScope: 'component' }, null);
    }
    const policyCheck = validate ? validatePolicy(policy) : { ok: true };
    if (!policyCheck.ok) {
      return buildDecision({ outcome: 'SYSTEM_HALT', reason: `invalid_policy:${policyCheck.reason}`, haltScope: 'component' }, observation);
    }
    // Copy into a frozen null-prototype record so rules cannot read inherited properties or mutate input.
    const o = Object.freeze(Object.assign(Object.create(null), observation));
    const verdicts = gates.map((gate) => evaluate(gate, o, policy));
    const composed = compose(verdicts, o);
    if (!OUTCOMES.includes(composed?.outcome)) {
      return buildDecision({ outcome: 'SYSTEM_HALT', reason: 'undefined_composition_result', haltScope: 'component' }, o);
    }
    return buildDecision(composed, o);
  };
}

export const decide = createDecider();

export function fullSpaceSize() {
  return DIMENSION_KEYS.reduce((n, key) => n * DIMENSIONS[key].length, 1);
}
