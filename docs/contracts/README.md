<!--tos-doc
{
  "doc_id": "XQ-DOC-CONTRACT-0000",
  "class": "contract",
  "claims_truth_state": "proposed",
  "written_against": { "head_sha": "Not yet verified" },
  "depends_on": ["docs/contracts/"]
}
-->

# xqueue Contracts

| Field | Value |
|---|---|
| Doc ID | XQ-DOC-CONTRACT-0000 |
| Status | proposed — not yet approved |
| Version | 0.2.1 |
| Created | 2026-09-03 |
| Last updated | 2026-09-04 |
| Owner | Patrick Craven (sole approving authority) |
| Drafted by | Claude, revised against the ChatGPT contract audit of 2026-09-03; scheduling contract added by ChatGPT on 2026-09-04 after recovery failed |
| Verified against implementation | No — implementation conformance is audited separately |

## What a contract is

A contract defines **required system behavior**. It is normative: it says what the system shall
and shall not do, independent of how any current file happens to be written.

Contracts exist because behavior in this project is spread across code, tests, runbook steps,
and conversation. That spread makes it possible for a refactor to silently delete a safety
property nobody wrote down.

## Document precedence

```text
BUSINESS INTENT        what Patrick wants the system to accomplish
      ↓
CONTRACTS              required behavior (this directory)
      ↓
ARCHITECTURE / CODE    implementation of that behavior
      ↓
TESTS                  verification that behavior holds
      ↓
RUNBOOK                how a human operates the running system
      ↓
EVIDENCE               what was actually proven, and when
```

- If implementation behavior conflicts with an **active** contract, the implementation is
  defective unless the contract has been explicitly revised first.
- A contract is never edited to match code that drifted. Either the code is fixed, or the
  contract is revised deliberately and the old version preserved.
- Nothing here records history. Historical claims belong in `docs/milestones/` and
  `docs/evidence/`. Review records belong in `docs/contracts/reviews/`.

## Layer vocabulary

The 0.1.0 drafts collapsed four different things into one state enum. They are kept apart now,
and every contract uses these words in exactly this sense:

| Layer | What it is | Persisted as | Examples |
|---|---|---|---|
| **Content lifecycle state** | Where an item stands in its life | Mutable projection, CAS-guarded | `scheduled`, `publishing`, `posted`, `deferred`, `skipped`, `needs_reconciliation` |
| **Transaction outcome** | What one publication attempt produced | Append-only event | `confirmed_posted`, `confirmed_not_posted`, `ambiguous` |
| **Derived condition** | Computed at read time, never stored | — | eligibility |
| **Separate resource** | Its own subsystem with its own rules | Its own records | the account publication lease; schedule and workflow versions |

Two consequences worth stating up front, because both were wrong in 0.1.0: an API rejection is
**evidence about an attempt**, not a permanent state of the content; and an item is not
"leased" as a state — a lease is a resource held against the account.

## Normative language

RFC 2119 / RFC 8174 keywords, uppercase only: MUST, MUST NOT, SHOULD, SHOULD NOT, MAY.

Every normative statement carries a stable requirement ID (`PUB-3`, `AUTH-7`). Those IDs are the
join key between contracts, tests, and evidence. Never renumber. Retire an ID rather than reuse
it — retired IDs are listed in their contract's change log.

## Status vocabulary

| Status | Meaning |
|---|---|
| `proposed` | Drafted, not approved. Not binding. Not staleness-checked. |
| `active` | Approved by Patrick. Binding on implementation. |
| `superseded` | Replaced by a later version. Retained; never deleted or rewritten. |

Truth states inside contracts follow the TOS vocabulary: `verified`, `declared`, `inferred`,
`unknown`, `conflicting`, `stale`, `not_applicable`. Precedence is **deterministic evidence >
human declaration > AI inference**. Unknowns are written `Not yet verified`, never omitted and
never filled with a plausible value.

## The five contracts

| # | File | Version | Status | Last updated | Answers |
|---|---|---|---|---|---|
| 1 | `scheduling-and-missed-slot-contract.md` | 0.1.0 | proposed | 2026-09-04 | What happens when time passes, slots are missed, DST shifts, or content is deferred |
| 2 | `publication-transaction-contract.md` | 0.2.0 | proposed | 2026-09-03 | When X may be called, what an attempt produced, how many dispatches |
| 3 | `authority-and-ownership-contract.md` | 0.2.0 | proposed | 2026-09-03 | Who may publish, who may schedule, what is owner-reserved |
| 4 | `durable-state-and-ledger-contract.md` | 0.2.0 | proposed | 2026-09-03 | What is authoritative, which transitions are legal, what is append-only |
| 5 | `workflow-lifecycle-contract.md` | 0.2.0 | proposed | 2026-09-03 | Workflow IDs, schedule versions, supersession, replacement, stale wakeups |

