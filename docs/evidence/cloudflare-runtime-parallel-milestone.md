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
Lanes executed by this session: A (issue #8), C (issue #10), D (issue #11)
Lane B (issue #9) was delivered outside this session, then verified and integrated here.
Integration candidate: `150f8bb260bf6247fd57a4aa59628217a7c8b037`.

Every row below carries a truth state. `verified` means a command was run at the stated SHA in this
session and its output observed. `unknown` means it was not established — it is never inferred.

## Exact lane candidates

| Lane | Branch | Candidate SHA | Truth state |
|---|---|---|---|
| B — D1 publication lease + concurrency | `cf-runtime-lease` | `d55cb37a78b3814af6975f4995c691d0cc5be903` | verified |
| A — queue bundle + hash parity | `cf-runtime-bundle-hash` | `43464e119dfe03ce44a5155219367d31de5e4fd9` | verified |
| C — read-only eligibility parity | `cf-runtime-eligibility` | `f298d1ffa8f2c514cb74ea0dc4113610c1205925` | verified |
| D — R2 media inventory + parity | `cf-runtime-media` | `9a73b2a403c21cfbcf2415e88ba47504a2091295` | verified |
| Integration | `cf-runtime-integration` | `150f8bb260bf6247fd57a4aa59628217a7c8b037` | verified |

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


## Lane B — D1 publication lease + concurrency (`d55cb37`)

Delivered outside this session and verified here before integration. Adds three files and touches no
other lane's files: `cloudflare/migrations/0003_publication_lease.sql`,
`cloudflare/src/publication-lease.mjs`, `test/cloudflare-publication-lease.test.mjs`.

| Evidence | Result | Truth state |
|---|---|---|
| Repository tests | 105 pass, 0 fail | verified |
| `node:` imports in lease module | 0 | verified |
| Write targets | `publication_leases` only; ledger tables never referenced | verified |
| X / publication surface in lease module | none | verified |
| Authority gates | 11/11 intact | verified |
| Migration applied to any D1 database | **unknown** — not applied by this session | unknown |
| Independent adversarial re-test by this session | **unknown** — not performed | unknown |

Concurrency gates covered by name in its suite: one winner; same-timestamp contenders still produce one
winner; an active lease cannot be stolen before expiry; stale takeover allowed exactly at expiry and
fences the old handle; wrong owner and wrong acquisition handle cannot release; an acquisition ID can
never be granted again across generations; a replayed acquisition ID on expired takeover is rejected.

## Integration (`150f8bb`)

Merged in the charter's required order — B, A, C, D. All four merges were clean; no conflict
resolution was required, because the lanes own disjoint files.

| Evidence | Result | Truth state |
|---|---|---|
| Repository tests | 242 pass, 0 fail | verified |
| Test arithmetic | 94 baseline + 55 A + 38 C + 44 D + 11 B = 242 — nothing lost or duplicated | verified |
| Authority gates | 11/11 intact | verified |
| Wrangler dry-run | exit 0; 169.06 KiB, gzip 45.17 KiB; bindings D1 + R2 only; zero cron mentions | verified |
| `wrangler.jsonc` `triggers.crons` | `[]`, count 0 | verified |
| Queue bundle regeneration | byte-identical | verified |
| Media requirements regeneration | byte-identical | verified |
| Eligibility parity matrix | 32/32 PASS, exit 0, committed artifact byte-fresh | verified |
| Queue integrity vs real D1 sha | `ok: true`, 180/180, exact deferred tail | verified |
| Media manifest with empty `media/` | exit 1, nothing written | verified |
| `package.json` after merge | all five lane scripts present; `post:live` intact | verified |

A clean merge was not treated as a correct merge: `package.json` was checked semantically to confirm
every lane's added script survived and that `post:live` was unchanged.

## Authority boundary

`scripts/authority-boundary-audit.mjs` asserts eleven properties mechanically. Result at baseline, at
each lane candidate, and at the integrated candidate: **all gates passed**, truth state `verified`.
(The audit was ten gates until the D1 rule was split in two; see below.)

| Gate | Result |
|---|---|
| Cloudflare cron trigger count is 0 | PASS |
| No X credential surface in `cloudflare/` | PASS |
| No `vars` or secret bindings in `wrangler.jsonc` | PASS |
| No X publication call in `cloudflare/src/` | PASS |
| No D1 write to the publication ledger | PASS |
| D1 writes confined to lease tables | PASS |
| No R2 mutation in `cloudflare/src/` | PASS |
| systemd unit still runs `post:live` | PASS |
| `package.json` still defines `post:live` | PASS |
| `queue.json` / `state.json` / `.env` untracked | PASS |
| No media binaries tracked | PASS |

The `tweet_id` occurrences in `cloudflare/migrations/` are D1 mirror column names, not a publication
path; the call-surface gate is scoped to Worker source deliberately.

### One deliberate change to the D1 gate, made during integration

The audit originally asserted a blanket *no D1 write statement in `cloudflare/src/`*. That was
calibrated for the three read-only lanes and would have failed lane B's publication lease, which
legitimately writes.

The real invariant is not that the Worker never writes D1 — a lease row records who may **attempt**,
never what was published. It is that the Worker never writes the publication ledger. The gate now
names the tables: `publication_state`, `publication_events` and `runtime_metadata` are forbidden write
targets, and any write must land in a lease table.

This is more precise rather than weaker, and that was proven rather than asserted: an injected
`UPDATE publication_state` and an injected write to an unrelated table each still break the audit with
exit 1. Lane B writes only `publication_leases` (plus trigger-written audit rows into
`publication_lease_events`) and never references the ledger tables or any X surface.

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
6. **Lane B was verified but not independently adversarially re-tested here.** Its own suite covers
   the concurrency gates by name, and this session confirmed its write targets, test result and
   authority compliance — but no adversarial pass was run against it in this session. Truth state:
   `unknown`.
7. **Migration `0003_publication_lease.sql` has not been applied to any D1 database** by this session.
   The lease is verified in tests against in-memory stubs only. Truth state of "lease works against
   real D1": `unknown`.
8. **Only Lane A's module is reachable from the deployed Worker.** `/health` calls
   `verifyQueueIntegrity`; `eligibility.mjs`, `media-verify.mjs` and `publication-lease.mjs` are not
   imported by `worker.mjs` and therefore are not in the deployed bundle. Wiring them is a later
   milestone, not this one.

## Authority boundary after this milestone — unchanged

Local systemd remains the sole publication authority. Cloudflare remains non-authoritative: no cron,
no X credentials, no live publication path, D1 and R2 access read-only. No lane changed
`deploy/`, `src/cli.mjs` publication paths, or `wrangler.jsonc`.

## Next action

One named, dependency-ready next action: **run the outstanding adversarial and independent
verification passes against the integrated candidate `150f8bb`** — specifically the Lane C adversarial
pass that never ran (hunting the direction where local refuses but Cloudflare accepts), and an
independent verifier for Lane A that did not complete. Both terminated on a session rate limit, not on
a technical blocker, so both are re-runnable as-is.

Decision required from the owner: none for this milestone. Nothing here transfers publication
authority. `cf-runtime-integration` must not be merged, must not become an authority-transfer
configuration, and no cron or X credential should be provisioned until the gaps above are closed and
the owner explicitly approves the next milestone.
