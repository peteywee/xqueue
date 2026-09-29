<!--tos-doc
{
  "doc_id": "XQ-DOC-CONTRACT-0002",
  "class": "contract",
  "claims_truth_state": "proposed",
  "written_against": { "head_sha": "0f3fb9c6d974c99ad58f9b135b19e50dcee366de" },
  "depends_on": [
    "src/autonomy/",
    "test/autonomy-*.test.mjs",
    "test/autonomy/",
    "docs/architecture/autonomy/",
    "cloudflare/src/publication-halt.mjs",
    "cloudflare/src/publication-ledger.mjs",
    "cloudflare/src/assignment-version-fence.mjs",
    "src/continuous-queue-owner-ops.mjs",
    "docs/RUNBOOK.md",
    "docs/architecture/source-of-truth.md",
    "docs/contracts/scheduling-and-missed-slot-contract.md",
    "docs/contracts/continuous-queue/"
  ]
}
-->

# Autonomous Decision Contract

| Field | Value |
|---|---|
| Status | proposed — not active; Patrick decides activation |
| Requirement prefix | ADM |
| Owner | Patrick Craven |
| Written against | `main` @ `0f3fb9c6d974c99ad58f9b135b19e50dcee366de` (inspected) |
| Reference model | `src/autonomy/` (Batch 0, pure local, not wired into any runtime) |
| Created | 2026-09-29 |
| Last updated | 2026-09-29 |
| Version | 0.1.0 |
| Supersedes | none |
| Interview | The Batch 0 work order supplied intent, outcome meanings, and the failure list. Undecided items are Open Questions below. |

## 1. Failure this contract prevents

