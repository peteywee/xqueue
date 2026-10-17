<!-- derived from lessons/2026-10-17-xqueue-timeout-without-cancellation.md | record status: verified | gate: passed 2026-10-17 -->
<!-- DRAFT in queue post format. A901 is a placeholder ID; numbering and queue insertion are Patrick's. -->
<!-- Self-contained on purpose: queued A67 (2026-11-12) and C5 (2026-11-10) cover the same concept but are not yet published, so this post cannot assume the reader has seen them. Placing it away from them avoids repetition; that call is Patrick's. -->
<!-- Patrick to confirm: the voided-ticket line is an analogy, not an event. Check that it rings true on a real line. -->

**A901 · Stopping the wait is not stopping the work**
```
A timeout that stops waiting is not a timeout that stops
the work.

An audit of my own software found one. When it fired, the
tool reported a timeout and moved on. Nothing told the
request to stop, so it kept running. I reproduced it on
purpose. I don't know if it ever happened for real.

Same shape on a line. A server voids a ticket, the void
never reaches the window, and the cook fires it anyway.

Project management calls this a secondary risk: a new risk
created by your response to the first one. The cancel has
to reach the work, not just the person who was waiting.
```
