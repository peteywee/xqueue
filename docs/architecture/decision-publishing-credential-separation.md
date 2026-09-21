# Decision: Structural publishing credential separation

Status: **approved by owner on 2026-09-21**

Issue: #45  
Decision scope: AUTH-5 / OQ-AUTH-6

## Target production topology

XQueue has two Cloudflare Worker roles.

### Status Worker

Worker identity: `xqueue-production`

Target entrypoint: `cloudflare/src/status-worker.mjs`

Responsibilities:
- HTTP health/readiness;
- read-only D1/R2 inspection required for status;
- no scheduled handler;
- no import path to the X publisher;
- no X write credentials;
- no service binding or other invocation path to the publisher.

### Publisher Worker

Worker identity: `xqueue-publisher-production`

Entrypoint: `cloudflare/src/publisher-worker.mjs`

Responsibilities:
- Cloudflare Cron scheduled entry only;
- single route into `runScheduledPublication`;
- sole Cloudflare deployment eligible to receive X write credentials;
- same canonical D1 and R2 resources required for publication truth;
- existing runtime authority, halt, lease, assignment, fence, and reconciliation checks remain mandatory.

The publisher Worker has no normal HTTP publication route.

## Configuration surfaces

- `wrangler.status.jsonc`: target status-only production deployment; no triggers.
- `wrangler.publisher.jsonc`: inert publisher deployment; no triggers.
- `wrangler.authority.jsonc`: publisher authority activation surface; exactly one 15-minute cron.
- `wrangler.jsonc`: legacy compatibility descriptor retained unchanged until #46 so merging #45 does not change the currently deployed production entrypoint.
- `wrangler.preview.jsonc`: existing non-authoritative preview surface.

## Credential rule

X write secrets belong only to `xqueue-publisher-production`.

The status-only module graph must not contain X credential names, X SDK imports, transport calls, the production publisher, or any scheduled handler.

## Activation boundary

#45 creates and proves the structural boundary in repository artifacts. It does **not** deploy the new publisher, move production secrets, replace the current production entrypoint, activate the cron, or retire local/systemd rollback.

Those control-plane actions are reserved for the exact-candidate #46 cutover. Before activation, #46 must independently verify secret inventory and prove that `xqueue-production` has no X write secrets and `xqueue-publisher-production` is the only Cloudflare deployment that does.
