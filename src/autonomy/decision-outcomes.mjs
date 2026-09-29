// Batch 0 — Autonomous decision outcomes (pure, local, no I/O).
//
// This module is a decision CONTRACT, not an executor. Nothing here performs a
// canonical mutation, an external side effect, or a network call. Future
// consumers (#145 production mutation control plane, ZIP intake, media intake,
// XQueue Author, orchestration) consume these outcomes instead of inventing
// their own failure semantics.

export const OUTCOMES = Object.freeze([
  'AUTO_RESOLVE',
  'AUTO_RETRY',
  'AUTO_DEFER',
  'AUTO_IGNORE',
  'QUARANTINE',
  'OWNER_ATTESTATION_REQUIRED',
  'OWNER_APPROVAL_REQUIRED',
  'SYSTEM_HALT',
]);

// Total severity order used for pre-dispatch composition. Higher wins.
// AUTO_IGNORE ranks below AUTO_RETRY: a duplicate verdict computed from a view
// that must be re-read cannot be trusted until the re-read succeeds.
export const SEVERITY = Object.freeze({
  AUTO_RESOLVE: 0,
  AUTO_IGNORE: 1,
  AUTO_RETRY: 2,
  AUTO_DEFER: 3,
  OWNER_APPROVAL_REQUIRED: 4,
  OWNER_ATTESTATION_REQUIRED: 5,
  QUARANTINE: 6,
  SYSTEM_HALT: 7,
});

export const RETRY_TARGETS = Object.freeze(['plan', 'read', 'operation']);
export const HALT_SCOPES = Object.freeze(['component', 'lane', 'system']);
export const UNRELATED_WORK = Object.freeze(['yes', 'other_lanes_only', 'no']);

// canonicalChange vocabulary:
//   none                 — no canonical write of any kind
//   planned_idempotent   — only the planned CAS/idempotent mutation, or recording a conclusive outcome
//   status_record_only   — only an append-only status record for this item (deferral/quarantine/wait/ignore)
//   halt_record_only     — only the generation-CAS halt set + evidence (automation may SET, never CLEAR)
export const CANONICAL_CHANGE = Object.freeze([
  'none',
  'planned_idempotent',
  'status_record_only',
  'halt_record_only',
]);

const c = (value) => Object.freeze(value);

