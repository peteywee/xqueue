<!-- derived from lessons/2026-10-17-xqueue-green-suite-untested-controls.md | record status: verified | gate: passed 2026-10-17 -->
<!-- DRAFT. Not published. Internal file names, hostnames and storage names are deliberately left out. Note: the repo is public as of 2026-10-17, although its README says it should be private. -->

# My test suite was green. The code that starts every publish run had barely been run.

The scheduler that posts to my X account had a clean bill of health. The full
gate passed: 1,295 tests, every boundary audit green, every CI job green.
Green is very easy to read as "tested."

So I had an AI coding agent audit the repository, with one instruction: don't
invent work, shore up what's there, and make the improvement measurable. The
first thing it did was ask a different question. Not "do the tests pass?" but
"what code do the tests actually run?"

## Measuring what runs

Node can tell you which lines executed during a test run:

```bash
node --test --experimental-test-coverage test/*.test.mjs
```

Three gaps stood out because of what that code does:

| What it is | Lines executed under test |
|---|---|
| The scheduled entry point that starts every publishing run | 8.79% |
| The adapter for the paid model API used to draft posts | never loaded |
| The check that re-reads an image's bytes before upload | never executed |

The entry point was the one that bothered me. It runs every fifteen minutes in
production. It decides whether publishing is even allowed, records a
heartbeat, and turns any unexpected crash into a safe "stop, don't retry"
result. The tests that mentioned it only inspected it from the outside: its
text, its file path, its fingerprint. Nothing had ever run it.

The image check matters for a different reason. The storage layer reports its
own checksum for each file, and an earlier design decision trusts that report
without reading the bytes. That trust was written down deliberately, with a
test pinning it. The thing that makes it safe is a second check: right before
an image goes to X, the publisher reads the actual bytes and hashes them again.
That second check had never executed in any test.

## What I got wrong first

Coverage said those lines never ran, so the obvious conclusion was that the
old suite was blind. Delete the second check and nothing would notice.

That turned out to be wrong, and the way it was wrong is the useful part.

The agent tested it directly: delete the re-hash, run the old suite. One test
failed. The repo has a tripwire that fingerprints the entire publisher (every
file it imports) and fails if a single byte changes. It exists so that
publisher changes get a deliberate review.

But a fingerprint answers "did this change?" It does not answer "does this
still work?" And its failure message tells you exactly what to do next:
re-evaluate, then record the new fingerprint.

So we did that too: deleted the safety check, recorded the new fingerprint,
and ran the old suite again. **Every test passed with the safety check
gone.**

The suite protected the check's bytes. It never protected its behavior.

## The name for this

Deliberately breaking code to see whether the tests notice is called mutation
testing, or mutation analysis. My repo already used it in one subsystem, but I
had not pointed it at the publisher. Coverage tells you what ran. Mutation
tells you whether anything would notice if it were wrong. You need both:
coverage found this gap, and mutation showed exactly what the existing
tripwire did and did not cover.

## The fix

The publisher code is frozen and fingerprinted, so the fix could not touch it.
It had to be tests.

New tests now run the entry point for real:
- publishing switched off (writes the heartbeat and nothing else)
- a failed heartbeat write (reported, no crash)
- a missing schedule time (stays idle)
- an unexpected exception (becomes a safe stop with retry off)

Other tests drive the image check with a storage fake that lies. It reports
the honest checksum while holding different bytes of the same length. The
check catches it, and no bytes are handed on for upload.

Coverage on the entry point went from 8.79% to 100% of lines. The publisher
went from 77% to 88%. Before merge, an independent review of the change found
three places where the new tests claimed more than they checked. Those got
fixed too.

The agent also broke the code on purpose, aiming to see every new test fail at
least once. The first pass fell short. Ten breaks were all caught, but five of
the twelve tests had never failed on their own, and the change description
said "each test" anyway. After merge, a review of this write-up caught that.
Five more breaks, one per remaining test, closed it. A test you have never
seen fail hasn't proven anything yet, and that includes the claim that it has.

## What I still don't know

- The publisher still has roughly 12% of its lines untested, and another file
  sits at 49% branch coverage. Coverage measures execution, not correctness.
- The breaks were hand-picked: fifteen across the two publisher files. A
  systematic mutation run might find more gaps.
- I don't know how long the gap existed. The history available when this was
  found didn't reach back far enough to say.

## The rule now

A safety control isn't "tested" until a test fails when the control is
removed. For every new control, record one deliberate break that the suite
catches.

A fingerprint tripwire is a change detector, not a behavior test. Re-recording
one now requires a behavior test that covers the changed code to pass first.
