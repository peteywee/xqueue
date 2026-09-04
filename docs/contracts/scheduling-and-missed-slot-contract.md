<!--tos-doc
{
  "doc_id": "XQ-DOC-CONTRACT-0001",
  "class": "contract",
  "claims_truth_state": "proposed",
  "written_against": { "head_sha": "Not yet verified" },
  "depends_on": [
    "src/",
    "cloudflare/src/",
    "docs/contracts/"
  ]
}
-->

# Scheduling and Missed-Slot Contract

| Field | Value |
|---|---|
| Doc ID | XQ-DOC-CONTRACT-0001 |
| Requirement prefix | `SCHED` |
| Status | proposed — not yet approved |
| Version | 0.1.0 |
| Created | 2026-09-04 |
| Last updated | 2026-09-04 |
| Owner | Patrick Craven (sole approving authority) |
| Drafted by | ChatGPT from approved cross-contract business intent and safety constraints; not reverse-engineered from current scheduler code |
| Supersedes | none |
| Superseded by | none |
| Verified against implementation | No — implementation audit follows this document |

## 1. Purpose

This contract defines what a schedule assignment means, when an item is due, when a slot is
missed, how missed or temporarily refused content is deferred, and how deferred content receives
a replacement slot.

The scheduler is not publication authority. It decides **when an item is eligible to be
considered**, not whether the X API may be called. Publication authority, fencing, outcome
classification, and durable lifecycle state remain governed by their own contracts.

This document was created because the contract set referenced a scheduling contract that could
not be recovered from the repository or available saved xqueue materials. Its requirements are
therefore a fresh normative proposal derived from the already-stated xqueue intent: deliberate
cadence, no silent content loss, deterministic time handling, no opportunistic catch-up bursts,
and explicit versioned rescheduling. Existing scheduler behavior is evidence to audit later, not
the source of these rules.

## 2. Definitions

| Term | Definition |
|---|---|
| **Scheduling policy** | Owner-approved rules that define eligible weekdays, local slot times, timezone, grace window, and any campaign-specific placement rules. |
| **Slot** | One unique publication opportunity represented by an exact UTC instant plus the local scheduling metadata from which it was resolved. |
| **Assignment** | The binding of one content item to one slot under one schedule version. |
| **Resolved instant** | The unambiguous UTC instant corresponding to an assigned local wall-clock slot. |
| **Due** | A derived condition: the current instant has reached or passed the assigned resolved instant and the item remains publishable. |
| **Grace window** | A configured period after the resolved instant during which the original slot is still considered current. |
| **Missed slot** | A slot whose grace window has expired without the item becoming `posted`, `skipped`, or `needs_reconciliation`. |
| **Deferred** | A content lifecycle state meaning the old slot is no longer valid and a new future slot must be assigned before publication. |
| **Scheduling frontier** | The latest committed future slot already assigned to an unresolved campaign item; replacement deferrals are placed after this frontier unless the owner explicitly overrides placement. |
| **Schedule version** | The version identity that makes a slot assignment detectably stale after rescheduling. Representation and storage are defined by the approved schedule-version model, not by this contract alone. |

## 3. Scheduling authority and determinism

**SCHED-1** — The scheduling policy MUST be owner-approved input. Automation MAY execute an
approved policy, but MUST NOT silently change cadence, timezone, grace, ordering, or slot rules.

**SCHED-2** — Given the same content set, scheduling policy, prior committed assignments, and
schedule-version inputs, schedule generation MUST be deterministic.

**SCHED-3** — An unresolved item MUST have at most one active slot assignment at any instant.
Creating a replacement assignment MUST retire the prior assignment as superseded evidence rather
than leaving two active slots.

**SCHED-4** — Two unresolved items MUST NOT share the same active slot instant for the same target
account unless a future contract revision explicitly defines multi-item slots.

## 4. Time representation and DST

**SCHED-5** — Every active assignment MUST persist an exact UTC resolved instant together with the
IANA timezone and local wall-clock date/time used to derive it. A local wall-clock string alone is
not a valid production assignment.

**SCHED-6** — Timezone resolution MUST occur when the assignment is committed. A later DST offset
change MUST NOT shift an already committed resolved instant.

**SCHED-7** — An unknown or unsupported timezone MUST cause assignment to fail closed. The
scheduler MUST NOT substitute the host timezone, UTC, or another guessed zone.

**SCHED-8** — A nonexistent local wall-clock time during a spring-forward transition MUST be
rejected as an invalid slot. It MUST NOT be silently normalized to an earlier or later instant.

**SCHED-9** — An ambiguous local wall-clock time during a fall-back transition MUST either carry
an explicit disambiguating offset/occurrence in the policy or be rejected. The scheduler MUST NOT
silently choose an occurrence.

## 5. Due and missed-slot semantics

**SCHED-10** — `due` MUST be derived at read time from the current instant and the active resolved
slot. `due` MUST NOT be persisted as lifecycle state.

**SCHED-11** — The grace window MUST be an explicit scheduling-policy value. A runtime MUST NOT
invent, extend, or shorten grace based on how late a worker happened to wake up.

