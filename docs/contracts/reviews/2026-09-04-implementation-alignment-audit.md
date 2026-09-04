<!--tos-doc
{
  "doc_id": "XQ-DOC-REVIEW-0002",
  "class": "review",
  "claims_truth_state": "declared",
  "written_against": { "head_sha": "cc8fe06973e36bd10fcd5b8b8a86cb90359dd43a" },
  "depends_on": [
    "docs/contracts/",
    "cloudflare/src/",
    "cloudflare/migrations/",
    "src/",
    "scripts/",
    "test/",
    "wrangler.jsonc",
    "wrangler.authority.jsonc",
    "deploy/systemd/"
  ]
}
-->

# Implementation Alignment Audit — 2026-09-04

| Field | Value |
|---|---|
| Doc ID | XQ-DOC-REVIEW-0002 |
| Class | implementation alignment review |
| Created | 2026-09-04 |
| Last updated | 2026-09-04 |
| Normative source | xqueue contract set v0.2.0 in `docs/contracts/` |
| Audited baseline | `cc8fe06973e36bd10fcd5b8b8a86cb90359dd43a` (`main`) |
| Docs-first commit | `346d0a1228a095d821d971f4cdd5d74c6b1fdb04` |
| First alignment candidate | `04e8ff886110f3b276c9dd7b1f4ac43f0f37c947` |
| Draft PR | #40 — `Contracts v0.2.0: docs-first implementation alignment` |
| Audit rule | **The contracts lead. A code mismatch is a defect or a blocked decision; it is not a reason to weaken the contract.** |

## 1. Executive result

The current implementation already contains several strong safety primitives: an account-scoped
generation-fenced publication lease, exact lease verification, conservative ambiguous-outcome
handling, no generic create-post retry in the current publication path, deterministic scheduling
and timezone tests, and a deliberate authority-cutover boundary between the local systemd
publisher and the dormant Cloudflare authority configuration.

It does **not** yet conform to the v0.2.0 contract set as a whole. The most important verified
mismatches are publication-outcome semantics at the persistence boundary, incomplete fence/evidence
binding, missing durable lifecycle/version fields required by the state contract, no implemented
global halt, and a missing normative scheduling contract that other contracts depend on.

The Workflow lifecycle contract is intentionally ahead of implementation and is therefore
classified as **planned**, not as a current-runtime regression.

## 2. Verification of the first alignment candidate

GitHub Actions tested PR #40 with branch head
`04e8ff886110f3b276c9dd7b1f4ac43f0f37c947` merged onto base
`cc8fe06973e36bd10fcd5b8b8a86cb90359dd43a` as PR merge ref
`c124f556347f7be40e2a2309b6e08a86ec0e853a`.

Both workflows completed successfully:

- `verify` run #83: **PASS**.
- `XQueue Integrity` run #62: **PASS**.
- Strict contract lint: **6 documents, 116 requirements, 0 errors, 0 warnings**.
- Test suite: **332 tests, 332 pass, 0 fail**.
- New negative evidence-immutability tests: **PASS** for both `publication_events` and
  `publication_lease_events` UPDATE/DELETE refusal.
- Content validation: **180 posts, 0 errors, 0 warnings**.
- XQueue health / safe repair: **PASS**.
- Authority-boundary audit: **15/15 gates PASS**.
- Default Worker, authority-cutover Worker, and inert XDK probe Wrangler dry-run bundles: **PASS**.

This proves the first alignment change does not break the existing verified repository gates. It
does **not** prove the contract set as a whole is implemented.

## 3. Publication transaction alignment

