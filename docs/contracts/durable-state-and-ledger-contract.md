<!--tos-doc
{
  "doc_id": "XQ-DOC-CONTRACT-0004",
  "class": "contract",
  "claims_truth_state": "proposed",
  "written_against": { "head_sha": "Not yet verified" },
  "depends_on": [
    "src/",
    "migrations/",
    "state.json",
    "wrangler.toml",
    "wrangler.jsonc",
    "docs/contracts/"
  ]
}
-->

# Durable State and Ledger Contract

| Field | Value |
|---|---|
| Doc ID | XQ-DOC-CONTRACT-0004 |
| Requirement prefix | `STATE` |
| Status | proposed — not yet approved |
| Version | 0.2.0 |
| Created | 2026-09-03 |
| Last updated | 2026-09-03 |
| Owner | Patrick Craven (sole approving authority) |
| Drafted by | Claude; revised against the ChatGPT contract audit of 2026-09-03 |
| Supersedes | 0.1.0 (proposed, never active) |
| Superseded by | none |
| Verified against implementation | No — repository not inspectable from the drafting session |

## 1. Purpose

Two things in this system both look like state: the historical local `state.json` and the D1
publication tables. Two candidate truths is one too many, and they will disagree the first time
a local run follows a cloud publish.

The 0.1.0 draft made a second mistake worth naming, because it is the more expensive one: it
declared the whole ledger append-only, which would have forced full event sourcing on a design
that already had the healthier shape — a mutable current-state projection beside an append-only
event log. This version keeps those apart.

## 2. Authoritative state

**STATE-1** — After Cloudflare cutover, D1 MUST be the sole production truth for lifecycle state,
scheduling state, leases, fences, and publication events. No other store MUST be consulted to
authorize a publishing decision.

**STATE-2** — After cutover, `state.json` is a **backup and evidence artifact only**. It MUST
NOT be read to make a publishing decision and MUST NOT be written by production.

**STATE-3** — Until cutover is complete and recorded, §2 is `proposed` and the pre-cutover
arrangement stands. Cutover is owner-reserved (`AUTH-12.7`) and MUST produce an evidence record
naming the date, the D1 database, and the final `state.json` snapshot.

**STATE-4** — R2, where used, holds artifacts and archives. R2 MUST NOT be authoritative for
queue state.

**STATE-5** — Any component reading state for a publishing decision MUST read it from the
authoritative store at decision time. Cached, exported, or in-memory copies MUST NOT authorize a
dispatch.

**STATE-6** — Where the authoritative store and a secondary copy disagree, the disagreement MUST
be reported as a conflict. The system MUST NOT silently prefer whichever is cleaner.

## 3. Two stores, two rules

This is the central distinction of this contract.

| | Current-state projection | Event ledger |
|---|---|---|
| Reported table | `publication_state` | `publication_events` |
| Holds | Where each item stands now | What happened, in order |
| Mutation | **MAY be updated in place**, through guarded CAS transitions only | **MUST be append-only** |
| Deletion | Owner action with recorded reason | Never (`STATE-20`) |
| Answers | "What is B30 right now?" | "What did we do, and what did X say?" |

**STATE-7** — Current-state projections MAY be updated through guarded CAS transitions. Event
and audit records MUST be append-only.

**STATE-8** — The projection MUST be derivable from the ledger. Where it is not, the ledger is
missing an event, and that is a defect in the ledger rather than a licence to trust the
projection alone.

**STATE-9** — A projection update and its corresponding event MUST both be committed, or
neither. Where the store cannot do both in one statement, the event MUST be written first, and
recovery MUST reconcile a projection that lags its ledger. See OQ-STATE-3.

## 4. Lifecycle states

These are the values the projection may hold. They are content lifecycle states — not attempt
outcomes, not lease conditions, not workflow conditions.

| State | Meaning | Terminal |
|---|---|---|
| `scheduled` | Assigned to a slot | No |
| `prepared` | Prepared for publication ahead of its slot. Exact semantics `Not yet verified`; see OQ-STATE-7. | No |
| `publishing` | Fence committed, dispatch in flight | No |
| `posted` | Confirmed posted, post ID recorded | **Yes** |
| `deferred` | Moved out of its slot; awaiting a new one | No |
| `skipped` | **Owner** has suppressed this content from automatic publication | No — owner may unskip |
| `needs_reconciliation` | Outcome ambiguous; human resolution required | No — but locked |

