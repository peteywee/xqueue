<!--tos-doc
{
  "doc_id": "XQ-CQ-0006",
  "class": "contract",
  "claims_truth_state": "proposed",
  "written_against": { "head_sha": "8fefc81bddcdcf7e444d26e332dccca232c1939a" },
  "depends_on": ["src/authoring/", "content/", "src/schedule.mjs", "cloudflare/src/"]
}
-->

# Bulk Approved-Post Ingestion Contract

Status: proposed.
Requirement prefix: BULK.

## Purpose

Bulk conversation distillation or another upstream workflow may produce many finished owner-approved posts. Bulk ingestion must be a batching convenience, not a separate scheduling or publication architecture.

## Requirements

BULK-1 — Bulk and single-item ingestion MUST use the same underlying intake and assignment rules.

BULK-2 — A batch MUST have a stable ordered manifest. Input order, or another owner-approved deterministic ordering rule, determines append order.

BULK-3 — Dry run MUST report every proposed content ID, digest, assignment slot, and any rejected item before mutation.

BULK-4 — By default, any blocking item SHOULD cause the batch apply to refuse before mutation unless an explicit partial-batch mode is later approved.

BULK-5 — Apply MUST revalidate the canonical frontier, ID uniqueness, input digests, and batch digest against the dry-run plan.

BULK-6 — Replaying the exact same successful batch MUST be idempotent and MUST NOT duplicate content or assignments.

BULK-7 — A partially observed/ambiguous batch mutation MUST be reconciled by exact per-item readback before retry.

BULK-8 — Batch ingestion MUST NOT reorder or move previously committed assignments.

BULK-9 — Batch ingestion MUST NOT call the X API.

BULK-10 — The source may be conversation distillation, XQueue Author, manual files, or another governed producer; runtime semantics remain identical.

BULK-11 — Automated upstream handoff MUST carry explicit owner approval evidence for the exact batch or exact items. A model-generated batch cannot self-authorize production ingestion.

BULK-12 — The batch record MUST preserve source references where supplied but source provenance MUST NOT alter slot selection.

## Acceptance cases

| Case | Setup | Expected |
|---|---|---|
| BULK-AC-1 | 20 valid posts | 20 deterministic tail assignments; existing queue unchanged |
| BULK-AC-2 | One duplicate ID in batch | Default apply refuses before mutation |
| BULK-AC-3 | Exact batch replay | No duplicates; reports already applied |
| BULK-AC-4 | Frontier changes after dry run | Apply refuses stale batch plan |
| BULK-AC-5 | Response lost during apply | Readback reconciles each item before retry |