Contract 1 was referenced by the supplied 0.2.0 set but could not be recovered from `main` or
available saved xqueue materials. Issue #42 records that gap. A fresh 0.1.0 proposal was added on
2026-09-04 from the already-stated cross-contract business intent and safety constraints. It was
explicitly not reverse-engineered from current scheduler code. Implementation conformance is a
separate audit.

Deliberately **not** separate contracts: timezone, retry, idempotency, concurrency, D1, R2, and
X API behavior. Each belongs inside one of the five above.

## Anchor block

Every contract carries one anchor as the first lines of the file — HTML comment so it does not
render, JSON so it can be machine-checked:

```text
<!--tos-doc
{
  "doc_id": "XQ-DOC-CONTRACT-0002",
  "class": "contract",
  "claims_truth_state": "proposed",
  "written_against": { "head_sha": "<exact SHA, or Not yet verified>" },
  "depends_on": ["src/", "migrations/"]
}
-->
```

`depends_on` lists the git pathspecs the document's claims rest on. Err wide — a too-narrow
list passes a freshness check while being wrong.

## Tooling, and what it actually does

Two scripts ship with this set. Read the limits, because a tool that is trusted for more than
it does is worse than no tool.

**`scripts/doc-stamp.mjs` — timestamp integrity only.** It compares the `Last updated` row
against the last git commit that touched **that document**, and rewrites or reports it. That is
its entire job.

It does **not** inspect `depends_on`, compare dependency commit dates, validate
`written_against.head_sha`, or mark anything stale.

**`scripts/contract-lint.mjs` — structural integrity.** Validates anchor JSON, required header
rows, status vocabulary, requirement ID uniqueness and ordering, that every normative sentence
carries an ID, that every MUST has at least one acceptance case, and that every `OQ-` reference
resolves to a row in the same document's open-questions table.

It does **not** verify that any requirement is implemented. Nothing here does. Implementation
verification requires running the code.

```bash
node scripts/install-doc-scripts.mjs   # adds the pnpm scripts to package.json, once
pnpm doc:stamp                         # rewrite Last updated from git
pnpm doc:stamp:check                   # CI mode — exit 1 on drift
pnpm contract:lint                     # CI mode — exit 1 on structural defect
```

A true dependency-freshness checker — the thing that reads `depends_on` and flags a contract
whose implementation paths moved — does not exist yet. It is worth building once contracts are
`active`; while everything is `proposed` it would correctly report nothing.

## Changing a contract

While a contract is `proposed`, bump the version and record the change in its change log. That
is enough; supersession ceremony for an unapproved draft is bureaucracy.

Once a contract is `active`:

1. Open a GitHub issue. No material contract change starts without one.
2. Copy the current file to `docs/contracts/superseded/<name>-v<old-version>.md`, set its status
   to `superseded`, fill `superseded_by`.
3. Bump `Version` on the live file, fill `supersedes`, record what changed and why.
4. Update affected acceptance cases before touching implementation code.
5. Only then change the code.

Never rewrite a contract so a new decision looks like it was always the decision. Preserve
failures — they are evidence.

## Review records

External review of this set is recorded in `docs/contracts/reviews/`. Findings are dispositioned
individually; a finding that was rejected is recorded as rejected rather than dropped.

## Approval

All five documents are `proposed`. They become binding when Patrick marks them `active`. Until
then they MUST NOT be cited as authority in a milestone, evidence index, or status report.

Blocking open questions remain listed per contract and in the review/tracking issues. The
implementation-alignment program is tracked in #48; issue closure, code merge, production cutover,
and contract activation are intentionally separate decisions.

## Change log

| Date | Version | Change |
|---|---|---|
| 2026-09-04 | 0.2.1 | Registered the newly created scheduling/missed-slot contract after the referenced prior file could not be recovered; corrected the README's recovery history without deriving requirements from implementation. |
| 2026-09-03 | 0.2.0 | Revised against external audit. Added layer vocabulary; corrected tooling claims; added `contract-lint.mjs` and `install-doc-scripts.mjs`; added reviews directory; relaxed supersession ceremony for proposed drafts. |
| 2026-09-03 | 0.1.0 | Initial directory established. |
