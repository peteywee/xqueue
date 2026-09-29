<!--tos-doc
{
  "doc_id": "XQ-DOC-ARCH-AUTONOMY-0005",
  "class": "architecture",
  "claims_truth_state": "proposed",
  "written_against": { "head_sha": "0f3fb9c6d974c99ad58f9b135b19e50dcee366de" },
  "depends_on": ["src/autonomy/invariants.mjs", "test/autonomy-invariants.test.mjs", "test/autonomy-exhaustive.test.mjs", "test/autonomy-concurrency-sim.test.mjs"]
}
-->

# Invariant Catalog

Status: proposed. Machine-readable source: `INVARIANTS` in `src/autonomy/invariants.mjs`.

All 22 candidate invariants from the work order were kept. One was strengthened (INV-22). Eight were added, each because an attack on the model found a hole the candidate set did not close. None were removed.

## How each kind is checked

| Check kind | Method |
|---|---|
| decision | Executable predicate `(observation, decision, policy) -> violation or null`, run on 50,528 lifted gate-domain points, the 48-row Section 12 kernel, 400,000 seeded samples (uniform + near-baseline), and every scenario item. Each predicate also has a non-vacuity witness: a deliberately wrong decision it must reject (`test/autonomy-invariants.test.mjs`). |
| fsm | Direct assertions over the transition table plus the exhaustive FSM property and graph oracles. |
| simulation | Exhaustive state-graph exploration of two concurrent actors with injected faults and crash points (`test/autonomy/harness/sim.mjs`). |
| determinism | Repeat and key-order-permuted evaluation; seeded sample re-evaluation. |

## Catalog

| ID | Origin | Check | Invariant | Justification (modified/added only) |
|---|---|---|---|---|
| INV-01 | candidate | decision | No unverified artifact becomes canonical production truth. |  |
| INV-02 | candidate | decision | No ambiguous external mutation is blindly retried. |  |
| INV-03 | candidate | decision | No generated assertion can approve itself. |  |
| INV-04 | candidate | decision | No machine-generated experiential claim can attest to itself. |  |
| INV-05 | candidate | decision | No item-local failure unnecessarily blocks unrelated safe work. |  |
| INV-06 | candidate | decision | No system-level integrity failure may be downgraded to item quarantine. |  |
| INV-07 | candidate | determinism | Same source + same version + same plan produces the same decision. |  |
| INV-08 | candidate | fsm | Every completed mutation has durable evidence. |  |
| INV-09 | candidate | decision | Every resumable operation has an idempotency identity. |  |
| INV-10 | candidate | decision | Every external side effect has an independently readable outcome or enters ambiguity handling. |  |
| INV-11 | candidate | decision | A stale halt generation cannot authorize mutation. |  |
| INV-12 | candidate | decision | A stale runtime generation cannot authorize mutation. |  |
| INV-13 | candidate | decision | A stale assignment/version cannot authorize mutation. |  |
| INV-14 | candidate | decision+simulation | A duplicate input cannot create duplicate canonical work. |  |
| INV-15 | candidate | fsm+simulation | Restarting an interrupted run cannot replay completed side effects. |  |
| INV-16 | candidate | simulation | Concurrent ingestion of the same logical input converges safely. |  |
| INV-17 | candidate | decision | Unknown does not mean safe. |  |
| INV-18 | candidate | decision | Failure to prove safety is not equivalent to proof of failure. |  |
| INV-19 | candidate | decision+fsm | Publication authority and content-generation authority remain separate. |  |
| INV-20 | candidate | decision+fsm | Generated content never grants itself owner approval. |  |
| INV-21 | candidate | fsm | Item quarantine does not silently become permanent data loss. |  |
| INV-22 | modified | fsm | SYSTEM_HALT cannot be automatically cleared by ANY automated actor (strengthened from "by the component that triggered it"). | Existing publication-halt semantics already restrict automation to setting the halt (actor_class automation); only the owner path clears. "Not the triggering component" would still let a sibling automation clear it, which reintroduces self-approval by proxy. |
| INV-23 | added | decision | Any effect observed without verified dispatch preconditions halts the lane. | Found while attacking composition: after an effect, a pre-dispatch verdict (e.g., approval missing) must not be read as "ask the owner"; the effect already happened without the precondition. |
| INV-24 | added | decision | Post-dispatch items are never ignored, never sent to owner approval/attestation, and only quarantined with not-applied proof. | An effect that may have happened must be accounted for before the item can leave the verification path. |
| INV-25 | added | fsm | Every retry re-plans from fresh fence reads (RETRY_WAIT and DEFERRED only re-enter PLANNED). | Prevents a retry from re-using a fence snapshot that authorized the failed attempt. |
| INV-26 | added | fsm | Owner waiting states never time out into progress; owner unavailability leaves work parked. | Compound chaos (owner unavailable) showed the candidate set never forbade a timeout-based exit; a timeout that advances work is an approval synthesized by the clock. |
| INV-27 | added | decision | Every decision is a defined, contract-consistent outcome (0 undefined, 0 contradictory fields). | Section 12 requires 0 undefined and 0 contradictory outcomes; this makes that requirement an executable predicate checked on every enumerated and sampled decision. |
| INV-28 | added | decision | After a possible dispatch, any broken fence, lease, authority, canonical read, checkpoint, or item invariant halts at least the lane. | Added after mutation analysis showed post-dispatch fence rules were not independently asserted. An effect whose surrounding evidence cannot be bound must be reconciled, not recorded as if clean. |
| INV-29 | added | decision | A resumed operation whose prior application cannot be proven either way never proceeds or is ignored. | Added after mutation analysis: pre-dispatch readback unavailable/contradictory (checking whether a prior run applied) must not be read as "not applied". |
| INV-30 | added | decision | Legitimate post-dispatch changes (owner halt set mid-flight, unrelated runtime append) do not block recording a proven outcome. | Liveness counterpart to INV-28: over-halting after a clean, proven effect would turn ordinary concurrency into owner work. |

## Candidate wording kept, with the executable reading made explicit

- **INV-17 "Unknown does not mean safe"** — reads as: unknown blast radius is system scope; unknown authority and unreadable halt state halt; an internally inconsistent observation halts; any out-of-schema value halts (ADM-5).
- **INV-18 "Failure to prove safety is not proof of failure"** — reads as: an unproven effect is never treated as not-applied (no AUTO_RETRY, AUTO_DEFER, or QUARANTINE that assumes nothing happened).
- **INV-05 "No item-local failure unnecessarily blocks unrelated safe work"** — reads as: every non-halt outcome reports `unrelatedWorkContinues = yes`; lane/component halts report `other_lanes_only`.

## Invariant defects found in my own predicates (not model defects)

Two predicates first demanded a *specific* narrow halt scope (INV-17 inconsistent observation, INV-19 read-only effect). The model correctly produced a *wider* scope when another fault was present at the same time (widest scope wins, ADM-9). The predicates were corrected to require a halt, not a narrow scope. Recorded here because a predicate that is wrong in the strict direction can hide a model that is wrong in the lax direction.
