<!-- derived from lessons/2026-10-17-xqueue-timeout-without-cancellation.md | record status: verified | gate: passed 2026-10-17 -->
<!-- DRAFT in queue post format. A901 is a placeholder ID; numbering and queue insertion are Patrick's. -->
<!-- A67 and C5 already teach secondary risk, so this post calls back to the concept rather than re-teaching it. -->
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

It's secondary risk again: the fix for one problem quietly
made another. The cancel has to reach the work, not just
the person who was waiting.
```
