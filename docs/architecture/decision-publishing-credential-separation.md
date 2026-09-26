# Decision: Structural publishing credential separation

Status: **approved 2026-09-21; production-activated by #46 on 2026-09-26**

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

- `wrangler.status.jsonc`: target status-only production deployment; explicit `triggers.crons: []` removes any previously deployed cron during #46 cutover.
- `wrangler.publisher.jsonc`: inert publisher deployment; no triggers and explicit `XQUEUE_PUBLISH_AUTHORITY=disabled`.
- `wrangler.authority.jsonc`: publisher authority surface; production-safe migration lane, explicit `XQUEUE_PUBLISH_AUTHORITY=enabled`, exact Worker version metadata binding, and exactly one 15-minute cron.
- `wrangler.jsonc`: legacy compatibility descriptor; it is not routine publication authority after #46.
- `wrangler.preview.jsonc`: existing non-authoritative preview surface.

## Credential rule

X write secrets belong only to `xqueue-publisher-production`.

The status-only module graph must not contain X credential names, X SDK imports, transport calls, the production publisher, or any scheduled handler.

## Activated boundary

#46 completed the control-plane transition: `xqueue-production` is status-only and scheduler-free, X write secrets exist only on `xqueue-publisher-production`, and the publisher has the single routine Cron authority.

Post-cutover hardening requires every authority-capable Worker version to carry exact version metadata and a Git-SHA tag that matches durable D1 authority. Local/systemd is compatibility-only and must not regain routine production authority.
