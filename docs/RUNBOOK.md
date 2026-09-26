# XQueue Production Runbook

## Current production model

XQueue is fail-closed and has one routine production publication authority:

- production D1 is canonical for runtime content, revisions, assignments, publication state, deferrals, leases, fences, halt state, runtime revisions, and durable authority ownership;
- production R2 is canonical for media bytes referenced by D1 media metadata;
- `xqueue-publisher-production` is the only Worker allowed to hold X write credentials or execute scheduled publication;
- `xqueue-production` is status-only, has no publication entrypoint, no X write credentials, and no Cron Trigger;
- the publisher has exactly one `*/15 * * * *` Cron Trigger;
- the local `xqueue.service` path is disabled/inactive and is not routine production rollback authority;
- generated queue/media artifacts and local `state.json` remain compatibility/evidence artifacts only.

A production publication requires all of the following at runtime:

1. `XQUEUE_PUBLISH_AUTHORITY=enabled`;
2. the global owner-controlled publication halt is clear;
3. durable authority is stable `owner=cloudflare`;
4. `CF_VERSION_METADATA.id` equals the exact Worker version recorded in D1 `authority_state.deployment_id`;
5. `CF_VERSION_METADATA.tag` equals D1 `authority_state.candidate_sha`;
6. the canonical D1 runtime revision, assignments, content digests, and R2 media validate;
7. publication ledger/eligibility is safe;
8. the exact D1 publisher lease is acquired and verified;
9. the immutable publication fence binds the lease, assignment/version, policy version, and content digest;
10. the global halt is rechecked immediately before any external X side effect.

If any of these checks cannot be proven, the correct result is no publication.

## Repository authoring and compatibility inputs

`content/*.md` and `config/schedule-policy.json` remain reviewed repository inputs for authoring, validation, parity, and compatibility workflows. They are not the live production publisher's queue read source after #46.

Useful local checks:

```bash
pnpm verify
pnpm validate
pnpm post:dry
```

`pnpm post:dry` is safe and performs no X mutation. `pnpm post:live` is a legacy/local capability and must not be used as routine production authority after the D1 canonical cutover.

## Production Worker topology

### Status Worker

`wrangler.status.jsonc` deploys `xqueue-production` from `cloudflare/src/status-worker.mjs`.

Required properties:

- `triggers.crons: []`;
- no scheduled handler;
- no publisher import or X transport;
- no X write secrets;
- health is gated by canonical D1/R2 runtime state and the global halt store;
- static bundle integrity may be reported only as rollback-compatibility telemetry and does not gate canonical production health.

### Publisher Worker

`wrangler.authority.jsonc` deploys `xqueue-publisher-production`.

Required properties:

- production D1 and R2 bindings only;
- `XQUEUE_PUBLISH_AUTHORITY=enabled`;
- `CF_VERSION_METADATA` binding;
- exactly one Cron Trigger: `*/15 * * * *`;
- exactly the four required X write secret names;
- no preview D1 identity.

`wrangler.publisher.jsonc` targets the same publisher Worker with authority explicitly disabled and no scheduler. It is used for inert staging/proof when required.

## Safe forward deployment / authority rebind

A code merge does not itself authorize a new production Worker version.

For any authority-capable publisher update:

1. Put production under the owner halt.
2. Verify:
   - clean `main`;
   - exact candidate SHA;
   - zero unresolved `prepared|publishing|needs_reconciliation` states;
   - zero active leases;
   - mirror `inflight=null`;
   - current durable authority state/event are coherent and stable;
   - local systemd remains disabled/inactive.
3. Apply any production-safe D1 migration before running a control action that depends on it.
4. Upload, but do not deploy, the authority-enabled Worker version and tag it with the exact Git SHA:

```bash
HEAD="$(git rev-parse HEAD)"

pnpm wrangler versions upload \
  --config wrangler.authority.jsonc \
  --tag "$HEAD" \
  --message "XQueue exact production candidate"
```

5. Record the returned immutable Worker version ID.
6. Rebind durable authority while the halt remains set:

```bash
pnpm production:authority \
  rebind \
  --expected-halt-generation=<current-halt-generation> \
  --deployment-id=cloudflare-worker:xqueue-publisher-production:version:<VERSION_ID> \
  --confirm=xqueue-production-authority-rebind
```

The control command independently reads the uploaded version and refuses unless:

- its ID is the exact requested UUID;
- its Worker tag is the current Git SHA;
- its authority binding is enabled;
- it contains the version-metadata binding;
- the previous D1 authority state/event/candidate/deployment are an exact coherent CAS predecessor.

The authority event append is the single mutation. The production D1 projection trigger advances `authority_state` in the same SQLite statement transaction or aborts the event.

7. Deploy that exact already-uploaded version to 100% traffic. Do not create another version.
8. Reassert the one publisher trigger if trigger configuration changed.
9. While still halted, observe a real scheduled invocation and require `publication_halted` with `dispatched=false`.
10. Recheck exact authority/version, zero unresolved attempts, zero active leases, no inflight state, credential separation, and scheduler topology.
11. Clear the owner halt using the exact current halt generation.
12. Observe a scheduler heartbeat after the clear and require the publication state to settle to zero unresolved/leases/inflight.
13. Capture a post-release D1 logical backup and run the isolated restore-parity proof.

Never clear the halt because a deployment command merely succeeded.

