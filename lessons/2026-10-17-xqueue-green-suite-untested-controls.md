---
id: 2026-10-17-xqueue-green-suite-untested-controls
type: win                # a latent gap found and closed before it mattered
project: xqueue
date_occurred: 2026-10-17   # date found; when the gap began is unknown (predates the shallow clone)
date_recorded: 2026-10-17
status: verified
root_cause_state: verified
evidence:
  repo: xqueue
  branch: main
  head_sha: d7a8cab471e60e98b07081ab304374826418933d   # merge of PR #174; tree identical to reviewed head c48ca66
  runtime: "Node 22.22.0 (local container), GitHub Actions ubuntu-24.04 (CI)"
  artifact: "test/cloudflare-publisher-worker-entry.test.mjs, test/cloudflare-production-publisher-media.test.mjs"
  observed_at: 2026-10-17   # exact minute of the coverage run was not recorded
negative_test: yes
concept:
  name: Mutation testing (mutation analysis)
  source: external
  citation: "Wikipedia, 'Mutation testing' (summary read 2026-10-17). Primary source cited there, not read: DeMillo, Lipton & Sayward, 'Hints on test data selection: Help for the practicing programmer', IEEE Computer 11(4):34-41, 1978."
  known_to_me: partial      # inferred: the repo already runs 'mutation analysis' (test/autonomy/mutation.test.mjs). Patrick to confirm.
  name_state: verified
pillar: D                  # the transferable part is how the gap was found and proven
publish_state: drafted
blocked_by: null
supersedes: null
superseded_by: null
---

## 1. What happened

On 2026-10-17, `main` @ `2f22956` passed its full gate: `pnpm verify` exit 0,
1,295/1,295 tests, authority boundary 28/28, credential boundary intact. An
audit measured which code those tests actually execute
(`node --test --experimental-test-coverage`):

- `cloudflare/src/publisher-worker.mjs`, the scheduled entry point that starts
  every production publishing run (cron `*/15 * * * *` in
  `wrangler.authority.jsonc`): **8.79%** of lines executed. Its three
  runtime branches (authority disabled, success, unhandled error) never ran.
  The tests that referenced it inspected it statically:
  - source-text regexes (`credential-separation.test.mjs`)
  - its config `main` path (`deployment-config-preservation.test.mjs`)
  - the publisher module-graph digest (`production-intake-launch.test.mjs`)

  None of them executed it.
- `prepareSelectedMedia` in `cloudflare/src/production-publisher.mjs`, the
  check that re-reads a figure's bytes and re-verifies size and SHA-256 before
  upload: never executed (lines 145-213 uncovered). It was exported for
  testing (`productionPublisherInternals`) and nothing used the export. This
  check is the compensating control for a deliberate, test-pinned trust
  assumption in `media-verify.mjs`: an R2-asserted checksum is believed without
  the bytes being read.
- `src/authoring/providers/openai.mjs`: never loaded by any test.

## 2. What I expected instead

**Repo-declared:** the README describes `test/` as a "node:test suite
including failure-path hardening tests", and every gate was green. A reasonable
reading is that the production publishing path was exercised.

**Patrick's own belief before the audit:** `unknown`. Not yet asked.

## 3. Impact

No incident. Nothing broke, and the untested code turned out to be correct
when tested. The exposure was future: a later edit could weaken these controls
without any behavior test noticing (see section 7). What contained it: a
coverage measurement during an owner-requested hardening audit. No incident
prompted it. The instruction was to "shore up and quantifiably improve" the
repo without inventing code, and the audit was carried out by an AI coding
agent (Claude Code).

## 4. Diagnosis

**Symptom chain:** the gate was green → coverage showed the entry point and
the media check never ran → mutation (deliberately breaking each check)
showed what the suite would and would not notice.

**What I first believed, and why it was wrong:** that the pre-existing suite
was *blind* to removing the media check, because coverage proved those lines
never ran. That was wrong. With the body re-hash deleted, exactly one old test
failed: `publisher code is unchanged since the mutex pin, or the pin must be
re-evaluated`. That test hashes the publisher's whole module graph and fails
on *any* byte change, so that a publisher change forces the mutex-compatibility
pin to be re-evaluated in the same change. The coverage evidence was real; the conclusion drawn
from it skipped a check that doesn't need to execute code to fail.

**Root cause** (verified): the suite guarded these controls' *bytes*, not
their *behavior*. The digest test detects change. Its own failure message
tells you to re-record the digest, and after that (tested, see section 7) the
suite passes with the safety check deleted.

## 5. The professional concept

**Mutation testing (mutation analysis):** deliberately introducing small
faults into code to evaluate whether the tests detect them. It is used to
"design new software tests" and "evaluate the quality of existing software
tests" (Wikipedia summary). Coverage answers *what ran*; mutation answers
*whether anything would notice if it were wrong*. Both were needed here:
coverage found the gap, and mutation showed exactly what the existing
tripwire did and did not protect.

