# Changelog

## 1.2.0 — 2026-09-15

Feature release adding the bounded XQueue Author pipeline while preserving the deterministic publication runtime and owner-reserved promotion authority.

### XQueue Author

- Added versioned contracts and deterministic authoring flow from source material through knowledge-unit distillation, candidate generation, validation, review, and promotion planning.
- Added provider-neutral bounded generation with an OpenAI adapter, prompt/version provenance, timeout/count/output budgets, and CI-safe operation without production model credentials.
- Added provenance, freshness, sensitivity, unsupported-claim, similarity, voice, and evidence-risk controls, plus privacy-safe generation telemetry.
- Added read-only Context Source ingestion and approved-only feedback contracts without creating a second scheduler, publication ledger, or direct draft-to-publish path.
- Added post, blog, and lesson promotion planning, including state-bound post promotion that refuses stale authoritative targets.

### Owner approval hardening

- Replaced owner-looking approval strings with detached Ed25519 owner authentication.
- Added a committed public verification trust root while keeping the encrypted production private signing key outside GitHub, CI, agents, repository state, and `.xqueue-author/`.
- Promotion re-verifies the exact signed approval payload before granting authority; repository/workspace access plus candidate digest is insufficient to manufacture owner approval.
- Added adversarial coverage for unsigned approvals, wrong keys, forged signatures, altered candidates, altered decisions/timestamps, and noncanonical payload bytes.

### Security and dependency hygiene

- Upgraded Wrangler to `4.131.0`, moving the Miniflare dependency graph to `sharp >= 0.35.4` and resolving the transitive Sharp security advisory tracked in #78.
- Retained production/preview authority separation, scheduler integrity controls, exact-candidate verification, and TSAL runtime/deployment evidence collection.

### Runtime boundary

This release does not introduce new scheduler behavior, D1 migrations, publication-ledger semantics, X publication behavior, or authoritative `content/*.md` changes. The immutable `1.1.0` tag/history remains unchanged.

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
