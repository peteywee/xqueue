<!--tos-doc
{
  "doc_id": "XQ-DOC-CONTRACT-0002",
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

# Publication Transaction Contract

| Field | Value |
|---|---|
| Doc ID | XQ-DOC-CONTRACT-0002 |
| Requirement prefix | `PUB` |
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

One question governs this contract: **under exactly what conditions may xqueue send a
create-post request to X, and what does the system believe afterward?**

Everything expensive lives on the far side of that request. A duplicate post is public and
permanent. A lost post is invisible. An ambiguous outcome that gets retried automatically is the
failure mode that turns a scheduling bug into a credibility problem on an account whose entire
value is that it looks deliberate.

This contract freezes the transaction shape so a later refactor cannot replace it with generic
retry logic.

## 2. Scope

In scope: eligibility checks, lease acquisition, fencing, dispatch, outcome classification, and
reconciliation.

Out of scope: when a slot becomes due and what happens to a missed one
(`scheduling-and-missed-slot-contract.md`), who may run a transaction
(`authority-and-ownership-contract.md`), how state and events persist
(`durable-state-and-ledger-contract.md`), workflow identity and supersession
(`workflow-lifecycle-contract.md`).

## 3. Definitions

| Term | Definition |
|---|---|
| **Item** | One queued unit of content with a stable identifier (e.g. `B30`). |
| **Intent** | The exact content to be published for an item at this instant: text, media references, thread structure, target account. |
| **Intent digest** | A deterministic hash over the intent, used to detect that intent changed mid-transaction. |
| **Eligible** | A **derived** condition, computed at read time from schedule and state. Never a stored value. |
| **Publication lease** | The account-scoped `publisher` lease: a single, generation-fenced, time-bounded right to publish on behalf of the X account. |
| **Lease generation** | The monotonically increasing generation number carried by the publication lease. |
| **Fence** | A durably committed record, written before dispatch, binding one lease generation to one item and one intent digest. |
| **Dispatch** | A single create-post request issued to the X API. |
| **Outcome** | `confirmed_posted`, `confirmed_not_posted`, or `ambiguous`. |
| **Reconciliation** | Determination of what actually happened after an ambiguous outcome. |

## 4. The transaction sequence

```text
eligible (derived)
   ↓
acquire ACCOUNT publication lease  ──→ generation G
   ↓
verify exact current intent
   ↓
verify identity / media
   ↓
persist fence  (binds G ↔ item ↔ intent digest)
   ↓
AT MOST ONE X create-post dispatch
   ↓
   ├── confirmed_posted ──────────→ posted
   ├── confirmed_not_posted ──────→ attempt outcome recorded; lifecycle per §10
   └── ambiguous ─────────────────→ needs_reconciliation
                                     ↓
                                 NO AUTOMATIC RETRY
```

**PUB-1** — A publication transaction MUST execute these stages in this order. No stage may be
skipped, reordered, or performed speculatively ahead of the stage before it.

**PUB-2** — Each stage MUST be individually observable in the event record, so a partially
completed transaction can be located after a crash.

## 5. Preconditions

**PUB-3** — A dispatch MUST NOT occur unless all of the following hold at the moment the fence
is committed:

1. The item is eligible under the scheduling contract.
2. The actor holds the account publication lease at generation `G`, unexpired.
3. The actor holds publication authority under the authority contract.
4. The global publishing halt is not set.
5. The item's current lifecycle state permits publication (durable-state contract §3).
6. The intent digest computed now equals the digest recorded at lease acquisition.
7. The target account identity has been verified against configured credentials.
8. Every media reference in the intent resolves to a retrievable, valid asset.

**PUB-4** — If any precondition fails, the transaction MUST abort without dispatching, release
the lease, and record the failing precondition by requirement ID.

**PUB-5** — Aborting on a failed precondition MUST NOT itself change the item's scheduling
state. What happens to a passed-over item belongs to the scheduling contract.

## 6. The account publication lease

The lease is account-scoped, not per-item. One X account publishes one thing at a time, so
serialization belongs at the account. A per-item lease would permit two items to hold leases
simultaneously and would then need a second account-level mechanism anyway.

**PUB-6** — Publication MUST be serialized by the account-scoped `publisher` lease. Per-item
leasing MUST NOT be introduced as a substitute for it.

**PUB-7** — At most one holder of the publication lease MUST exist at any instant.

**PUB-8** — The lease MUST be acquired by an atomic compare-and-set carrying a generation and an
owner or acquisition token. Read-then-write in separate statements does not satisfy this.

**PUB-9** — Lease generations MUST increase monotonically and MUST NOT be reused. A holder whose
generation is no longer current MUST be treated as having lost the lease, and MUST NOT dispatch.

**PUB-10** — Takeover of an expired lease MUST increment the generation. Takeover alone MUST NOT
be treated as evidence that the previous holder issued no dispatch; the prior holder's fence
governs that question (`PUB-14`).

**PUB-11** — The lease MUST be released on every exit path, including aborts and thrown errors,
except where the item has entered a state that intentionally holds it.

**PUB-12** — Lease duration is `Not yet verified` — see OQ-PUB-1. Whatever the value, it MUST be
shorter than any interval on which a takeover could be attempted, and longer than the configured
dispatch timeout.

## 7. The fence

**PUB-13** — A fence record MUST be durably committed **before** the dispatch is issued. If the
fence write fails, the dispatch MUST NOT be attempted.

**PUB-14** — The fence MUST record at minimum: item ID, intent digest, lease generation, holder
token, schedule version, and the instant at which dispatch was about to begin.

**PUB-15** — A dispatch MUST NOT be issued when a fence already exists for the same item and
intent digest whose outcome is unresolved. An unresolved fence means a dispatch may already be
in flight or may already have landed — the exact case this contract exists to protect.

**PUB-16** — **At most one** create-post dispatch may ever occur for a given fence. Where
execution reaches the dispatch stage, exactly one request is permitted. A fence with zero
dispatches is a legitimate outcome — for example a crash between fence commit and the call —
and MUST NOT be "completed" later by any recovery path.

**PUB-17** — Fence records MUST NOT be deleted, updated in place, or compacted. They are
evidence.

## 8. Dispatch

**PUB-18** — The dispatch step MUST NOT be wrapped in generic retry logic — not by an HTTP
client, not by a workflow engine step retry, not by queue redelivery, not by an operator loop.
Retry behavior for this call is defined solely by this contract.

**PUB-19** — Native X create-post idempotency is **not available and MUST NOT be relied upon**.
As of 2026-09-03, no idempotency key or equivalent parameter is documented for the create-post
endpoint. The protection is therefore entirely local: fence, single dispatch, outcome
classification, reconciliation. If X later documents such a mechanism, adopting it is a contract
revision, not an implementation detail.

**PUB-20** — Transport-level timeouts MUST be finite and configured explicitly. A hung dispatch
is an ambiguous outcome, not a pending one.

## 9. Outcome classification

**PUB-21** — Every dispatch MUST resolve to exactly one outcome, and the outcome is a property
of the **attempt**, not of the content.

| Outcome | Definition |
|---|---|
| `confirmed_posted` | A response identifying a created post (a post ID) was received. |
| `confirmed_not_posted` | A response was received that unambiguously states no post was created. |
| `ambiguous` | Anything else: timeout, connection reset, 5xx, unparseable body, eviction mid-call, or an unrecognized response. |

**PUB-22** — Classification MUST default to `ambiguous`. An unrecognized response MUST NOT be
optimistically read as not-posted, and MUST NOT be pessimistically read as success.

**PUB-23** — `confirmed_posted` MUST persist the returned post ID together with the fence before
the transaction completes. A success that was never recorded is operationally identical to an
ambiguous outcome.

**PUB-24** — The outcome MUST be persisted before the lease is released.

**PUB-25** — Every outcome MUST be persisted with the semantics it was classified as. A
`confirmed_not_posted` outcome MUST NOT be stored as `needs_reconciliation`, and vice versa. See
the known conflict in §14.

## 10. Not-posted classes

**PUB-26** — A `confirmed_not_posted` outcome MUST be classified before any policy is applied.
These classes describe the attempt; the item's lifecycle state is then set per the table.

| Class | Meaning | Automatic retry | Item lifecycle |
|---|---|---|---|
| `auth` | Credentials invalid, expired, revoked | MUST NOT retry | Unchanged; global halt set (`PUB-27`) |
| `rate_limit` | Declined on rate or quota grounds | MUST NOT retry in this transaction | `deferred`, per scheduling contract |
| `duplicate` | The API states this content already exists | MUST NOT retry | `needs_reconciliation` — the account may already hold this post |
| `policy` | Content refused on policy grounds | MUST NOT retry | Owner decision required; see OQ-PUB-5 |
| `media` | Media upload or attachment failed | MUST NOT retry in this transaction | `deferred` |
| `malformed` | Request rejected as invalid | MUST NOT retry | Held for owner; this is a defect, not a transient fault |

**PUB-27** — An `auth` result MUST set the global publishing halt. One bad credential rotation
should not burn the entire queue.

**PUB-28** — Rescheduling after `rate_limit` or `media` MUST go through the scheduling contract.
This transaction ends.

**PUB-29** — A not-posted class not in the table above MUST be treated as `ambiguous`.

**PUB-30** — A not-posted class MUST NOT terminate the content. `posted` is the only terminal state
reachable through publication; a failed attempt is evidence about an attempt, and MUST be recorded
as one.

## 11. Ambiguity and reconciliation

**PUB-31** — An ambiguous outcome MUST place the item in `needs_reconciliation`.

**PUB-32** — There MUST be no automatic retry of an ambiguous dispatch. None. Not delayed, not
exponential, not "just once more."

**PUB-33** — While an item is in `needs_reconciliation`, no actor may dispatch for it, and it
MUST NOT be selected as eligible.

**PUB-34** — Reconciliation MUST establish what happened by reading the account's published
timeline for a post matching the intent digest within the fence window.

**PUB-35** — Reconciliation MUST record its determination, the evidence it rested on, and who or
what approved it. Whether it may resolve automatically from timeline evidence or always requires
Patrick is `Not yet verified` — see OQ-PUB-3.

**PUB-36** — An unresolved `needs_reconciliation` item MUST surface in operational output. A
silent stuck item is worse than a loud failure.

## 12. Crash behavior

**PUB-37** — After a crash, restart, or eviction, the recovering actor MUST classify every fence
with no recorded outcome as `ambiguous` and apply `PUB-31`. It MUST NOT assume no dispatch
occurred because no response was seen.

**PUB-38** — Recovery MUST NOT dispatch, and MUST NOT complete an incomplete fence. Recovery
classifies and records; publishing is a separate authority.

## 13. Evidence obligations

**PUB-39** — Each transaction MUST produce an append-only event record containing: item ID,
intent digest, schedule version, lease generation, holder token, dispatch instant, outcome,
not-posted class where applicable, post ID where applicable, and the requirement ID of any
precondition that aborted it.

**PUB-40** — A correction MUST be a new event referencing the earlier one. Events MUST NOT be
updated in place.

## 14. Known conflicts

Recorded, not repaired — repair is an engineering change requiring its own issue.

**Conflict PUB-C-1 — outcome semantics lost at the persistence boundary.**
The classifier is reported to distinguish `confirmed_posted`, `confirmed_not_posted`, and
`needs_reconciliation`, while the persistence branch is reported to be effectively
`if confirmed_posted → posted, else → needs_reconciliation`. A `confirmed_not_posted` outcome
therefore persists as `needs_reconciliation`, so the returned transaction result and the durable
record disagree.

- Truth state: `declared` by ChatGPT from code inspection, 2026-09-03. Not independently
  verified — the repository was not inspectable from the drafting session.
- Violates: `PUB-25`.
- Required: a regression test asserting that each classifier outcome persists with its own
  semantics, then the repair. This is material work and needs a GitHub issue before it starts.

## 15. Prohibited

- Dispatching without a committed fence.
- Any automatic retry of a dispatch, in any layer.
- A recovery path issuing a dispatch, or completing a fence it found incomplete.
- Treating lease takeover as proof that no post was created.
- Deleting, updating, or compacting fence or outcome records.
- Collapsing `ambiguous` into `confirmed_not_posted` to keep the queue moving.
- Persisting an outcome under a different classification than it was given.
- Publishing from a recovery, watchdog, health-check, deployment probe, or test path.
- Introducing a per-item publication lease alongside the account lease.

## 16. Acceptance cases

<!-- lint-exempt-acceptance: PUB-1, PUB-5, PUB-6, PUB-12, PUB-18, PUB-20, PUB-21, PUB-26, PUB-28, PUB-34, PUB-35, PUB-36 -->
Exempt from automated coverage, and why: `PUB-1`, `PUB-6`, `PUB-21`, and `PUB-26` are proven
collectively by the cases below rather than individually; `PUB-12` and `PUB-20` are configuration
facts checked by inspection; `PUB-5` and `PUB-28` hand off to the scheduling contract, which owns
their cases; `PUB-18` is proven by `PUB-AC-9` and `WF-AC-9`; `PUB-34`, `PUB-35`, and `PUB-36` cover
reconciliation procedure and operational visibility, verified by the runbook drill.

| Case | Proves | Setup | Expected |
|---|---|---|---|
| PUB-AC-1 | PUB-13 | Fence write fails | No dispatch; transaction aborts |
| PUB-AC-2 | PUB-16 | Normal successful path | Exactly one create-post call recorded |
| PUB-AC-3 | PUB-16, PUB-38 | Crash after fence commit, before the call | Fence has zero dispatches; recovery does not complete it |
| PUB-AC-4 | PUB-3 | Intent mutated between lease and fence | Abort, no dispatch, digest mismatch recorded |
| PUB-AC-5 | PUB-7, PUB-8 | Two actors contend for the account lease | Exactly one acquires it |
| PUB-AC-6 | PUB-9 | Holder at stale generation attempts dispatch | Refused |
| PUB-AC-7 | PUB-10 | Expired lease taken over with an unresolved fence | New holder does not dispatch for that item |
| PUB-AC-8 | PUB-22 | API returns an unrecognized body | Outcome is `ambiguous` |
| PUB-AC-9 | PUB-31, PUB-32 | Dispatch times out | State is `needs_reconciliation`; zero retries observed |
| PUB-AC-10 | PUB-25 | Each classifier outcome persisted in turn | Durable record matches the returned outcome in every case |
| PUB-AC-11 | PUB-33 | Item in `needs_reconciliation`, scheduler runs | Not selected; no dispatch |
| PUB-AC-12 | PUB-37 | Process killed after fence, before response | On restart, classified `ambiguous` |
| PUB-AC-13 | PUB-27 | API returns an auth failure | Global halt set, not just this item |
| PUB-AC-14 | PUB-23 | Post created but ID persist fails | Item does not report `posted`; ends in reconciliation |
| PUB-AC-15 | PUB-15 | Unresolved fence exists for same item and digest | Second transaction refuses to dispatch |
| PUB-AC-16 | PUB-30 | `rate_limit` result | Item is `deferred`, not terminal |
| PUB-AC-17 | PUB-19 | Inspect the dispatch request | No reliance on any X-side idempotency mechanism |
| PUB-AC-18 | PUB-2, PUB-39 | Complete one transaction | Every stage appears in the event record with the required fields |
| PUB-AC-19 | PUB-4 | Each precondition failed in turn | Abort recorded against the correct requirement ID; no dispatch |
| PUB-AC-20 | PUB-11 | Transaction throws mid-flight | Lease released on the error path |
| PUB-AC-21 | PUB-14, PUB-17 | Inspect a committed fence, then attempt to alter it | All required fields present; update and delete both refused |
| PUB-AC-22 | PUB-24 | Outcome persist fails | Lease is not released while the outcome is unrecorded |
| PUB-AC-23 | PUB-29 | API returns an undocumented failure class | Treated as `ambiguous` |
| PUB-AC-24 | PUB-40 | Correct an earlier event | New event written referencing the original; original unchanged |

## 17. Runbook obligations

`RUNBOOK.md` MUST document:

1. Detecting and listing items in `needs_reconciliation`.
2. Reconciling one item against the live timeline, with exact commands and what each output means.
3. Clearing a global `auth` halt after credential rotation.
4. Inspecting lease generation, fence, and outcome history for one item.
5. Confirming after a deploy or incident that no fence is unresolved.

## 18. Open questions requiring Patrick's decision

| ID | Question | Blocking |
|---|---|---|
| OQ-PUB-1 | Publication lease duration and dispatch timeout, and their relative ordering | Yes — `PUB-12`, `PUB-20` |
| OQ-PUB-3 | May reconciliation resolve automatically from timeline evidence, or always owner-approved? | Yes — `PUB-35` |
| OQ-PUB-4 | On `rate_limit`, does the item keep its slot or take the next available one? | Yes — scheduling contract interaction |
| OQ-PUB-5 | On `policy` refusal, is the item held for review, skipped by the owner, or removed? | Yes — `PUB-26` |
| OQ-PUB-6 | Is threaded or multi-post content in scope? A partial thread is an outcome class this contract does not cover. | Yes if threads are planned |
| OQ-PUB-7 | On `duplicate`, is reconciliation the right destination, or should it be owner review? | No — affects `PUB-26` |

Closed since 0.1.0: **OQ-PUB-2** — X create-post idempotency. No such mechanism is documented;
resolved into `PUB-19`.

## 19. Verification status

| Claim | Truth state |
|---|---|
| A generation-fenced account `publisher` lease exists and has passed contention, takeover, stale-release, and concurrency tests | `declared` by ChatGPT, 2026-09-03 |
| The classifier distinguishes three outcomes while persistence collapses two of them | `declared` by ChatGPT, 2026-09-03 — see PUB-C-1 |
| X documents no create-post idempotency key | `verified` against X developer documentation reviewed 2026-09-03. Absence of documentation is not proof of absence; the requirement is written so that it holds either way. |
| Requirements in this document are implemented | `unknown` |
| Acceptance cases exist as tests | `unknown` |

An anonymous clone of `github.com/peteywee/xqueue` was attempted on 2026-09-03 and failed with
an authentication error. Nothing here rests on inspection of the code.

## 20. Change log

| Date | Version | Change |
|---|---|---|
| 2026-09-03 | 0.2.0 | Audit revision. `PUB-16` weakened from exactly-one to at-most-one per fence, with recovery explicitly barred from completing a fence. Lease model changed from per-item to the account-scoped generation-fenced `publisher` lease (`PUB-6`–`PUB-12` rewritten). Outcome vocabulary aligned to the implementation's `confirmed_posted` / `confirmed_not_posted` / `ambiguous`. Rejection reframed as attempt evidence; `PUB-30` added so no not-posted class terminates content. `PUB-19` closes the idempotency question. `PUB-25`, `PUB-38`, and conflict PUB-C-1 added. Renumbering from `PUB-13` onward is a consequence of the lease rewrite; 0.1.0 was never active, so no ID is in use elsewhere. |
| 2026-09-03 | 0.1.0 | Initial draft. |
