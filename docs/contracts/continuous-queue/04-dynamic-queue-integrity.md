<!--tos-doc
{
  "doc_id": "XQ-CQ-0005",
  "class": "contract",
  "claims_truth_state": "proposed",
  "written_against": { "head_sha": "8fefc81bddcdcf7e444d26e332dccca232c1939a" },
  "depends_on": ["cloudflare/generated/", "cloudflare/src/queue-integrity.mjs", "cloudflare/migrations/", "queue.json"]
}
-->

# Dynamic Queue Integrity Contract

Status: proposed.
Requirement prefix: QINT.

## Purpose

The current runtime protects a finite queue by pinning an exact 180-post count and canonical queue SHA in Worker code. That is useful bootstrap evidence but incompatible with a perpetual queue.

The replacement must preserve fail-closed integrity without requiring a code deployment every time approved content is added.

## Requirements

QINT-1 — Production integrity MUST prove the exact canonical queue/assignment revision currently authorized, not a permanently hard-coded lifetime post count.

QINT-2 — Queue count MUST be derived from or stored with the canonical revision and MAY grow indefinitely.

QINT-3 — Every canonical queue revision MUST have an immutable digest over a deterministic representation or equivalent tamper-evident identity.

QINT-4 — Append MUST create a new canonical revision/digest while preserving proof that prior assignments were unchanged.

QINT-5 — The publisher MUST bind eligibility to the current canonical assignment/revision and fail closed on stale or mismatched evidence.

QINT-6 — A Worker code deploy MUST NOT be required solely because the queue gained valid new content.

QINT-7 — A changed canonical queue digest MUST NOT imply that all individual assignments changed. Per-assignment identity/version remains authoritative for stale-work fencing.

QINT-8 — Canonical queue metadata MUST include enough information to detect missing/duplicate active assignments and conflicting occupied slots.

QINT-9 — Integrity read failure or ambiguous revision state MUST fail closed for publication.

QINT-10 — Migration from the static bundle MUST prove exact parity for all existing committed assignments before dynamic integrity becomes authoritative.

QINT-11 — Static bundle/hash evidence MAY remain as rollback evidence during migration but MUST NOT create a second live scheduling authority.

QINT-12 — Historical revision evidence MUST remain inspectable after later appends.

## Acceptance cases

| Case | Setup | Expected |
|---|---|---|
| QINT-AC-1 | Count grows 180 -> 181 | New canonical revision accepted without Worker source edit |
| QINT-AC-2 | One prior assignment mutates unexpectedly during append | Integrity/apply refuses |
| QINT-AC-3 | Runtime holds stale canonical revision | No dispatch |
| QINT-AC-4 | Canonical metadata unavailable | Fail closed |
| QINT-AC-5 | Migration from static queue | All existing assignments/digests prove parity before activation |
