<!--tos-doc
{
  "doc_id": "XQ-DOC-ARCH-AUTONOMY-0004",
  "class": "architecture",
  "claims_truth_state": "proposed",
  "written_against": { "head_sha": "0f3fb9c6d974c99ad58f9b135b19e50dcee366de" },
  "depends_on": ["src/autonomy/state-machine.mjs", "test/autonomy-state-machine.test.mjs", "test/autonomy/harness/fsm-oracle.mjs"]
}
-->

# Autonomous Processing State Machine

Status: proposed. Machine-readable form: `stateMachineSpec()` in `src/autonomy/state-machine.mjs` (exported to `05-state-machine.json` in the evidence package).

## States (15)

Pipeline: `RECEIVED → INSPECTED → CLASSIFIED → PLANNED → EXECUTING → VERIFYING → COMPLETE`
Holding: `RETRY_WAIT`, `DEFERRED`, `QUARANTINED`, `WAITING_ATTESTATION`, `WAITING_APPROVAL`, `HALTED`
Terminal: `COMPLETE`, `IGNORED`, `DISCARDED`

Each item record is `{ state, dispatched }`. `dispatched` means an effect may have left the process.

| State | Legal dispatch flag | Canonical mutation | External effect | Automatic retry | Unrelated work | Terminal |
|---|---|---|---|---|---|---|
| RECEIVED | false | no | no | yes (read) | yes | no |
| INSPECTED | false | no | no | yes | yes | no |
| CLASSIFIED | false | no | no | yes | yes | no |
| PLANNED | false | no | no | yes | yes | no |
| EXECUTING | false | yes (the planned step) | yes (publication lane) | no | yes | no |
| VERIFYING | true | outcome record only | no | only readback-proven not-applied internal operation | yes | no |
| COMPLETE | true | no | no | no | yes | yes |
| RETRY_WAIT | false | no | no | via PLANNED only | yes | no |
| DEFERRED | false | no | no | no | yes | no |
| QUARANTINED | false | no | no | no | yes | no |
| WAITING_ATTESTATION | false | no | no | no | yes | no |
| WAITING_APPROVAL | false | no | no | no | yes | no |
| HALTED | false or true | no | no | no | other lanes only (unless system scope) | no |
| IGNORED | false | no | no | no | yes | yes |
| DISCARDED | false | no | no | no | yes | yes |

## Transitions

| Event | From | To | Actor | Required evidence | Guard |
|---|---|---|---|---|---|
| AUTO_RESOLVE | RECEIVED / INSPECTED / CLASSIFIED / PLANNED | next pipeline state | automation | `input_digest` / `classification_record` / `plan_digest`+`idempotency_key` / `idempotency_key`+`fence_snapshot` | not dispatched |
| DISPATCH_RETURNED | EXECUTING | VERIFYING | automation | `dispatch_record` | — |
| AUTO_RESOLVE | VERIFYING | COMPLETE | automation | `outcome_evidence` | dispatched |
| AUTO_RETRY | RECEIVED..PLANNED | RETRY_WAIT | automation | `retry_reason`, `retry_target` | not dispatched |
| AUTO_RETRY | VERIFYING | RETRY_WAIT | automation | + `readback_not_applied` | target `operation` or `plan` |
| RETRY_READY | RETRY_WAIT | PLANNED | automation | `fresh_fence_read` | — |
| AUTO_DEFER | RECEIVED..PLANNED | DEFERRED | automation | `deferral_reason` | not dispatched |
| AUTO_DEFER | VERIFYING | DEFERRED | automation | + `conclusive_not_applied` | dispatched |
| DEFER_ELAPSED | DEFERRED | PLANNED | automation | `fresh_fence_read` | — |
| AUTO_IGNORE | RECEIVED..PLANNED | IGNORED | automation | `ignore_basis` | not dispatched |
| QUARANTINE | RECEIVED..PLANNED | QUARANTINED | automation | `quarantine_record` | not dispatched |
| QUARANTINE | VERIFYING | QUARANTINED | automation | + `conclusive_not_applied` | dispatched |
| OWNER_ATTESTATION_REQUIRED | CLASSIFIED / PLANNED | WAITING_ATTESTATION | automation | `owner_request_id` | not dispatched |
| OWNER_APPROVAL_REQUIRED | CLASSIFIED / PLANNED | WAITING_APPROVAL | automation | `owner_request_id` | not dispatched |
| SYSTEM_HALT | RECEIVED..VERIFYING, RETRY_WAIT, DEFERRED | HALTED | automation | `halt_record` | from EXECUTING marks dispatched |
| OWNER_ATTESTED | WAITING_ATTESTATION | CLASSIFIED | owner | `attestation_signature` | — |
| OWNER_APPROVED | WAITING_APPROVAL | PLANNED | owner | `approval_exact_digest` | — |
| OWNER_REJECTED | WAITING_* | QUARANTINED | owner | `rejection_record` | — |
| OWNER_RELEASED | QUARANTINED | RECEIVED | owner | `release_record` | — |
| OWNER_DISCARDED | QUARANTINED | DISCARDED | owner | `discard_record` (tombstone) | — |
| OWNER_CLEARED_HALT | HALTED | RECEIVED | owner | `halt_clear_generation` | not dispatched |
| OWNER_RECONCILED_APPLIED | HALTED | COMPLETE | owner | `reconciliation_record` | dispatched |
| OWNER_RECONCILED_NOT_APPLIED | HALTED | DEFERRED | owner | `reconciliation_record` | dispatched |

