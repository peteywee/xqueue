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
- An ambiguous create-post result blocks automatic retry until the owner reconciles it.
- Production media validation blocks missing referenced figures.
- Ordinary Cloudflare deploys do not declare scheduler state and therefore must preserve existing Cron Trigger authority.
- Scheduler authority is expressed only by the explicit `wrangler.authority.jsonc` deployment path.
- Production deployment is not considered fully verified until TSAL reconciles repository intent with Cloudflare control-plane and runtime evidence.

### Cloudflare deployment authority boundary

`wrangler.jsonc` and `wrangler.authority.jsonc` deliberately have different authority roles even though they identify the same production Worker and storage.

- `wrangler.jsonc` is the ordinary deployment configuration. It MUST NOT contain a `triggers` property. Ordinary code deployment is not authorized to create, replace, or delete scheduler authority.
- `wrangler.authority.jsonc` is the explicit scheduler-authority configuration. It pins exactly one cron: `*/15 * * * *`.
- An explicit empty scheduler declaration such as `"crons": []` is forbidden in the ordinary config because provider replacement semantics can turn an apparently empty value into deletion of live external state.

The repository test suite enforces this distinction, while TSAL deployment evidence independently verifies the live Cloudflare state after deployment.

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

See `docs/RUNBOOK.md` for the production procedure and scheduler command.

---

This repository should remain private. `content/` contains original publishing
material and `docs/PLAN.md` contains the strategy behind it.