**STATE-10** — Every item MUST be in exactly one of these states at any instant.

**STATE-11** — The following MUST NOT be persisted as lifecycle states, because each belongs to
another layer:

| Not a state | What it actually is |
|---|---|
| `eligible` | A condition derived at read time from slot, state, and halt |
| `leased` | A property of the account publication lease resource |
| `rejected` | The outcome of one attempt, recorded as an event |
| `superseded` | A comparison between a workflow's bound version and the current one |
| `queued` | Covered by `scheduled`; an item with no slot is a scheduling concern |

A state diagram is not a schema. Persisting a value merely because it appears in a diagram
creates a second place for truth to live.

### 4.1 Dependency on the scheduling contract

`deferred` is new in this version and is the scheduler's normal handling of a missed window.
`scheduling-and-missed-slot-contract.md` MUST therefore answer three things before this contract
can be activated:

1. What moves an item to `deferred`, and what removes it from `deferred`.
2. How a new slot is chosen for a deferred item, and whether it keeps its original ordering.
3. Whether `prepared` is reachable from `deferred`.

## 5. Legal transitions

```text
                    ┌──────────────────────────────┐
                    ↓                              │
scheduled ──→ prepared ──→ publishing ──→ posted (terminal)
    │  ↑          │             │
    │  │          │             ├──→ needs_reconciliation ──→ (owner) ──→ deferred | posted | skipped
    │  │          │             │
    │  └──────────┴─────────────┴──→ deferred ──→ scheduled   (version bump)
    │
    └──→ skipped (owner only) ──→ scheduled | deferred   (owner only)
```

Explicit answers to the questions this contract exists to settle:

| Question | Answer | Requirement |
|---|---|---|
| Can state move backward? | Only along the edges above. Out of `posted`, never. | STATE-12 |
| Can `posted` → `scheduled`? | **No.** `posted` is terminal. Republishing is a new item. | STATE-13 |
| Can `deferred` → `scheduled`? | **Yes**, with a schedule version bump. | STATE-14 |
| Can `needs_reconciliation` → `deferred`? | Only as the recorded outcome of a completed reconciliation. Never automatically. | STATE-15 |
| Who may move an item to `skipped`? | **The owner only.** | STATE-16 |
| Who may defer? | The scheduler, and the owner. | STATE-17 |
| Is a rejected attempt terminal? | No. It is an event; the item goes to `deferred` or reconciliation per `PUB-26`. | STATE-18 |
| What is a valid write? | §6. | STATE-19 |
| What can never be erased? | §7. | STATE-20 |

**STATE-12** — Transitions not shown above MUST be rejected at the persistence layer, not merely
avoided by convention in calling code.

**STATE-13** — `posted` MUST be terminal: the persistence layer MUST reject every transition out of
it. A correction is a new item referencing the old one.

**STATE-14** — `deferred → scheduled` MUST increment the item's schedule version, so any workflow
holding the old version becomes detectably stale.

**STATE-15** — `needs_reconciliation` MUST NOT be exited by any path that does not carry a
recorded reconciliation determination.

**STATE-16** — `skipped` means the owner has suppressed this content. Automation MUST NOT move
an item to `skipped` for any reason — not a missed window, not a rate limit, not a media
failure, not repeated ambiguity. A missed window is a **defer**, and conflating the two lets
automation quietly delete content from the campaign.

**STATE-17** — Unskipping MUST be an owner action, recorded as one.

**STATE-18** — An attempt outcome MUST NOT terminate content by itself. Attempt results are events;
the lifecycle consequence MUST be set explicitly per `PUB-26`.

## 6. Write discipline

**STATE-19** — Every projection transition MUST be a compare-and-set against the value the
writer read. Read-then-write without a version guard is prohibited.

**STATE-21** — Every mutable row MUST carry a monotonically increasing version or generation. A
write presenting a lower value than stored MUST fail.