**SCHED-12** — An unresolved slot becomes missed only when the current instant is strictly later
than `resolved_instant + grace_window`. The exact boundary instant remains inside grace.

**SCHED-13** — Once a slot is missed, the stale slot MUST NOT authorize a publication dispatch.
The item MUST be rescheduled before it can become publication-eligible again.

**SCHED-14** — A missed item that is not `posted`, `skipped`, or `needs_reconciliation` MUST move
to `deferred`; automation MUST NOT translate a missed slot into `skipped`.

**SCHED-15** — A stale backlog MUST NOT be drained by opportunistically dispatching every missed
item when a scheduler or publisher resumes. Missed items MUST enter the explicit defer/reschedule
path.

## 6. Deferral

**SCHED-16** — Every deferral MUST record the item ID, reason, prior slot, prior schedule version,
and deferral instant as durable evidence.

**SCHED-17** — While an item is `deferred`, it MUST have no active publication slot capable of
authorizing dispatch.

**SCHED-18** — `rate_limit` and `media` outcomes handed off by the publication transaction
contract MUST end the current publication transaction and enter the defer/reschedule path. The
scheduler MUST NOT convert that handoff into a same-transaction create-post retry.

**SCHED-19** — Automation MUST NOT move a `needs_reconciliation` item into `deferred`. That
transition is valid only after the reconciliation contract/state rules have produced a recorded
determination permitting it.

## 7. Replacement-slot selection

**SCHED-20** — An automatic replacement slot MUST be a future slot strictly later than the
current instant and strictly later than the existing scheduling frontier for unresolved campaign
content.

**SCHED-21** — Automatic rescheduling MUST choose the earliest policy-valid, unoccupied slot after
the scheduling frontier. It MUST NOT displace or rewrite an already committed assignment merely
to bring deferred content forward.

**SCHED-22** — When multiple deferred items await automatic replacement, they MUST be ordered by
their superseded resolved instant, then by stable item ID as a deterministic tie-breaker.
Retry count, failure count, worker wake order, and database row order MUST NOT change that order.

**SCHED-23** — An owner MAY explicitly place a deferred item into a different future policy-valid
slot, but the override MUST be recorded as an owner action and MUST NOT erase the superseded
assignment or deferral evidence.

**SCHED-24** — A replacement assignment MUST NOT target an instant in the past, an occupied active
slot, or an invalid/ambiguous local wall-clock instant.

## 8. Versioning and lifecycle handoff

**SCHED-25** — Any change to an item's committed active slot MUST produce a detectably new schedule
version according to the approved schedule-version model. Reusing the old version after a slot
change is prohibited.

**SCHED-26** — `deferred → scheduled` MUST create the replacement assignment and new schedule
version before the item can again become due.

**SCHED-27** — `prepared` MUST NOT be reached directly from `deferred`. A deferred item MUST first
return to `scheduled` under a new valid assignment/version; only then may another contract permit
`schedule → prepared`.

**SCHED-28** — A workflow, wakeup, or publisher bound to a superseded schedule version MUST fail
closed and MUST NOT dispatch under the stale assignment.

**SCHED-29** — Rescheduling MUST NOT alter content text, media, thread structure, or target account
as a side effect. Intent changes belong to content/publication governance and produce their own
intent digest changes.

## 9. Policy changes and operational failure

**SCHED-30** — Changing the scheduling policy MUST NOT rewrite historical posted assignments or
event evidence. Any reflow of unresolved future content MUST be an explicit owner-approved
operation with new schedule versions.

**SCHED-31** — If authoritative scheduling state cannot be read or a replacement assignment cannot
be committed, scheduling MUST fail closed. The system MUST NOT synthesize an in-memory slot and
publish from it.

**SCHED-32** — A schedule write and its corresponding scheduling event MUST obey the durable-state
contract's atomicity/event-ordering rule. A projection that claims a new slot without durable
evidence is invalid.

## 10. Prohibited

- Treating `eligible` or `due` as persisted lifecycle states.
- Publishing from a missed slot after grace has expired.
- Automatically converting missed content to `skipped`.
- Backlog catch-up bursts that bypass defer/reschedule.
- Silent host-timezone fallback.
- Silent DST normalization of nonexistent or ambiguous wall-clock times.
- Two active slots for one unresolved item.
- Two unresolved items occupying one account slot.
- Reusing a schedule version after the committed slot changes.
- Direct `deferred → prepared` transition.
- Reordering deferred content based on retry count or worker/database incidental order.
- Rewriting committed historical schedule evidence.

## 11. Acceptance cases

