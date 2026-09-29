// Batch 0 — Autonomous processing finite state machine (pure, fail-closed).
//
// transition(item, event) -> { ok, from, to, item } | { ok:false, reason, from }
//
// item  = { state, dispatched }   (dispatched: an effect may have left the process for this item)
// event = { type, actor, evidence, retryTarget? }
//
// Normalization decisions (see docs/architecture/autonomy/state-machine.md):
//   * AMBIGUOUS is not a separate state. A possibly-applied effect is verified in VERIFYING
//     (bounded inline readback); if it cannot be proven it becomes SYSTEM_HALT -> HALTED with
//     reason needs_reconciliation. A waiting AMBIGUOUS state with automatic exits would be a
//     place where a naive consumer could "retry" an unproven mutation.
//   * IGNORED and DISCARDED are explicit terminal states so that dropping work always leaves
//     durable evidence. DISCARDED is owner-only and retains a tombstone.
//   * RETRY_WAIT and DEFERRED only ever re-enter PLANNED, so every retry re-reads fences.

export const STATES = Object.freeze([
  'RECEIVED',
  'INSPECTED',
  'CLASSIFIED',
  'PLANNED',
  'EXECUTING',
  'VERIFYING',
  'COMPLETE',
  'RETRY_WAIT',
  'DEFERRED',
  'QUARANTINED',
  'WAITING_ATTESTATION',
  'WAITING_APPROVAL',
  'HALTED',
  'IGNORED',
  'DISCARDED',
]);

export const TERMINAL_STATES = Object.freeze(['COMPLETE', 'IGNORED', 'DISCARDED']);
export const ACTORS = Object.freeze(['automation', 'owner', 'generator']);

export const EVENTS = Object.freeze([
  // decision outcomes (actor: automation)
  'AUTO_RESOLVE',
  'AUTO_RETRY',
  'AUTO_DEFER',
  'AUTO_IGNORE',
  'QUARANTINE',
  'OWNER_ATTESTATION_REQUIRED',
  'OWNER_APPROVAL_REQUIRED',
  'SYSTEM_HALT',
  // mechanical (actor: automation)
  'DISPATCH_RETURNED',
  'RETRY_READY',
  'DEFER_ELAPSED',
  // owner actions (actor: owner)
  'OWNER_ATTESTED',
  'OWNER_APPROVED',
  'OWNER_REJECTED',
  'OWNER_RELEASED',
  'OWNER_DISCARDED',
  'OWNER_CLEARED_HALT',
  'OWNER_RECONCILED_APPLIED',
  'OWNER_RECONCILED_NOT_APPLIED',
]);

const PRE_DISPATCH = Object.freeze(['RECEIVED', 'INSPECTED', 'CLASSIFIED', 'PLANNED']);
// Dispatch-flag values that can legitimately co-occur with each state.
export const DISPATCH_CONSISTENT = Object.freeze({
  RECEIVED: [false], INSPECTED: [false], CLASSIFIED: [false], PLANNED: [false], EXECUTING: [false],
  VERIFYING: [true], COMPLETE: [true], RETRY_WAIT: [false], DEFERRED: [false], QUARANTINED: [false],
  WAITING_ATTESTATION: [false], WAITING_APPROVAL: [false], HALTED: [false, true], IGNORED: [false], DISCARDED: [false],
});

export const HALTABLE = Object.freeze([
  'RECEIVED', 'INSPECTED', 'CLASSIFIED', 'PLANNED', 'EXECUTING', 'VERIFYING', 'RETRY_WAIT', 'DEFERRED',
]);

// Transition rows. `from` states, destination, actor, required evidence keys, and an optional guard.
// Anything not matched by a row is illegal and fails closed (state unchanged).
const row = (event, from, to, actor, evidence, guard = null, note = '') =>
  Object.freeze({ event, from: Object.freeze(from), to, actor, evidence: Object.freeze(evidence), guard, note });

const PIPELINE_NEXT = Object.freeze({
  RECEIVED: 'INSPECTED',
  INSPECTED: 'CLASSIFIED',
  CLASSIFIED: 'PLANNED',
  PLANNED: 'EXECUTING',
  VERIFYING: 'COMPLETE',
});