**STATE-22** — A failed write MUST NOT be retried in a way that could apply twice under
different tokens. Retry the read-compare-set cycle, never the bare write.

**STATE-23** — Instants MUST be stored in UTC with an explicit marker. Local time belongs to
presentation and to the scheduling contract, never to stored state.

**STATE-24** — Durations that represent a future moment MUST be stored as instants, not as
offsets computed at write time. An offset computed before a DST change is wrong after it.

## 7. The ledger

**STATE-20** — The following MUST NOT be erased, rewritten, or compacted, ever:

1. Fence records.
2. Attempt outcomes, including ambiguous ones and `confirmed_not_posted` ones.
3. Post IDs of confirmed publications.
4. Reconciliation determinations and who approved them.
5. Owner-reserved actions (`AUTH-12`).
6. Halt set and clear events.
7. Lease generation changes and takeovers.
8. Records of contract supersession.

**STATE-25** — Failed attempts MUST NOT be removed to make history look clean. Failures are
evidence, and deleting them destroys the reason the requirement exists.

**STATE-26** — Deletion of anything else MUST be an owner action with a recorded reason.

## 8. Backup and restore

**STATE-27** — Authoritative state MUST be backed up on a stated cadence. Cadence is
`Not yet verified`; see OQ-STATE-4.

**STATE-28** — A restore MUST be treated as a cutover: owner-reserved, evidence-producing, and
every fence with an unresolved outcome in the restored data MUST be classified `ambiguous`
before publishing resumes.

**STATE-29** — Restore capability MUST NOT be described as verified disaster recovery until a
restore has actually been performed against a specific backup and recorded.

## 9. Prohibited

- Reading `state.json` to authorize a publish after cutover.
- Any transition out of `posted`.
- Automation moving an item to `skipped`.
- Persisting `eligible`, `leased`, `rejected`, or `superseded` as lifecycle states.
- Unguarded writes to projections, leases, fences, or outcomes.
- Updating or deleting ledger events.
- Storing local time, or a future moment as a precomputed offset.
- Describing D1 as production truth before cutover is recorded.

## 10. Acceptance cases

<!-- lint-exempt-acceptance: STATE-3, STATE-4, STATE-8, STATE-10, STATE-12, STATE-17, STATE-22, STATE-26, STATE-27, STATE-29 -->
Exempt from automated coverage, and why: `STATE-3`, `STATE-26`, `STATE-27`, and `STATE-29` govern
owner procedure and evidence, verified by inspecting the record rather than by execution; `STATE-4`
and `STATE-8` are design properties; `STATE-10` and `STATE-12` are proven collectively by the
transition cases below; `STATE-17` is proven by `AUTH-AC-9`; `STATE-22` is proven by `STATE-AC-2`.

| Case | Proves | Setup | Expected |
|---|---|---|---|
| STATE-AC-1 | STATE-13 | Attempt `posted → scheduled` | Rejected at persistence layer |
| STATE-AC-2 | STATE-19 | Two concurrent writers, one item | One succeeds; the other retries the full cycle |
| STATE-AC-3 | STATE-21 | Write presenting a stale version | Rejected |
| STATE-AC-4 | STATE-14 | `deferred → scheduled` | Schedule version increments |
| STATE-AC-5 | STATE-15 | Automated path tries to exit `needs_reconciliation` | Refused without a determination record |
| STATE-AC-6 | STATE-16 | Scheduler encounters a missed window | Item becomes `deferred`; never `skipped` |
| STATE-AC-7 | STATE-16 | Automation attempts a skip | Refused and recorded |
| STATE-AC-8 | STATE-7 | Update a ledger event in place | Refused |
| STATE-AC-9 | STATE-7 | Update a projection through CAS | Succeeds |
| STATE-AC-10 | STATE-9 | Crash between event write and projection update | Recovery reconciles the lagging projection deterministically |
| STATE-AC-11 | STATE-2 | Post-cutover run with a stale `state.json` present | No production read of it |
| STATE-AC-12 | STATE-23, STATE-24 | Item scheduled across a DST boundary | Stored value is an unambiguous UTC instant |
| STATE-AC-13 | STATE-28 | Restore from backup with an unresolved fence | Item lands in `needs_reconciliation` |
| STATE-AC-14 | STATE-11 | Inspect the schema | No `eligible`, `leased`, `rejected`, or `superseded` state values persisted |
| STATE-AC-15 | STATE-5 | Publishing decision made with a stale in-memory copy available | Decision reads the authoritative store; cached value is not used |
| STATE-AC-16 | STATE-6 | Projection and ledger disagree | Conflict reported, neither silently preferred |
| STATE-AC-17 | STATE-20, STATE-25 | Attempt to delete a fence, an outcome, or a failed attempt | Refused in every case |
| STATE-AC-18 | STATE-1 | Post-cutover publishing decision | Every input read from D1; no other store consulted |
| STATE-AC-19 | STATE-18 | Attempt outcome recorded for an item | Lifecycle state set explicitly per `PUB-26`; no state terminated by the outcome alone |