export const OUTCOME_CONTRACTS = Object.freeze({
  AUTO_RESOLVE: c({
    meaning:
      'Trusted evidence proves a deterministic, bounded, idempotent step may be performed or completed automatically.',
    entryConditions: [
      'canonical state trusted',
      'halt, authority, runtime-generation, assignment-version and lease fences satisfied for the operation class',
      'idempotency identity present for any mutating step',
      'no unresolved attestation/approval/quarantine condition',
      'post-dispatch only: outcome proven by conclusive response (external) or readback proves_applied (internal)',
    ],
    prohibitedEntryConditions: [
      'any possibly-applied effect whose outcome is not proven',
      'any stale or unreadable fence',
      'approval missing, mismatched or synthesized',
      'unknown blast radius',
    ],
    canonicalChange: 'planned_idempotent',
    externalSideEffect: 'planned_dispatch_only',
    retryPermitted: false,
    unrelatedWorkContinues: 'yes',
    ownerNotification: false,
    ownerResponseRequired: false,
    exitEvidence: ['step evidence for the next state (see state machine evidence table)'],
    fsmTargets: ['INSPECTED', 'CLASSIFIED', 'PLANNED', 'EXECUTING', 'COMPLETE'],
    illegalTransitions: ['EXECUTING -> COMPLETE (must pass VERIFYING)', 'any waiting/halted state -> next pipeline state'],
    idempotency: 'Step keyed by idempotency identity; re-running a completed step is AUTO_IGNORE, never a second effect.',
    recovery: 'Resume from durable checkpoint; completed steps are proven by evidence, not re-executed.',
  }),
  AUTO_RETRY: c({
    meaning:
      'A failure is conclusively transient and nothing possibly-applied is outstanding; re-planning, re-reading, or re-issuing a conclusively-not-applied idempotent CAS operation cannot duplicate an effect.',
    entryConditions: [
      'retry budget available',
      'retryTarget=plan: a fence went stale before dispatch',
      'retryTarget=read: a canonical read failed transiently before dispatch',
      'retryTarget=operation: internal target, explicit transient failure or readback proves_not_applied, idempotency present',
    ],
    prohibitedEntryConditions: [
      'effect ambiguous without proves_not_applied readback',
      'external target (external re-dispatch is deferred to the next governed invocation, never retried in-flight)',
      'idempotency identity missing',
      'retry budget exhausted',
    ],
    canonicalChange: 'none',
    externalSideEffect: 'none',
    retryPermitted: true,
    unrelatedWorkContinues: 'yes',
    ownerNotification: false,
    ownerResponseRequired: false,
    exitEvidence: ['retry_reason', 'retry_target', 'fresh fence snapshot on re-plan'],
    fsmTargets: ['RETRY_WAIT'],
    illegalTransitions: ['RETRY_WAIT -> EXECUTING (must re-plan with fresh fences)'],
    idempotency: 'Same idempotency identity is reused; retries re-plan from fresh canonical reads.',
    recovery: 'On budget exhaustion the reason escalates to a declared target (AUTO_DEFER or SYSTEM_HALT).',
  }),
  AUTO_DEFER: c({
    meaning: 'The work is valid but must not execute now; it remains durable and eligible for later governed handling.',
    entryConditions: [
      'publication while the owner halt is set',
      'lease held by another operation on the same object',
      'external explicit transient failure (confirmed_not_posted): returns to scheduled; missed-slot deferral may apply',
      'retry budget exhausted for a reason whose escalation target is defer',
    ],
    prohibitedEntryConditions: ['possibly-applied effect without proof it was not applied', 'untrusted canonical state'],
    canonicalChange: 'status_record_only',
    externalSideEffect: 'none',
    retryPermitted: false,
    unrelatedWorkContinues: 'yes',
    ownerNotification: false,
    ownerResponseRequired: false,
    exitEvidence: ['deferral_reason'],
    fsmTargets: ['DEFERRED'],
    illegalTransitions: ['DEFERRED -> EXECUTING', 'DEFERRED -> IGNORED without re-evaluation'],
    idempotency: 'Deferral record keyed by item identity; repeated deferral is a no-op.',
    recovery: 'DEFERRED -> PLANNED on the next governed opportunity; no catch-up publication (existing missed-slot contract).',
  }),
  AUTO_IGNORE: c({
    meaning: 'The object is conclusively duplicate, already processed, superseded, or intentionally non-actionable.',
    entryConditions: [
      'same idempotency identity already committed with the same digest (proven by trusted canonical read)',
      'assignment superseded by a proven newer version',
      'exact duplicate input digest already processed',
    ],
    prohibitedEntryConditions: [
      'item already dispatched (EXECUTING/VERIFYING)',
      'duplicate judgement made from an untrusted or stale view',
      'same identity with a DIFFERENT digest (that is conflicting -> QUARANTINE)',
    ],
    canonicalChange: 'status_record_only',
    externalSideEffect: 'none',
    retryPermitted: false,
    unrelatedWorkContinues: 'yes',
    ownerNotification: false,
    ownerResponseRequired: false,
    exitEvidence: ['ignore_basis (duplicate op id or superseding version)'],
    fsmTargets: ['IGNORED'],
    illegalTransitions: ['EXECUTING -> IGNORED', 'VERIFYING -> IGNORED'],
    idempotency: 'Ignoring is itself idempotent; the basis is recorded.',
    recovery: 'Terminal. Evidence of the ignore basis is retained.',
  }),
  QUARANTINE: c({
    meaning:
      'An item-local defect cannot be resolved automatically. Only the affected item is isolated; unrelated safe work continues.',
    entryConditions: [
      'fault scope proven item-local',
      'malformed/hostile/unsupported/conflicting/vanished input',
      'uncertain classification',
      'contradicted (fabricated) claim, restricted material, or generated content asserting authority',
      'permanent explicit failure with proof the effect was not applied',
      'missing referenced canonical record for this item only',
    ],
    prohibitedEntryConditions: [
      'fault scope system or unknown (must be SYSTEM_HALT)',
      'possibly-applied effect (must be SYSTEM_HALT)',
      'item in EXECUTING, or VERIFYING without conclusive not-applied evidence',
    ],
    canonicalChange: 'status_record_only',
    externalSideEffect: 'none',
    retryPermitted: false,
    unrelatedWorkContinues: 'yes',
    ownerNotification: true,
    ownerResponseRequired: true,
    exitEvidence: ['owner release_record (re-enters as new revision) or owner discard_record (tombstone, evidence retained)'],
    fsmTargets: ['QUARANTINED'],
    illegalTransitions: ['QUARANTINED -> any state by automation', 'QUARANTINED -> deletion'],
    idempotency: 'Quarantine record keyed by item identity + digest.',
    recovery: 'Owner release or owner discard only. Never auto-purged; discard retains a tombstone.',
  }),
  OWNER_ATTESTATION_REQUIRED: c({
    meaning:
      'A factual, experiential, personal, provenance-sensitive, or currency-sensitive assertion cannot be established from trusted evidence; Patrick must attest to its truth (or supply fresh evidence).',
    entryConditions: ['unsupported experiential claim', 'unsupported factual claim', 'current fact without fresh evidence'],
    prohibitedEntryConditions: [
      'claim contradicted by evidence (that is QUARANTINE — attestation cannot make a known-false claim true)',
      'attestation synthesized by automation',
    ],
    canonicalChange: 'status_record_only',
    externalSideEffect: 'none',
    retryPermitted: false,
    unrelatedWorkContinues: 'yes',
    ownerNotification: true,
    ownerResponseRequired: true,
    exitEvidence: ['attestation_signature by owner over the exact claim/candidate digest'],
    fsmTargets: ['WAITING_ATTESTATION'],
    illegalTransitions: ['WAITING_ATTESTATION -> PLANNED by automation', 'timeout -> any progress state'],
    idempotency: 'One pending attestation request per claim digest.',
    recovery: 'Owner attests -> CLASSIFIED (re-evaluated); owner rejects -> QUARANTINED. Owner unavailability never auto-resolves.',
  }),
  OWNER_APPROVAL_REQUIRED: c({
    meaning:
      'The operation crosses a human authority or editorial/policy boundary even though its technical state may be valid.',
    entryConditions: [
      'exact-digest approval missing where policy requires it',
      'approval digest mismatch (content edited after approval)',
      'sensitive (not restricted) material',
      'generated content drifted from the intended meaning',
    ],
    prohibitedEntryConditions: ['approval synthesized by automation (that is SYSTEM_HALT — authority breach)'],
    canonicalChange: 'status_record_only',
    externalSideEffect: 'none',
    retryPermitted: false,
    unrelatedWorkContinues: 'yes',
    ownerNotification: true,
    ownerResponseRequired: true,
    exitEvidence: ['approval_exact_digest signed by the owner key'],
    fsmTargets: ['WAITING_APPROVAL'],
    illegalTransitions: ['WAITING_APPROVAL -> PLANNED by automation or generator', 'timeout -> approval'],
    idempotency: 'One pending approval request per candidate digest; edit invalidates approval.',
    recovery: 'Owner approves exact digest -> PLANNED; owner rejects -> QUARANTINED.',
  }),
  SYSTEM_HALT: c({
    meaning:
      'Continuing could corrupt canonical truth, duplicate an external effect, violate authority, lose recoverability, or operate under materially ambiguous state. The affected automation scope stops.',
    entryConditions: [
      'canonical corruption with system or unknown scope',
      'authority unknown, not bound to this component, or changed after dispatch',
      'possibly-applied effect whose outcome cannot be proven (needs_reconciliation)',
      'effect observed without verified dispatch preconditions',
      'synthesized approval',
      'duplicate active assignment (assignment_multiplicity)',
      'invalid/unknown observation',
      'retry budget exhausted for a reason whose escalation target is halt',
    ],
    prohibitedEntryConditions: [],
    canonicalChange: 'halt_record_only',
    externalSideEffect: 'none',
    retryPermitted: false,
    unrelatedWorkContinues: 'other_lanes_only (scope component/lane) or no (scope system)',
    ownerNotification: true,
    ownerResponseRequired: true,
    exitEvidence: [
      'owner halt clear at the exact current halt generation (pre-dispatch items -> PLANNED)',
      'owner reconciliation record for post-dispatch items (applied -> COMPLETE, not applied -> DEFERRED)',
    ],
    fsmTargets: ['HALTED'],
    illegalTransitions: ['HALTED -> any state by automation (any automated actor, not only the trigger)'],
    idempotency: 'Halt set is generation-CAS; repeated set while halted is a no-op (existing publication-halt semantics).',
    recovery: 'Owner-only. Mirrors actor_class semantics: automation may set the halt, only the owner path clears it.',
  }),
});

export function isOutcome(value) {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(SEVERITY, value);
}

export function maxSeverity(outcomes) {
  let best = 'AUTO_RESOLVE';
  for (const outcome of outcomes) {
    if (!isOutcome(outcome)) throw new Error(`unknown outcome ${String(outcome)}`);
    if (SEVERITY[outcome] > SEVERITY[best]) best = outcome;
  }
  return best;
}
