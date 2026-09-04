<!--tos-doc
{
  "doc_id": "XQ-DOC-REVIEW-0003",
  "class": "review",
  "claims_truth_state": "declared",
  "written_against": { "head_sha": "faa0728e146182dad89f3adca1801a47a95d01bd" },
  "depends_on": [
    "docs/contracts/scheduling-and-missed-slot-contract.md",
    "src/schedule.mjs",
    "src/post-time.mjs",
    "cloudflare/src/eligibility.mjs",
    "config/schedule-policy.json",
    "scripts/build-production-queue.mjs",
    "test/schedule.test.mjs",
    "test/post-time.test.mjs",
    "test/cloudflare-eligibility-parity.test.mjs"
  ]
}
-->

# Scheduling Conformance Audit — 2026-09-04

| Field | Value |
|---|---|
| Doc ID | XQ-DOC-REVIEW-0003 |
| Class | implementation conformance review |
| Created | 2026-09-04 |
| Last updated | 2026-09-04 |
| Normative source | proposed `docs/contracts/scheduling-and-missed-slot-contract.md` v0.1.0 |
| Reviewed branch head | `faa0728e146182dad89f3adca1801a47a95d01bd` |
| Code lineage | scheduling/runtime implementation remains materially inherited from audited `main` `cc8fe06973e36bd10fcd5b8b8a86cb90359dd43a`; branch changes before this review are contracts/audit tooling and append-only event enforcement |
| Review rule | Existing behavior is evidence. Contract requirements remain the target. |

## 1. Executive result

The existing xqueue scheduler has a strong **static authoring** foundation: deterministic queue
generation, a committed policy file, stable content distribution, unique date/time slots, explicit
America/Chicago metadata, and a tail-deferral helper that preserves unaffected assignments.

It does not yet implement the full **runtime scheduling lifecycle** described by the proposed
scheduling contract. The main gaps are:

1. wall-clock times are re-resolved at read time instead of storing an exact UTC assignment;
2. nonexistent and ambiguous DST wall clocks are silently normalized/resolved by existing code;
3. local live selection can still consider stale overdue items due, while Cloudflare adds a
   stricter stale-backlog veto;
4. there is no durable runtime `deferred` lifecycle path, deferral event, or replacement-assignment
   store;
5. schedule-version authority and stale-version fencing do not yet exist;
6. static `deferToEnd` is an authoring primitive, not runtime missed-slot recovery.

Issues #52, #53, and #54 record the concrete scheduling conformance work. Issue #47 owns the
schedule-version decision those changes depend on.

## 2. What already aligns well

| Contract area | Status | Evidence / interpretation |
|---|---|---|
| `SCHED-1` policy as explicit input | **PARTIAL / STRONG BASE** | `config/schedule-policy.json` explicitly carries campaign start, timezone, slots, weekdays, expected counts, and static tail deferrals. Some defaults also remain encoded in `src/schedule.mjs`, so policy authority is not yet singularly enforced. |
| `SCHED-2` deterministic generation | **CONFORMS for static authoring** | `test/schedule.test.mjs` proves repeated generation from identical inputs yields identical ordering; the production build consumes the committed policy file. |
| `SCHED-3` one static assignment per item | **CONFORMS for generated queue; runtime model absent** | The generated queue contains each content ID once. No durable runtime assignment/supersession model exists yet. |
| `SCHED-4` unique account slot | **CONFORMS for static queue** | Existing tests prove date/time pair uniqueness across the generated queue. Runtime persistence does not yet enforce this as a durable uniqueness constraint. |
| `SCHED-7` unknown timezone | **PARTIAL / FAIL-CLOSED READ PATH** | Cloudflare eligibility treats unsupported IANA zones as `unknown_timezone`; local `Intl` resolution throws. This is good fail-closed behavior, but assignments still lack committed UTC instants. |
| `SCHED-10` due is derived | **CONFORMS** | `isDue()` and Cloudflare eligibility calculate due at read time; no `due` lifecycle value is persisted. |
| `SCHED-12` grace boundary arithmetic | **CONFORMS in current health arithmetic** | Overdue uses a strict `< cutoff` comparison, leaving the exact `slot + grace` boundary inside grace. |
| `SCHED-29` scheduling does not rewrite intent | **CONFORMS for static tail deferral** | `deferPostsToEnd()` changes scheduling fields only; content body/media metadata are not rewritten by the helper. |

## 3. Time and DST findings

| Contract area | Status | Finding | Tracking |
|---|---|---|---|
| `SCHED-5` exact UTC assignment persisted | **FAIL** | Static queue records `scheduledDate`, `scheduledTime`, and `timezone`; it does not persist the resolved UTC instant. | #52 |
| `SCHED-6` resolve at assignment commit | **FAIL** | `src/post-time.mjs` and Cloudflare eligibility recompute wall-clock → UTC at read time. | #52 |
| `SCHED-8` nonexistent spring-forward time | **FAIL — TEST-LOCKED** | Existing parity evidence deliberately resolves a nonexistent local time instead of refusing the assignment. | #52 |
| `SCHED-9` ambiguous fall-back time | **FAIL — TEST-LOCKED** | Existing parity tests deliberately select one occurrence of a repeated wall clock. | #52 |

The production policy currently uses `14:30` and `22:15`, so the canonical campaign does not
appear to place content inside the common DST transition hours. That reduces immediate production
exposure but does not make the resolver behavior conforming. Migration work still needs to prove
the 180-item canonical schedule resolves to the same intended instants before committing a new
assignment representation.

