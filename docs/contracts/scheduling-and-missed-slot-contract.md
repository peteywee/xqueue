<!--tos-doc
{
  "doc_id": "XQ-DOC-CONTRACT-0001",
  "class": "contract",
  "claims_truth_state": "proposed",
  "written_against": { "head_sha": "8fefc81bddcdcf7e444d26e332dccca232c1939a" },
  "depends_on": [
    "config/schedule-policy.json",
    "src/schedule.mjs",
    "cloudflare/src/",
    "cloudflare/migrations/",
    "docs/contracts/continuous-queue/03-schedule-identity.md"
  ]
}
-->

# Scheduling and Missed-Slot Contract

Status: proposed mainline scheduling contract.
Requirement prefix: SCHED.
Owner: Patrick Craven.
Supersedes the unreconciled copy retained on `contracts/xqueue-v0.2.0-alignment` once this package is merged.

## Purpose

This contract defines how an approved content item receives a durable publication assignment, when that assignment is due, when it becomes missed, how missed work is deferred, and how replacement assignments are created without silently reflowing unrelated work.

The scheduler determines **when an item may be considered**. It does not grant X publication authority.

The schedule identity model is defined by `continuous-queue/03-schedule-identity.md`:
- stable `assignment_id`;
- per-item monotonic `assignment_version`;
- independent `policy_version`;
- exact `content_digest`.

## Definitions

- **Scheduling policy** — owner-approved eligible weekdays, local slot times, timezone, grace window, and placement rules.
- **Slot** — one unique publication opportunity represented by an exact UTC instant plus retained local scheduling metadata.
- **Assignment** — binding of one content revision to one slot under one assignment version and policy version.
- **Resolved instant** — exact UTC instant committed for an assignment.
- **Due** — derived condition: now has reached the assignment's resolved instant while the assignment remains current and publishable.
- **Grace window** — owner-approved duration after the resolved instant during which the original slot remains current.
- **Missed slot** — a current unresolved assignment evaluated strictly after `resolved_at + grace`.
- **Deferred** — lifecycle state meaning the old assignment can no longer authorize dispatch and replacement work is required.
- **Scheduling frontier** — latest active committed future slot among unresolved assignments.
- **Superseded assignment** — immutable prior assignment version retained as historical evidence after a replacement becomes current.

## Scheduling authority and uniqueness

**SCHED-1** — Scheduling policy MUST be owner-approved input. Automation MUST NOT silently change cadence, timezone, grace, ordering, or slot rules.

**SCHED-2** — Given the same canonical content set, active assignments, policy version, and deterministic input order, assignment generation MUST be deterministic.

**SCHED-3** — One unresolved content item MUST have at most one active assignment at a time.

**SCHED-4** — Two unresolved items MUST NOT occupy the same active slot for the same target account unless a future owner-approved contract explicitly defines multi-item slots.

## Time representation and DST

**SCHED-5** — Every active assignment MUST persist an exact UTC resolved instant together with IANA timezone and local wall-clock date/time metadata.

**SCHED-6** — Timezone resolution occurs when the assignment is committed. Later DST changes MUST NOT shift the committed UTC instant.

**SCHED-7** — Unknown or unsupported timezones fail closed. No host-timezone, UTC, or guessed-zone fallback is permitted.

**SCHED-8** — A nonexistent local time during spring-forward MUST be rejected.

**SCHED-9** — An ambiguous local time during fall-back MUST be explicitly disambiguated by policy or rejected.

## Due and missed-slot semantics

**SCHED-10** — `due` is derived at read time and MUST NOT be persisted as lifecycle state.

**SCHED-11** — Grace is an explicit policy value. Runtime wake lateness MUST NOT extend or shorten grace.

**SCHED-12** — A current unresolved assignment becomes missed only when now is strictly later than `resolved_at + grace`. The exact boundary instant remains inside grace.

**SCHED-13** — A missed assignment MUST NOT authorize publication dispatch.

**SCHED-14** — A missed unresolved item that is not `posted`, owner-`skipped`, or `needs_reconciliation` MUST enter `deferred`. Automation MUST NOT convert a missed item to `skipped`.

**SCHED-15** — Stale backlog MUST NOT be drained by catch-up publication bursts. Missed items enter defer/reschedule flow.

## Deferral

**SCHED-16** — Deferral evidence MUST record content ID, prior assignment ID/version/policy version, prior slot, reason, and deferral instant.

**SCHED-17** — A deferred item MUST have no active assignment capable of authorizing dispatch.