| Requirement area | Status | Audit finding | Action |
|---|---|---|---|
| `PUB-6`–`PUB-10` account lease / generation fencing | **CONFORMS strongly** | Current D1 lease is account-scoped (`publisher`), atomically acquired, generation-fenced, takeover increments generation, replay/stale handles are rejected. Existing contention/takeover/replay tests pass. | Preserve. |
| `PUB-13` fence before dispatch | **CONFORMS in current path** | Publication state is moved to `publishing` and a `publish_started` event is persisted before `createPost`. | Preserve; strengthen evidence fields per #41. |
| `PUB-14` fence contents | **PARTIAL / DEFECT** | Durable publication fence does not bind all required fields. Lease generation/holder identity and schedule version are absent from the durable fence/event evidence. | Issue #41. Lease binding can proceed; schedule-version portion is blocked on `OQ-WF-6`. |
| `PUB-16` at-most-one dispatch per fence | **CONFORMS in tested current path** | Transport delegates once; concurrent simulations with one lease winner dispatch exactly once; no recovery path observed completing a dispatch fence in the Cloudflare path. | Preserve with explicit regression coverage as code evolves. |
| `PUB-18` no generic create-post retry | **CONFORMS in tested current path** | Current transport/simulation tests prove one delegation and no automatic retry for 429, timeout, or transport ambiguity. | Preserve. |
| `PUB-21` / `PUB-22` three-way outcome classification | **CONFORMS at classifier boundary** | Classifier distinguishes confirmed posted, confirmed not posted, and reconciliation-required/ambiguous behavior conservatively. | Preserve. |
| `PUB-25` persist exact outcome semantics | **FAIL — VERIFIED DEFECT** | `persistPublicationOutcome()` maps `confirmed_posted` to `posted` and every other classifier result to `needs_reconciliation`; current test `any non-posted outcome becomes a durable reconciliation block` encodes the mismatch. | Issue #38 / conflict `PUB-C-1`. Fix code/tests, not the contract. |
| `PUB-26` not-posted class → explicit lifecycle policy | **BLOCKED / NOT IMPLEMENTED AS CONTRACTED** | Current persistence does not retain/apply the class-specific lifecycle policy. Several branches depend on unresolved owner/spec decisions. | Resolve dependent decisions, then implement behind failing regression tests. |
| `PUB-31` / `PUB-32` ambiguous → reconciliation / no retry | **CONFORMS strongly** | Timeout, 5xx, unknown evidence, lease loss during request, and persistence uncertainty fail closed to reconciliation with no automatic redispatch. | Preserve. |
| `PUB-39` complete transaction evidence | **PARTIAL / DEFECT** | Current evidence omits schedule version and does not bind all lease/fence authority fields required by the contract. | Issue #41. |

## 4. Authority and ownership alignment

| Requirement area | Status | Audit finding | Action |
|---|---|---|---|
| `AUTH-1` one production publication authority | **PARTIAL / CUTOVER-SENSITIVE** | Cloudflare authority is dormant by default; separate authority config enables cron, while the local systemd `post:live` unit is retained as rollback. The repository audit requires local publication to be disabled before Cloudflare authority is activated. | Preserve the cutover gate; do not delete rollback merely for architectural neatness. |
| `AUTH-2` scheduling ≠ publication authority | **PARTIAL** | Default Worker has no cron; authority config adds cron. Runtime flag still controls publication. | Continue moving toward structural enforcement without weakening fail-closed behavior. |
| `AUTH-5` non-publishers structurally cannot call X create-post | **BLOCKED BY CONTRACT DECISION** | `/health` and `scheduled()` live in the same Worker module graph. The contract itself marks `AUTH-5` blocked on `OQ-AUTH-6`: whether to split control and publication Workers. | **Do not auto-split.** Owner decision required. |
| `AUTH-7` credential confinement | **PARTIAL / STRONG MODULE BOUNDARY** | Repository audit proves X credential references and publication surface are confined to the production publisher module, but the deployable-level split required by active `AUTH-5` does not yet exist. | Keep proposed until the Worker-boundary decision is made and tested. |
| `AUTH-14`–`AUTH-17` global publishing halt | **NOT IMPLEMENTED / BLOCKED** | No global halt implementation was found in the audited runtime. Contract open question `OQ-AUTH-2` intentionally leaves its durable location undecided. | Decide halt storage/authority first; then implement and negative-test owner-only clear. |

## 5. Durable state and ledger alignment

| Requirement area | Status | Audit finding | Action |
|---|---|---|---|
| `STATE-1` / `STATE-2` D1 sole production truth after cutover | **BLOCKED — CUTOVER NOT PROVEN** | D1 runtime state exists, but the local `state.json` model and local `post:live` rollback publisher still exist. There is no evidence in this audit that the owner-reserved D1 cutover has occurred. | Do not call D1 canonical until cutover is explicitly recorded. |
| `STATE-7` events append-only | **ALIGNED ON PR #40** | Baseline schema did not block UPDATE/DELETE. Migration `0004_append_only_event_ledgers.sql` now enforces immutability for `publication_events` and `publication_lease_events`; negative tests pass. | Issue #39 implemented on alignment branch; keep in verification gate. |
| `STATE-9` projection + event atomicity | **PARTIAL / GOOD IMPLEMENTATION PATTERN** | Current publication ledger uses D1 `batch()` for paired projection/event writes. Failure-mode semantics should remain covered as state model evolves. | Preserve; add contract-specific failure cases when state migration proceeds. |
| `STATE-10` / `STATE-11` lifecycle state set | **FAIL / SCHEMA GAP** | Current D1 CHECK permits `scheduled`, `prepared`, `publishing`, `posted`, `needs_reconciliation`, `skipped`; contract adds `deferred`. Existing campaign "tail deferrals" are schedule placement and are not proof of a durable `deferred` lifecycle state. | Requires migration/backfill decision `OQ-STATE-1` / `OQ-STATE-8`; do not conflate scheduling data with lifecycle state. |
| `STATE-19` guarded CAS transitions | **PARTIAL** | Publication-state updates guard expected prior status, which is safer than blind writes. | Preserve, then tighten alongside explicit row versioning. |
| `STATE-21` monotonically increasing version/generation on every mutable row | **FAIL / NOT IMPLEMENTED FOR publication_state** | `publication_state` has no row version/generation column. Lease rows do have generation. | Plan a state-schema migration after cutover/state-model decisions are resolved. |
| `STATE-23` UTC instants | **PARTIAL / CURRENT CODE CONSISTENT** | Runtime publication timestamps use UTC ISO strings; scheduler timezone conversion is heavily tested. | Preserve and make schema/test obligation explicit during state migration. |
| `STATE-27` backup cadence / `STATE-28` restore | **BLOCKED / NOT VERIFIED** | Contract deliberately leaves cadence open; this audit does not establish a performed restore against the authoritative production state. | Do not claim DR verification until an actual restore drill is recorded. |