Not used, and why: "change-detector test" (Google Testing Blog, 2015)
describes the digest pin's mechanism, but the post body could not be read
this session, so its definition is unverified. "Design vs. operating
effectiveness" of a control (auditing) is a likely management-side name, but
it is not defined in *The Whole Degree* (Ch. 7 mentions Sarbanes-Oxley
internal control assessment only), and the PCAOB source returned 403. Both
are left unnamed rather than guessed.

## 6. The fix

Tests only. No production publisher code changed, because that code is
content-pinned and governed by the 1.1.0 freeze criterion.

- `test/cloudflare-publisher-worker-entry.test.mjs`: runs `scheduled()` for
  disabled authority (writes the heartbeat only), heartbeat failure (reported,
  no throw), missing scheduled time (`invalid_now`), and an escaping exception
  (`failed_closed`, `automaticRetryAllowed: false`).
- `test/cloudflare-production-publisher-media.test.mjs`: impostor bytes
  behind an R2-asserted checksum, size mismatch, missing body, row-binding
  refusals, surfaced verifier reasons, and the honest path.

Merged in PR #174 (`c48ca66` → `main` `d7a8cab`).

## 7. Verification

**Positive test:** `pnpm verify` exit 0, 1,317/1,317 tests. CI green on
`c48ca66` and on `main` `d7a8cab`. Coverage after the change:
`publisher-worker.mjs` 8.79% → 100% lines; `production-publisher.mjs`
77.32% → 88.37%.

**Negative test:**
- Before merge: 10 deliberate breaks (5 media, 5 entry point), each caught by
  at least one new test. That left 5 of the 12 new publisher tests never
  individually seen to fail, yet commit `5515d70` said "each test" for these
  files, and the #174 description said "each new test" across all three
  files. Both were overclaims, found by review of this record. (For the
  adapter half, see the companion timeout record.)
- Closed after merge (2026-10-17): 5 more breaks, one per remaining test:
  media no-figure, missing snapshot, missing body, honest bytes, and entry
  invalid time. The last was made in `production-publisher.mjs`, where the
  `invalid_now` guard lives. Each was caught by exactly its intended test.
  All 12 new publisher tests have now been seen to fail.
- Counterfactual on the *old* suite (117 files, the new test files excluded):
  - body re-hash deleted → 1 failure, the digest pin
  - entry point made to rethrow → 1 failure, the digest pin
- Body re-hash deleted **and** the pin re-recorded → old suite **1297/1297
  pass**. The new tests fail on the same mutant with or without the pin.
  (1297, not 1295, because the "old" set included `authoring-provider.test.mjs`,
  which gained two unrelated timeout tests in the same PR.)
- All sabotage was restored from git; the tree was confirmed clean afterwards.

**Independent review:** `/code-review` (high) of the PR found no high-severity
bug. It found three of the new tests' assertions claiming more than they
checked, and those were fixed before merge (`c48ca66`).

## 8. Residual risk and unknowns

- `production-publisher.mjs` is still 11.63% uncovered, and
  `publication-ledger.mjs` sits at 49% branch coverage (mostly input guards).
  Coverage measures execution, not correctness.
- In-process coverage undercounts scripts that tests spawn with a custom
  environment, so script-level numbers are low-bound only.
- When the gap began is unknown (beyond the shallow clone).
- Mutation here was hand-picked, not systematic. There were 15 breaks across
  the two publisher files: `production-publisher.mjs` (10) and
  `publisher-worker.mjs` (5). The adapter's breaks belong to the companion
  timeout record. Faults outside these breaks may survive the suite.

## 9. Policy or control extracted

1. A safety control is not "tested" until a test fails when the control is
   removed. For each new control, record one mutant that the suite kills.
2. A content-digest tripwire is a change detector, not a behavior test.
   Re-recording a pin requires a behavior test that covers the changed code
   to pass first.
3. When adding a test-only export (such as `productionPublisherInternals`),
   add the test that uses it in the same change.

## 10. Where else this applies

- **xqueue:** any *runtime* behavior whose only test inspects source text or
  a hash. Static properties are different: the credential-separation regex
  tests check what a module imports, and source inspection is the right tool
  for that.
- **TOS / Teach:** governance gates that verify a document or config exists
  rather than that its rule fires.
- **Kitchen:** a probe thermometer that is stored, logged and never
  calibrated. Its presence is checked; its accuracy is not.

## 11. Content hooks

- Hook: the suite was green, and the code that starts every publishing run
  had 8.79% of its lines executed.
- Counterintuitive part: the old suite *did* fail when the check was deleted.
  It just failed for the wrong reason, and its own message told you how to
  make it pass.
- Must redact: Worker hostnames, D1/R2 names, the X account handle, and the
  publisher's internal file paths in posts. The storage checksum trust detail
  stays generic in posts.
- Repo visibility: the README says the repo "should remain private", but
  GitHub reports it **public** (checked 2026-10-17). This record and
  everything else in the repo are publicly readable. The trust detail is
  already public in the code's own comments. Whether to make the repo
  private is the owner's decision.

**Counterfactual** (win record): without the new tests, deleting the media
body re-hash and re-recording the publisher digest leaves the suite at
1297/1297 green. Verified 2026-10-17.

**Non-obvious constraint:** the publisher code was frozen and content-pinned,
so the fix could not touch it. Tests were the only lever.
