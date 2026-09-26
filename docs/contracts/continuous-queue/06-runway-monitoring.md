<!--tos-doc
{
  "doc_id": "XQ-CQ-0007",
  "class": "contract",
  "claims_truth_state": "declared",
  "written_against": { "head_sha": "8fefc81bddcdcf7e444d26e332dccca232c1939a" },
  "depends_on": ["cloudflare/src/", "scripts/", "src/authoring/"]
}
-->

# Queue Runway and Replenishment Monitoring Contract

Status: proposed.
Requirement prefix: RUNWAY.

## Purpose

A perpetual queue needs an early warning before approved scheduled inventory runs low. Monitoring must surface the problem without acquiring content approval, scheduling mutation, or publication authority.

## Requirements

RUNWAY-1 — The system MUST be able to calculate scheduled runway from the current canonical future assignments and active policy.

RUNWAY-2 — Runway monitoring MUST distinguish at least:
- scheduled future posts;
- approved but unscheduled posts, if that inventory exists;
- upstream candidates/drafts, which do not count as publishable inventory.

RUNWAY-3 — Warning and critical thresholds MUST be owner-configurable policy, not hard-coded business truth.

RUNWAY-4 — Crossing a threshold MAY alert, create a work item, or request content preparation. It MUST NOT self-approve content.

RUNWAY-5 — Runway monitoring MUST NOT mutate the queue or call the X API.

RUNWAY-6 — An alert MUST identify the observation time, current frontier, publishable scheduled count/runway, and threshold that triggered.

RUNWAY-7 — Monitoring failure MUST NOT interfere with already scheduled publication.

RUNWAY-8 — Upstream Author/distillation workflows MAY use low-runway signals to prepare candidates, but those candidates remain upstream until owner-approved ingestion.

RUNWAY-9 — A queue reaching zero approved scheduled items MUST result in no publication rather than filler generation.

## Proposed initial policy, not binding until owner chooses values

A reasonable first operational policy is:
- target: at least 30 days scheduled;
- warning: below 21 days;
- critical: below 14 days.

The thresholds are intentionally recommendations, not requirements.

## Acceptance cases

| Case | Setup | Expected |
|---|---|---|
| RUNWAY-AC-1 | 10 days scheduled, warning threshold 21 | Warning emitted with frontier/count |
| RUNWAY-AC-2 | 30 drafts, 0 approved posts | Publishable runway remains zero |
| RUNWAY-AC-3 | Monitoring service fails | Scheduled publisher continues unaffected |
| RUNWAY-AC-4 | Queue empty | No synthetic/filler post is published |