## 4. Missed-slot and backlog findings

| Contract area | Status | Finding | Tracking |
|---|---|---|---|
| `SCHED-11` grace is policy input | **PARTIAL** | Cloudflare publication currently supplies a hard-coded 20-minute eligibility grace. The committed schedule policy file does not yet carry grace as the authoritative production value. | #53 / policy decision |
| `SCHED-13` stale slot cannot dispatch | **FAIL / PATH DIVERGENCE** | Cloudflare `safeToPublish` withholds on stale backlog, but the local live selection model still selects from `due`, including overdue items. | #53 |
| `SCHED-14` missed → deferred | **NOT IMPLEMENTED** | Durable state lacks `deferred`; no runtime transition exists. | #53 + #43 |
| `SCHED-15` no catch-up backlog drain | **FAIL in local rollback semantics** | Repeated local invocations can continue selecting stale due items one at a time rather than moving them through a defer/reschedule path. | #53 |
| `SCHED-16` durable deferral evidence | **NOT IMPLEMENTED** | No runtime deferral event carries prior assignment/version/reason. | #53 / #47 |
| `SCHED-17` deferred has no active slot | **NOT IMPLEMENTED** | No durable runtime deferred state/assignment model exists. | #53 |
| `SCHED-18` rate-limit/media handoff | **BLOCKED / PARTIAL** | Publication classifier can produce confirmed-not-posted evidence, but persistence currently collapses those semantics and no runtime deferred path exists. | #38 → #53 |
| `SCHED-19` reconciliation → deferred guard | **NOT IMPLEMENTED** | Requires the durable state transition model and reconciliation evidence path. | #53 |

## 5. Replacement assignment and version findings

`src/schedule.mjs::deferPostsToEnd()` is useful evidence of one design instinct worth preserving:
selected static posts can be moved after the normal campaign tail without shifting every other
assignment. It is not sufficient as the runtime rescheduler because it accepts caller order and
mutates an in-memory/generated queue rather than producing durable assignment supersession.

| Contract area | Status | Finding | Tracking |
|---|---|---|---|
| `SCHED-20`–`SCHED-21` automatic replacement after frontier | **PARTIAL STATIC ANALOG ONLY** | Static `deferToEnd` appends after the existing tail, but runtime frontier/state semantics are absent. | #54 |
| `SCHED-22` deterministic ordering of multiple deferred items | **FAIL / NOT IMPLEMENTED** | Static helper uses the caller-supplied ID order; it does not order runtime deferred work by prior resolved instant then stable ID. | #54 |
| `SCHED-23` audited owner override | **NOT IMPLEMENTED** | No durable owner scheduling override path/evidence exists. | #54 |
| `SCHED-24` invalid replacement target refusal | **PARTIAL STATIC** | Static generation avoids collisions through construction, but there is no runtime durable constraint for past/occupied/DST-invalid replacement targets. | #52 / #54 |
| `SCHED-25`–`SCHED-26` new schedule version on reschedule | **BLOCKED / NOT IMPLEMENTED** | There is a policy file `version`, but no approved per-assignment/version authority model satisfying #47. | #47 → #54 |
| `SCHED-27` no direct deferred → prepared | **NOT IMPLEMENTED** | Deferred lifecycle is absent. | #53 / #54 |
| `SCHED-28` stale-version wakeup fencing | **NOT IMPLEMENTED** | Publisher/workflow evidence does not bind an authoritative schedule version. | #47 / #41 / #54 |
| `SCHED-30` explicit future reflow | **PARTIAL** | Regenerating the static queue can deterministically change future assignments, but durable historical/supersession evidence is absent. | #54 |
| `SCHED-31` authoritative scheduling state fail-closed | **BLOCKED PRE-CUTOVER** | Current schedule is largely generated file/in-memory data; post-cutover authoritative assignment storage is not established. | #54 / #46 |
| `SCHED-32` schedule event + projection discipline | **NOT IMPLEMENTED** | No runtime scheduling-event/projection subsystem exists yet. | #43 / #54 |

## 6. Required ordering

Recommended implementation order from this audit:

1. **#52** — make wall-clock assignment resolution fail closed and establish exact UTC assignment
   semantics while proving the current 180-item campaign does not drift.
2. **#38** — preserve confirmed-not-posted outcome semantics so rate-limit/media classes can be
   handed to scheduling correctly.
3. **#43 + #47** — add mutable-row CAS generation and approve the schedule-version authority
   model.
4. **#53** — implement runtime missed-slot → `deferred` and block stale-slot dispatch on every
   publisher path.
5. **#54** — implement durable replacement assignments, deterministic deferred ordering, owner
   override evidence, and stale-version fencing.
6. **#41 / #46** — carry the final scheduling identity into publication evidence and production
   activation proof.

## 7. Strong properties to preserve

- deterministic static campaign generation;
- committed owner-readable schedule policy;
- unique static slot assignments;
- no unrelated schedule movement during the existing tail-deferral authoring operation;
- explicit IANA timezone metadata;
- strict grace-boundary arithmetic;
- Cloudflare's current conservative stale-backlog withholding until the durable defer path exists.

## 8. Conclusion

The recovered scheduling specification is already exposing behavior that the prior parity suite
mistook for correctness because both runtimes agreed on it. DST normalization is the clearest
example: parity is useful, but parity between two implementations does not prove conformance to
the intended rule.

The next engineering work therefore follows the same pattern as the publication audit:
**normative rule → failing/contradictory evidence → issue → code/test remediation → exact-candidate
proof**.