const PIPELINE_EVIDENCE = Object.freeze({
  RECEIVED: ['input_digest'],
  INSPECTED: ['classification_record'],
  CLASSIFIED: ['plan_digest', 'idempotency_key'],
  PLANNED: ['idempotency_key', 'fence_snapshot'],
  VERIFYING: ['outcome_evidence'],
});

const notDispatched = (item) => item.dispatched === false;
const dispatched = (item) => item.dispatched === true;

export const TRANSITIONS = Object.freeze([
  ...Object.entries(PIPELINE_NEXT).map(([from, to]) =>
    row('AUTO_RESOLVE', [from], to, 'automation', PIPELINE_EVIDENCE[from],
      from === 'VERIFYING' ? dispatched : notDispatched,
      from === 'VERIFYING' ? 'outcome proven' : 'pipeline advance')),
  row('DISPATCH_RETURNED', ['EXECUTING'], 'VERIFYING', 'automation', ['dispatch_record'], null,
    'every dispatch attempt is verified; there is no EXECUTING -> COMPLETE edge'),

  row('AUTO_RETRY', [...PRE_DISPATCH], 'RETRY_WAIT', 'automation', ['retry_reason', 'retry_target'], notDispatched),
  row('AUTO_RETRY', ['VERIFYING'], 'RETRY_WAIT', 'automation', ['retry_reason', 'retry_target', 'readback_not_applied'],
    (item, event) => dispatched(item) && ['operation', 'plan'].includes(event.retryTarget),
    'only a readback-proven not-applied internal operation may be re-issued or re-planned'),
  row('RETRY_READY', ['RETRY_WAIT'], 'PLANNED', 'automation', ['fresh_fence_read'], null, 're-plan with fresh fences'),

  row('AUTO_DEFER', [...PRE_DISPATCH], 'DEFERRED', 'automation', ['deferral_reason'], notDispatched),
  row('AUTO_DEFER', ['VERIFYING'], 'DEFERRED', 'automation', ['deferral_reason', 'conclusive_not_applied'], dispatched,
    'external confirmed_not_posted returns to schedule; missed-slot deferral applies'),
  row('DEFER_ELAPSED', ['DEFERRED'], 'PLANNED', 'automation', ['fresh_fence_read']),

  row('AUTO_IGNORE', [...PRE_DISPATCH], 'IGNORED', 'automation', ['ignore_basis'], notDispatched),

  row('QUARANTINE', [...PRE_DISPATCH], 'QUARANTINED', 'automation', ['quarantine_record'], notDispatched),
  row('QUARANTINE', ['VERIFYING'], 'QUARANTINED', 'automation', ['quarantine_record', 'conclusive_not_applied'], dispatched,
    'permanent rejection proven not applied'),

  row('OWNER_ATTESTATION_REQUIRED', ['CLASSIFIED', 'PLANNED'], 'WAITING_ATTESTATION', 'automation', ['owner_request_id'], notDispatched),
  row('OWNER_APPROVAL_REQUIRED', ['CLASSIFIED', 'PLANNED'], 'WAITING_APPROVAL', 'automation', ['owner_request_id'], notDispatched),

  // Only in-flight items move to HALTED. Items already parked for the owner (QUARANTINED,
  // WAITING_*) stay parked: moving them would let a later halt clear bypass the owner gate.
  row('SYSTEM_HALT', HALTABLE, 'HALTED', 'automation', ['halt_record']),

  row('OWNER_ATTESTED', ['WAITING_ATTESTATION'], 'CLASSIFIED', 'owner', ['attestation_signature']),
  row('OWNER_APPROVED', ['WAITING_APPROVAL'], 'PLANNED', 'owner', ['approval_exact_digest']),
  row('OWNER_REJECTED', ['WAITING_ATTESTATION', 'WAITING_APPROVAL'], 'QUARANTINED', 'owner', ['rejection_record']),
  row('OWNER_RELEASED', ['QUARANTINED'], 'RECEIVED', 'owner', ['release_record'], notDispatched,
    'released item re-enters as a new revision and is re-inspected'),
  row('OWNER_DISCARDED', ['QUARANTINED'], 'DISCARDED', 'owner', ['discard_record']),
  row('OWNER_CLEARED_HALT', ['HALTED'], 'RECEIVED', 'owner', ['halt_clear_generation'], notDispatched,
    'pre-dispatch items are re-evaluated from RECEIVED after the owner clears the halt'),
  row('OWNER_RECONCILED_APPLIED', ['HALTED'], 'COMPLETE', 'owner', ['reconciliation_record'], dispatched),
  row('OWNER_RECONCILED_NOT_APPLIED', ['HALTED'], 'DEFERRED', 'owner', ['reconciliation_record'], dispatched),
]);

