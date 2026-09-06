# Changelog

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