| Case | Proves | Setup | Expected |
|---|---|---|---|
| SCHED-AC-1 | SCHED-1 | Automation attempts to change timezone/cadence without owner-approved policy change | Refused; existing policy remains authoritative |
| SCHED-AC-2 | SCHED-2 | Generate twice from byte-identical inputs | Byte-equivalent assignment result |
| SCHED-AC-3 | SCHED-3 | Attempt second active assignment for one unresolved item | Rejected or prior assignment superseded atomically; never two active assignments |
| SCHED-AC-4 | SCHED-4 | Attempt to assign two unresolved items to one account instant | Second assignment refused |
| SCHED-AC-5 | SCHED-5, SCHED-6 | Commit a summer slot, then evaluate after a DST offset change | Stored UTC instant remains unchanged and local metadata is retained |
| SCHED-AC-6 | SCHED-7 | Policy names an unsupported timezone | Assignment fails; no fallback zone used |
| SCHED-AC-7 | SCHED-8 | Assign a spring-forward nonexistent local time | Assignment rejected; no normalized instant committed |
| SCHED-AC-8 | SCHED-9 | Assign a fall-back ambiguous local time without explicit disambiguation | Assignment rejected |
| SCHED-AC-9 | SCHED-10 | Inspect stored lifecycle state for a due item | No `due`/`eligible` state value; condition is derived |
| SCHED-AC-10 | SCHED-11 | Worker wakes late and attempts to extend grace ad hoc | Original configured grace remains in force |
| SCHED-AC-11 | SCHED-12 | Evaluate exactly at `slot + grace` and one millisecond after | Boundary remains in grace; later instant is missed |
| SCHED-AC-12 | SCHED-13, SCHED-14 | Unresolved item wakes after grace | No dispatch from old slot; item enters `deferred`, not `skipped` |
| SCHED-AC-13 | SCHED-15 | Ten stale items exist after an outage | No catch-up dispatch burst; all use defer/reschedule path |
| SCHED-AC-14 | SCHED-16 | Defer an item | Evidence contains reason, prior slot/version, and deferral instant |
| SCHED-AC-15 | SCHED-17 | Evaluate a deferred item before replacement | No active slot can authorize dispatch |
| SCHED-AC-16 | SCHED-18 | Publication returns confirmed rate-limit/media class | Current transaction ends; no create-post retry; scheduler receives deferral work |
| SCHED-AC-17 | SCHED-19 | Automation tries `needs_reconciliation → deferred` without determination | Refused |
| SCHED-AC-18 | SCHED-20, SCHED-21 | Deferred item with existing future campaign assignments | Earliest unoccupied policy-valid slot after frontier is selected |
| SCHED-AC-19 | SCHED-22 | Multiple deferred items inserted/read in different database orders | Replacement order remains prior-slot then stable-ID order |
| SCHED-AC-20 | SCHED-23 | Owner selects a different valid future slot | Override recorded; old assignment/evidence preserved |
| SCHED-AC-21 | SCHED-24 | Replacement targets past, occupied, nonexistent, or ambiguous instant | Refused in every case |
| SCHED-AC-22 | SCHED-25, SCHED-26 | `deferred → scheduled` with replacement slot | New detectable schedule version exists before item is due |
| SCHED-AC-23 | SCHED-27 | Attempt direct `deferred → prepared` | Refused; must pass through `scheduled` with new assignment/version |
| SCHED-AC-24 | SCHED-28 | Old workflow wakes after item was rescheduled | Stale version blocks dispatch |
| SCHED-AC-25 | SCHED-29 | Reschedule an item | Content intent remains byte-equivalent; only scheduling identity changes |
| SCHED-AC-26 | SCHED-30 | Owner changes future cadence | Historical posted schedule evidence unchanged; unresolved reflow is explicit/versioned |
| SCHED-AC-27 | SCHED-31 | Scheduling store read/write fails | No synthetic slot; scheduling/publishing fail closed |
| SCHED-AC-28 | SCHED-32 | Simulate failure between schedule event/projection operations | Durable-state recovery rule detects/reconciles lag; no unsupported assignment authorizes publish |

## 12. Open questions requiring Patrick's decision

| ID | Question | Blocking |
|---|---|---|
| OQ-SCHED-1 | What exact production grace-window duration should the approved scheduling policy use? | Yes — production policy value, not semantics |
| OQ-SCHED-2 | What exact weekdays and local slot times are owner-approved for each campaign/account? | Yes — production policy value, not semantics |
| OQ-SCHED-3 | May an owner override place deferred content before the automatic scheduling frontier, provided it is future and unoccupied? | No — automatic behavior is already defined |
| OQ-SCHED-4 | What runbook/UI mechanism records an owner schedule override? | No — affects operations, not transition legality |
| OQ-SCHED-5 | Is `prepared` needed long-term, or should a later contract revision remove it? | No — direct `deferred → prepared` remains prohibited either way |

## 13. Cross-contract obligations

- The durable-state contract owns the legal lifecycle transitions and persistence CAS rules.
- The publication-transaction contract owns rate-limit/media classification and prohibits a
  same-transaction create-post retry.
- The workflow-lifecycle contract owns stale workflow behavior and the authoritative
  representation/storage of schedule versions.
- The authority contract owns who may change scheduling policy, manually reschedule, or perform
  owner-reserved cutover operations.

## 14. Change log

| Version | Date | Change |
|---|---|---|
| 0.1.0 | 2026-09-04 | Fresh normative scheduling/missed-slot proposal created after the referenced prior contract could not be recovered. Derived from cross-contract business intent and safety constraints, explicitly not from current scheduler behavior. |