function hasEvidence(evidence, key) {
  return evidence !== null && typeof evidence === 'object' &&
    Object.prototype.hasOwnProperty.call(evidence, key) &&
    typeof evidence[key] === 'string' && evidence[key].trim().length > 0;
}

function reject(from, reason) {
  return Object.freeze({ ok: false, from, to: from, reason });
}

function validateItemRecord(item) {
  const from = item?.state;
  if (!STATES.includes(from)) return reject(from ?? null, 'unknown_state');
  if (typeof item.dispatched !== 'boolean') return reject(from, 'dispatch_flag_missing');
  // An item record that cannot occur (e.g. RETRY_WAIT with dispatched=true, as a corrupted checkpoint
  // might present) is rejected rather than interpreted (Batch 0 finding F-04).
  if (!DISPATCH_CONSISTENT[from].includes(item.dispatched)) return reject(from, 'inconsistent_item_state');
  return null;
}

export function createTransition({ table = TRANSITIONS, haltFromExecutingMarksDispatched = true } = {}) {
  return function transition(item, event) {
  const from = item?.state;
  const invalidItem = validateItemRecord(item);
  if (invalidItem) return invalidItem;
  if (!event || !EVENTS.includes(event.type)) return reject(from, 'unknown_event');
  if (!ACTORS.includes(event.actor)) return reject(from, 'unknown_actor');
  if (TERMINAL_STATES.includes(from)) return reject(from, 'terminal_state');

  const candidates = table.filter((t) => t.event === event.type && t.from.includes(from));
  if (candidates.length === 0) return reject(from, 'illegal_transition');

  const actorOk = candidates.filter((t) => t.actor === event.actor);
  if (actorOk.length === 0) return reject(from, 'actor_not_authorized');

  const guarded = actorOk.filter((t) => t.guard === null || t.guard(item, event) === true);
  if (guarded.length === 0) return reject(from, 'guard_failed');
  if (guarded.length > 1) return reject(from, 'ambiguous_transition_table');

  const t = guarded[0];
  for (const key of t.evidence) {
    if (!hasEvidence(event.evidence, key)) return reject(from, `evidence_missing:${key}`);
  }

  let nextDispatched = item.dispatched;
  if (t.event === 'DISPATCH_RETURNED') nextDispatched = true;
  // Halting mid-execution: the dispatch may already have left the process.
  if (haltFromExecutingMarksDispatched && from === 'EXECUTING' && t.to === 'HALTED') nextDispatched = true;
  if (['RETRY_WAIT', 'DEFERRED', 'QUARANTINED'].includes(t.to) && from === 'VERIFYING') nextDispatched = false;
  if (t.event === 'OWNER_RECONCILED_NOT_APPLIED') nextDispatched = false;
  if (t.to === 'PLANNED' || t.to === 'RECEIVED') nextDispatched = false;
  // PLANNED -> EXECUTING does not set dispatched: the flag becomes true only once the dispatch returns
  // OR the process crashes inside EXECUTING (see resumeFromCrash).

  return Object.freeze({
    ok: true,
    from,
    to: t.to,
    item: Object.freeze({ state: t.to, dispatched: nextDispatched }),
  });
  };
}

export const transition = createTransition();

