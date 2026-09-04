<!--tos-doc
{
  "doc_id": "XQ-DOC-CONTRACT-0003",
  "class": "contract",
  "claims_truth_state": "proposed",
  "written_against": { "head_sha": "Not yet verified" },
  "depends_on": [
    "src/",
    "migrations/",
    "wrangler.toml",
    "wrangler.jsonc",
    ".github/workflows/",
    "docs/contracts/"
  ]
}
-->

# Authority and Ownership Contract

| Field | Value |
|---|---|
| Doc ID | XQ-DOC-CONTRACT-0003 |
| Requirement prefix | `AUTH` |
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

Duplicate-post incidents rarely come from a wrong publisher. They come from a second thing that
was also allowed to publish: a watchdog, a health check, a deploy hook, an old workflow that woke
up. Each individually reasonable; collectively a second mouth on the same account.

This contract names the authorities, keeps them distinct, and states the invariant that stops
them multiplying.

## 2. The prime invariant

> At every instant, xqueue SHALL have no more than one production publication authority. A
> scheduler, watchdog, health process, deployment probe, recovery process, repair process, or
> superseded workflow SHALL NOT independently acquire publication authority unless the
> authoritative state explicitly permits it.

**AUTH-1** — The prime invariant in §2 MUST hold at every instant, and any condition in which two
actors could hold publication authority simultaneously MUST be detected and reported. Every other
requirement here exists to make that enforceable rather than aspirational.

## 3. The authority chain

Four different things. Conflating any two is how the invariant breaks.

```text
Owner (Patrick)
  ↓ grants
Scheduling authority        may decide work is due and wake it
  ↓ wakes work
Publication authority       may initiate a publication transaction
  ↓ initiates
Account publication lease   grants one fenced transaction at one generation
  ↓
X
```

**AUTH-2** — Scheduling authority MUST NOT imply publication authority. Deciding something is due
is not permission to post it.

**AUTH-3** — Publication authority MUST NOT imply the right to dispatch. A holder still has to
win the account lease and commit a fence (`PUB-6`, `PUB-13`).

**AUTH-4** — Holding the lease MUST NOT be treated as ownership beyond that single transaction.
A lease expires and its generation moves on; ownership does not transfer.

## 4. Actors and their capabilities

Default-deny: anything not granted here is forbidden.

| Actor | Schedule | Publish | Mutate state | Read evidence | Notes |
|---|---|---|---|---|---|
| Owner (Patrick) | Yes | Yes, via an explicit owner-initiated path | Yes, recorded | Yes | Sole approving authority |
| Scheduler / cron trigger | Yes | No | Scheduling fields, defer only | Yes | May defer; may never skip (`STATE-16`) |
| Workflow instance (current version) | No | Yes | Yes, within transaction rules | Yes | The only routine publisher |
| Workflow instance (superseded) | No | **No** | No | Yes | MUST self-terminate |
| Orphan repair process | No | **No** | Workflow state only | Yes | Creates missing instances; never publishes (`WF-15`) |
| Watchdog / monitor | No | **No** | No | Yes | Detects and reports; may set the halt |
| Health / readiness probe | No | **No** | Metadata only | Yes | MUST NOT touch the queue |
| Deployment process | No | **No** | Migrations only | Yes | Schema, not content |
| Reconciliation process | No | **No** | Classification fields only | Yes | Classifies; never dispatches |
| CI | No | **No** | No production access | No | Non-production credentials or a stub |
| Local developer machine | No | **No** by default | No, against production | Yes | See `AUTH-11` |

**AUTH-5** — Any actor whose Publish column reads **No** MUST have no structural path to the X
create-post call — enforced by credential scoping or by code paths absent from that binding, not
by a runtime conditional a refactor can invert.

> **`AUTH-5` is blocked pending a decision and MUST NOT be activated before OQ-AUTH-6 is
> answered.** Health, fetch, and scheduled publication are reported to live in one Worker script
> today, with the scheduled handler calling the production publisher when authority is enabled.
> Activating `AUTH-5` literally means splitting that into a control Worker holding no X write
> secrets and a publication Worker holding them. That is a real security improvement and a real
> architectural change. It is Patrick's call, not a side effect of approving this document.