## 6. Workflow lifecycle alignment

The Workflow lifecycle contract states that Cloudflare Workflows are not yet implemented and is
written ahead of that implementation. Therefore `WF-*` requirements are **PLANNED**, not current
runtime failures.

The current runtime uses cron-triggered Worker execution and the local systemd publisher/cutover
model. Do not retrofit the existing cron runtime into the Workflow contract simply to produce a
false PASS. Implement Workflows only after the engine/instance/version/repair open questions are
resolved.

## 7. Scheduling specification gap

The contract README states that `docs/contracts/scheduling-and-missed-slot-contract.md` already
exists and was intentionally excluded from the supplied bundle. It did not exist on audited
`main`, and no actual scheduling contract was recovered from the available saved xqueue
materials.

This is **not permission to turn current scheduler code into the specification**.

Issue #42 tracks the required resolution. This blocks activation because the durable-state and
publication contracts delegate missed-slot, `deferred`, rate-limit/media rescheduling, and
replacement-slot policy to the missing scheduling contract.

Existing scheduler tests remain valuable **evidence** — deterministic calendar generation,
America/Chicago conversion, DST edge cases, unique slots, and B1/A30/C1 tail deferrals — but
those tests do not become normative until checked against an approved scheduling contract.

## 8. Alignment backlog by class

### A. Concrete implementation defects — code must change

1. **#38 — PUB-C-1 / PUB-25:** preserve `confirmed_not_posted` semantics instead of collapsing it
   to `needs_reconciliation`.
2. **#41 — PUB-14 / PUB-39:** bind durable publication fence/evidence to exact lease authority;
   add schedule version after its model is approved.
3. **STATE-21:** add monotonic row version/generation to mutable publication state when the state
   migration is designed.
4. **STATE-7 / STATE-20:** baseline gap already remediated on PR #40 by migration 0004 + negative
   tests (#39).

### B. Missing normative specification

1. **#42:** recover or author `scheduling-and-missed-slot-contract.md` from intended behavior,
   never from implementation drift.

### C. Owner / architecture decisions — do not guess

1. `OQ-AUTH-2` — where the global halt lives.
2. `OQ-AUTH-6` — split control Worker and publication Worker or retain a single deployable.
3. `OQ-STATE-1` / `OQ-STATE-8` — durable `deferred` migration and backfill.
4. `OQ-STATE-2` / `OQ-STATE-5` — whether D1 cutover has occurred and the post-cutover role of
   `state.json`.
5. `OQ-STATE-7` — exact meaning of `prepared`.
6. `OQ-WF-6` — where schedule version lives and what increments it.
7. `OQ-PUB-5` and related not-posted policy choices needed before implementing all `PUB-26`
   branches.

### D. Strong invariants to preserve during remediation

1. Account-scoped generation-fenced publication lease.
2. No automatic retry of create-post after dispatch uncertainty.
3. Ambiguous outcomes fail closed to reconciliation.
4. Exact identity/media checks before dispatch.
5. One publication authority during cutover.
6. Deterministic scheduling/timezone behavior.
7. Append-only event evidence at the database boundary.

## 9. Activation gate

The v0.2.0 contracts MUST remain `proposed` until at minimum:

1. the missing scheduling contract exists and its cross-contract dependencies are reconciled;
2. `PUB-C-1` is repaired with regression tests;
3. owner-blocked authority/state decisions required by active requirements are resolved;
4. the durable state migration plan is explicit where the contract requires new state/version
   fields;
5. acceptance cases for active requirements map to executable tests or explicit inspection
   evidence;
6. the exact activation candidate has green repository verification and an implementation audit
   tied to that candidate SHA.

## 10. Conclusion

xqueue is not being re-documented around what happens to exist today. The repository now has a
normative target, and the first alignment pass is already exposing the exact kinds of defects the
contracts are supposed to expose: semantic loss at a persistence boundary, authority evidence
that is not fully bound to the transaction, and schema/state decisions that cannot safely be
inferred from implementation.

That is the correct direction: **contract → failing evidence → implementation change → negative
verification → exact-candidate proof**.
