<!--tos-doc
{
  "doc_id": "XQ-CQ-0003",
  "class": "contract",
  "claims_truth_state": "declared",
  "written_against": { "head_sha": "8fefc81bddcdcf7e444d26e332dccca232c1939a" },
  "depends_on": ["config/schedule-policy.json", "src/schedule.mjs", "cloudflare/src/", "cloudflare/migrations/"]
}
-->

# Append-Only Assignment Contract

Status: proposed.
Requirement prefix: APPEND.

## Definitions

Scheduling frontier: the latest committed active future assignment among unresolved content.

Append: assigning previously unscheduled approved content strictly after the current frontier using the active scheduling policy.

Reflow: changing one or more existing committed assignments. Reflow is not append.

## Requirements

APPEND-1 — Ordinary add MUST be append-only.

APPEND-2 — An append operation MUST NOT alter the resolved instant, local time metadata, content binding, assignment identity, or assignment version of any previously committed item.

APPEND-3 — A new automatic assignment MUST use the earliest policy-valid unoccupied slot strictly after the scheduling frontier.

APPEND-4 — Ordinary append MUST NOT backfill an earlier empty or missed slot.

APPEND-5 — New content MUST receive a durable assignment identity and initial assignment version before it becomes publication-eligible.

APPEND-6 — The committed assignment MUST contain an exact resolved UTC instant plus the local date/time/timezone metadata used to derive it.

APPEND-7 — Assignment creation MUST bind the exact content ID and content digest.

APPEND-8 — Assignment creation MUST bind the active scheduling policy version.

APPEND-9 — The publisher MUST refuse a stale or superseded assignment version.

APPEND-10 — Append MUST be deterministic for the same canonical state, active policy, and ordered input set.

APPEND-11 — Dry run MUST be the default for operator-facing add commands. Dry run shows proposed IDs/slots and proves the non-movement invariant without mutating production.

APPEND-12 — Apply MUST re-read the canonical frontier and fail on drift rather than applying a stale dry-run plan.

APPEND-13 — A successful append MUST produce durable evidence sufficient to prove which assignments were added and that prior assignments were not modified.

APPEND-14 — Policy changes MUST affect new appends only unless an explicit owner-approved reflow operation says otherwise.

APPEND-15 — Missed-slot replacement and manual rescheduling SHOULD reuse the same assignment primitive, but they are supersession operations rather than append and must preserve prior assignment history.

## Acceptance cases

| Case | Setup | Expected |
|---|---|---|
| APPEND-AC-1 | 180 committed items, add one | Item 181 receives next tail slot; prior 180 assignments identical |
| APPEND-AC-2 | Empty historical slot exists before frontier | Append ignores it |
| APPEND-AC-3 | Frontier changes between dry run and apply | Apply refuses stale plan |
| APPEND-AC-4 | Two new posts in fixed order | Deterministic consecutive valid tail slots |
| APPEND-AC-5 | Publisher sees superseded assignment version | No dispatch |
| APPEND-AC-6 | Active policy changed after old assignments | Old assignments remain fixed; new append records new policy version |
