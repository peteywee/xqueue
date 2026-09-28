# XQueue Source of Truth

## Production authority

XQueue production is post-cutover. The canonical sources are:

| Concern | Canonical source | Notes |
|---|---|---|
| Runtime content and revisions | production D1 | `queue_content`, `queue_content_revisions` |
| Scheduling assignments and deferrals | production D1 | `queue_assignments`, `queue_deferrals`, frontier/event tables |
| Publication state/outcomes/fences/leases | production D1 | durable publication evidence |
| Publication halt | production D1 | owner-controlled generation-fenced singleton + events |
| Publisher authority | production D1 | `authority_state` / `authority_events` |
| Runtime revision/integrity | production D1 | immutable `queue_runtime_revisions` chain |
| Scheduler heartbeat | production D1 | `runtime_metadata['scheduler.last_invocation']` |
| Media bytes | production R2 | identity/hash/size/MIME bound by D1 metadata |
| Production publisher code | exact immutable Cloudflare Worker version | D1 authority records exact version ID + Git candidate SHA |
| Authoring policy/contracts | Git repository | reviewed inputs and normative design/contract history |
| Production acceptance evidence | local acceptance evidence + GitHub issue/PR records | acceptance runner emits resumable evidence outside the repo |

## Non-authoritative compatibility inputs

These remain useful but cannot override canonical production truth:

- `content/*.md`: reviewed authoring/history input;
- `config/schedule-policy.json`: repository scheduling-policy input;
- generated `queue.json` and Worker queue/media bundles: compatibility/parity artifacts;
- local `state.json`: compatibility/evidence ledger;
- local/systemd publisher path: disabled/inactive and not routine rollback authority;
- preview D1: development/proof surface only.

A difference between one of these compatibility artifacts and production D1/R2 is
not resolved by overwriting production. Production evidence wins unless an
explicit governed migration/recovery procedure proves a safe replacement.

## Routine production surfaces

Read-only operator state:

```bash
pnpm production:status
pnpm production:status -- --json
```

Production release/authority acceptance:

```bash
pnpm production:acceptance -- \
  --sync-main \
  --apply \
  --release \
  --confirm xqueue-production-acceptance
```

Publication halt and authority controllers remain separate explicit control
surfaces.

## Production mutation gap

The canonical runtime is live, but the original continuous-queue mutation CLIs
for intake, revise/rebind/cancel, and deferred replacement remain preview-only.
That is intentional until #145 supplies a production-safe mutation control
plane with exact halt/authority/runtime CAS semantics.

Do not point those preview CLIs at production by changing database/config
constants. Their current remote transaction transport was designed for preview
proof and is not the accepted production mutation boundary.

## Historical documents

Roadmaps, cutover-preparation notes, and compatibility contracts may describe
pre-cutover states. They are design/evidence history, not current operator
instructions. Current production operation is defined by this document,
`README.md`, and `docs/RUNBOOK.md`, with #48 tracking remaining program debt.
