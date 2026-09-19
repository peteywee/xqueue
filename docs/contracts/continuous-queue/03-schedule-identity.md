<!--tos-doc
{
  "doc_id": "XQ-CQ-0004",
  "class": "decision-proposal",
  "claims_truth_state": "proposed",
  "written_against": { "head_sha": "8fefc81bddcdcf7e444d26e332dccca232c1939a" },
  "depends_on": ["config/schedule-policy.json", "src/schedule.mjs", "cloudflare/src/publication-ledger.mjs", "docs/contracts/"]
}
-->

# Schedule Identity and Version Model — Proposed Resolution for #47

Status: proposed owner decision.
Decision prefix: SV.

## Problem

One scalar schedule_version is too ambiguous for the perpetual-queue model. It conflates two different facts:
1. which scheduling policy produced an assignment;
2. which revision of a particular item's assignment is current.

These must be separate.

## Proposed model

Every committed assignment carries:

- assignment_id — stable identity for the logical assignment lineage;
- assignment_version — monotonic integer for that content item's assignment lineage;
- policy_version — identity of the scheduling policy used to create that assignment;
- resolved_at — exact UTC publication instant;
- local scheduling metadata;
- content_id and exact content_digest.

The publication fence/event carries the composite schedule identity:
assignment_id + assignment_version + policy_version.

## Proposed requirements

SV-1 — A newly scheduled content item starts at assignment_version 1.

SV-2 — Appending unrelated content MUST NOT increment existing items' assignment versions.

SV-3 — Changing an item's active slot MUST supersede the prior assignment and increment that item's assignment_version exactly once.

SV-4 — Deferral/reschedule MUST increment assignment_version because the authoritative slot changed.

SV-5 — Retry of the same publication transaction without changing the slot MUST NOT increment assignment_version.

SV-6 — Content text changes MUST NOT be disguised as an assignment-version change. Content revision/digest is a separate identity.

SV-7 — Scheduling policy changes create a new policy_version. They MUST NOT rewrite existing assignments by default.

SV-8 — An explicit owner-approved reflow may supersede future assignments under a new policy_version; every changed item receives a new assignment_version.

SV-9 — Publication eligibility/fence evidence MUST bind both assignment_version and policy_version.

SV-10 — A mismatch in either current assignment_version or bound content_digest MUST fail closed before dispatch.

SV-11 — policy_version representation may be an integer, digest, or durable ID, but its canonical storage and increment/change rule must be deterministic and auditable.

## Why this matches the product vision

Adding post 181 must not make posts 1–180 stale merely because the queue grew. Per-item assignment versioning gives stale-writer protection without turning every append into a global schedule mutation.

A policy change can also coexist with already committed assignments: old items remain evidence-bound to the policy under which they were created; new items use the current policy.

## Acceptance examples

- Append A181: A1–A180 assignment versions unchanged; A181 version 1.
- Defer A61: A61 version n becomes superseded; replacement is n+1.
- Change posting slots: policy version increments; existing committed assignments stay fixed unless owner reflow is invoked.
- Stale worker wakes on A61 version n after n+1 exists: refuse before dispatch.

## Owner approval effect

If Patrick approves this decision, issue #47 can treat the composite identity above as the normative schedule-version model consumed by #41, #53, #54, and eventual #46 evidence.
