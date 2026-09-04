# Incident #56 Hardening Action Plan

## Objective

Convert the verified production failure and recovery evidence from incident #56 into permanent controls that make the same class of failure structurally harder to reproduce.

## P0 — Environment isolation

Status: implementing on `hardening/incident-56-controls`

- [x] Remove preview D1 identity from production authority config.
- [x] Make default Wrangler config target preview instead of production.
- [x] Keep preview cron list empty.
- [x] Add machine verifier for production/preview identity.
- [x] Add negative tests for cross-environment bindings and cron drift.
- [x] Wire verifier into `pnpm verify`.
- [ ] Observe CI on exact branch head.
- [ ] Review candidate diff and merge only after green evidence.

## P0 — Scheduler liveness (#58)

- [ ] Add durable `last_scheduled_observation_at` and last-result metadata.
- [ ] Build a separate watchdog path with no publication capability and no X write credentials.
- [ ] Expose liveness separately from authority/readiness/eligibility.
- [ ] Add stale-heartbeat and recovery tests.
- [ ] Test notification delivery end-to-end after owner selects provider.

## P0 — Durable single-authority ownership (#46/#59)

- [ ] Define durable authority owner: `cloudflare | local-systemd | none`.
- [ ] Add authority generation/version and transition evidence.
- [ ] Require publication paths to prove current ownership.
- [ ] Negative test simultaneous/conflicting authority claims.

## P1 — Repeatable reconciliation (#59)

- [ ] Implement read-only plan generation.
- [ ] Require explicit environment target.
- [ ] Bind plan to source state/hash and exact target state/hash.
- [ ] Apply only when preconditions still match.
- [ ] Verify exact read-back.
- [ ] Make repeated identical reconciliation idempotent.

## P1 — Incident evidence snapshot

- [ ] Add `pnpm incident:snapshot --post <id>`.
- [ ] Correlate runtime version, authority, heartbeat, queue integrity, D1 state, lease, events, and eligibility.
- [ ] Return one of: `confirmed_success`, `suspected_failure`, `confirmed_failure`, `indeterminate`.
- [ ] Negative test that an absent/partial observation alone cannot produce `confirmed_failure`.

## P1 — Missed-slot lifecycle

Track under #52/#53/#54.

- [ ] Implement normative missed-slot → deferred lifecycle.
- [ ] Preserve no-backfill/no-burst policy.
- [ ] Version/fence schedule transitions.
- [ ] Test stale backlog cannot indefinitely lock later policy-approved work after deterministic disposition.

## Exit criteria

Incident #56 may close only when its definition of done is satisfied, including independent scheduler liveness and regression tests. Recovery of A16 is necessary evidence but is not, by itself, completion of all permanent fixes.
