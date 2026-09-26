<!--tos-doc
{
  "doc_id": "XQ-CQ-0001",
  "class": "contract",
  "claims_truth_state": "declared",
  "written_against": { "head_sha": "8fefc81bddcdcf7e444d26e332dccca232c1939a" },
  "depends_on": ["content/", "src/authoring/", "src/schedule.mjs", "cloudflare/src/"]
}
-->

# Continuous Queue Product Boundary Contract

Status: proposed.
Requirement prefix: CQ.

## Purpose

This contract prevents XQueue from drifting into either an AI authoring product that publishes autonomously or a finite campaign generator that must be rebuilt whenever content grows.

## Requirements

CQ-1 — XQueue MUST support an indefinitely extensible queue. No product rule may require a terminal campaign date or fixed lifetime post count.

CQ-2 — A finished post presented at the production ingestion boundary MUST be treated as editorially complete. XQueue MUST NOT rewrite its title/body as part of ingestion or scheduling.

CQ-3 — Editorial approval occurs upstream of production ingestion. XQueue MUST NOT infer approval merely because an AI generated a draft.

CQ-4 — Manual writing, bulk conversation distillation, XQueue Author, and other governed upstream workflows MUST converge on one production ingestion contract.

CQ-5 — Content authority, scheduling authority, and publication authority MUST remain distinct. Supplying approved content does not itself authorize an X API call.

CQ-6 — There MUST be only one production publication path for routine scheduled posts. New ingestion features MUST reuse it rather than add a second publisher.

CQ-7 — Adding content MUST extend the queue without moving any already committed assignment unless a separate explicit reschedule/reflow operation authorizes that movement.

CQ-8 — The current finite corpus and current 180-post queue MUST be treated as migration/bootstrap state, not normative queue capacity.

CQ-9 — A content record and a schedule assignment MUST have separate identities. Editing or replacing one MUST NOT silently mutate the other.

CQ-10 — A scheduled assignment MUST bind to the exact content revision/digest intended for publication. Changing content after assignment requires an explicit new content revision and a governed decision about whether to supersede the assignment.

CQ-11 — A policy change MUST NOT silently reflow existing assignments. Existing assignments retain the policy identity under which they were committed until an explicit reflow/reschedule supersedes them.

CQ-12 — Upstream AI/provider availability MUST NOT be required for an already-ingested approved post to publish on schedule.

## Prohibited shortcuts

- Rebuilding the whole future queue whenever one post is added.
- Filling old schedule holes opportunistically during ordinary append.
- Letting a model call queue apply or publish because it authored the text.
- Making queue length or one source-file hash the permanent definition of production integrity.
- Treating authoring approval and publication authority as the same permission.

## Acceptance cases

| Case | Setup | Expected |
|---|---|---|
| CQ-AC-1 | Add one approved post to a populated future queue | Every prior committed assignment is unchanged; exactly one new tail assignment appears |
| CQ-AC-2 | AI provider is unavailable after ingestion | Existing scheduled post remains publishable |
| CQ-AC-3 | Upstream source is manual instead of AI | Same ingestion and scheduling path |
| CQ-AC-4 | Policy version changes | Existing assignments do not move without explicit reflow |
| CQ-AC-5 | Content body changes after assignment | Existing assignment does not silently point at changed bytes |
