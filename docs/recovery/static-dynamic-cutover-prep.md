# Static-to-dynamic parity and cutover preparation

Issues: #93, #46

> Historical + acceptance record. The original #46 authority cutover executed on
> 2026-09-26. A post-close audit reopened #46 for PR #137 hardening so the
> implementation, rollback model, and documentation satisfy the strict contract.

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

- [x] #52 coordinated production bundle/hash + D1 scheduling metadata activation/readback is complete.
- [x] #91 production-source backup is captured and isolated restore parity passes.
- [x] #93 parity proof is green on the exact code candidate.
- [x] production D1/R2 identities are explicitly verified.
- [x] no `needs_reconciliation`, publishing, or prepared attempt is unresolved.
- [x] global publication halt storage is readable and owner control is proven.
- [x] target status Worker contains no X write capability.
- [x] publisher Worker is the only Cloudflare deployment that can receive X write credentials.
- [x] local/systemd remained the sole routine publisher until the authority transfer step.
- [x] rollback deployment ID/config and current local ledger identity were recorded before transfer.

### Controlled transfer

- [x] owner sets/validates the global publication halt before authority transfer.
- [x] candidate publisher is deployed with publication authority disabled.
- [x] candidate publisher D1/R2/readiness checks pass while halted.
- [x] local ledger ↔ D1 state is reconciled exactly immediately before transfer.
- [x] local/systemd routine scheduler is disabled without deleting its rollback configuration.
- [x] durable authority ownership is transferred exactly once.
- [x] X write credentials exist only on the publisher deployment.
- [x] the authority-enabled publisher version is uploaded without changing live traffic or scheduler triggers.
- [x] if enabling authority changes the immutable Worker version identity, durable authority is rebound under the global halt from Cloudflare to Cloudflare with an append-only generation and the exact enabled version ID.
- [x] the exact rebound publisher version is deployed to 100% before scheduler activation.
- [x] publisher authority is enabled only after the old routine publisher is confirmed inactive.
- [x] the single publisher Cron Trigger is attached separately after exact-version deployment.
- [x] one scheduler invocation source is confirmed.
- [x] owner clears global halt only after the preceding gates pass.

### Immediate post-transfer evidence

- [x] status/readiness reports exactly one publication authority.
- [x] no duplicate scheduler is active.
- [x] first eligible/no-op cycle has deterministic evidence.
- [x] publication fence schema/runtime enforcement binds exact lease + assignment/version/policy/content digest; no new fence is required for a deterministic no-op cycle.
- [x] D1 backup identity is recorded after cutover.
- [x] no unresolved reconciliation was introduced.

## Post-cutover rollback model

The local/static publisher is no longer a safe routine rollback authority once
new content can exist only in canonical D1. Re-enabling it would reintroduce
dual authority and could ignore D1-only content.

Supported production rollback is therefore **Cloudflare exact-version
rollback** while D1/R2 remain canonical:

1. halt first;
2. require zero unresolved attempts, zero active leases, and no mirror inflight;
3. identify an immutable previously known-good publisher version and its exact Git candidate SHA;
4. verify the Worker's stored version tag equals that candidate;
5. append a new Cloudflare-to-Cloudflare durable authority generation pointing to the prior candidate/version;
6. deploy that exact existing version to 100% traffic;
7. keep exactly one publisher Cron Trigger and zero status-worker/local schedulers;
8. observe a real scheduled invocation while halted and require no dispatch;
9. clear the halt only after live traffic and D1 authority identify the same version;
10. prove a new post-clear heartbeat and stable state;
11. capture and isolated-restore a fresh D1 backup.

Rollback never overwrites newer D1 evidence with an older backup and never
deletes append-only authority, publication, fence, or reconciliation evidence.

The production authority event is the only mutation compiled by the control
plane. Production migration 0014 projects the singleton authority row via a
SQLite trigger in that same statement transaction; a projection failure aborts
the event append.

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

## PR #137 post-cutover hardening acceptance

Before #46 is re-closed after the audit:

- [ ] exact-head PR #137 verification is green, including atomicity/crash/replay/rollback tests;
- [ ] production migration `0014_authority_event_projection.sql` is applied while halted;
- [ ] an authority-enabled publisher version is uploaded with `--tag <exact-main-sha>` and no traffic move;
- [ ] durable authority is rebound from the current Cloudflare generation to that exact tagged version;
- [ ] the exact version is deployed to 100% while the halt remains set;
- [ ] runtime self-binding proves Worker version ID and candidate tag equal D1 authority;
- [ ] live publisher/readiness consume verified D1/R2 runtime truth, not generated static queue/media artifacts;
- [ ] a real halted scheduler invocation proves `dispatched=false`;
- [ ] owner clears halt only after all gates pass;
- [ ] a fresh post-clear scheduler heartbeat is observed;
- [ ] unresolved attempts, active leases, and mirror inflight return to zero;
- [ ] a final post-hardening D1 backup and isolated restore proof pass;
- [ ] README, runbook, automation contract, #48, and #95 all describe the same canonical topology.

After this acceptance, generated queue/media artifacts and local/systemd are
compatibility/evidence surfaces only. They are not production publication
authority.
