# XQ-POL-001 — Authority, Liveness, Readiness, and Eligibility

Status: Proposed
Owner: Top Shelf Service / xqueue owner
Source: Production incident #56; implementation tracker #58

## Policy

xqueue MUST represent the following as distinct operational facts:

- **authority** — which publisher is permitted to create external publication side effects;
- **liveness** — whether the authorized scheduler is actually invoking within its expected cadence;
- **readiness** — whether required dependencies and integrity gates are healthy;
- **eligibility** — whether policy currently permits a particular publication action.

No one fact may be silently inferred from another.

In particular:

1. Authority readiness MUST NOT be presented as proof of scheduler liveness.
2. Eligibility failure MUST NOT silently revoke or redefine durable authority ownership.
3. Scheduler liveness MUST be backed by durable or independently observable invocation evidence.
4. Unknown/stale liveness MUST be reported as unknown/failed rather than healthy.
5. The liveness-control path MUST be structurally incapable of publishing.

## Required controls

Implementation is tracked by #58 and the durable authority work referenced by #46/#59.

## Failure behavior

When authority is conflicting or unknown, publication fails closed. When liveness is unknown or stale, health must say so explicitly; it must not fabricate scheduler proof.