## 11. Runbook obligations

`RUNBOOK.md` MUST document:

1. Reading an item's current projection and its full event history.
2. Taking and verifying a backup.
3. Performing a restore, including the mandatory post-restore fence classification pass.
4. Detecting divergence between the projection and the ledger.
5. Detecting divergence between D1 and any `state.json` snapshot.
6. Owner skip and unskip, and how each is recorded.
7. The cutover procedure, and how it is recorded.

## 12. Open questions requiring Patrick's decision

| ID | Question | Blocking |
|---|---|---|
| OQ-STATE-1 | Confirm the persisted state set. Reported as `scheduled`, `prepared`, `publishing`, `posted`, `needs_reconciliation`, `skipped`; this contract adds `deferred`. | Yes — requires a migration |
| OQ-STATE-2 | Has cutover happened? If so, on what date and against which D1 database? | Yes — `STATE-1`, `STATE-3` |
| OQ-STATE-3 | Can D1 commit a projection update and its event in one statement, or is the event-first ordering required? | Yes — `STATE-9` |
| OQ-STATE-4 | Backup cadence, destination, retention | Yes — `STATE-27` |
| OQ-STATE-5 | Is `state.json` an ongoing mirror or frozen at cutover as a one-time snapshot? | Yes — `STATE-2` |
| OQ-STATE-6 | Given `posted` is terminal, is there a legitimate republish case? | No — affects ergonomics |
| OQ-STATE-7 | What does `prepared` mean, and what enters and leaves it? | Yes — `STATE`§4 |
| OQ-STATE-8 | Do existing rows need backfilling when `deferred` is introduced? | Yes — migration planning |

## 13. Verification status

| Claim | Truth state |
|---|---|
| D1 has a mutable `publication_state` table and an append-only `publication_events` table | `declared` by ChatGPT, 2026-09-03 |
| Current permitted states are `scheduled`, `prepared`, `publishing`, `posted`, `needs_reconciliation`, `skipped` | `declared` by ChatGPT, 2026-09-03 |
| D1 is currently authoritative | `unknown` — cutover status not verified |
| `state.json` semantics still exist alongside D1 | `declared` by ChatGPT, 2026-09-03 |
| A backup has ever been restored | `unknown` — MUST NOT be claimed until performed |

## 14. Change log

| Date | Version | Change |
|---|---|---|
| 2026-09-03 | 0.2.0 | Audit revision. Split projection from ledger (`STATE-7`–`STATE-9`); append-only now applies to events only. State set aligned to the reported schema plus `deferred`; `QUEUED`, `ELIGIBLE`, `LEASED`, `REJECTED`, `SUPERSEDED` removed as persisted states (`STATE-11`). `skipped` redefined as owner-only suppression; missed windows defer instead (`STATE-16`, `STATE-17`). `REJECTED` removed as a terminal state (`STATE-18`). Added `STATE-24` on storing instants rather than offsets, and §4.1 dependencies on the scheduling contract. `STATE-20` retained its number for the never-erase list; §6 numbering runs `STATE-19`, `STATE-21`–`STATE-24` as a result. |
| 2026-09-03 | 0.1.0 | Initial draft. |
