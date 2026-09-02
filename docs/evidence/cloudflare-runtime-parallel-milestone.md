<!--tos-doc
{
  "doc_id": "TOS-DOC-EVID-XQ-0001",
  "class": "evidence",
  "claims_truth_state": "verified",
  "written_against": { "head_sha": "707d71edf037e3a90525d29b44f2bbfd8b8992dc" },
  "depends_on": [
    "cloudflare/",
    "config/schedule-policy.json",
    "content/",
    "src/",
    "scripts/",
    "test/",
    "wrangler.jsonc",
    "deploy/systemd/",
    "package.json"
  ]
}
-->

# Cloudflare Runtime Parallel Milestone — Evidence Record

Baseline: `707d71edf037e3a90525d29b44f2bbfd8b8992dc`
Lanes executed: A (issue #8), C (issue #10), D (issue #11)
Lane B (issue #9) was not in scope for this session. Integration was not performed.

Every row below carries a truth state. `verified` means a command was run at the stated SHA in this
session and its output observed. `unknown` means it was not established — it is never inferred.

## Exact lane candidates

| Lane | Branch | Candidate SHA | Truth state |
|---|---|---|---|
| A — queue bundle + hash parity | `cf-runtime-bundle-hash` | `43464e119dfe03ce44a5155219367d31de5e4fd9` | verified |
| C — read-only eligibility parity | `cf-runtime-eligibility` | `f298d1ffa8f2c514cb74ea0dc4113610c1205925` | verified |
| D — R2 media inventory + parity | `cf-runtime-media` | `9a73b2a403c21cfbcf2415e88ba47504a2091295` | verified |

## Canonical queue facts

Established by running `scripts/build-production-queue.mjs` at baseline and by a live read-only query
against production D1 `fc85026e-bfc8-435f-8bb0-c60e139178a3`.

| Fact | Value | Truth state |
|---|---|---|
| Queue length | 180 | verified |
| Unique post IDs | 180 | verified |
| Canonical bytes | 160277 | verified |
| Canonical SHA-256 | `09c36e24207d7720c46d163b83b9cee9465e6ded36221499032c0acee218bbc1` | verified |
| D1 `runtime_metadata.queue.sha256` | identical to the above | verified |
| D1 `runtime_metadata.queue.count` | `"180"` | verified |

Canonical hash semantics, confirmed rather than assumed: SHA-256 over the canonical `queue.json`
bytes, `JSON.stringify(queue, null, 2) + "\n"`, UTF-8. Not over any JavaScript wrapper module.

Deferred rotation tail, exact and unchanged:

| # | ID | Scheduled | Zone |
|---|---|---|---|
| 178 | `B1` | 2027-01-04 14:30 | America/Chicago |
| 179 | `A30` | 2027-01-04 22:15 | America/Chicago |
| 180 | `C1` | 2027-01-05 14:30 | America/Chicago |

## Lane A — queue bundle + hash parity (`43464e1`)

| Evidence | Result | Truth state |
|---|---|---|
| Bundle sha == canonical sha == D1 sha | all three identical | verified |
| Count / unique IDs | 180 / 180 | verified |
| Deterministic regeneration | byte-identical; git diff clean | verified |
| Live regeneration parity | canonical text from `content/` + policy is byte-identical to bundled text | verified |
| Repository tests | 149 pass, 0 fail | verified |
| Authority gates | 10/10 intact | verified |
| Wrangler dry-run | exit 0; 169.06 KiB, gzip 45.17 KiB; bindings D1 + R2 only; no cron | verified |
| Worker `/health` fail-closed | 503 + `status: "error"` on mismatch | verified |

### Two fail-open defects found by adversarial review and fixed

Both were reproduced independently by the lane lead before and after the fix.

**1. The gate never pinned the queue content.** At the pre-fix candidate `e940166`, the string
`09c36e24…` did not appear anywhere in `cloudflare/src/queue-integrity.mjs`. Every check was
bundle-against-itself or bundle-against-mirror; nothing compared the bundle to a known-good value.
A forged bundle — 180 posts, 180 unique IDs, the exact `B1`/`A30`/`C1` tail, content replaced, a
self-consistent declared sha, and a D1 mirror echoing the forged sha — returned `ok: true`.
Anchoring correctness solely to a mirror that this architecture explicitly designates
non-authoritative is the wrong anchor. Fixed by pinning `EXPECTED_QUEUE_SHA256` in Worker source; the
same forgery now returns `ok: false` / `bundle_canonical_sha_mismatch`, while the real bundle against
the real D1 value still returns `ok: true`.

**2. Inherited properties counted as D1 evidence.** `readD1QueueMetadata` accumulated rows onto a
`{}` literal. With zero rows returned but `Object.prototype['queue.sha256']` set, the gate returned
`ok: true` — absence of evidence read as success, which the module explicitly forbids. Fixed with
`Object.create(null)`; the same input now returns `ok: false` / `d1_queue_sha256_missing`.

A third finding — lenient `Number()` coercion of D1 `queue.count` accepting `'0xB4'`, `'0180'`,
`'1.8e2'` — was assessed as a hardening gap, not an exploitable defect: every accepted value
numerically is 180, so it could not mask a wrong count. Fixed with a strict decimal parser anyway.

## Lane C — read-only eligibility parity (`f298d1f`)

| Evidence | Result | Truth state |
|---|---|---|
| Imports in `cloudflare/src/eligibility.mjs` | 0 — fully standalone re-implementation | verified |
| Parity matrix | 32 rows, 32 PASS, 0 FAIL, exit 0 | verified |
| Committed matrix freshness | byte-fresh against regeneration | verified |
| Repository tests | 132 pass, 0 fail | verified |
| Authority gates | 10/10 intact | verified |
| Wrangler dry-run | exit 0; no cron | verified |

Wall-clock instants cross-checked directly against the local `scheduledAt`, 10 of 10 matching:

| Case | Wall clock | Instant |
|---|---|---|
| Spring-forward, before gap | 2027-03-14 01:30 | `2027-03-14T07:30:00.000Z` |
| Spring-forward, **nonexistent** wall clock | 2027-03-14 02:30 | `2027-03-14T07:30:00.000Z` |
| Spring-forward, after gap | 2027-03-14 03:30 | `2027-03-14T08:30:00.000Z` |
| Fall-back, **ambiguous** repeated hour | 2027-11-07 01:30 | `2027-11-07T06:30:00.000Z` (first/CDT) |
| Deferred tail `B1` / `A30` / `C1` | — | `20:30Z` / `04:15Z` (next day) / `20:30Z` |

Harness sensitivity was confirmed by the lane lead's own mutations of the Cloudflare module, not
only by the builder's: breaking the due boundary (`<=` to `<`) yields 23/32 and exit 1; selecting the
last rather than the first due post yields 29/32 and exit 1. A green matrix therefore carries meaning.

### Documented withhold-only divergences

These are deliberate. Each can only cause Cloudflare to refuse where local proceeds, never the
reverse. The reverse direction — local refuses, Cloudflare accepts — is the dangerous one and was
not searched exhaustively, because the Lane C adversarial pass did not complete (see gaps).

1. A `prepared` inflight blocks. Local live mode recovers it by mutating `state.json` and then
   publishes; a read-only module cannot perform that write and must not assume it happened.
2. `safeToPublish` additionally requires `health.ok`, so a stale backlog withholds even though
   `cmdPost` publishes through staleness. `selection.selected` still mirrors local exactly.
3. A missing or null ledger is `malformed_ledger`, not an implied empty ledger.

## Lane D — R2 media inventory + parity (`9a73b2a`)

Required media derived from the regenerated 180-post queue, cross-checked independently by the lane
lead against `queue.json`. Exactly 4 objects, no figure shared by two posts:

| postId | figure | logicalMediaId | R2 key prefix |
|---|---|---|---|
| `D1` | 1 | `figure-0001` | `media/figures/figure-0001` |
| `A4` | 9 | `figure-0009` | `media/figures/figure-0009` |
| `A1` | 14 | `figure-0014` | `media/figures/figure-0014` |
| `C1` | 23 | `figure-0023` | `media/figures/figure-0023` |

| Evidence | Result | Truth state |
|---|---|---|
| Requirements determinism | byte-identical; committed artifact matches regeneration | verified |
| Repository tests | 138 pass, 0 fail | verified |
| R2 mutation calls in verifier | 0 (`.put(` / `.delete(`) | verified |
| `node:` imports in verifier | 0 | verified |
| Manifest with empty `media/` | exit 1, nothing written, all 4 figures named | verified |
| Upload helper default | dry-run; `--confirm` required; `--dry-run --confirm` rejected | verified |
| Authority gates | 10/10 intact | verified |
| Wrangler dry-run | exit 0; no cron | verified |
| Hash-bearing manifest, real bytes | **unknown** — real figure files absent from this environment | unknown |
| Live R2 verification against `xqueue-media` | **unknown** — no Cloudflare credentials in this environment | unknown |

The manifest failure is the correct outcome, not a defect: `media/*` is gitignored and the real figure
files are absent, so refusing to emit sizes and hashes is the fail-closed behaviour the lane requires.

### Hardening applied after adversarial review

- **Trust boundary recorded.** An R2 checksum or `customMetadata` sha is an assertion by the bucket
  about bytes never read; only a body digest observes them. Each object now carries `hashTrust`
  (`bucket_asserted` / `body_observed`) and the summary counts `bodyObservedCount`.
- **Listing completeness reported.** A truncated stray listing under-reports unrelated objects and
  must never read as an observed absence of them.
- **Empty required set refused.** A manifest requiring nothing is not evidence the bucket is correct.
- **Figure matching bounded on a non-digit.** `src/cli.mjs` uses an unanchored `0*<n>\.ext$`, so
  figure 1 also matches `figure-11.png`. Against a real media directory holding figures 1..30 that
  makes figures 1 and 9 ambiguous, and a builder that correctly refuses ambiguity could then never
  emit a manifest at all. The accepted set remains a strict subset of the CLI's.

## Authority boundary

`scripts/authority-boundary-audit.mjs` asserts ten properties mechanically. Result at baseline and at
each of the three lane candidates: **10/10 passed**, truth state `verified`.

| Gate | Result |
|---|---|
| Cloudflare cron trigger count is 0 | PASS |
| No X credential surface in `cloudflare/` | PASS |
| No `vars` or secret bindings in `wrangler.jsonc` | PASS |
| No X publication call in `cloudflare/src/` | PASS |
| No D1 write statement in `cloudflare/src/` | PASS |
| No R2 mutation in `cloudflare/src/` | PASS |
| systemd unit still runs `post:live` | PASS |
| `package.json` still defines `post:live` | PASS |
| `queue.json` / `state.json` / `.env` untracked | PASS |
| No media binaries tracked | PASS |

The `tweet_id` occurrences in `cloudflare/migrations/` are D1 mirror column names, not a publication
path; the call-surface gate is scoped to Worker source deliberately.

Live D1 access was exercised read-only. The Worker's exact parameterised statement
`SELECT key, value FROM runtime_metadata WHERE key IN (?, ?)` returned both rows with
`rows_written: 0` and `changes: 0`.

## Gaps — what this record does NOT establish

These are stated rather than omitted. None were worked around.

1. **Independent verification did not complete for Lane A.** The verifier subagent terminated on a
   session rate limit before producing a report. The Lane A findings above were reproduced by the
   lane lead, who did not author the code but is not an independent verifier. Truth state of
   "Lane A independently verified": `unknown`.
2. **The Lane C adversarial pass did not run.** Its subagent terminated on the same rate limit having
   committed nothing. Lane C has had no adversarial review. In particular, the dangerous parity
   direction — local refuses but Cloudflare accepts — has not been searched. Truth state: `unknown`.
3. **The Lane D adversarial pass was interrupted.** Its uncommitted work was reviewed, validated and
   committed by the lane lead. That is weaker than independent adversarial review.
4. **Lanes C and D are not wired into the Worker.** `worker.mjs` is owned by Lane A, so
   `eligibility.mjs` and `media-verify.mjs` are not imported and therefore do not appear in the
   dry-run bundle (Lane C and D bundles are 2.07 KiB, unchanged from baseline; Lane A is 169.06 KiB).
   Their dry-runs prove the lanes do not break deployment, not that those modules bundle. Wiring them
   is integration work.
5. **No live R2 or live Worker verification.** No Cloudflare credentials are present in this
   environment. All R2 evidence is from in-memory stubs.
6. **Integration was not performed and `cf-runtime-integration` was not advanced.** Lane B
   (issue #9, D1 publication lease and concurrency safety) is first in the required integration order
   and was not in this session's charter. Integrating without it would violate the milestone rule
   against integrating unfinished candidates.

## Authority boundary after this milestone — unchanged

Local systemd remains the sole publication authority. Cloudflare remains non-authoritative: no cron,
no X credentials, no live publication path, D1 and R2 access read-only. No lane changed
`deploy/`, `src/cli.mjs` publication paths, or `wrangler.jsonc`.

## Next action

One named, dependency-ready next action: **complete Lane B (issue #9)**, then re-run the adversarial
and independent-verification passes for lanes A and C against their exact candidate SHAs before any
integration is attempted.

Decision required from the owner: none for this milestone. Nothing here transfers authority, and
none of the three lane branches should be merged until the gaps above are closed.