// A crash while EXECUTING means the dispatch may have left the process. Resume treats it as
// dispatched so it must be verified (VERIFYING) before anything else can happen.
export function resumeFromCrash(item) {
  const invalidItem = validateItemRecord(item);
  if (invalidItem) return invalidItem;
  if (item.state === 'EXECUTING') {
    return Object.freeze({ ok: true, from: 'EXECUTING', to: 'VERIFYING', item: Object.freeze({ state: 'VERIFYING', dispatched: true }) });
  }
  return Object.freeze({ ok: true, from: item.state, to: item.state, item: Object.freeze({ ...item }) });
}

// Machine-readable export used to generate 05-state-machine.json.
export function stateMachineSpec() {
  const perState = {};
  for (const state of STATES) {
    const outbound = TRANSITIONS.filter((t) => t.from.includes(state)).map((t) => ({
      event: t.event, to: t.to, actor: t.actor, evidence: [...t.evidence], guard: t.guard ? (t.note || 'guarded') : null,
    }));
    const inbound = TRANSITIONS.filter((t) => t.to === state).map((t) => ({ event: t.event, from: [...t.from], actor: t.actor }));
    perState[state] = { terminal: TERMINAL_STATES.includes(state), inbound, outbound, ...STATE_PROPERTIES[state] };
  }
  return { states: [...STATES], terminal: [...TERMINAL_STATES], events: [...EVENTS], actors: [...ACTORS], perState };
}

export const STATE_PROPERTIES = Object.freeze({
  RECEIVED: { durableEvidence: ['receipt record', 'input reference'], canonicalMutation: false, externalSideEffects: false, automaticRetry: true, unrelatedWorkProceeds: true },
  INSPECTED: { durableEvidence: ['input_digest', 'structural inspection record'], canonicalMutation: false, externalSideEffects: false, automaticRetry: true, unrelatedWorkProceeds: true },
  CLASSIFIED: { durableEvidence: ['classification_record'], canonicalMutation: false, externalSideEffects: false, automaticRetry: true, unrelatedWorkProceeds: true },
  PLANNED: { durableEvidence: ['plan_digest', 'idempotency_key'], canonicalMutation: false, externalSideEffects: false, automaticRetry: true, unrelatedWorkProceeds: true },
  EXECUTING: { durableEvidence: ['idempotency_key', 'fence_snapshot', 'intent persisted before dispatch'], canonicalMutation: true, externalSideEffects: true, automaticRetry: false, unrelatedWorkProceeds: true },
  VERIFYING: { durableEvidence: ['dispatch_record', 'readback result'], canonicalMutation: 'outcome record only', externalSideEffects: false, automaticRetry: 'readback-proven not-applied internal operation only', unrelatedWorkProceeds: true },
  COMPLETE: { durableEvidence: ['outcome_evidence'], canonicalMutation: false, externalSideEffects: false, automaticRetry: false, unrelatedWorkProceeds: true },
  RETRY_WAIT: { durableEvidence: ['retry_reason', 'retry_target'], canonicalMutation: false, externalSideEffects: false, automaticRetry: 'via PLANNED only', unrelatedWorkProceeds: true },
  DEFERRED: { durableEvidence: ['deferral_reason'], canonicalMutation: false, externalSideEffects: false, automaticRetry: false, unrelatedWorkProceeds: true },
  QUARANTINED: { durableEvidence: ['quarantine_record', 'retained input reference'], canonicalMutation: false, externalSideEffects: false, automaticRetry: false, unrelatedWorkProceeds: true },
  WAITING_ATTESTATION: { durableEvidence: ['owner_request_id'], canonicalMutation: false, externalSideEffects: false, automaticRetry: false, unrelatedWorkProceeds: true },
  WAITING_APPROVAL: { durableEvidence: ['owner_request_id'], canonicalMutation: false, externalSideEffects: false, automaticRetry: false, unrelatedWorkProceeds: true },
  HALTED: { durableEvidence: ['halt_record', 'halt generation', 'dispatch flag at halt'], canonicalMutation: false, externalSideEffects: false, automaticRetry: false, unrelatedWorkProceeds: 'other lanes only unless system scope' },
  IGNORED: { durableEvidence: ['ignore_basis'], canonicalMutation: false, externalSideEffects: false, automaticRetry: false, unrelatedWorkProceeds: true },
  DISCARDED: { durableEvidence: ['discard_record (tombstone, retained input reference)'], canonicalMutation: false, externalSideEffects: false, automaticRetry: false, unrelatedWorkProceeds: true },
});

