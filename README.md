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

- Production runtime content, assignments, publication state, halt state, authority state, and revision evidence are canonical in production D1.
- Production media bytes are canonical in R2 and are bound to exact D1 content revisions by digest/size/MIME metadata.
- `content/*.md` and `config/schedule-policy.json` are repository-controlled authoring/compatibility inputs; they are not the live production publication read source after #46.
- `queue.json`, generated Worker queue bundles, generated media manifests, and local `state.json` are rebuildable/rollback-compatibility artifacts, not production authority.
- Routine live publication exists only in `xqueue-publisher-production`.
- Every live publication requires the durable D1 owner to be stable `cloudflare`, the executing immutable Worker version to match D1 `deployment_id`, and the Worker version tag to match D1 `candidate_sha`.
- A production invocation publishes at most one eligible post and is protected by D1 lease/fence/state CAS.
- Authority-event append and the singleton authority projection are one atomic SQLite statement via the production projection trigger.
- A publication intent is persisted before the X create call begins.
- `confirmed_posted`, `confirmed_not_posted`, and `needs_reconciliation` remain distinct when publication outcomes are persisted.
- An ambiguous create-post result blocks automatic retry until the owner reconciles it.
- Production media validation blocks missing referenced figures.
- Inert Cloudflare deployment is explicit: the status config removes cron triggers and the publisher config sets `XQUEUE_PUBLISH_AUTHORITY=disabled`; only the authority config enables the capability and adds the cron.
- Preview D1 access is isolated behind explicit `wrangler.preview.jsonc`; production configs contain zero preview D1 identities.
- Cloudflare publication authority is structurally isolated in `xqueue-publisher-production`; `xqueue-production` is status-only and has no scheduler or X write credentials.
- Every production scheduled invocation writes a D1 heartbeat; scheduler liveness becomes stale after three missed 15-minute cycles.
- The independent hourly TSAL observer fails on stale/missing production scheduler liveness, opens one deduplicated GitHub incident, and closes it after recovery.
- Production deployment is not considered fully verified until TSAL reconciles repository intent with Cloudflare control-plane and runtime evidence.

### Cloudflare deployment authority boundary

The target production architecture separates status/read-only execution from publishing execution by Worker identity and module graph.

- `wrangler.status.jsonc` targets `xqueue-production` with `cloudflare/src/status-worker.mjs`. It explicitly declares `triggers.crons: []` so deployment removes the legacy cron; the Worker has no scheduled handler, no publisher import, no service binding to the publisher, and must never receive X write credentials.
- `wrangler.publisher.jsonc` targets the separate `xqueue-publisher-production` Worker with `cloudflare/src/publisher-worker.mjs`. It is intentionally inert, declares no cron, and explicitly sets `XQUEUE_PUBLISH_AUTHORITY=disabled`.
- `wrangler.authority.jsonc` is the explicit scheduler-authority surface for `xqueue-publisher-production`. It uses the production-safe D1 migration lane, sets `XQUEUE_PUBLISH_AUTHORITY=enabled`, binds `CF_VERSION_METADATA`, and pins exactly one cron: `*/15 * * * *`.
- `wrangler.preview.jsonc` remains the non-authoritative preview surface.
- `wrangler.jsonc` is retained only as a legacy compatibility descriptor. It is not the deployed routine publisher authority after #46.
- All production-role configs bind the same canonical production D1/R2 truth, while the preview config remains isolated from production D1 identity.
- X write credentials belong only to `xqueue-publisher-production`. The repository audits and CI bundle inspection fail if X credential references, the X SDK, or publish transport become reachable from the target status-only bundle.

#46 activated this topology with exact production evidence. New publisher versions are uploaded without moving traffic, tagged with the exact Git SHA, rebound in durable D1 authority under the global halt, promoted to 100%, and only then released. Rollback uses the same append-only Cloudflare-to-Cloudflare rebind to an exact previously tagged version/candidate while halted. The local/systemd publisher remains disabled and is not a routine production rollback authority.

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
content/          authoring library / static compatibility source
config/           repository-controlled scheduling policy inputs
src/              parser, validator, scheduler, XDK client, CLI, safety modules
test/             node:test suite including failure-path hardening tests
docs/PLAN.md      full content plan
docs/RUNBOOK.md   production operations and recovery procedures
media/            deployment-local figure assets (gitignored)
queue.json        generated local compatibility schedule (gitignored)
state.json        local compatibility publication ledger (gitignored)
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
| `pnpm post` / `pnpm post:dry` | safe local compatibility dry-run; never X mutation |
| `pnpm post:live` | legacy/local live path; not routine production authority after #46 |
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
