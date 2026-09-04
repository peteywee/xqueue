# XQ-POL-001 — Authority, Liveness, Readiness, and Eligibility

Status: Proposed / implementation in draft PR #61
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
6. Heartbeat persistence failure MUST NOT manufacture publication authority or convert monitoring into a publication decision path.

## Required controls

- Production scheduled invocations persist a sanitized scheduler observation in D1 metadata.
- `/health` exposes `schedulerLiveness` separately from `publicationAuthority` and `authorityReadiness`.
- `schedulerAuthority` is true only when publication authority is valid AND durable liveness evidence is fresh.
- `xqueue-watchdog` is a separate Worker bundle with D1 only: no R2 media binding, X credentials, publication authority config, or publication imports.
- Watchdog alert/recovery state is provider-neutral and bounded: initial stale threshold 3 hours; re-notification no more frequently than 12 hours.
- Notification-provider selection remains owner-reserved under #58.

## Failure behavior

When authority is conflicting or unknown, publication fails closed. When liveness is unknown or stale, health says so explicitly and `schedulerAuthority` remains false. Monitoring failure does not gain publication capability.

## Required negative verification

- authority present + heartbeat absent => scheduler authority false;
- stale heartbeat => liveness stale;
- watchdog config with R2/X/publication capability => verification fail;
- watchdog source importing publication machinery => authority audit fail;
- alert path can emit a signal without dispatching a publication;
- recovery produces one recovery signal, then returns to silence.