## Cloudflare exact-version rollback

Production rollback stays inside the single Cloudflare authority model. Do **not** reactivate local/systemd as a second publication authority.

Rollback is an append-only authority transition to a previously known, immutable, tagged publisher version.

1. Set/verify the owner halt.
2. Verify zero unresolved publication attempts, zero active leases, and no mirror inflight state.
3. Select the exact prior known-good publisher version and candidate SHA from recorded production evidence/authority history.
4. Verify the prior Worker version still exists and its `workers/tag` equals that exact candidate SHA.
5. Rebind durable authority to the prior version/candidate:

```bash
pnpm production:authority \
  rollback-cloudflare \
  --expected-halt-generation=<current-halt-generation> \
  --candidate-sha=<PRIOR_40_HEX_SHA> \
  --deployment-id=cloudflare-worker:xqueue-publisher-production:version:<PRIOR_VERSION_ID> \
  --confirm=xqueue-production-authority-rollback
```

6. Deploy that exact existing version to 100% traffic.
7. Verify the publisher Cron Trigger remains singular and the status Worker remains unscheduled.
8. Observe a real scheduled invocation while halted; it must dispatch nothing.
9. Recheck durable authority and live traffic identify the same exact prior version/candidate.
10. Clear the owner halt.
11. Prove a fresh post-clear scheduler heartbeat and stable publication state.
12. Capture and isolated-restore a new D1 backup.

Rollback must **not**:

- restore an older D1 backup over newer canonical publication evidence;
- delete authority/publication/fence/reconciliation history;
- enable the local systemd publisher;
- move X write credentials to the status Worker;
- create a second scheduler.

A schema downgrade is not part of routine rollback.

## Global publication halt

The halt is a D1 generation/CAS singleton controlled by the owner path.

Read:

```bash
pnpm halt:status --environment production
```

Set or clear mutations require:

- the exact expected generation;
- a reason;
- `--apply`;
- the production confirmation token.

The Worker checks halt state before transaction work, before lease acquisition, before media upload, and immediately before X post creation. Missing/unreadable halt state fails closed.

## Publication state and reconciliation

D1 `publication_state`, append-only publication events, immutable publication fences, and the mirrored ledger preserve publication truth.

An ambiguous external create result becomes `needs_reconciliation` and blocks automatic retry. The owner must verify the actual X account before deciding whether the attempt posted.

Production D1 reconciliation uses the guarded D1 reconciliation command/runbook. The local `pnpm reconcile` command operates only on the local compatibility ledger and is not the canonical production reconciliation path after #46.

Never clear ambiguity by deleting state or pretending a post succeeded.

## Backup and restore proof

Capture a logical production backup with explicit confirmation:

```bash
pnpm d1:backup \
  --environment production \
  --output /tmp/xqueue-production-backup.json \
  --evidence /tmp/xqueue-production-backup-evidence.json \
  --confirm xqueue-production-backup
```

Then prove isolated restore parity:

```bash
pnpm d1:restore-proof \
  --backup /tmp/xqueue-production-backup.json \
  --evidence /tmp/xqueue-production-restore-proof.json
```

The restore proof must report:

- SQLite integrity check `ok`;
- zero foreign-key violations;
- exact table parity;
- no duplicate active slots;
- no duplicate assignment versions;
- no assignment/content digest mismatches.

A backup is evidence/recovery material, not permission to overwrite newer canonical D1 state.

## Scheduler liveness

Every real scheduled invocation writes `scheduler.last_invocation` to D1 before publication processing. A configured Cron Trigger is not considered healthy merely because configuration exists.

The production status/evidence path must use the durable heartbeat to establish liveness. Missing, malformed, or stale heartbeat evidence fails the scheduler-liveness gate when publication authority is expected.

## Credential boundary

Only `xqueue-publisher-production` may hold:

- `X_API_KEY`;
- `X_API_SECRET`;
- `X_ACCESS_TOKEN`;
- `X_ACCESS_SECRET`.

`xqueue-production` must hold none of them.

Run repository authority/credential audits before any production authority mutation:

```bash
pnpm audit:authority
pnpm audit:credentials
```

Never print X secret values into terminal evidence or issue comments.

## Local/systemd compatibility path

The local systemd unit is retained only as compatibility/history unless the owner approves a future architecture change. It must remain disabled and inactive during normal production:

```bash
systemctl --user is-enabled xqueue.service
systemctl --user is-active xqueue.service
```

Expected normal state is `disabled` and `inactive`.

Do not use the old installer, cron example, or `pnpm post:live` to recover production. Those paths can diverge from canonical D1 content after dynamic intake and would reintroduce dual authority.

## Incident handling

For any uncertain production condition:

1. set the global owner halt if it is not already set;
2. preserve all D1/R2 evidence;
3. do not retry an ambiguous X write;
4. inspect durable authority, current Worker version/tag, scheduler heartbeat, publication state, leases, and fences;
5. reconcile any ambiguous remote outcome;
6. choose forward repair or exact tagged Cloudflare rollback;
7. release only after exact postconditions are proven.

## Manual owner decisions

The following remain owner-reserved:

- reconcile ambiguous external publication outcomes;
- change or revoke production authority;
- select a prior version for rollback;
- clear the global halt;
- provision/rotate X credentials;
- change scheduling/content policy;
- approve a future change to the single-publisher topology.
