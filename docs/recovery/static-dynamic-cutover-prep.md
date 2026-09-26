# Static-to-dynamic parity and cutover preparation

Issue: #93

## Purpose

This proof answers one question before #46 is allowed to change production authority:

> Does the candidate D1 queue contain the same authoritative scheduling and content identity as the current static Markdown/policy queue, and does it produce the same next/due/overdue/selection behavior under the same publication ledger?

#93 does **not** activate the D1 publisher.

## Independent source paths

The static side is rebuilt from:

- `content/`;
- `config/schedule-policy.json`;
- the local scheduling implementation;
- the local missed-slot deferral/runtime-health implementation.

The dynamic side is read from preview D1:

- `queue_content`;
- `queue_content_revisions`;
- `queue_assignments`;
- `publication_state`;
- `queue_deferrals`;
- `queue_runtime_revisions`.

The dynamic decision projection uses the Cloudflare eligibility implementation and D1 missed-slot classifier. The proof therefore does not compare one serialized queue to itself.

## Exact identity checks

Every active assignment must match the static production queue on:

- assignment ID and version;
- content ID and revision;
- content digest;
- target account;
- schedule policy version;
- exact committed UTC instant;
- local date/time/timezone;
- slot label.

The D1 revision digest must equal the assignment digest and the active assignment must bind the current active content revision.

Any extra/missing assignment, digest drift, version drift, slot drift, or UTC drift fails the proof.

## State checks

The mirrored publication ledger is independently checked against D1 `publication_state` and `queue_deferrals`:

- posted IDs and X post IDs must agree;
- skipped timestamps/reasons must agree;
- at most one inflight publication may exist and its status/attempt identity must agree;
- pending deferrals must match the exact assignment/version/policy/prior slot and the assignment must be in deferred lifecycle state;
- reconciliation remains fail-closed.

The same ledger snapshot is then held constant while the two queue sources are compared. This isolates queue-authority parity from unrelated state mutation.

## Bounded observation matrix

The deterministic acceptance matrix covers all 180 currently committed production assignments.

For each slot, the proof evaluates:

1. 1 ms before the due instant;
2. exactly at the due instant;
3. exactly at the 20-minute grace boundary;
4. 1 ms after the grace boundary.

It also checks one instant before the whole window and one after it.

Total: **722 decision observations**.

For every observation the static and candidate dynamic paths must agree on:

- next;
- due;
- overdue;
- selected publication;
- projected missed-slot deferrals;
- inflight blocking;
- safe-to-publish verdict.

The matrix uses a clean synthetic ledger so each slot boundary is tested without historical-state time travel. A second live observation uses the actual preview D1/mirrored ledger.

## Evidence chain

The main-only proof chain is:

1. **Preview Dynamic Runtime Proof**
2. **Preview D1 Recovery Proof**
3. **Preview Static Dynamic Parity Proof**

The parity workflow is read-only and runs only after the exact upstream recovery proof succeeds for main.

## #46 production cutover checklist

#46 may not change publication authority unless all items below are evidenced on the exact candidate.

### Before any authority mutation

- [ ] #52 coordinated production bundle/hash + D1 scheduling metadata activation/readback is complete.
- [ ] #91 production-source backup is captured and isolated restore parity passes.
- [ ] #93 parity proof is green on the exact code candidate.
- [ ] production D1/R2 identities are explicitly verified.
- [ ] no `needs_reconciliation`, publishing, or prepared attempt is unresolved.
- [ ] global publication halt storage is readable and owner control is proven.
- [ ] target status Worker contains no X write capability.
- [ ] publisher Worker is the only deployment that can receive X write credentials.
- [ ] local/systemd remains the sole routine publisher until the authority transfer step.
- [ ] rollback deployment ID/config and current local ledger identity are recorded.

### Controlled transfer

- [ ] owner sets/validates the global publication halt before authority transfer.
- [ ] candidate publisher is deployed with publication authority disabled.
- [ ] candidate publisher D1/R2/readiness checks pass while halted.
- [ ] local ledger ↔ D1 state is reconciled exactly immediately before transfer.
- [ ] local/systemd routine scheduler is disabled without deleting its rollback configuration.
- [ ] durable authority ownership is transferred exactly once.
- [ ] X write credentials exist only on the publisher deployment.
- [ ] the authority-enabled publisher version is uploaded without changing live traffic or scheduler triggers.
- [ ] if enabling authority changes the immutable Worker version identity, durable authority is rebound under the global halt from Cloudflare to Cloudflare with an append-only generation and the exact enabled version ID.
- [ ] the exact rebound publisher version is deployed to 100% before scheduler activation.
- [ ] publisher authority is enabled only after the old routine publisher is confirmed inactive.
- [ ] the single publisher Cron Trigger is attached separately after exact-version deployment.
- [ ] one scheduler invocation source is confirmed.
- [ ] owner clears global halt only after the preceding gates pass.

### Immediate post-transfer evidence

- [ ] status/readiness reports exactly one publication authority.
- [ ] no duplicate scheduler is active.
- [ ] first eligible/no-op cycle has deterministic evidence.
- [ ] publication fence contains exact lease + assignment/version/policy/content digest.
- [ ] D1 backup identity is recorded after cutover.
- [ ] no unresolved reconciliation was introduced.

## Rollback compatibility

The current dynamic schema can coexist with the legacy static rollback publisher. Migrations 0006-0012 add durable queue/recovery state without requiring the legacy local publisher to become the database schema authority.

Rollback rules:

1. **halt first**; never race a rollback against an active Cloudflare publisher;
2. disable Cloudflare publication authority before re-enabling local/systemd;
3. preserve D1 and all append-only events/fences/determinations;
4. never restore an older D1 backup over newer canonical publication evidence merely to make rollback easier;
5. reconcile/sync the latest canonical publication outcome into the local rollback ledger before local publication resumes;
6. verify the exact local deployment ID and X identity;
7. resume exactly one local scheduler;
8. leave the dynamic schema/data intact for investigation and later forward recovery.

A schema downgrade is not part of normal rollback.

## Static-path retirement criteria

The static generated queue/bundled media path may stop being an authority only when all of these are true:

- #46 production cutover has been accepted with exact-candidate evidence;
- D1 is explicitly recorded as canonical runtime state;
- exactly one Cloudflare publisher is active;
- post-cutover backup/restore proof passes;
- no unresolved reconciliation remains;
- dynamic append/revision/cancel/reschedule operations are proven against production-safe state;
- the owner explicitly ends the rollback stabilization period;
- #95 documentation/source-of-truth migration is complete.

Until those conditions are met, the static path remains a **rollback compatibility path**, not a second routine publisher.

## Current intentional boundary

`cloudflare/src/production-publisher.mjs` still decodes the bundled static queue today. #93 does not silently replace that input.

The actual authority/read-source switch belongs only to #46 after this parity package is accepted.