A future autonomous component (production mutation control plane #145, ZIP intake, media import, XQueue Author, orchestration) hits a partial failure — for example, a D1 mutation whose response is lost, or an X create-post that times out after dispatch — and invents its own recovery. It retries because "the error looked transient", creates a duplicate canonical record or a duplicate public post, then records the item as complete. Or it quarantines one item while the canonical runtime revision it read from is corrupt, and keeps processing the rest on bad truth. Every component that invents its own failure semantics gets one of these edges wrong.

This contract fixes one finite set of outcomes and the rules for choosing between them, so every component fails the same way: closed, explainable, and without duplicating an effect.

## 2. Scope

In scope: decision outcomes, the observation schema they are chosen from, blast-radius rules, post-dispatch rules, and the processing state machine that consumes outcomes.

Out of scope: any executor, transport, database write, X call, scheduler change, or publication-authority change. This contract does not change existing publisher behavior; existing publisher semantics (halt, fence, lease, `needs_reconciliation`) are treated as constraints it must remain consistent with.

## 3. Definitions

- **Observation** — a complete assignment of every dimension in `DIMENSIONS` (21 dimensions, finite values).
- **Dispatched** — the operation's effect may have left the process (`effect != none`).
- **Lane** — `publication` (external X), `mutation` (canonical D1/R2), `staging` (non-canonical), `read`.
- **Halt scope** — `component` (this runtime only), `lane`, or `system` (all lanes).
- **Proven applied / proven not applied** — as defined by `effectProof()` in `src/autonomy/invariants.mjs`.
- **Explicit external failure** — `effect=failure_transient` or `effect=failure_permanent` on an external target is valid only when the transport/target result itself conclusively establishes that the external effect was not applied. A timeout, lost response, connection loss, or other error after dispatch that could have applied MUST be classified as `effect=ambiguous`, regardless of whether the underlying error is normally called transient or permanent. `readback=unavailable` does not weaken an already-conclusive external rejection; it also cannot make an ambiguous dispatch conclusive. Internal failures still require `readback=proves_not_applied` before retry/defer/quarantine semantics may treat them as not applied.

## 4. Requirements

### 4.1 Outcome set

- **ADM-1** — Every decision MUST be exactly one of: `AUTO_RESOLVE`, `AUTO_RETRY`, `AUTO_DEFER`, `AUTO_IGNORE`, `QUARANTINE`, `OWNER_ATTESTATION_REQUIRED`, `OWNER_APPROVAL_REQUIRED`, `SYSTEM_HALT`.
- **ADM-2** — A new outcome MUST NOT be added without a demonstrated scenario, a statement of why each existing outcome is semantically wrong for it, the cost of overloading an existing one, and Patrick's explicit approval.
- **ADM-3** — Outcomes MUST be totally ordered by severity: `AUTO_RESOLVE < AUTO_IGNORE < AUTO_RETRY < AUTO_DEFER < OWNER_APPROVAL_REQUIRED < OWNER_ATTESTATION_REQUIRED < QUARANTINE < SYSTEM_HALT`.
- **ADM-4** — Every decision MUST carry its primary reason and the complete sorted set of contributing reasons.

### 4.2 Observation handling

- **ADM-5** — An observation with a missing dimension, an unknown dimension, an out-of-schema value, or a non-plain-object shape MUST produce `SYSTEM_HALT` at `component` scope.
- **ADM-6** — An invalid policy object MUST produce `SYSTEM_HALT` at `component` scope.
- **ADM-7** — Equal observations and equal policy MUST produce byte-identical decisions, independent of key order, and MUST NOT mutate the input.
- **ADM-8** — A fault whose blast radius is `unknown` or unreported MUST be treated as `system`.

### 4.3 Composition

- **ADM-9** — The decision MUST be the maximum-severity verdict across all gates; for `SYSTEM_HALT` the widest halt scope wins.
- **ADM-10** — A verdict that is valid only before dispatch (owner approval, attestation, ignore, stale-fence retry) MUST NOT be applied after dispatch; the post-dispatch rule for the same condition MUST apply instead.

### 4.4 Side effects and ambiguity

- **ADM-11** — A possibly-applied effect whose outcome is not proven applied or proven not applied MUST produce `SYSTEM_HALT` with reason `needs_reconciliation` (or a more specific halt reason) at no narrower than `lane` scope.
- **ADM-12** — `AUTO_RETRY` MUST NOT be emitted for an external target after dispatch. External not-applied outcomes MUST be `AUTO_DEFER` (next governed invocation) or `QUARANTINE`.
  - Adapter obligation: external `failure_transient` / `failure_permanent` MUST only represent a conclusive not-applied response. If dispatch may have reached the target, the adapter MUST emit `ambiguous` instead.
- **ADM-13** — `AUTO_RETRY` after dispatch MUST require: internal target, readback `proves_not_applied`, an idempotency identity, and available retry budget.
- **ADM-14** — Automation readback of an external effect MUST NOT resolve ambiguity while `externalReadbackAuthoritative` is `false`. The default MUST be `false`. See OQ-ADM-1.
- **ADM-15** — An internal mutation MUST NOT be recorded complete without readback `proves_applied`. An explicit internal failure MUST NOT be treated as not-applied without readback `proves_not_applied`.
- **ADM-16** — Any effect observed without verified dispatch preconditions MUST produce `SYSTEM_HALT`.
- **ADM-17** — Any effect observed without an idempotency identity MUST produce `SYSTEM_HALT`.
- **ADM-18** — A CAS rejection caused by an advanced runtime generation MUST be treated as a stale fence (`AUTO_RETRY` re-plan; `AUTO_DEFER` on budget exhaustion), not as a store fault.
- **ADM-19** — After dispatch, a changed authority, broken assignment fence, lost/contended lease, concurrent completion of the same identity, unreadable or corrupt canonical state, stale or corrupt checkpoint, or changed item invariant MUST produce `SYSTEM_HALT`.
- **ADM-20** — After dispatch, an owner halt set mid-flight and an unrelated runtime-generation advance MUST NOT prevent recording a proven outcome.

### 4.5 Fences and authority

- **ADM-21** — Before dispatch on a mutating lane, `AUTO_RESOLVE` MUST NOT be emitted unless halt fence, authority, version fence and lease are all current.
- **ADM-22** — Publication MUST NOT proceed while the owner halt is set; the outcome MUST be `AUTO_DEFER`.
- **ADM-23** — Production canonical mutation MUST NOT proceed while the dedicated mutation-lane halt is blocking. A blocking mutation-lane halt yields `AUTO_DEFER`; generation drift or unreadable halt state follows the fail-closed fence rules. Routine safe mutation MUST NOT require a global publication-halt window.
- **ADM-24** — Unknown authority MUST produce `SYSTEM_HALT` at `system` scope. A runtime not bound to durable authority MUST produce `SYSTEM_HALT` at `component` scope and MUST NOT set the shared halt.
- **ADM-25** — Unreadable halt state on a mutating lane before dispatch MUST produce `SYSTEM_HALT` at no narrower than `lane` scope.
- **ADM-26** — Duplicate active assignments (`assignment_multiplicity`) MUST produce `SYSTEM_HALT` at `system` scope.

### 4.6 Blast radius

- **ADM-27** — Canonical corruption proven item-local MUST produce `QUARANTINE`; any other canonical corruption MUST produce `SYSTEM_HALT` at `system` scope (`component` for read-only components).
- **ADM-28** — `QUARANTINE`, owner, and automatic outcomes MUST report `unrelatedWorkContinues = yes`.
- **ADM-29** — `SYSTEM_HALT` at `lane` or `component` scope MUST report `other_lanes_only`; at `system` scope MUST report `no`.

### 4.7 Human authority

- **ADM-30** — A synthesized (non-owner-signed) approval MUST produce `SYSTEM_HALT` at `system` scope, before or after dispatch.
- **ADM-31** — Generated content asserting approval or authority MUST produce at least `QUARANTINE` and MUST NOT be honored.
- **ADM-32** — Promotion without owner exact-digest approval MUST produce at least `OWNER_APPROVAL_REQUIRED`.
- **ADM-33** — Unsupported experiential or factual claims, and current facts without fresh evidence, MUST produce at least `OWNER_ATTESTATION_REQUIRED` before dispatch.
- **ADM-34** — A claim contradicted by evidence MUST produce `QUARANTINE`; attestation MUST NOT be offered as a path to make it publishable.

### 4.8 Lane capability

- **ADM-35** — Only the publication lane MAY carry an external effect. Mutation and staging lanes planning or observing an external effect MUST produce `SYSTEM_HALT`. A read-only component observing any effect MUST produce `SYSTEM_HALT`.

### 4.9 Retry budget

- **ADM-36** — `AUTO_RETRY` MUST NOT be emitted with an exhausted budget; each retry reason MUST declare its escalation target (`AUTO_DEFER` or `SYSTEM_HALT`).

### 4.10 State machine

- **ADM-37** — The processing FSM MUST reject every transition not in its table, leaving state unchanged.
- **ADM-38** — Every transition MUST require its declared evidence keys as non-blank strings.
- **ADM-39** — `COMPLETE` MUST be entered only from `VERIFYING` (automation, with outcome evidence) or from `HALTED` by owner reconciliation.
- **ADM-40** — `EXECUTING` MUST be entered only from `PLANNED` with no possible prior dispatch.
- **ADM-41** — `RETRY_WAIT` and `DEFERRED` MUST exit only to `PLANNED` (fresh fence read) or `HALTED`.
- **ADM-42** — Exits from `HALTED`, `QUARANTINED`, `WAITING_ATTESTATION`, `WAITING_APPROVAL` MUST require actor `owner`. No automated actor, and no timeout, MAY exit them.
- **ADM-43** — Halting from `EXECUTING` MUST mark the item possibly dispatched; such an item MUST leave `HALTED` only by owner reconciliation.
- **ADM-44** — An owner halt clear MUST return a never-dispatched item to `RECEIVED` for full re-evaluation.
- **ADM-45** — A lane halt MUST NOT move items parked in `QUARANTINED` or `WAITING_*`.
- **ADM-46** — An item record whose dispatch flag is inconsistent with its state MUST be rejected.
- **ADM-47** — `QUARANTINED` MUST NOT be deleted; `DISCARDED` MUST be owner-only and MUST retain a tombstone record.
- **ADM-48** — Events from actor `generator` MUST be rejected in every state.

## 5. Acceptance Cases

Test files: `test/autonomy-*.test.mjs`, `test/autonomy/mutation.test.mjs`. Scenario IDs refer to `test/autonomy/harness/scenarios.mjs`.

| Case | Proves | Setup | Expected |
|---|---|---|---|
| ADM-AC-1 | ADM-1, ADM-2, ADM-3 | Contract table inspection | Exactly 8 outcomes; severity is a total order. For ADM-2 this is only the automated guard (adding an outcome fails the test); Patrick's approval is manual evidence recorded in the Change Log. |
| ADM-AC-2 | ADM-4 | Stale runtime + halt generation change | Both reasons present, sorted, unique |
| ADM-AC-3 | ADM-5, ADM-6, ADM-8 | 10 malformed observations, 4 malformed policies | Every one `SYSTEM_HALT` |
| ADM-AC-4 | ADM-7 | Same observation 50 times, key order reversed | One distinct decision; input unchanged |
| ADM-AC-5 | ADM-9 | 15,120 gate-verdict combinations | Result is max severity; widest halt scope |
| ADM-AC-6 | ADM-10, ADM-19 | CP-15, PD-01..PD-07, PD-13, PD-15, PD-18 | `SYSTEM_HALT`; no owner outcome after dispatch |
| ADM-AC-7 | ADM-11, ADM-12 | EX-04, EX-06, EX-09, EX-10, EX-11, CP-05 | `SYSTEM_HALT`; zero retries accepted by FSM |
| ADM-AC-8 | ADM-13 | EX-08b, ST-01, RR-02 | `AUTO_RETRY` target `operation` only with internal not-applied proof |
| ADM-AC-9 | ADM-14 | EX-07 vs EX-07b, EX-08 vs EX-08c | Default halts; trusting policy resolves/defers |
| ADM-AC-10 | ADM-15 | ST-10, PD-17, RR-08b | `SYSTEM_HALT` |
| ADM-AC-11 | ADM-16, ADM-17 | CP-16, PD-15 | `SYSTEM_HALT` |
| ADM-AC-12 | ADM-18 | ST-01c, ST-01d; simulation `different_inputs` | Re-plan, then defer; no lane halt from contention |
| ADM-AC-13 | ADM-20 | CP-08, PD-04, PD-08 | `AUTO_RESOLVE` -> `COMPLETE` |
| ADM-AC-14 | ADM-21 | CS-01, CC-03..CC-06 | Never `AUTO_RESOLVE` |
| ADM-AC-15 | ADM-22, ADM-23 | CC-05b, CP-11, CP-12 | `AUTO_DEFER` for a blocking publication or mutation-lane halt; generation drift/unreadable state remains fail-closed |
| ADM-AC-16 | ADM-24 | CP-10, PD-02; `authority_unknown` via exhaustive enumeration | Component / system scope as stated |
| ADM-AC-17 | ADM-25, ADM-26 | PD-09, CS-04 | Lane / system halt |
| ADM-AC-18 | ADM-27 | CS-11, CS-05b vs CS-02, CS-06, CP-07, CP-17 | Item -> quarantine; other -> system halt |
| ADM-AC-19 | ADM-28, ADM-29 | CP-06, AI-01b | Siblings continue; other lanes continue |
| ADM-AC-20 | ADM-30, ADM-31 | AI-10, AI-10b, CP-14, CL-07 | Quarantine; system halt for forged approval |
| ADM-AC-21 | ADM-32..ADM-34 | AI-05..AI-09, AI-12, CP-13, CP-20 | Attestation before approval; contradicted -> quarantine |
| ADM-AC-22 | ADM-35 | CP-19, PD-12, PD-13, PD-20 | `SYSTEM_HALT` |
| ADM-AC-23 | ADM-36 | CS-01b, CS-09b, CC-06b, ST-01b | Declared escalation target; no retry |
| ADM-AC-24 | ADM-37..ADM-48 | 6,840 enumerated FSM attempts; graph checks; contract exits; mutants | 0 property failures; every FSM mutant killed or proven equivalent |

## 6. Open Questions

| ID | Question | Blocks activation |
|---|---|---|
| OQ-ADM-1 | X readback authority for ambiguous publication. | **Resolved in #145:** remains `false`; owner reconciliation stays authoritative. |
| OQ-ADM-2 | Durable representation of a lane-scoped halt. | **Resolved in #145:** add a dedicated durable mutation-lane halt, generation-CAS fenced; automation may set, only owner may clear. |
| OQ-ADM-3 | Retry policy and readback budget. | **Architecture resolved in #145:** finite, reason-scoped, durable, and every retry re-reads relevant fences; exact numeric constants remain implementation parameters with negative tests/status evidence. |
| OQ-ADM-4 | Owner halt for every canonical mutation. | **Resolved in #145: NO.** Routine safe mutations use the dedicated mutation lane; owner interaction is exception-only per decision outcome. |
| OQ-ADM-5 | Recovery checkpoint before canonical mutation. | **Resolved in #145: YES.** Create and verify one automated checkpoint/backup per mutation run before its first canonical write. |
| OQ-ADM-6 | Concrete error mapping. | **Requirement resolved in #145:** central reviewed mapping through the Batch 0 fault schema, fail closed on unmapped errors; concrete mappings are #145 implementation/test work. |
| OQ-ADM-7 | Independent review before #145 consumes Batch 0. | **Resolved 2026-09-29:** independent review found/fixed IR-01 and IR-02 and clarified IR-03; see package `18-INDEPENDENT-REVIEW-AND-REPAIRS.md`. |

## 7. Verification Status

| Item | Truth state | Evidence |
|---|---|---|
| Reference model satisfies ADM-1..ADM-48 | verified (author-produced, not independent) | `pnpm verify:autonomy` at the Batch 0 working head; see package `12-TEST-RESULTS.md` |
| Existing XQueue tests still pass with Batch 0 files present | verified | full `node --test test/*.test.mjs` run recorded in package |
| Any production component implements this contract | not_applicable | No component consumes `src/autonomy/` yet |
| Independent review | Verified after repair | package `18-INDEPENDENT-REVIEW-AND-REPAIRS.md`; 398-mutant rerun; compound sweep |
| GitHub issue tracking Batch 0 | Verified | #152 closed milestone; #145 consumes Batch 0 directly and records resolved pre-implementation decisions |

## 8. Change Log

| Version | Date | Change |
|---|---|---|
| 0.1.0 | 2026-09-29 | Initial proposed contract from Batch 0. |
| 0.1.1 | 2026-09-29 | Independent review repairs IR-01/IR-02, adapter safety clarification IR-03, and #145 resolution of OQ-ADM-1..7 recorded. |
