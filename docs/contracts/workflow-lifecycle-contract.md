<!--tos-doc
{
  "doc_id": "XQ-DOC-CONTRACT-0005",
  "class": "contract",
  "claims_truth_state": "proposed",
  "written_against": { "head_sha": "Not yet verified" },
  "depends_on": [
    "src/",
    "migrations/",
    "wrangler.toml",
    "wrangler.jsonc",
    "docs/contracts/"
  ]
}
-->

# Workflow Lifecycle Contract

| Field | Value |
|---|---|
| Doc ID | XQ-DOC-CONTRACT-0005 |
| Requirement prefix | `WF` |
| Status | proposed — not yet approved |
| Version | 0.2.0 |
| Created | 2026-09-03 |
| Last updated | 2026-09-03 |
| Owner | Patrick Craven (sole approving authority) |
| Drafted by | Claude; revised against the ChatGPT contract audit of 2026-09-03 |
| Supersedes | 0.1.0 (proposed, never active) |
| Superseded by | none |
| Verified against implementation | No — Workflows not yet implemented; repository not inspectable |
| Precedence | **Write this before implementing the Workflow scheduler, not after** |

## 1. Purpose

A durable execution engine is a machine for making sure something eventually happens. That is
what makes it dangerous here: it will faithfully resume a decision that stopped being correct
months ago.

```text
B30 workflow-v1 → scheduled Sep 2
                     ↓
                misses window
                     ↓
B30 → moved to Jan 5
                     ↓
B30 workflow-v2 created

BUT...

old workflow-v1 eventually wakes
```

Without a written invariant, v1 wakes on Jan 5, believes it is the publisher for B30, and posts.
A durable scheduler built without this contract is **more dangerous than cron**, because cron
forgets and Workflows do not.

The 0.2.0 revision adds the opposite failure, which the audit surfaced: an item whose old
workflow correctly self-supersedes while its replacement was never created is **orphaned**.
Safety without liveness is only half the problem solved.

## 2. Scope

In scope: workflow identity, schedule versioning, supersession, replacement, cancellation, stale
wakeups, step retry policy.

Out of scope: when a slot is due (scheduling contract), what a publish does (publication
transaction contract), who may publish (authority contract), how state persists (durable-state
contract).

## 3. Definitions

| Term | Definition |
|---|---|
| **Workflow instance** | One durable execution run bound to one item and one schedule version. |
| **Schedule version** | A monotonically increasing integer on an item, incremented when its scheduling or publication *inputs* change. |
| **Current version** | The schedule version stored in authoritative state right now. |
| **Superseded instance** | A running or sleeping instance whose bound version is lower than current. |
| **Workflow state** | A field on the item recording replacement progress: `active`, `replacement_pending`, `none`. |
| **Stale wakeup** | An instance resuming after its bound decision is no longer current. |

## 4. Identity and versioning

**WF-1** — A workflow instance MUST be bound at creation to exactly one item ID and one schedule
version, and that binding MUST be immutable for the life of the instance.

**WF-2** — The instance ID MUST be deterministically derived from item ID and schedule version —
for example `xqueue-B30-v4` — so that creating the same logical instance twice is a detectable
collision rather than a duplicate publisher. Cloudflare instance IDs are unique per Workflow and
cannot be reused, so a duplicate creation throws rather than silently succeeding; the contract
relies on that behavior.

**WF-3** — Schedule versions MUST increase monotonically per item and MUST NOT be reused.

**WF-4** — Any mutation to the **inputs** that determine scheduling or publication intent MUST
increment the relevant version. The passage of time is not a mutation.

| Change | Version bump |
|---|---|
| `scheduledAt` changed | Yes |
| Timezone or slot definition changed | Yes |
| Content text changed | Yes — intent digest and version |
| Media changed | Yes — intent digest and version |
| Owner skip or unskip | Yes |
| Clock passes `scheduledAt` | **No** |
| Item becomes eligible because time moved | **No** |

