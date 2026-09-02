# Cloudflare Mirror Foundation Milestone

Status: PASS

## Purpose

Establish a hosted Cloudflare foundation for xqueue without transferring
publication authority from the existing local systemd publisher.

## Verified foundation

- Cloudflare Worker deployed and health verified.
- Production D1 database provisioned.
- Separate preview D1 database provisioned.
- R2 media bucket provisioned.
- D1 migration tested first against remote preview.
- Invalid publication status negatively tested and rejected.
- Valid D1 write/read/delete behavior positively tested.
- Exact 180-row state parity proven in preview D1.
- Exact 180-row state parity proven in production D1 mirror.
- Historical A1 tweet evidence preserved.
- B1, A30, and C1 preserved at the approved rotation tail.
- Cloudflare remains non-authoritative.
- Cloudflare has no X credentials.
- Cloudflare has no cron trigger.
- Local systemd remains sole publication authority.

## Cloudflare resources

Production D1:

`fc85026e-bfc8-435f-8bb0-c60e139178a3`

Preview D1:

`f5f9bea9-e88c-41ab-9407-70356079a638`

R2:

`xqueue-media`

Worker:

`https://xqueue-production.patrickcraven.workers.dev`

## Authority boundary

At this milestone:

- Local systemd: authoritative publisher.
- Cloudflare D1: non-authoritative production mirror.
- Cloudflare Worker: inert.
- Cloudflare cron: disabled.
- Cloudflare X credentials: absent.

Do not transfer publication authority until the Cloudflare runtime independently
passes deterministic eligibility selection, distributed locking, concurrency
negative testing, state-transition testing, ambiguous-result reconciliation,
and exact-candidate verification.

Runtime state snapshots, queue artifacts, OAuth credentials, X credentials,
and local Wrangler credentials are intentionally excluded from Git.