**AUTH-6** — A single component MUST NOT hold both the implementer and verifier roles for the
same outcome. A component that dispatches MUST NOT decide the dispatch succeeded, beyond
recording the raw response.

## 5. Credentials as the enforcement boundary

**AUTH-7** — Production X write credentials MUST exist in exactly one binding, used by exactly
one deployable, and MUST NOT be readable by CI, by local development configuration, or by any
non-publishing worker.

**AUTH-8** — Read-only or stubbed credentials MUST be used everywhere the write path is not
intended: tests, dry runs, preview deployments.

**AUTH-9** — Credential rotation is owner-reserved and MUST produce an evidence record naming
what was rotated and when — never the secret value.

**AUTH-10** — A deployment MUST NOT acquire production write credentials as a side effect of
being deployed to a preview or branch environment.

**AUTH-11** — A local machine MAY hold publication authority only during an owner-initiated,
time-bounded, recorded operation. Convenience is not a justification for a second standing
publisher.

## 6. Owner-reserved actions

**AUTH-12** — The following MUST NOT occur without an explicit, recorded owner action:

1. Approving content for publication.
2. Forcing publication of an item outside its schedule.
3. Cancelling or reordering the queue in a way that changes what gets published.
4. Moving an item to `skipped`, and unskipping it (`STATE-16`, `STATE-17`).
5. Resolving a `needs_reconciliation` item, subject to OQ-PUB-3.
6. Clearing a global publishing halt.
7. Rotating or replacing X credentials.
8. Cutting over authoritative state (`STATE-3`).
9. Marking any contract `active` or `superseded`.
10. Any permanent removal of evidence, further restricted by `STATE-20`.

**AUTH-13** — Owner actions MUST be distinguishable in evidence from automated ones. "The system
did it" and "Patrick did it" are different facts and MUST NOT share a representation.

## 7. Emergency stop

**AUTH-14** — A global publishing halt MUST exist, MUST be settable without a deploy, and MUST be
checked as a precondition of every publication transaction (`PUB-3.4`).

**AUTH-15** — While the halt is set, no actor MUST dispatch, regardless of authority held. The halt
overrides every other permission in this document.

**AUTH-16** — The halt MUST be clearable only by the owner (`AUTH-12.6`); setting and clearing
MUST both be recorded.

**AUTH-17** — Automated processes MAY set the halt — a watchdog seeing duplicate posts should be
able to stop the line. They MUST NOT clear it.

## 8. Content authority

**AUTH-18** — *Retired in 0.2.0.* This slot previously required that published content respect
the X3 authorization boundary. No definition of X3 exists in this repository and no other
document references it, so the requirement was unenforceable as written. It MUST NOT be reinstated until a
document defining X3 exists to reference, and the ID MUST NOT be reused for anything else. See
OQ-AUTH-4.

**AUTH-19** — The publishing account's standing content rules — never name the employer, never
claim customers or pilots without authorization, keep legal content general with a disclaimer,
never post from an empty queue — are content-authority constraints. They are recorded here as
Patrick's stated rules, not as verified policy, and MUST be confirmed against the actual content
policy before becoming normative. Whether they are enforced by the validator or held editorially
is `Not yet verified`; see OQ-AUTH-1.

## 9. Prohibited

- Any process publishing "just to be safe" when it believes the scheduler failed.
- Watchdogs, probes, repair, or recovery paths with write access to the X API.
- Sharing one credential across environments.
- A superseded workflow retaining any publication capability.
- Automation clearing its own halt.
- Automation recording an action as an owner decision.
- Automation performing any action in `AUTH-12`.

## 10. Acceptance cases

<!-- lint-exempt-acceptance: AUTH-3, AUTH-4, AUTH-8, AUTH-9, AUTH-17, AUTH-18, AUTH-19 -->
Exempt from automated coverage, and why: `AUTH-3` and `AUTH-4` are proven by the publication
contract's lease cases; `AUTH-8`, `AUTH-9`, and `AUTH-19` are configuration and policy facts
checked by inspection, not by execution; `AUTH-17` grants a capability rather than restricting one; `AUTH-18` is retired.