**SCHED-18** — Confirmed rate-limit/media handoff from the publication transaction ends the current transaction and enters defer/reschedule flow. It MUST NOT trigger a same-transaction create-post retry.

**SCHED-19** — Automation MUST NOT move `needs_reconciliation` to `deferred` without a recorded reconciliation determination permitting the transition.

## Append and replacement placement

**SCHED-20** — Ordinary append assigns previously unscheduled approved content to the earliest policy-valid, unoccupied slot strictly after the scheduling frontier.

**SCHED-21** — Ordinary append MUST NOT backfill historical holes or move an existing committed assignment.

**SCHED-22** — Automatic replacement for deferred content MUST choose the earliest policy-valid, unoccupied slot after the scheduling frontier unless an explicit owner override applies.

**SCHED-23** — Multiple deferred items awaiting replacement are ordered by prior resolved instant, then stable content ID.

**SCHED-24** — Owner override MAY select a different future policy-valid unoccupied slot, but the action MUST be recorded and MUST NOT erase the superseded assignment.

**SCHED-25** — A new or replacement assignment MUST NOT target the past, an occupied active slot, or an invalid/ambiguous local wall-clock instant.

## Versioning and stale-work fencing

**SCHED-26** — A newly assigned content item starts at `assignment_version = 1`.

**SCHED-27** — Changing one item's committed active slot supersedes the prior assignment and increments only that item's `assignment_version`.

**SCHED-28** — Appending unrelated content MUST NOT increment or invalidate existing assignment versions.

**SCHED-29** — A policy change increments `policy_version` for newly created assignments but MUST NOT silently move existing committed assignments.

**SCHED-30** — Explicit owner-approved reflow MAY supersede future assignments under a new policy version; every moved item receives a new assignment version.

**SCHED-31** — Any stale workflow, scheduler wake, or publisher bound to a superseded assignment/version/content digest MUST fail closed before dispatch.

**SCHED-32** — Assignment creation/supersession and its corresponding durable event/projection update MUST obey exact-version/CAS and event-ordering rules. If canonical scheduling state cannot be read or committed unambiguously, no synthetic in-memory assignment may authorize publication.

## Content separation

A schedule operation MUST NOT silently rewrite post text, media, thread structure, or target account.

Content revision and assignment version are separate identities. If approved content changes after assignment, an explicit content-revision/rebind operation is required.

## Policy changes

Historical posted assignment/evidence is immutable.

Changing policy affects new assignments by default. Reflow of unresolved future work is a separate explicit owner-approved operation.

## Prohibited

- Persisting `due` or `eligible` as lifecycle state.
- Publishing from an expired/missed assignment.
- Automatic missed -> skipped.
- Opportunistic backlog catch-up bursts.
- Silent timezone fallback or DST normalization.
- Two active assignments for one unresolved item.
- Two unresolved items in one active account slot.
- Reusing an assignment version after slot change.
- Direct deferred -> prepared without a new scheduled assignment.
- Reordering deferred content by retry count, worker wake order, or DB row order.
- Rewriting historical assignment evidence.
- Ordinary append that moves prior assignments.

## Acceptance cases

| Case | Expected |
|---|---|
| SCHED-AC-1 | Same canonical inputs yield byte-equivalent proposed assignments |
| SCHED-AC-2 | Unsupported timezone fails; no fallback |
| SCHED-AC-3 | Nonexistent/ambiguous local time fails unless explicitly disambiguated |
| SCHED-AC-4 | Exactly at slot+grace remains current; later instant is missed |
| SCHED-AC-5 | Missed item does not dispatch and becomes deferred, not skipped |
| SCHED-AC-6 | Outage with multiple stale items does not create catch-up burst |
| SCHED-AC-7 | Deferred item cannot dispatch until replacement exists |
| SCHED-AC-8 | needs_reconciliation cannot auto-defer |
| SCHED-AC-9 | Append adds one tail assignment and leaves all prior assignments unchanged |
| SCHED-AC-10 | Replacement supersedes one item and increments only that item's assignment version |
| SCHED-AC-11 | Policy change leaves existing assignments fixed unless explicit reflow |
| SCHED-AC-12 | Stale assignment/version/content digest refuses before dispatch |
| SCHED-AC-13 | Scheduling-store read/write ambiguity fails closed |
| SCHED-AC-14 | Concurrent frontier claims cannot create duplicate occupied slots |

## Policy values intentionally separate from semantics

The contract freezes behavior without hard-coding future business values such as:
- exact grace duration;
- exact weekdays/slot times;
- account-specific cadence;
- initial runway thresholds.

Those remain owner-approved policy inputs.
