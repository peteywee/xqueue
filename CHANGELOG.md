# Changelog

## 1.1.0 — 2026-09-06

Final engineering closeout release for the production-governed XQueue baseline.

### Material reliability improvements

- Production deployment now has exactly one D1 identity: both the ordinary Workers Builds config and explicit authority config target `xqueue-production` plus the production D1 only, while preview D1 access is isolated behind explicit `wrangler.preview.jsonc`. Production configs contain zero `preview_database_id` or preview D1 IDs, and ordinary deployment declares zero scheduler mutations.
- Production scheduler liveness is now durable and independently observable. Each scheduled invocation records a D1 heartbeat; `/health` reports freshness, expected-next timing, and stale state; the TSAL runtime collector fails if scheduler authority is expected but the heartbeat is missing or older than three 15-minute cycles.
- The hourly TSAL observer opens one deduplicated GitHub incident when scheduled conformance fails and closes it after recovery.
- Durable publication outcome persistence now preserves all classifier semantics: `confirmed_posted`, `confirmed_not_posted`, and `needs_reconciliation` remain distinct at the D1 state/event boundary.
- Exact-candidate TSAL evidence includes environment-isolation, scheduler-liveness, and outcome-fidelity regression tests.

### Freeze criterion

After production authority deployment and a fresh 14/14 TSAL audit of the exact 1.1.0 merge candidate, XQueue is considered feature-frozen. Future changes require a real incident, a failed conformance/monitoring gate, or a deliberately approved business requirement.

## 1.0.0 — 2026-09-06

First production-governed XQueue baseline.

### Included

- Deterministic 180-post content queue and production schedule validation.
- Fail-closed X publication path with explicit runtime authority.
- Maximum one publication per live execution.
- Durable intent/evidence handling and explicit reconciliation for ambiguous X outcomes.
- Cloudflare D1 lease/fencing and publication-ledger controls.
- Production media integrity validation.
- TSAL 0.3.2 project manifest, automation contract, evidence collection, and conformance workflow.
- Read-only runtime and Cloudflare deployment evidence collectors.
- External-state preservation controls preventing ordinary deployments from deleting scheduler authority.
- Regression coverage for destructive empty Cron configuration and authority/deployment drift.

### Release standard

The repository `VERSION` file and `package.json` version must match. Release acceptance requires native XQueue verification plus a fresh TSAL audit of the exact released candidate and current external production state.

## 0.0.1 — 2026-08-31

Historical early repository release. Superseded by the 1.0.0 production-governed baseline.
