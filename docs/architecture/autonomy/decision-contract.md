<!--tos-doc
{
  "doc_id": "XQ-DOC-ARCH-AUTONOMY-0003",
  "class": "architecture",
  "claims_truth_state": "proposed",
  "written_against": { "head_sha": "0f3fb9c6d974c99ad58f9b135b19e50dcee366de" },
  "depends_on": ["src/autonomy/decision-outcomes.mjs", "src/autonomy/decision-model.mjs", "docs/contracts/autonomous-decision-contract.md"]
}
-->

# Decision Outcome Contract (summary)

The normative text is `docs/contracts/autonomous-decision-contract.md`. The machine-readable per-outcome contract is `OUTCOME_CONTRACTS` in `src/autonomy/decision-outcomes.mjs`; each entry defines meaning, entry conditions, prohibited entry conditions, canonical change, external side effects, retry, unrelated work, owner notification, owner response, exit evidence, FSM targets, illegal transitions, idempotency, and recovery.

**Adapter safety rule:** for an external target, `failure_transient` / `failure_permanent` means the target or transport conclusively reported **not applied**. If a request may have reached the target (timeout after dispatch, lost response, connection loss after send), adapters must use `ambiguous`. This is independent of whether the underlying error class is colloquially “transient.” Internal effects continue to require readback proof.

## Outcome semantics at a glance

| Outcome | Severity | Canonical change allowed | External effect | Retry | Unrelated work | Owner notified / must respond | Exit evidence | FSM target |
|---|---|---|---|---|---|---|---|---|
| AUTO_RESOLVE | 0 | planned idempotent step, or recording a proven outcome | planned dispatch only (publication, pre-dispatch) | no | continues | no / no | next step's evidence | next pipeline state |
| AUTO_IGNORE | 1 | status record only | none | no | continues | no / no | `ignore_basis` | IGNORED (terminal) |
| AUTO_RETRY | 2 | none | none | yes (plan / read / operation; budgeted) | continues | no / no | `retry_reason`, `retry_target`, fresh fence read | RETRY_WAIT → PLANNED |
| AUTO_DEFER | 3 | status record only (e.g. missed-slot deferral) | none | no | continues | no / no | `deferral_reason` | DEFERRED → PLANNED |
| OWNER_APPROVAL_REQUIRED | 4 | status record only | none | no | continues | yes / yes | owner exact-digest approval | WAITING_APPROVAL |
| OWNER_ATTESTATION_REQUIRED | 5 | status record only | none | no | continues | yes / yes | owner attestation signature | WAITING_ATTESTATION |
| QUARANTINE | 6 | status record only | none | no | continues | yes / yes | owner release or owner discard (tombstone) | QUARANTINED |
| SYSTEM_HALT | 7 | halt set + evidence only (automation may set, never clear) | none | no | other lanes only, or none at system scope | yes / yes | owner halt clear, or owner reconciliation | HALTED |

## Refinements made while attacking the starting definitions

| Starting definition | Refinement | Why |
|---|---|---|
| AUTO_RETRY: "failure is conclusively transient" | Retry carries a target (`plan`, `read`, `operation`). `operation` requires an internal target, readback proves not applied, and an idempotency identity. External effects are never retried in flight. | "Transient" is not enough; an external timeout is transient and still possibly applied. |
| AUTO_DEFER | Also used for external confirmed-not-posted outcomes and persistent CAS contention. | Matches existing `confirmed_not_posted` → scheduled semantics; contention is not a store fault (finding F-03). |
| AUTO_IGNORE | Ranked below AUTO_RETRY; forbidden after dispatch. | A duplicate verdict from a view that must be re-read is not proof. |
| QUARANTINE | Forbidden after dispatch unless the effect is proven not applied. | A possibly-applied effect is never item-local. |
| OWNER_ATTESTATION_REQUIRED | Covers stale current facts (owner supplies fresh evidence). Excludes contradicted claims. | Attestation cannot make a known-false claim true. |
| AUTO_DEFER | Also the outcome when the dedicated #145 mutation lane is already halted before canonical mutation. | Routine safe mutation does not require the global publication halt; an existing mutation-lane halt blocks work until owner clear. |
| SYSTEM_HALT | Scoped (`component`, `lane`, `system`); cleared by the owner only — not by any automated actor. | Existing publication-halt semantics already let automation set but never clear. |

## New outcomes considered and rejected

| Candidate | Scenario | Why rejected |
|---|---|---|
| `RECONCILE_PENDING` (possibly-applied, readback retryable) | EX-04, ST-02b | Represented as bounded inline readback inside VERIFYING, then SYSTEM_HALT(lane, needs_reconciliation). A separate waiting outcome with automatic exits would give a naive consumer a place to "retry" an unproven mutation. Overloading AUTO_RETRY for it was also rejected for the same reason. |
| `AWAITING_EXTERNAL` (owner or provider unavailable) | CP-04, AI-01b | Owner unavailability is already "stay parked" (no timeout exits). Provider unavailability is AUTO_RETRY then a staging-lane halt. |

No new outcome is proposed for approval.
