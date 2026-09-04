<!--tos-doc
{
  "doc_id": "XQ-DOC-REVIEW-0001",
  "class": "review",
  "claims_truth_state": "declared",
  "written_against": { "head_sha": "Not yet verified" },
  "depends_on": ["docs/contracts/"]
}
-->

# Contract Audit Disposition — 2026-09-03

| Field | Value |
|---|---|
| Doc ID | XQ-DOC-REVIEW-0001 |
| Class | review record |
| Created | 2026-09-03 |
| Last updated | 2026-09-03 |
| Reviewer | ChatGPT (engineering role), with repository access |
| Reviewed | xqueue contracts 0.1.0 (four documents, 106 requirements) |
| Result | 0.2.0 issued. 10 findings, 3 secondary observations. All dispositioned below. |

Findings are recorded whether accepted or not. A rejected finding stays visible so the reasoning
survives the next time it comes up.

## Findings

| # | Finding | Disposition | Where |
|---|---|---|---|
| 1 | `SKIPPED` wrongly allowed automation to skip a missed slot | **Accepted** | `STATE-16`, `STATE-17`; scheduler defers only. Owner-only skip added to `AUTH-12.4` |
| 2 | `REJECTED` cannot be a terminal item state when rate-limit rejections reschedule | **Accepted** | Attempt outcome separated from lifecycle state. `STATE-11`, `STATE-18`, `PUB-30` |
| 3 | `PUB-16` "exactly one per fence" is unsafe — a crash legitimately leaves one fence and zero dispatches | **Accepted** | `PUB-16` weakened to at-most-one; `PUB-38` bars recovery from completing a fence |
| 4 | Per-item lease contradicts the proven account-scoped generation-fenced `publisher` lease | **Accepted** | `PUB-6`–`PUB-12` rewritten to the account lease; per-item leasing explicitly prohibited |
| 5 | Contract conflated the mutable state projection with the append-only audit ledger | **Accepted** | `STATE-7`–`STATE-9` and the two-store table in §3 |
| 6 | Proposed canonical states do not match the schema; several should not be persisted | **Accepted** | State set aligned to the reported schema plus `deferred`. `STATE-11` lists what is not a state and why |
| 7 | Workflow replacement has an availability hole — bump succeeds, creation fails, item orphaned | **Accepted** | `workflow_state = replacement_pending`, `WF-12`–`WF-16`; repair may never publish |
| 8 | `WF-4` too broad — eligibility changes with the clock, which must not bump a version | **Accepted** | `WF-4` narrowed to input mutations, with an explicit bump / no-bump table |
| 9 | Cloudflare facts allow closing OQ-WF-2 and OQ-WF-3 | **Accepted with a caveat** | `WF-19`, `WF-26`. Sleep ceiling, concurrency exemption, and ID uniqueness independently verified against Cloudflare documentation on 2026-09-03. `retries.limit: 0` recorded as `declared` rather than `verified` — documented per-step retry configuration is confirmed, but a limit of 0 has not been exercised in this codebase. Smoke-test it before activation |
| 10 | X documents no create-post idempotency key | **Accepted** | `PUB-19` states the mechanism is not available and not relied upon. OQ-PUB-2 closed |

## Secondary observations

| Observation | Disposition | Where |
|---|---|---|
| Classifier returns `confirmed_not_posted` but persistence collapses it into `needs_reconciliation` | **Accepted as a recorded conflict, not repaired here.** Repair is engineering work and needs its own GitHub issue | `PUB-25`, conflict PUB-C-1, case PUB-AC-10 |
| `AUTH-5` implies splitting the single Worker; a draft should not make that call | **Accepted.** `AUTH-5` marked blocked pending OQ-AUTH-6, with both options stated | `AUTH-5`, OQ-AUTH-6 |
| `AUTH-18` cites an X3 boundary with no definition anywhere; `AUTH-19` asserts unverified content rules | **Accepted.** `AUTH-18` retired, ID not reused. `AUTH-19` downgraded to stated-but-unverified | `AUTH-18`, `AUTH-19`, OQ-AUTH-1, OQ-AUTH-4 |
| README overclaimed what `doc-stamp.mjs` does | **Accepted.** README now states its limits explicitly, and a real structural checker was added | README §Tooling, `scripts/contract-lint.mjs` |
| Archive did not install the `pnpm` scripts it documented | **Accepted** | `scripts/install-doc-scripts.mjs` |
| Add the missing `scheduling-and-missed-slot-contract.md` | **Not done, deliberately.** That contract already exists in the repository and was excluded from this work by request. Its three new obligations are listed instead | Durable-state contract §4.1 |

## What this audit did not settle

`deferred` is a new persisted state and needs a migration and a backfill decision (OQ-STATE-1,
OQ-STATE-8). `prepared` remains undefined in contract terms (OQ-STATE-7). Whether cutover has
happened is still unknown to the documentation side (OQ-STATE-2).

Blocking open questions across the four contracts: **22**.

## Provenance

```json
{
  "from": "chatgpt",
  "candidate_sha": "Not yet verified",
  "objective": "Audit xqueue contracts 0.1.0 against the implemented system",
  "files_changed": [],
  "positive_tests": "Not yet verified",
  "negative_tests": "Not yet verified",
  "independently_verified_by": "Cloudflare Workflows documentation, reviewed 2026-09-03, for findings 9 only",
  "evidence_refs": [],
  "github_issue": null,
  "unverified": [
    "publication_state / publication_events table split",
    "current persisted state set",
    "account-scoped publisher lease and its test coverage",
    "classifier / persistence mismatch (PUB-C-1)",
    "single-Worker deployment shape"
  ]
}
```

Every repository claim in this audit is `declared` by ChatGPT from code inspection. None was
independently verified: an anonymous clone of `github.com/peteywee/xqueue` was attempted on
2026-09-03 and failed with an authentication error. The audit carries no `candidate_sha`, so no
document revised from it can claim `verified`. That is why 0.2.0 remains `proposed`.
