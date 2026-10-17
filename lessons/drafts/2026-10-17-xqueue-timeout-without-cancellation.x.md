<!-- derived from lessons/2026-10-17-xqueue-timeout-without-cancellation.md | record status: verified | gate: passed 2026-10-17 -->
<!-- DRAFT in queue post format. A901 is a placeholder ID; numbering and queue insertion are Patrick's. -->
<!-- Patrick to confirm: the voided-ticket analogy is an analogy, not an event. Check that it rings true on a real line. -->

**A901 · Stopping the wait is not stopping the work**
```
A timeout that stops waiting is not a timeout that stops
the work.

An audit of my own software turned this up. After 30
seconds it gave up on a request and reported a timeout. The
request kept running. Nothing had told it to stop.

Same thing on a line. A server voids a ticket, the void
never reaches the window, and the cook fires it anyway.

Project management calls this a secondary risk: a new risk
created by your response to the first one. The fix is the
same in both places. The cancel has to reach the work, not
just the person who was waiting.
```
