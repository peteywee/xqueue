# Incident: Cloudflare production cron drift — 2026-09-06

## Summary

TSAL deployment evidence detected that the production Worker `xqueue-production` had no Cloudflare Cron Triggers even though repository authority policy expected exactly `*/15 * * * *` and the deployed Worker health surface reported scheduler/publication authority as enabled.

The incident was discovered by independent deployment-state reconciliation rather than by the repository test suite or runtime health alone.

## Expected state

- Worker: `xqueue-production`
- Authority config: `wrangler.authority.jsonc`
- Cloudflare Cron Triggers: exactly one trigger, `*/15 * * * *`
- Runtime authority health: enabled and healthy
- TSAL deployment-authority evidence: PASS

## Observed state

The 2026-09-06 TSAL conformance run reached Cloudflare successfully with read-only credentials and observed:

- production runtime health: PASS
- Cloudflare schedules API: `[]`
- deployment collector observation errors: none
- deployment-authority failing check: `exact_cron`
- TSAL conformance: 13 PROVEN / 1 BLOCKING

The blocking claim was `xqueue-publisher.deployment.authority`.

## Containment

No scheduler mutation was performed while diagnosing the mismatch. The workflow was first changed so runtime/deployment evidence artifacts survive a BLOCKING audit, allowing the authoritative Cloudflare observation to be inspected without weakening the conformance gate.

## Contributing configuration hazard

The repository had two Wrangler configurations targeting the same production Worker and storage:

- `wrangler.authority.jsonc` explicitly declared `triggers.crons = ["*/15 * * * *"]`.
- `wrangler.jsonc` explicitly declared `triggers.crons = []`.

For a provider whose deployment semantics replace external scheduler state, an explicit empty list is a destructive mutation, not a neutral representation of "no authority change".

The exact historical deployment invocation that removed the trigger is not established by this incident record. The repository configuration nevertheless contained a path capable of deleting scheduler authority during an otherwise ordinary deployment and therefore required removal.

## Root lesson

Absence and preservation are not equivalent.

A deployment path that is not authorized to change external control-plane state must omit that control-plane field rather than encode an empty/null/default value whose provider semantics may mean delete, reset, revoke, or replace.

## Corrective actions

1. Remove `triggers` entirely from ordinary `wrangler.jsonc` so normal code deploys do not express scheduler intent.
2. Keep scheduler authority explicit and isolated in `wrangler.authority.jsonc`.
3. Add regression tests that fail if ordinary configuration declares scheduler state, including `crons: []`.
4. Continue post-deploy TSAL reconciliation against Cloudflare control-plane state.
5. Restore the live `*/15 * * * *` trigger only through the explicit authority deployment path.
6. Promote the generalized lesson into TSAL policy as external-state preservation / destructive-absence semantics.

## Resume gate

The incident is not fully closed until independent TSAL evidence reports:

- runtime.safe: PROVEN
- deployment.authority: PROVEN
- overall conformance: PROVEN
- 14 PROVEN / 0 PARTIAL / 0 UNPROVEN / 0 BLOCKING

## Standard promotion

Promote to TSAL 0.3.2:

> Non-authoritative deployment paths MUST preserve external authority state. Empty, null, default, or omission-like configuration values MUST be treated as potentially destructive until provider replacement semantics are explicitly understood. Authority-changing configuration requires an explicit controlled path, and deployment completion requires independent reconciliation with authoritative external state.
