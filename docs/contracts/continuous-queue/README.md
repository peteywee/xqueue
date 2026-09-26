<!--tos-doc
{
  "doc_id": "XQ-CQ-0000",
  "class": "contract-package",
  "claims_truth_state": "declared",
  "written_against": { "head_sha": "8fefc81bddcdcf7e444d26e332dccca232c1939a" },
  "depends_on": [
    "config/schedule-policy.json",
    "content/",
    "src/schedule.mjs",
    "src/authoring/",
    "cloudflare/src/",
    "cloudflare/generated/",
    "cloudflare/migrations/",
    "docs/architecture/"
  ]
}
-->

# Continuous Queue Contract Package

Status: declared — owner-approved normative contract package; implementation verification remains evidence-driven.
Written against main: 8fefc81bddcdcf7e444d26e332dccca232c1939a
Owner: Patrick Craven
Created: 2026-09-19

## Fixed product intent

XQueue is a perpetual, governed publishing queue.

The owner or an upstream content workflow supplies finished, already-approved post content. XQueue does not need to decide whether that content is good, rewrite it, or obtain a second editorial approval. Its responsibility begins at the ingestion boundary: preserve the approved content exactly, validate operational constraints, give it a stable identity, append a durable future assignment without moving existing committed assignments, and publish it later through the single authorized publisher.

The queue must not have a designed end date. The current 180-post campaign is bootstrap data, not the long-term architecture.

## One product, two bounded spaces

Upstream content intelligence may include manual writing, ChatGPT/Claude work, bulk conversation distillation, XQueue Author, project evidence, or another governed authoring workflow.

Runtime publishing owns ingestion, durable assignment, eligibility, publication fencing, outcome evidence, recovery, and queue runway.

All upstream paths converge on the same finished-post ingestion boundary. Source origin must not create a second scheduler or publication path.

## Package contents

1. 00-product-boundary.md — what XQueue is and is not.
2. 01-approved-content-intake.md — contract for receiving finished approved posts.
3. 02-append-only-assignment.md — append semantics and the scheduling frontier.
4. 03-schedule-identity.md — proposed resolution for issue #47: assignment version and policy version are separate.
5. 04-dynamic-queue-integrity.md — integrity without a hard-coded 180-post count/hash.
6. 05-bulk-ingestion.md — deterministic single/batch behavior.
7. 06-runway-monitoring.md — queue-low monitoring without content or publication authority.\n8. ../scheduling-and-missed-slot-contract.md — canonical scheduling, missed-slot, append, and replacement semantics.

## Scope guard

This package does not activate the older v0.2.0 contract set. The #46 production cutover is a separate evidence-gated implementation/operations event and has now executed; these contracts remain normative independently of that activation.

It also does not require XQueue Author to be the only way content enters the queue. XQueue Author remains an optional upstream helper.

The following are explicitly outside this package unless referenced by interface:
- generating or rewriting post prose;
- deciding editorial approval;
- self-approving AI output;
- changing X credentials;
- moving production authority;
- implementing a second scheduler;
- automatically reflowing existing assignments;
- automatically publishing merely because content was ingested.

## Historical implementation mismatch recorded, not normalized

At the written-against head, production scheduling was still built around a finite 180-post corpus and the Worker integrity gate pinned an expected count/hash. That mismatch drove the continuous-queue implementation and #46 cutover. The historical note is retained as rationale; current production runtime authority is documented in README.md and docs/RUNBOOK.md.

## Owner decisions intentionally left open

The contracts below freeze behavior first and leave narrow implementation choices open:
- exact storage representation for canonical content inventory;
- exact D1 schema for assignments and queue revisions;
- owner-proof representation for automated upstream handoff;
- initial runway warning/critical thresholds;
- migration sequencing from the static queue bundle.

Those choices may change implementation, but they must not weaken the fixed product intent above.
