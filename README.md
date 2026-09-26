# xqueue

Content queue, rule validator, and fail-closed scheduled publisher for a
restaurant-operations X account.

Runtime: Node 22.13+ with pnpm. X network operations use the official
`@xdevplatform/xdk` package.

```bash
pnpm verify                 # tests + content validation + build + schedule health
pnpm validate:production    # additionally requires every referenced figure locally
pnpm post:dry               # what would publish right now; no X mutation
```

## Safety model

Scheduling is the easy half. XQueue is designed around the harder operational
failure modes: external side effects, deterministic scheduling, timezone
correctness, concurrent invocations, crash-safe state, backlog recovery, and
ambiguous network outcomes.

Key invariants:

- `content/*.md` is the content source of truth.
- `config/schedule-policy.json` is the production schedule policy.
- `queue.json` is generated and gitignored.
- `state.json` is a local durable publication ledger and is gitignored.
- Live publication requires explicit `--live` / `pnpm post:live`.
- A live run publishes at most one overdue post.
- A filesystem lock blocks concurrent live publishers.
- State writes are atomic.
- A publication intent is persisted before the X create call begins.
- `confirmed_posted`, `confirmed_not_posted`, and `needs_reconciliation` remain distinct when publication outcomes are persisted.
- An ambiguous create-post result blocks automatic retry until the owner reconciles it.
- Production media validation blocks missing referenced figures.
- Ordinary Cloudflare code deployment uses only the production Worker/D1 identity and cannot mutate scheduler authority because it declares no triggers.
- Preview D1 access is isolated behind explicit `wrangler.preview.jsonc`; production configs contain zero preview D1 identities.
- Target Cloudflare publication authority is structurally isolated in `xqueue-publisher-production`; the legacy combined production descriptor remains in place only until #46 activation.
- Every production scheduled invocation writes a D1 heartbeat; scheduler liveness becomes stale after three missed 15-minute cycles.
- The independent hourly TSAL observer fails on stale/missing production scheduler liveness, opens one deduplicated GitHub incident, and closes it after recovery.
- Production deployment is not considered fully verified until TSAL reconciles repository intent with Cloudflare control-plane and runtime evidence.

### Cloudflare deployment authority boundary

The target production architecture separates status/read-only execution from publishing execution by Worker identity and module graph.

- `wrangler.status.jsonc` targets `xqueue-production` with `cloudflare/src/status-worker.mjs`. It explicitly declares `triggers.crons: []` so deployment removes the legacy cron; the Worker has no scheduled handler, no publisher import, no service binding to the publisher, and must never receive X write credentials.
- `wrangler.publisher.jsonc` targets the separate `xqueue-publisher-production` Worker with `cloudflare/src/publisher-worker.mjs`. It is intentionally inert and declares no cron.
- `wrangler.authority.jsonc` is the future explicit scheduler-authority surface for `xqueue-publisher-production`. It pins exactly one cron: `*/15 * * * *`.
- `wrangler.preview.jsonc` remains the non-authoritative preview surface.
- `wrangler.jsonc` is retained as the legacy combined `xqueue-production` descriptor until the separately evidenced #46 cutover. Merging the structural split does not change the currently deployed entrypoint or move production secrets.
- All production-role configs bind the same canonical production D1/R2 truth, while the preview config remains isolated from production D1 identity.
- X write credentials belong only to `xqueue-publisher-production`. The repository audits and CI bundle inspection fail if X credential references, the X SDK, or publish transport become reachable from the target status-only bundle.

Activation is deliberately separate from architecture. Under #46, the exact candidate must deploy/prove the publisher inertly, verify live secret inventory, remove X write secrets from `xqueue-production`, place them only on `xqueue-publisher-production`, switch the status Worker to its status-only entrypoint, and only then activate the publisher cron. The local/systemd publisher remains the rollback path until separately approved for retirement.

### Scheduler liveness boundary

Publication authority and scheduler liveness are separate facts.

- `livePublication` means the production runtime is authorized to publish if current eligibility and transaction gates permit it.
- `schedulerAuthority` additionally requires a fresh durable scheduler heartbeat.
- `schedulerLiveness.lastInvocationAt` is written by the actual Cloudflare scheduled handler, not inferred from configuration.
- `schedulerLiveness.expectedNextAt` and `schedulerLiveness.staleAfterAt` make the detection window explicit.
- If production authority is expected and the heartbeat is missing, malformed, or older than 45 minutes, `/health` returns an error and TSAL runtime evidence fails.

This prevents a configured-but-dead scheduler from being represented as healthy.

## Layout

```text
content/          post library — SOURCE OF TRUTH
config/           production schedule policy
src/              parser, validator, scheduler, XDK client, CLI, safety modules
test/             node:test suite including failure-path hardening tests
docs/PLAN.md      full content plan
docs/RUNBOOK.md   production operations and recovery procedures
media/            deployment-local figure assets (gitignored)
queue.json        generated local schedule artifact (gitignored)
state.json        durable local publication ledger (gitignored)
```

Generated queue records contain repository-relative `sourceFile` paths so queue
regeneration is portable across CI and production hosts.

## Commands

| Command | Purpose |
|---|---|
| `pnpm verify` | full repository gate: tests, validation, build, schedule health |
| `pnpm test` | run the test suite |
| `pnpm validate` | authoring validation; missing local media can be informational |
| `pnpm validate:production` | production validation; all referenced media required |
| `pnpm build` | regenerate `queue.json` from Markdown |
| `pnpm health` | audit generated schedule against production policy |
| `pnpm stats` | pillar split, runway, cost projection, publication state |
| `pnpm next` | show upcoming unpublished posts |
| `pnpm post` / `pnpm post:dry` | safe dry-run |
| `pnpm post:live` | explicit live publication; at most oldest due post |
| `pnpm reconcile -- --posted <tweet-id>` | owner confirms ambiguous attempt did publish |
| `pnpm reconcile -- --not-posted` | owner confirms ambiguous attempt did not publish |
| `pnpm cf:preview:d1-diagnostic` | read-only preview D1 check through explicit `wrangler.preview.jsonc` |

`build` flags: `--start YYYY-MM-DD`, `--slots 14:30,22:15`,
`--days 1,2,3,4,5`, `--tz America/Chicago`.

## Validator

The validator mechanically enforces content and publication policy, including:

- blocked employer references,
- unauthorized customer/pilot claims,
- mandatory legal disclaimer rendering for Pillar B,
- X length limits,
- URL warnings,
- near-duplicate detection,
- voice checks,
- figure references.

Authoring mode can operate on a machine where media has not been provisioned.
Production mode cannot. Run `pnpm validate:production` on the actual publisher
host before enabling the scheduler.

## Ambiguous create-post recovery

A network or server failure can occur after a create request has left the
publisher but before XQueue receives the remote post ID. Blindly retrying can
create a duplicate.

XQueue therefore records `needs_reconciliation` and blocks later live runs.
The owner must inspect the actual X timeline and then choose exactly one:

```bash
pnpm reconcile -- --posted <tweet-id>
pnpm reconcile -- --not-posted
```

A conclusively `confirmed_not_posted` result is not represented as ambiguous; it is durably recorded as such and the content returns to scheduled state under the existing scheduler policy.

See `docs/RUNBOOK.md` for the production procedure and scheduler command.

---

This repository should remain private. `content/` contains original publishing
material and `docs/PLAN.md` contains the strategy behind it.
