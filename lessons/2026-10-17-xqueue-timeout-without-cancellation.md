---
id: 2026-10-17-xqueue-timeout-without-cancellation
type: failure            # latent defect in shipped code; no observed incident
project: xqueue
date_occurred: 2026-09-15   # inferred: shipped with 1.2.0 per CHANGELOG; introducing commit is beyond the shallow clone (first visible at 2cde1b2, 2026-09-21)
date_recorded: 2026-10-17
status: verified
root_cause_state: verified
evidence:
  repo: xqueue
  branch: main
  head_sha: d7a8cab471e60e98b07081ab304374826418933d   # fix merged in PR #174
  runtime: "Node 22.22.0 (local container); reproduction used an injected fetch, no network"
  artifact: "src/authoring/generation-provider.mjs, src/authoring/providers/openai.mjs"
  observed_at: 2026-10-17
negative_test: yes
concept:
  name: Secondary risk
  source: book
  citation: "Ch. 20 — Edwards, Managing Project Risks (2nd ed.), Wiley — MGMT440"
  known_to_me: partial      # inferred from Patrick's own compilation of MGMT440; Patrick to confirm
  name_state: verified
pillar: A                  # tells cleanly in kitchen terms; the code can be a footnote
publish_state: drafted
blocked_by: null
supersedes: null
superseded_by: null
---

## 1. What happened

`generateBoundedCandidates` (the authoring pipeline's bounded call to a model
provider) enforced `timeoutMs` (default 30,000 ms) with
`Promise.race([provider.generate(...), timeout])`. Reproduction with an
injected fetch, `timeoutMs = 200` and a request that takes 3 s:

| | caller rejected at | request aborted | process exited at |
|---|---|---|---|
| before | 202 ms, `generation_timeout` | no (no signal reached fetch) | 3,004 ms |
| after the fix | 202 ms, `generation_timeout` | yes | 203 ms |

## 2. What I expected instead

**Repo-declared:** CHANGELOG 1.2.0 describes "provider-neutral bounded
generation with … timeout/count/output budgets". A timeout budget reads as a
bound on the work, not only on the wait.

**Patrick's own belief before the audit:** `unknown`. Not yet asked.

## 3. Impact

- **Verified:** after a timeout, the HTTP request was not cancelled, and the
  CLI process stayed alive until the request finished on its own.
- **Unknown:** whether any live `author:generate` run ever hit the timeout.
  Failed generations write no telemetry (tracked in #175).
- **Unknown:** whether the provider billed for work after the client gave up.
  Billing behavior was not tested, and no claim is made.
- Blast radius: owner-local authoring CLI only. No publishing path uses this
  code, and no Worker bundle contains it (verified by dry-run bundle builds).

## 4. Diagnosis

**Symptom chain:** timeout fires → `Promise.race` settles with the timeout
error → the caller sees `generation_timeout` → nothing holds a handle to the
in-flight `fetch` → it keeps running, and its socket keeps the process alive.

**What I first believed, and why it was wrong:** the existing test
`provider timeout fails closed without producing a candidate` passed, which
made the timeout look correct. The test checked that the *caller* got an
error. It did not check that the *work* stopped. Its fake provider returned a
promise that never settles and holds no resources, so "abandoned" and
"cancelled" were indistinguishable in it.

**Root cause** (verified): a timeout that stops waiting is not a timeout that
stops work. JavaScript promises cannot be cancelled from outside. Stopping the
request requires passing a cancellation signal *into* the operation, and
nothing did.

## 5. The professional concept

**Secondary risk:** "a risk created by a risk response" (*The Whole Degree*,
Ch. 20, from Edwards, *Managing Project Risks*, MGMT440). The original risk
was a hung provider freezing the CLI. The response, a timeout, mitigated it,
and in doing so created a new risk that did not exist before: an abandoned
paid request still running, with its result thrown away.

The software mechanism for the fix is **cooperative cancellation**. Microsoft
Learn, *Cancellation in Managed Threads*: "Cancellation is cooperative and is
not forced on the listener … each listener is responsible for noticing the
request and responding to it." The race created no request to notice.

## 6. The fix

`src/authoring/generation-provider.mjs`: an `AbortController` is created per
call. When the timer fires, it rejects the race with `generation_timeout`,
then calls `abort.abort()`. `signal` is passed to the provider beside
`constraints`. `src/authoring/providers/openai.mjs` forwards `input.signal` to
`fetch`. 8 lines added and 1 removed across 2 files. The input digest and
candidate IDs are unchanged.

## 7. Verification

**Positive test:**
- The reproduction above: exit at 203 ms, request aborted.
- `pnpm verify` exit 0, 1,317/1,317 tests. CI green on `c48ca66` and on
  `main` `d7a8cab`.

**Negative test:**
- With both halves reverted, 3 regression tests fail:
  - `provider timeout aborts the provider request …`
  - `a provider that finishes in time is not aborted`
  - `a generation timeout cancels the in-flight OpenAI request`
- With only the wrapper fix (the adapter does not forward the signal), 1 still
  fails: the adapter-level test.
- Each half of the fix is therefore independently pinned.

## 8. Residual risk and unknowns

- Whether the provider stops generating, and stops billing, when the client
  aborts is **not verified**.
- A provider whose abort listener throws would crash the process. No real
  provider does this today (the only one hands the signal to `fetch`).
  Recorded in review, not fixed.
- Aborted generations still produce no usage or telemetry record (#175).
- This is the only `Promise.race` timeout in `src`, `scripts`, `cloudflare`
  and `probes`. The repo's other timeouts already use `AbortSignal.timeout`,
  which cancels.

## 9. Policy or control extracted

1. Every timeout around I/O passes a cancellation signal into the operation.
   `Promise.race` alone is not a timeout for work that holds resources.
2. A timeout test asserts that the operation *observed* cancellation, not
   only that the caller received an error.

## 10. Where else this applies

- **Teach / TOS:** any network call wrapped in a race or a deadline that the
  callee never sees.
- **Kitchen:** a server voids a ticket at the POS, but the void never reaches
  the line, so the cook still fires it. The person waiting stopped; the work
  did not. (This analogy is mine, not from an event; Patrick to confirm it
  rings true on a real line.)
- **Project work generally:** any mitigation whose side effect nobody owns,
  which is the textbook shape of secondary risk.

## 11. Content hooks

- Hook: a timeout that stops waiting is not a timeout that stops the work.
- Counterintuitive part: the test for the timeout passed, and it was testing
  the wrong thing.
- Must redact: the model ID and provider endpoint aren't secret but add
  nothing. Make no cost claim (unverified). Don't identify the X account
  handle or any Worker or storage names.
