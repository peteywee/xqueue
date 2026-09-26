<!--tos-doc
{
  "doc_id": "XQ-CQ-0002",
  "class": "contract",
  "claims_truth_state": "declared",
  "written_against": { "head_sha": "8fefc81bddcdcf7e444d26e332dccca232c1939a" },
  "depends_on": ["content/", "src/authoring/", "scripts/authoring-cli.mjs", "src/parse.mjs"]
}
-->

# Approved Content Intake Contract

Status: proposed.
Requirement prefix: INTAKE.

## Boundary

The input is a finished post the owner has already approved before production ingestion.

XQueue may persist the exact approved bytes into its governed content inventory, but this is mechanical ingestion, not authoring.

## Minimum logical input

- finished post body;
- stable pillar/category metadata when required by current account policy;
- a stable content identity or enough information to allocate one safely;
- optional title and source/provenance reference;
- owner-action evidence appropriate to the invocation path.

## Requirements

INTAKE-1 — Production ingestion MUST preserve the approved post body exactly. No silent copy-editing, summarization, expansion, truncation, or model rewrite is permitted.

INTAKE-2 — Validation MAY reject operationally invalid content but MUST return a reason rather than altering the content to make it pass.

INTAKE-3 — Duplicate content IDs MUST fail closed.

INTAKE-4 — Duplicate exact content submitted under the same intended identity MUST be idempotent rather than create a second queued item.

INTAKE-5 — Content origin MUST be metadata only for runtime scheduling. A post from bulk conversation distillation and a manually written post follow the same scheduling path.

INTAKE-6 — Owner-manual ingestion MAY use the owner-controlled invocation as the approval event. Automated upstream handoff MUST carry explicit owner-approval evidence; generation alone is never approval evidence.

INTAKE-7 — The exact accepted content digest MUST be recorded before assignment.

INTAKE-8 — A failed ingestion MUST NOT create a live schedule assignment.

INTAKE-9 — Ambiguous mutation results MUST be independently read back before retry. The system MUST NOT blindly repeat a possibly successful write.

INTAKE-10 — Intake MUST support an approved-unscheduled state so content can be safely stored even when assignment cannot yet be committed.

INTAKE-11 — Intake MUST NOT call the X API.

INTAKE-12 — Intake MUST NOT move or delete existing assignments.

## Validation boundary

Operational validation may include:
- schema/required metadata;
- size/platform constraints;
- stable ID uniqueness;
- prohibited malformed media references;
- current account policy checks that are explicitly part of runtime safety.

Editorial taste remains upstream.

## Acceptance cases

| Case | Setup | Expected |
|---|---|---|
| INTAKE-AC-1 | Valid finished post | Exact digest persisted; content unchanged |
| INTAKE-AC-2 | Too-long post | Refused with reason; no rewrite |
| INTAKE-AC-3 | Same request replayed | No duplicate item |
| INTAKE-AC-4 | Mutation response ambiguous | Readback determines state before any retry |
| INTAKE-AC-5 | Automated handoff lacks owner approval evidence | Refused |
| INTAKE-AC-6 | Assignment subsystem unavailable | Content may remain approved-unscheduled; no phantom assignment |