Anything else is rejected (`illegal_transition`, `actor_not_authorized`, `guard_failed`, `evidence_missing:<key>`, `terminal_state`, `inconsistent_item_state`, `unknown_*`) and the state is unchanged. Events from actor `generator` are rejected everywhere.

Crash recovery: `resumeFromCrash()` first rejects unknown, missing-dispatch, or dispatch-inconsistent checkpoints. A valid `EXECUTING` checkpoint moves to `VERIFYING` with `dispatched=true`; every other valid state resumes unchanged.

## Normalization decisions

| Decision | Reason |
|---|---|
| `AMBIGUOUS` is not a state | Ambiguity is verified inside VERIFYING (bounded inline readback) and otherwise becomes HALTED(`needs_reconciliation`). A waiting AMBIGUOUS state with automatic exits is where an unproven mutation gets retried. |
| `IGNORED` and `DISCARDED` are explicit terminals | Dropping work always leaves durable evidence; discard is owner-only with a tombstone. |
| `INSPECTED` and `CLASSIFIED` kept separate | Different evidence (structural inspection digest vs classification record) and different failure outcomes (hostile input vs uncertain classification). |
| Halt clear returns to `RECEIVED`, not `PLANNED` | Found in design review: returning to PLANNED let a halted RECEIVED item skip inspection and classification. |
| Lane halt does not sweep `QUARANTINED`/`WAITING_*` | Found in design review: a later halt clear would have bypassed the owner gate. |
| Halt from `EXECUTING` marks dispatched | Found in design review: otherwise a halt clear could re-dispatch a possibly-posted item. |
| Inconsistent item records rejected | Found by the FSM oracle (F-04): e.g. `RETRY_WAIT` with `dispatched=true` from a corrupt checkpoint was accepted and silently cleared. |

## Verification

- 6,840 attempts (15 states × 2 dispatch flags × 19 events × 3 actors × 4 retry targets) enumerated: 190 accepted, 6,650 rejected, 0 property failures.
- Graph checks over 16 reachable `(state, dispatched)` nodes: every state reachable, no trap node, no replay path from EXECUTING that avoids VERIFYING or owner reconciliation, owner-parked items cannot escape without an owner event.
- 21 normative contract exits present (`CONTRACT_EXITS`).
- Every FSM mutant (dropped evidence, dropped guard, actor swap, dropped row, 8 injected illegal rows, the three design-review regressions) is killed or mechanically proven equivalent.