Eligibility is derived (`STATE-11`). Bumping a version because the clock advanced would
invalidate every sleeping instance on a schedule nobody changed.

**WF-5** — The bound schedule version MUST be recoverable from within the instance without
reading anything mutable. An instance that cannot say which version it is cannot check whether
it is stale.

## 5. The supersession check

This is the core safety requirement.

```text
workflow-v1 MUST compare its scheduleVersion
against current D1 state.

v1 != current v2

→ superseded
→ no lease
→ no X request
→ no publication
```

**WF-6** — Immediately on every wakeup, and again immediately before any state-changing or
external action, an instance MUST re-read the item's current schedule version from authoritative
state and compare it to its own bound version.

**WF-7** — On mismatch the instance is superseded and MUST: acquire no lease, write no fence,
issue no X request, mutate no lifecycle state, record a supersession event, and terminate.

**WF-8** — A superseded instance MUST NOT reschedule itself, spawn a replacement, escalate as an
error, or take any corrective action. Being superseded is the normal outcome for a stale
instance, not an incident.

**WF-9** — The comparison MUST be equality against the current version. "Greater than or equal",
"close enough", and "within tolerance" are prohibited.

**WF-10** — If authoritative state cannot be read at wakeup, the instance MUST treat itself as
potentially superseded and MUST NOT publish. Unavailability is never permission.

**WF-11** — The check MUST NOT be cached across a sleep. A version read before a multi-month
sleep says nothing about the moment you wake.

## 6. Replacement, and the orphan hole

Supersession alone leaves a gap: if the version bump commits and the replacement instance is
never created, the old instance correctly retires and nothing takes its place.

**WF-12** — A schedule change MUST be applied in this order:

1. In one durable transaction, increment the schedule version **and** set
   `workflow_state = replacement_pending`.
2. Create the replacement instance bound to the new version.
3. Record `workflow_state = active` with the new instance ID.
4. Request cancellation of the superseded instance.

**WF-13** — Step 1 MUST commit before step 2. If the version bump is not durable, the
replacement may bind to a version that does not exist.

**WF-14** — An item left in `replacement_pending` with no live instance for the current version
is an **orphan**, and MUST be repairable. A repair process MUST detect this condition and create
the missing instance.

**WF-15** — The repair process MUST NOT publish, MUST NOT acquire the publication lease, and
MUST NOT alter lifecycle state. It creates the missing instance and records that it did. Repair
is a liveness mechanism, never a publishing path (`AUTH-5`).

**WF-16** — Because instance IDs are deterministic (`WF-2`), repair MUST tolerate the case where
the instance already exists: a collision means the replacement did land, and repair MUST then
only correct `workflow_state`.

**WF-17** — Cancellation is **best effort**. Correctness rests entirely on the supersession
check; cancellation only saves compute. A failed cancellation MUST NOT block the replacement,
MUST be recorded, and MUST NOT be retried indefinitely.

**WF-18** — At most one non-superseded instance per item MUST exist at any instant. Two is an
invariant violation under `AUTH-1` and MUST be reported.

## 7. Step retry policy

Durable engines retry steps by default. That default is wrong for exactly one step here.

| Step | Retryable | Why |
|---|---|---|
| Read authoritative state | Yes | Idempotent read |
| Supersession check | Yes | Idempotent read |
| Compute intent digest | Yes | Pure |
| Acquire publication lease | Yes, bounded | Generation-fenced CAS is safe to re-attempt |
| Write fence | Yes, bounded | Guarded by generation and digest |
| **X create-post dispatch** | **No** | `PUB-18`; a retry is a possible duplicate post |
| Persist outcome | Yes | Idempotent by fence |
| Release lease | Yes | Idempotent |

**WF-19** — The dispatch step MUST be configured with retries disabled — `retries.limit: 0` on
that step. Cloudflare Workflows configures retries per `step.do`, so a workflow-wide default
MUST NOT be allowed to cover the dispatch step.

