# D1 mirror sync authority contract

Status: Phase 0 design for issue #59. This document does **not** activate production writes or change publication authority.

## Problem

XQueue currently reads the mirrored local ledger from `runtime_metadata['state.snapshot_json']`, while Cloudflare publication capability is controlled by the deployment environment flag `XQUEUE_PUBLISH_AUTHORITY=enabled`. That flag is a capability switch, not a durable ownership record. A recovery command must not infer ownership from readiness, eligibility, scheduler health, or an environment flag alone.

## Decision

Introduce a dedicated durable authority-ownership model rather than overloading `runtime_metadata`.

The future D1 migration will contain:

```sql
CREATE TABLE authority_state (
  singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
  owner TEXT NOT NULL CHECK (owner IN ('local-systemd', 'cloudflare', 'none')),
  generation INTEGER NOT NULL CHECK (generation >= 1),
  transition_state TEXT NOT NULL CHECK (transition_state IN ('stable', 'transitioning')),
  transition_id TEXT NOT NULL,
  previous_owner TEXT CHECK (previous_owner IS NULL OR previous_owner IN ('local-systemd', 'cloudflare', 'none')),
  candidate_sha TEXT NOT NULL,
  deployment_id TEXT,
  transitioned_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE authority_events (
  generation INTEGER PRIMARY KEY,
  transition_id TEXT NOT NULL UNIQUE,
  previous_owner TEXT,
  next_owner TEXT NOT NULL,
  transition_state TEXT NOT NULL,
  candidate_sha TEXT NOT NULL,
  deployment_id TEXT,
  event_at TEXT NOT NULL,
  detail TEXT
);
```

The exact migration is intentionally deferred until the pure contract and negative tests are proven.

## Semantics

`authority_state` is the current ownership projection. `authority_events` is append-only transition evidence.

Ownership values:

- `local-systemd`: only the explicitly controlled local/systemd publisher may own publication.
- `cloudflare`: only the Cloudflare publication path may own publication.
- `none`: publication is intentionally unowned/disabled.

`transition_state='transitioning'` means no recovery sync or publication-authority transfer may claim a stable owner. All consumers fail closed.

A generation identifies one exact ownership transition. A successful transition increments generation exactly once and appends the matching event atomically with the projection update.

Time alone does not make an ownership record stale. Staleness means the current projection cannot be reconciled exactly with the latest append-only authority event or the caller is operating against an older generation.

## Capability is not ownership

`XQUEUE_PUBLISH_AUTHORITY=enabled` remains a deployment capability gate. It must never be treated as the canonical ownership record.

A future Cloudflare publication transaction will require both:

1. the existing capability/configuration gates; and
2. stable durable ownership of `cloudflare` at the exact generation used by the transaction.

This Phase 0 work does not make that runtime change.

## Mirror-sync authorization rule

A future `pnpm sync:d1-mirror --env production|preview` may write `runtime_metadata['state.snapshot_json']` only when all of the following are true:

1. explicit environment target supplied;
2. local `state.json` exists and validates;
3. local state has no inflight or unresolved reconciliation publication;
4. authority record validates structurally;
5. `transition_state === 'stable'`;
6. `owner === 'local-systemd'`;
7. current projection generation matches the latest durable authority event generation;
8. no conflicting authority evidence is present;
9. the write scope is limited to the mirrored state metadata and mirror evidence;
10. exact post-write readback/hash verification succeeds.

Any unknown, missing, malformed, `none`, `cloudflare`, transitioning, stale-generation, conflicting, or unreachable authority state causes refusal with zero D1 writes.

## Mirror evidence

The future sync operation records, without touching publication ledgers:

- target environment;
- authority generation;
- local normalized state hash;
- before/after posted/skipped/inflight counts;
- write timestamp;
- readback normalized state hash;
- exact result: `confirmed_synced` or `indeterminate`/failure.

A network or readback ambiguity must never be reported as success.

## Explicit non-goals for Phase 0

This phase does not:

- create or mutate D1 tables;
- change Cloudflare publication authority;
- change scheduler behavior;
- change `state.snapshot_json`;
- publish or schedule X content;
- reactivate the broader v0.2 contract-alignment program.

## Required Phase 0 proofs

Pure tests must show:

- only stable `local-systemd` ownership authorizes mirror sync;
- `cloudflare` refuses;
- `none` refuses;
- transitioning refuses;
- malformed/unknown owner refuses;
- invalid generation refuses;
- missing/invalid transition identity refuses;
- invalid candidate SHA refuses;
- mutation of an otherwise valid record causes revalidation failure where applicable.

Only after these tests and exact-head CI are green should Phase 1 add a D1 migration and read-only authority inspection. Production writes remain a later, separately evidenced step.