// Normative exits (from the outcome contracts' recovery semantics). The transition table must
// provide every one of these; tests assert it so a dropped recovery path cannot go unnoticed.
export const CONTRACT_EXITS = Object.freeze([
  { from: { state: 'RECEIVED', dispatched: false }, event: 'AUTO_RESOLVE', actor: 'automation', to: 'INSPECTED' },
  { from: { state: 'INSPECTED', dispatched: false }, event: 'AUTO_RESOLVE', actor: 'automation', to: 'CLASSIFIED' },
  { from: { state: 'CLASSIFIED', dispatched: false }, event: 'AUTO_RESOLVE', actor: 'automation', to: 'PLANNED' },
  { from: { state: 'PLANNED', dispatched: false }, event: 'AUTO_RESOLVE', actor: 'automation', to: 'EXECUTING' },
  { from: { state: 'EXECUTING', dispatched: false }, event: 'DISPATCH_RETURNED', actor: 'automation', to: 'VERIFYING' },
  { from: { state: 'VERIFYING', dispatched: true }, event: 'AUTO_RESOLVE', actor: 'automation', to: 'COMPLETE' },
  { from: { state: 'VERIFYING', dispatched: true }, event: 'AUTO_RETRY', actor: 'automation', to: 'RETRY_WAIT', retryTarget: 'operation' },
  { from: { state: 'VERIFYING', dispatched: true }, event: 'AUTO_DEFER', actor: 'automation', to: 'DEFERRED' },
  { from: { state: 'VERIFYING', dispatched: true }, event: 'QUARANTINE', actor: 'automation', to: 'QUARANTINED' },
  { from: { state: 'VERIFYING', dispatched: true }, event: 'SYSTEM_HALT', actor: 'automation', to: 'HALTED' },
  { from: { state: 'RETRY_WAIT', dispatched: false }, event: 'RETRY_READY', actor: 'automation', to: 'PLANNED' },
  { from: { state: 'DEFERRED', dispatched: false }, event: 'DEFER_ELAPSED', actor: 'automation', to: 'PLANNED' },
  { from: { state: 'WAITING_ATTESTATION', dispatched: false }, event: 'OWNER_ATTESTED', actor: 'owner', to: 'CLASSIFIED' },
  { from: { state: 'WAITING_ATTESTATION', dispatched: false }, event: 'OWNER_REJECTED', actor: 'owner', to: 'QUARANTINED' },
  { from: { state: 'WAITING_APPROVAL', dispatched: false }, event: 'OWNER_APPROVED', actor: 'owner', to: 'PLANNED' },
  { from: { state: 'WAITING_APPROVAL', dispatched: false }, event: 'OWNER_REJECTED', actor: 'owner', to: 'QUARANTINED' },
  { from: { state: 'QUARANTINED', dispatched: false }, event: 'OWNER_RELEASED', actor: 'owner', to: 'RECEIVED' },
  { from: { state: 'QUARANTINED', dispatched: false }, event: 'OWNER_DISCARDED', actor: 'owner', to: 'DISCARDED' },
  { from: { state: 'HALTED', dispatched: false }, event: 'OWNER_CLEARED_HALT', actor: 'owner', to: 'RECEIVED' },
  { from: { state: 'HALTED', dispatched: true }, event: 'OWNER_RECONCILED_APPLIED', actor: 'owner', to: 'COMPLETE' },
  { from: { state: 'HALTED', dispatched: true }, event: 'OWNER_RECONCILED_NOT_APPLIED', actor: 'owner', to: 'DEFERRED' },
]);

// Maps a decision outcome to the FSM event it drives.
export function outcomeEvent(decision, evidence) {
  return { type: decision.outcome, actor: 'automation', evidence, retryTarget: decision.retryTarget ?? undefined };
}