**WF-20** — A step failure after dispatch MUST NOT cause the dispatch step to re-execute. If the
engine cannot guarantee this, the dispatch MUST be moved outside engine-managed retry entirely,
and that arrangement recorded.

**WF-21** — Bounded retries MUST have an explicit maximum. "Retry until success" is prohibited
for any step that touches state.

**WF-22** — Exhausting retries on any step MUST leave the item in a state consistent with the
durable-state contract — never `publishing` with no instance alive to advance it. Recovery
classifies those, per `PUB-37`.

## 8. Long sleeps

**WF-23** — An instance MUST tolerate the possibility that the item was deleted, superseded,
skipped by the owner, or already published while it slept.

**WF-24** — On wakeup the instance MUST verify item existence before anything else, and
terminate cleanly if the item is gone.

**WF-25** — Sleeps MUST be expressed against a stored UTC instant using absolute scheduling
(`step.sleepUntil`), never a duration computed at creation time. A duration computed in
September is wrong by an hour after a DST change.

**WF-26** — The platform sleep ceiling is 365 days. Any slot further out than that MUST be
handled by scheduling a nearer wakeup rather than by a single longer sleep. No smaller artificial
horizon is imposed: sleeping instances do not count against instance concurrency, so a long sleep
costs nothing.

## 9. Observability

**WF-27** — Instance creation, wakeup, supersession, repair, cancellation, and termination MUST
each produce a record carrying item ID, bound version, current version at the time, instance ID,
and workflow state.

**WF-28** — Supersession and orphan-repair counts MUST be visible. A rising supersession rate
means scheduling is churning; any orphan repair at all means step 2 of `WF-12` failed and is
worth looking at.

## 10. Prohibited

- Publishing without a fresh supersession check.
- Caching the version comparison across a sleep.
- Bumping a schedule version because time passed.
- Relying on cancellation for correctness.
- Applying a blanket engine retry policy across the dispatch step.
- A superseded instance taking corrective action.
- A repair process publishing, leasing, or changing lifecycle state.
- Reusing a schedule version or an instance ID.
- Creating a replacement before the version bump is durable.

## 11. Acceptance cases

<!-- lint-exempt-acceptance: WF-1, WF-3, WF-5, WF-8, WF-9, WF-11, WF-20, WF-21, WF-23, WF-26, WF-27, WF-28 -->
Exempt from automated coverage, and why: `WF-1`, `WF-3`, `WF-5`, `WF-8`, `WF-9`, and `WF-11` are
proven collectively by `WF-AC-1`, `WF-AC-2`, and `WF-AC-7`; `WF-20`, `WF-21`, and `WF-26` are
engine configuration facts checked by inspection; `WF-23` is proven by `WF-AC-11`; `WF-27` and
`WF-28` cover observability, verified by the runbook drill.

| Case | Proves | Setup | Expected |
|---|---|---|---|
| WF-AC-1 | WF-6, WF-7 | v1 sleeping; item moved; v2 created; v1 wakes | v1 records supersession, takes no lease, issues no request, terminates |
| WF-AC-2 | WF-17 | Cancellation of v1 fails; v1 later wakes | v1 still self-supersedes and publishes nothing |
| WF-AC-3 | WF-12, WF-13 | Reschedule under concurrent load | Version and `replacement_pending` commit together, before creation |
| WF-AC-4 | WF-14, WF-15 | Version bumped, replacement creation fails, old instance retires | Orphan detected; instance created by repair; nothing published by repair |
| WF-AC-5 | WF-16 | Repair runs when the replacement actually did land | No second instance; `workflow_state` corrected |
| WF-AC-6 | WF-2 | Same item and version created twice | Creation throws; not two publishers |
| WF-AC-7 | WF-4 | Clock passes `scheduledAt` with no edit | Schedule version unchanged; sleeping instance remains valid |
| WF-AC-8 | WF-4 | Content edited | Version and intent digest both change; old instance self-supersedes |
| WF-AC-9 | WF-19 | Dispatch times out inside a workflow step | Exactly one create-post call observed |
| WF-AC-10 | WF-10 | Authoritative store unreachable at wakeup | No publish; instance yields or terminates |
| WF-AC-11 | WF-24 | Item deleted during sleep | Clean termination, no error escalation |
| WF-AC-12 | WF-18 | Two non-superseded instances for one item | Reported as an invariant violation |
| WF-AC-13 | WF-22 | Retries exhausted mid-transaction | Item not stranded in `publishing` |
| WF-AC-14 | WF-25 | Slot spans a DST boundary | Wakes at the intended local wall-clock slot |

