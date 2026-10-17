<!-- derived from lessons/2026-10-17-xqueue-green-suite-untested-controls.md | record status: verified | gate: passed 2026-10-17 -->
<!-- DRAFT in queue post format. D901 is a placeholder ID; numbering and queue insertion are Patrick's. -->

**D901 · Green is not tested**
```
My test suite was green. 1,295 tests passing. The code that
starts every publishing run had 8.79% of its lines executed.

I had an AI coding agent measure it, then break a safety
check on purpose to see what would notice.

One test failed, but only because a file fingerprint
changed. Update the fingerprint, which is what that test
tells you to do, and everything passes with the check gone.

That method has a name: mutation testing. Break the code on
purpose. If no test fails, it was never really tested.
```
