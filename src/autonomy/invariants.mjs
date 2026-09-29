// Batch 0 — Invariant catalog with executable predicates (pure).
//
// Decision predicates take (observation, decision, policy) and return null when the invariant holds,
// or a violation string. They are written against raw observation semantics, independently of the
// gate structure in decision-model.mjs, so they can falsify the model. #145 and later adapters can
// reuse them as runtime assertions around decide().

import { OUTCOMES, OUTCOME_CONTRACTS, SEVERITY } from './decision-outcomes.mjs';

const MUTATING = new Set(['publication', 'canonical_mutation']);
const PROMOTING = MUTATING;
const allowedTarget = { publication: 'external', canonical_mutation: 'internal', staging: 'internal', read_only: null };

export function effectProof(o, policy) {
  const dispatched = o.effect !== 'none';
  if (!dispatched) return { dispatched, appliedProven: false, notAppliedProven: false };
  const external = o.effectTarget === 'external';
  const trustReadback = !external || policy.externalReadbackAuthoritative === true;
  let appliedProven = false;
  let notAppliedProven = false;
  if (o.effect === 'success') {
    appliedProven = external ? ['not_performed', 'proves_applied', 'unavailable'].includes(o.readback) : o.readback === 'proves_applied';
  } else if (o.effect === 'failure_transient' || o.effect === 'failure_permanent') {
    notAppliedProven = external
      ? ['not_performed', 'proves_not_applied', 'unavailable'].includes(o.readback)
      : o.readback === 'proves_not_applied';
  } else if (o.effect === 'ambiguous') {
    appliedProven = trustReadback && o.readback === 'proves_applied';
    notAppliedProven = trustReadback && o.readback === 'proves_not_applied';
  }
  return { dispatched, appliedProven, notAppliedProven };
}

const sev = (d) => SEVERITY[d.outcome];
const fail = (cond, msg) => (cond ? msg : null);

