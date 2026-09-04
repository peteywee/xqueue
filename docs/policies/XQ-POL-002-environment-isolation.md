# XQ-POL-002 — Environment Isolation

Status: Proposed
Owner: Top Shelf Service / xqueue owner
Source: Production incident #56

## Purpose

Prevent preview and production resource identity from coexisting in a deployment configuration capable of changing the production publisher.

## Policy

1. A production deployment configuration MUST reference the production Worker and production D1 database only.
2. A production deployment configuration MUST NOT contain `preview_database_id` or the preview D1 name/ID.
3. The production publication cron MUST be explicit and exact.
4. The default Wrangler configuration MUST be non-production and MUST NOT register publication cron triggers.
5. Preview configuration MUST NOT reference the production D1 database.
6. Environment configuration MUST be machine-verified before repository verification can pass.
7. A configuration that is ambiguous, missing required identity, or contains conflicting environment identity MUST fail closed.

## Required controls

- `wrangler.authority.jsonc` is production-only.
- `wrangler.jsonc` is preview-safe and inert with respect to scheduled publication.
- `scripts/verify-environment-config.mjs` validates pinned Worker/D1 identities and cron policy.
- `test/environment-config.test.mjs` negatively tests cross-environment identity and cron drift.
- `pnpm verify` runs the environment verifier before the full test suite.

## Required evidence

For any candidate that changes Wrangler configuration:

- exact candidate SHA;
- `pnpm verify:environment-config` PASS;
- negative environment-config tests PASS;
- deployment output proving the intended Worker name and cron configuration;
- production health proving canonical queue/D1 agreement after deployment.

## Failure behavior

If environment identity is unknown, conflicting, or ambiguous, deployment/promotion MUST stop. Do not infer the intended target.

## Review triggers

Review this policy when:

- a Cloudflare binding changes;
- a new environment is introduced;
- deployment tooling changes;
- an incident involves resource targeting, configuration drift, or authority ambiguity.