| Case | Proves | Setup | Expected |
|---|---|---|---|
| AUTH-AC-1 | AUTH-5 | Watchdog binding attempts a create-post | Fails at the binding layer, not at a runtime check |
| AUTH-AC-2 | AUTH-14, AUTH-15 | Halt set, item due | No dispatch; reason recorded |
| AUTH-AC-3 | AUTH-16 | Automated process attempts to clear the halt | Refused and recorded |
| AUTH-AC-4 | AUTH-7 | CI job inspects its environment | No production write credential present |
| AUTH-AC-5 | AUTH-2 | Scheduler runs without a workflow | Work marked due; nothing posted |
| AUTH-AC-6 | AUTH-13 | Owner-forced publish | Evidence distinguishes it from a scheduled publish |
| AUTH-AC-7 | AUTH-1 | Two publication-capable actors active | Detected and reported as an invariant violation |
| AUTH-AC-8 | AUTH-10 | Preview deployment created | Holds no production write credential |
| AUTH-AC-9 | AUTH-12.4 | Automation attempts a skip | Refused; only an owner action succeeds |
| AUTH-AC-10 | AUTH-6 | Dispatching component records a response | It records the raw response; classification happens elsewhere |

## 11. Runbook obligations

`RUNBOOK.md` MUST document:

1. Setting the global halt, and what it does and does not stop.
2. Clearing the halt after an incident, with pre-clear checks.
3. Rotating X credentials end to end, and the evidence it produces.
4. Performing an owner-forced publication and how it is recorded.
5. Owner skip and unskip.
6. Confirming exactly one publication authority is deployed.

## 12. Open questions requiring Patrick's decision

| ID | Question | Blocking |
|---|---|---|
| OQ-AUTH-1 | Are the account content rules enforced in the validator or held editorially — and are they stated correctly in `AUTH-19`? | Yes — `AUTH-19` |
| OQ-AUTH-2 | Where does the halt live so it is settable without a deploy? | Yes — `AUTH-14` |
| OQ-AUTH-3 | Is a local machine ever permitted to publish to production? | Yes — `AUTH-11` |
| OQ-AUTH-4 | Does an X3 authorization boundary definition exist anywhere? If so, where, and should `AUTH-18` be reinstated against it? | No — `AUTH-18` is retired until answered |
| OQ-AUTH-5 | Does a non-production X account exist, or is dry-run the only non-production mode? | Yes — `AUTH-8` |
| OQ-AUTH-6 | **Split the single Worker into a control Worker without X write secrets and a publication Worker with them?** Required before `AUTH-5` can activate. | Yes — `AUTH-5` |

## 13. Verification status

| Claim | Truth state |
|---|---|
| Health, fetch, and scheduled publication currently share one Worker script, with the scheduled handler calling the production publisher when authority is enabled | `declared` by ChatGPT from code inspection, 2026-09-03 |
| The prime invariant is currently enforced | `unknown` |
| Exactly one deployable holds production write credentials | `unknown` |
| A global halt exists today | `unknown` |
| The `AUTH-19` content rules match an actual written content policy | `unknown` — recorded from Patrick's stated rules, unverified against a policy document |

The invariant text in §2 originated in a ChatGPT proposal dated 2026-09-03. It is recorded as a
proposal, not as a decision Patrick has made.

## 14. Change log

| Date | Version | Change |
|---|---|---|
| 2026-09-03 | 0.2.0 | Audit revision. `AUTH-5` marked blocked pending OQ-AUTH-6, with the Worker-split consequence stated rather than assumed. `AUTH-18` retired: X3 had no definition to reference. `AUTH-19` downgraded to stated-but-unverified. Repair process added to the actor table and the invariant. `AUTH-12` extended with owner-only skip and unskip. Lease references updated to the account-scoped generation-fenced lease. |
| 2026-09-03 | 0.1.0 | Initial draft. |
