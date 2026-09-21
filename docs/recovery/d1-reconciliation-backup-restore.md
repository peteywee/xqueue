# D1 reconciliation and backup/restore recovery

Issue: #91

## Recovery boundaries

XQueue uses two different recovery mechanisms and they must not be conflated.

### Reconciliation

Reconciliation resolves one ambiguous external X publication attempt.

It does **not** retry the old request.

The owner must inspect the actual X account and make one of two factual determinations:

- `confirmed_posted`: the exact post exists and its X post ID is known;
- `confirmed_not_posted`: the owner positively verified that the exact post does not exist.

The original `needs_reconciliation` event and publication fence remain immutable.

The owner determination is stored in `publication_reconciliation_determinations` and the state/snapshot transition is generation/CAS fenced. A stale snapshot or stale state generation leaves no determination or success event.

A confirmed-not-posted reconciliation returns the item to durable scheduled state with `automaticRetryAllowed: false`. Normal missed-slot/deferred scheduling rules decide what happens next. The reconciliation command never redispatches the stale attempt.

### Backup / restore

The D1 logical backup captures:

- final application schema SQL;
- migration ledger identity;
- every application table;
- exact rows;
- per-table row counts and SHA-256 hashes;
- schema hash;
- migration hash;
- whole-backup identity and SHA-256 hash.

The restore proof creates a fresh isolated SQLite database from the backed-up final schema, restores every application row, and verifies:

- `PRAGMA integrity_check`;
- `PRAGMA foreign_key_check`;
- exact per-table count/hash parity;
- content revision ↔ assignment digest parity;
- no duplicate active assignment slots;
- no duplicate assignment versions.

R2 object bytes are not stored inside the D1 logical backup. D1 preserves the R2 object key, size, MIME type, and SHA-256 metadata. R2 byte recovery remains a separate object-storage concern and must be verified against those hashes before a restored environment becomes authoritative.

## Operator commands

### Inspect / dry-run an ambiguous D1 reconciliation

Preview is the default target.

```bash
pnpm d1:reconcile -- \
  --post-id A1 \
  --outcome posted \
  --tweet-id 1234567890123456789 \
  --reason "owner verified exact post on X"
```

No mutation occurs without `--apply`.

Confirmed not posted:

```bash
pnpm d1:reconcile -- \
  --post-id A1 \
  --outcome not-posted \
  --reason "owner verified exact post is absent from X"
```

Production reconciliation additionally requires:

```text
--environment production
--apply
--confirm xqueue-production-reconciliation
```

Do not use `not-posted` merely because an API request failed. It is an owner factual determination after inspecting the remote account.

### Capture a logical backup

Preview:

```bash
pnpm d1:backup -- \
  --environment preview \
  --output /tmp/xqueue-d1-backup.json \
  --evidence /tmp/xqueue-d1-backup-evidence.json
```

Production backup is read-only but requires explicit source confirmation:

```text
--environment production
--confirm xqueue-production-backup
```

The raw backup contains publication content and operational state. Treat it as sensitive, keep it out of Git, and restrict access. Evidence summaries contain hashes/counts rather than table rows.

### Isolated restore proof

```bash
pnpm d1:restore-proof -- \
  --backup /tmp/xqueue-d1-backup.json \
  --evidence /tmp/xqueue-d1-restore-proof.json
```

This command restores into an in-memory isolated SQLite target. It does not write back to Cloudflare.

## Canonical-authority rule

A passing backup/restore proof is necessary but not sufficient for production cutover.

Before #46 can make D1 canonical, the exact production candidate must separately prove:

1. no unresolved reconciliation attempt;
2. current backup identity/hash recorded;
3. isolated restore parity;
4. canonical D1/R2 identity;
5. exactly one publication authority;
6. tested rollback procedure.

#91 does not activate production authority.