export const INVARIANTS = Object.freeze([
  {
    id: 'INV-01', origin: 'candidate', statement: 'No unverified artifact becomes canonical production truth.',
    check: 'decision', predicate: (o, d, p) => {
      if (d.outcome !== 'AUTO_RESOLVE') return null;
      const e = effectProof(o, p);
      if (e.dispatched && !e.appliedProven) return 'AUTO_RESOLVE after dispatch without applied proof';
      if (o.opClass !== 'read_only' && (o.input !== 'valid' || o.classification !== 'deterministic')) return 'AUTO_RESOLVE of unverified input';
      if (o.canonical !== 'trusted') return 'AUTO_RESOLVE with untrusted canonical state';
      return null;
    },
  },
  {
    id: 'INV-02', origin: 'candidate', statement: 'No ambiguous external mutation is blindly retried.',
    check: 'decision', predicate: (o, d, p) => {
      const e = effectProof(o, p);
      if (o.effect === 'ambiguous' && !e.notAppliedProven && d.outcome === 'AUTO_RETRY') return 'retry of unproven ambiguous effect';
      if (e.dispatched && o.effectTarget === 'external' && d.outcome === 'AUTO_RETRY') return 'in-flight external retry';
      return null;
    },
  },
  {
    id: 'INV-03', origin: 'candidate', statement: 'No generated assertion can approve itself.',
    check: 'decision', predicate: (o, d) => {
      if (o.opClass === 'read_only') return null;
      if (o.approval === 'synthesized' && d.outcome !== 'SYSTEM_HALT') return 'synthesized approval not halted';
      if (o.generatedAuthorityClaim === 'attempted' && o.effect === 'none' && sev(d) < SEVERITY.QUARANTINE) return 'authority assertion not isolated';
      return null;
    },
  },
  {
    id: 'INV-04', origin: 'candidate', statement: 'No machine-generated experiential claim can attest to itself.',
    check: 'decision', predicate: (o, d) => fail(
      PROMOTING.has(o.opClass) && o.effect === 'none' &&
      ['unsupported_experiential', 'unsupported_factual', 'stale_current_fact'].includes(o.claims) &&
      sev(d) < SEVERITY.OWNER_ATTESTATION_REQUIRED,
      'unsupported claim advanced without owner attestation'),
  },
  {
    id: 'INV-05', origin: 'candidate', statement: 'No item-local failure unnecessarily blocks unrelated safe work.',
    check: 'decision', predicate: (o, d) => {
      if (d.outcome !== 'SYSTEM_HALT' && d.unrelatedWorkContinues !== 'yes') return 'non-halt outcome blocks unrelated work';
      if (d.outcome === 'QUARANTINE' && d.haltScope !== null) return 'quarantine carries a halt scope';
      return null;
    },
  },
  {
    id: 'INV-06', origin: 'candidate', statement: 'No system-level integrity failure may be downgraded to item quarantine.',
    check: 'decision', predicate: (o, d) => {
      const systemFault =
        (o.canonical === 'corrupt' && o.faultScope !== 'item') ||
        (MUTATING.has(o.opClass) && (o.authority === 'unknown' || o.versionFence === 'assignment_multiplicity')) ||
        (o.opClass !== 'read_only' && o.approval === 'synthesized');
      if (!systemFault) return null;
      if (d.outcome !== 'SYSTEM_HALT') return 'system fault not halted';
      if (o.opClass !== 'read_only' && d.haltScope !== 'system') return 'system fault halted with narrower scope';
      return null;
    },
  },
  {
    id: 'INV-07', origin: 'candidate', statement: 'Same source + same version + same plan produces the same decision.',
    check: 'determinism',
  },
  {
    id: 'INV-08', origin: 'candidate', statement: 'Every completed mutation has durable evidence.',
    check: 'fsm', note: 'VERIFYING -> COMPLETE requires outcome_evidence; HALTED -> COMPLETE requires reconciliation_record; no EXECUTING -> COMPLETE edge.',
  },
  {
    id: 'INV-09', origin: 'candidate', statement: 'Every resumable operation has an idempotency identity.',
    check: 'decision', predicate: (o, d) => fail(
      o.opClass !== 'read_only' && o.idempotency === 'missing' && ['AUTO_RESOLVE', 'AUTO_RETRY'].includes(d.outcome),
      'operation without idempotency identity allowed to proceed or retry'),
  },
  {
    id: 'INV-10', origin: 'candidate', statement: 'Every external side effect has an independently readable outcome or enters ambiguity handling.',
    check: 'decision', predicate: (o, d, p) => {
      const e = effectProof(o, p);
      return fail(e.dispatched && !e.appliedProven && !e.notAppliedProven && d.outcome !== 'SYSTEM_HALT', 'unproven effect outcome not halted');
    },
  },
  {
    id: 'INV-11', origin: 'candidate', statement: 'A stale halt generation cannot authorize mutation.',
    check: 'decision', predicate: (o, d) => fail(
      MUTATING.has(o.opClass) && o.effect === 'none' && o.haltFence !== 'satisfied' && d.outcome === 'AUTO_RESOLVE',
      'mutation authorized under unsatisfied halt fence'),
  },
  {
    id: 'INV-12', origin: 'candidate', statement: 'A stale runtime generation cannot authorize mutation.',
    check: 'decision', predicate: (o, d) => fail(
      MUTATING.has(o.opClass) && o.effect === 'none' && o.versionFence === 'stale_runtime' && d.outcome === 'AUTO_RESOLVE',
      'mutation authorized under stale runtime generation'),
  },
  {
    id: 'INV-13', origin: 'candidate', statement: 'A stale assignment/version cannot authorize mutation.',
    check: 'decision', predicate: (o, d) => fail(
      MUTATING.has(o.opClass) && o.effect === 'none' &&
      (o.versionFence !== 'current' || o.authority !== 'bound' || o.concurrency !== 'none') && d.outcome === 'AUTO_RESOLVE',
      'mutation authorized under stale version/authority/lease'),
  },
  {
    id: 'INV-14', origin: 'candidate', statement: 'A duplicate input cannot create duplicate canonical work.',
    check: 'decision+simulation', predicate: (o, d) => fail(
      o.opClass !== 'read_only' && o.effect === 'none' &&
      (o.input === 'duplicate' || o.concurrency === 'completed_elsewhere' || o.readback === 'proves_applied') &&
      d.outcome === 'AUTO_RESOLVE',
      'duplicate proceeds to execution'),
  },
  {
    id: 'INV-15', origin: 'candidate', statement: 'Restarting an interrupted run cannot replay completed side effects.',
    check: 'fsm+simulation', note: 'Crash in EXECUTING resumes in VERIFYING (dispatched); dispatched->undispatched edges require not-applied proof.',
  },
  {
    id: 'INV-16', origin: 'candidate', statement: 'Concurrent ingestion of the same logical input converges safely.',
    check: 'simulation',
  },
  {
    id: 'INV-17', origin: 'candidate', statement: 'Unknown does not mean safe.',
    check: 'decision', predicate: (o, d) => {
      if (o.canonical === 'corrupt' && ['unknown', 'none'].includes(o.faultScope) && d.outcome !== 'SYSTEM_HALT') return 'unknown scope not halted';
      if (MUTATING.has(o.opClass) && (o.authority === 'unknown' || (o.effect === 'none' && o.haltFence === 'unreadable')) &&
        d.outcome !== 'SYSTEM_HALT') return 'unknown authority/halt not halted';
      if (o.canonical === 'trusted' && o.faultScope !== 'none' && d.outcome !== 'SYSTEM_HALT') {
        return 'internally inconsistent observation not halted';
      }
      if (MUTATING.has(o.opClass) && o.effect === 'none' && o.haltFence === 'unreadable' && d.haltScope !== 'lane' && d.haltScope !== 'system') {
        return 'unreadable halt narrowed below lane';
      }
      return null;
    },
    also: 'invalid or unknown observation values => SYSTEM_HALT (tested in decision-model tests)',
  },
  {
    id: 'INV-18', origin: 'candidate', statement: 'Failure to prove safety is not equivalent to proof of failure.',
    check: 'decision', predicate: (o, d, p) => {
      const e = effectProof(o, p);
      if (e.dispatched && !e.notAppliedProven && ['AUTO_RETRY', 'AUTO_DEFER', 'QUARANTINE'].includes(d.outcome) &&
        !e.appliedProven) return 'unproven effect treated as not applied';
      return null;
    },
  },
  {
    id: 'INV-19', origin: 'candidate', statement: 'Publication authority and content-generation authority remain separate.',
    check: 'decision+fsm', predicate: (o, d) => {
      if (d.externalSideEffectAllowed && o.opClass !== 'publication') return 'non-publication lane allowed an external effect';
      if (o.opClass === 'read_only' && o.effect !== 'none') {
        if (d.outcome !== 'SYSTEM_HALT') return 'read-only component effect not halted';
        const independentLaneFault = o.canonical === 'unreadable' || ['stale', 'corrupt'].includes(o.checkpoint);
        if (!independentLaneFault && d.haltScope !== 'component') return 'read-only component effect halted above component scope';
      }
      if (o.opClass !== 'read_only' && o.effect !== 'none' && allowedTarget[o.opClass] !== o.effectTarget &&
        !(d.outcome === 'SYSTEM_HALT' && ['lane', 'system'].includes(d.haltScope))) return 'post-dispatch capability violation not halted at lane scope';
      if (o.opClass !== 'read_only' && allowedTarget[o.opClass] !== o.effectTarget && d.outcome !== 'SYSTEM_HALT') return 'lane capability violation not halted';
      return null;
    },
    also: 'FSM rejects every event from actor=generator.',
  },
  {
    id: 'INV-20', origin: 'candidate', statement: 'Generated content never grants itself owner approval.',
    check: 'decision+fsm', predicate: (o, d) => fail(
      PROMOTING.has(o.opClass) && o.effect === 'none' && o.approval !== 'owner_exact_digest' && sev(d) < SEVERITY.OWNER_APPROVAL_REQUIRED,
      'promotion without owner exact-digest approval'),
    also: 'WAITING_APPROVAL -> PLANNED requires actor=owner and approval_exact_digest.',
  },
  {
    id: 'INV-21', origin: 'candidate', statement: 'Item quarantine does not silently become permanent data loss.',
    check: 'fsm', note: 'QUARANTINED has no automatic exits; DISCARDED only via owner with a tombstone discard_record; no deletion edge.',
  },
  {
    id: 'INV-22', origin: 'modified', statement: 'SYSTEM_HALT cannot be automatically cleared by ANY automated actor (strengthened from "by the component that triggered it").',
    justification: 'Existing publication-halt semantics already restrict automation to setting the halt (actor_class automation); only the owner path clears. "Not the triggering component" would still let a sibling automation clear it, which reintroduces self-approval by proxy.',
    check: 'fsm',
  },
  {
    id: 'INV-23', origin: 'added', statement: 'Any effect observed without verified dispatch preconditions halts the lane.',
    justification: 'Found while attacking composition: after an effect, a pre-dispatch verdict (e.g., approval missing) must not be read as "ask the owner"; the effect already happened without the precondition.',
    check: 'decision', predicate: (o, d) => fail(
      o.effect !== 'none' && o.dispatchPreconditions !== 'verified' && d.outcome !== 'SYSTEM_HALT', 'unverified dispatch not halted'),
  },
  {
    id: 'INV-24', origin: 'added', statement: 'Post-dispatch items are never ignored, never sent to owner approval/attestation, and only quarantined with not-applied proof.',
    justification: 'An effect that may have happened must be accounted for before the item can leave the verification path.',
    check: 'decision', predicate: (o, d, p) => {
      const e = effectProof(o, p);
      if (!e.dispatched) return null;
      if (['AUTO_IGNORE', 'OWNER_APPROVAL_REQUIRED', 'OWNER_ATTESTATION_REQUIRED'].includes(d.outcome)) return `post-dispatch ${d.outcome}`;
      if (d.outcome === 'QUARANTINE' && !e.notAppliedProven) return 'post-dispatch quarantine without not-applied proof';
      return null;
    },
  },
  {
    id: 'INV-25', origin: 'added', statement: 'Every retry re-plans from fresh fence reads (RETRY_WAIT and DEFERRED only re-enter PLANNED).',
    justification: 'Prevents a retry from re-using a fence snapshot that authorized the failed attempt.',
    check: 'fsm',
  },
  {
    id: 'INV-26', origin: 'added', statement: 'Owner waiting states never time out into progress; owner unavailability leaves work parked.',
    justification: 'Compound chaos (owner unavailable) showed the candidate set never forbade a timeout-based exit; a timeout that advances work is an approval synthesized by the clock.',
    check: 'fsm',
  },
  {
    id: 'INV-28', origin: 'added', statement: 'After a possible dispatch, any broken fence, lease, authority, canonical read, checkpoint, or item invariant halts at least the lane.',
    justification: 'Added after mutation analysis showed post-dispatch fence rules were not independently asserted. An effect whose surrounding evidence cannot be bound must be reconciled, not recorded as if clean.',
    check: 'decision', predicate: (o, d) => {
      if (o.effect === 'none' || o.opClass === 'read_only') return null;
      const breach =
        o.canonical !== 'trusted' || ['stale', 'corrupt'].includes(o.checkpoint) ||
        o.concurrency !== 'none' || o.idempotency !== 'present' ||
        o.input !== 'valid' || o.classification !== 'deterministic' ||
        o.generatedAuthorityClaim !== 'none' || o.sensitivity === 'restricted' ||
        (MUTATING.has(o.opClass) && (o.authority !== 'bound' ||
          ['stale_assignment', 'assignment_missing', 'assignment_multiplicity', 'not_applicable'].includes(o.versionFence))) ||
        (PROMOTING.has(o.opClass) && (!['none', 'supported'].includes(o.claims) || o.approval !== 'owner_exact_digest'));
      if (!breach) return null;
      if (d.outcome !== 'SYSTEM_HALT') return 'post-dispatch breach not halted';
      if (o.authority === 'not_bound' && MUTATING.has(o.opClass)) return null; // component scope by design
      if (d.haltScope === 'component') return 'post-dispatch breach halted below lane scope';
      return null;
    },
  },
  {
    id: 'INV-29', origin: 'added', statement: 'A resumed operation whose prior application cannot be proven either way never proceeds or is ignored.',
    justification: 'Added after mutation analysis: pre-dispatch readback unavailable/contradictory (checking whether a prior run applied) must not be read as "not applied".',
    check: 'decision', predicate: (o, d) => fail(
      o.opClass !== 'read_only' && o.effect === 'none' && ['unavailable', 'contradictory'].includes(o.readback) &&
      ['AUTO_RESOLVE', 'AUTO_IGNORE'].includes(d.outcome),
      'unproven prior application treated as settled'),
  },
  {
    id: 'INV-30', origin: 'added', statement: 'Legitimate post-dispatch changes (owner halt set mid-flight, unrelated runtime append) do not block recording a proven outcome.',
    justification: 'Liveness counterpart to INV-28: over-halting after a clean, proven effect would turn ordinary concurrency into owner work.',
    check: 'decision', predicate: (o, d, p) => {
      if (o.effect === 'none' || o.opClass === 'read_only') return null;
      const clean = o.canonical === 'trusted' && o.faultScope === 'none' && ['none', 'valid'].includes(o.checkpoint) &&
        o.concurrency === 'none' && o.idempotency === 'present' && o.dispatchPreconditions === 'verified' &&
        o.input === 'valid' && o.classification === 'deterministic' && o.generatedAuthorityClaim === 'none' &&
        o.sensitivity !== 'restricted' && o.approval !== 'synthesized' &&
        (!MUTATING.has(o.opClass) || (o.authority === 'bound' && ['current', 'stale_runtime'].includes(o.versionFence))) &&
        (!PROMOTING.has(o.opClass) || (['none', 'supported'].includes(o.claims) && o.approval === 'owner_exact_digest')) &&
        allowedTarget[o.opClass] === o.effectTarget;
      if (!clean) return null;
      const e = effectProof(o, p);
      if (o.effect === 'success' && e.appliedProven && d.outcome !== 'AUTO_RESOLVE') return 'clean proven effect not recorded';
      return null;
    },
  },
  {
    id: 'INV-27', origin: 'added', statement: 'Every decision is a defined, contract-consistent outcome (0 undefined, 0 contradictory fields).',
    justification: 'Section 12 requires 0 undefined and 0 contradictory outcomes; this makes that requirement an executable predicate checked on every enumerated and sampled decision.',
    check: 'decision', predicate: (o, d) => {
      if (!OUTCOMES.includes(d.outcome)) return 'undefined outcome';
      const c = OUTCOME_CONTRACTS[d.outcome];
      if (d.retryAllowed !== (d.outcome === 'AUTO_RETRY')) return 'retryAllowed inconsistent';
      if ((d.haltScope !== null) !== (d.outcome === 'SYSTEM_HALT')) return 'haltScope inconsistent';
      if ((d.retryTarget !== null) !== (d.outcome === 'AUTO_RETRY')) return 'retryTarget inconsistent';
      if (d.ownerActionRequired !== c.ownerResponseRequired) return 'ownerActionRequired inconsistent';
      if (d.canonicalChange !== c.canonicalChange) return 'canonicalChange inconsistent';
      if (c.ownerNotification && !d.ownerNotification) return 'owner notification missing';
      if (d.outcome === 'AUTO_RETRY' && o.retryBudget !== 'available') return 'retry with exhausted budget';
      if (d.outcome === 'AUTO_RETRY' && (d.retryTarget === 'operation' || o.effect !== 'none')) {
        const e = effectProof(o, { externalReadbackAuthoritative: false });
        if (!(e.dispatched && e.notAppliedProven && o.effectTarget === 'internal' && o.idempotency === 'present')) return 'post-dispatch retry without internal not-applied proof';
      }
      if (d.externalSideEffectAllowed && !(d.outcome === 'AUTO_RESOLVE' && o.effect === 'none' && o.opClass === 'publication')) return 'external effect allowed outside dispatch gate';
      return null;
    },
  },
]);

export const DECISION_INVARIANTS = Object.freeze(INVARIANTS.filter((inv) => typeof inv.predicate === 'function'));

export function checkDecisionInvariants(observation, decision, policy) {
  const violations = [];
  for (const inv of DECISION_INVARIANTS) {
    const message = inv.predicate(observation, decision, policy);
    if (message) violations.push({ id: inv.id, message });
  }
  return violations;
}