## 12. Runbook obligations

`RUNBOOK.md` MUST document:

1. Listing live instances with their bound schedule versions and workflow states.
2. Finding items in `replacement_pending` with no live instance, and repairing them.
3. Identifying superseded instances still alive.
4. Cancelling an instance manually, and what to expect when cancellation fails.
5. Forcing a reschedule in the mandated order.
6. Interpreting supersession and orphan-repair counts.

## 13. Open questions requiring Patrick's decision

| ID | Question | Blocking |
|---|---|---|
| OQ-WF-1 | Confirm Cloudflare Workflows as the engine and that the account plan covers the needed limits | Yes — the contract binds to it |
| OQ-WF-4 | One instance per item, or one per slot handling several items? | Yes — changes `WF-1` |
| OQ-WF-5 | Is a cron backstop retained after Workflows ship, and with what authority? | Yes — interacts with `AUTH-2` |
| OQ-WF-6 | Where does the schedule version live, and what increments it today? | Yes — `WF-4` |
| OQ-WF-7 | What runs the orphan repair — cron, watchdog, or scheduler pass — and how often? | Yes — `WF-14` |
| OQ-WF-8 | Does the campaign have any slot more than 365 days out? | No — `WF-26` |

Closed since 0.1.0:

- **OQ-WF-2** — per-step retry disablement. Cloudflare Workflows configures retries per
  `step.do`, and a limit of 0 is accepted; resolved into `WF-19`. Confirm with a smoke test
  before activation, since this is documented behavior rather than behavior observed in this
  codebase.
- **OQ-WF-3** — artificial sleep horizon. Not needed. The platform ceiling is 365 days, waiting
  instances do not count toward concurrency, and the campaign sits well inside that; resolved
  into `WF-26`.

## 14. Verification status

| Claim | Truth state |
|---|---|
| Maximum `step.sleep` duration is 365 days; waiting instances do not count toward instance concurrency; instance IDs are unique per Workflow and cannot be reused | `verified` against Cloudflare Workflows documentation reviewed 2026-09-03 |
| Retries are configurable per `step.do` and a limit of 0 disables them | `declared` — per-step retry configuration is documented; `limit: 0` is corroborated by public usage and a Cloudflare changelog entry fixing a zero-delay bug, but has not been exercised in this codebase |
| Cloudflare Workflows are implemented in xqueue | `unknown` — described as upcoming work |
| A schedule version field exists today | `unknown` |
| Supersession is enforced anywhere today | `unknown` |

This contract is written ahead of implementation deliberately. It is a specification, not a
description, and nothing in it is a claim about what the code does today.

## 15. Change log

| Date | Version | Change |
|---|---|---|
| 2026-09-03 | 0.2.0 | Audit revision. `WF-4` narrowed to input mutations so clock movement no longer bumps versions. Added the orphan hole and its repair path: `replacement_pending` workflow state, `WF-12`–`WF-16`, with repair explicitly barred from publishing. `WF-19` now names `retries.limit: 0` per `step.do`. `WF-25` requires absolute `sleepUntil` against a stored instant. `WF-26` replaces the invented sleep horizon with the platform's 365-day ceiling. OQ-WF-2 and OQ-WF-3 closed. Renumbering from `WF-12` onward follows from the replacement rewrite; 0.1.0 was never active. |
| 2026-09-03 | 0.1.0 | Initial draft, ahead of Workflow implementation. |
