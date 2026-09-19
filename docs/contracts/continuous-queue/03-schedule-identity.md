<!--tos-doc
{
  "doc_id": "XQ-CQ-0004",
  "class": "decision",
  "claims_truth_state": "declared",
  "written_against": { "head_sha": "8fefc81bddcdcf7e444d26e332dccca232c1939a" },
  "depends_on": ["config/schedule-policy.json", "src/schedule.mjs", "cloudflare/src/publication-ledger.mjs", "cloudflare/migrations/", "docs/contracts/"]
}
-->

# Schedule Identity and Version Model — Owner Decision for #47

Status: owner-approved decision.
Decision prefix: SV.
Approved: 2026-09-19.
Owner: Patrick Craven.

## Problem

One scalar `schedule_version` is too ambiguous for the perpetual-queue model. It conflates two different facts:

1. which scheduling policy produced an assignment;
2. which revision of a particular content item's assignment is current.

These are separate identities and MUST remain separate.

## Authoritative model

Every committed schedule assignment carries:

- `assignment_id` — stable identity for the content item's schedule lineage;
- `assignment_version` — monotonic integer for that content item's schedule lineage;
- `policy_version` — monotonic integer identifying the owner-approved scheduling policy used to create that assignment;
- `resolved_at` — exact UTC publication instant;
- local date/time/timezone metadata;
- `content_id`;
- exact `content_digest`.

The publication fence/event carries the composite schedule identity:

`assignment_id + assignment_version + policy_version + content_digest`.

## Authoritative storage

SV-1 — Once the durable scheduling model is implemented, the authoritative schedule identity MUST live with the canonical durable assignment projection in D1. Git SHA, Worker bundle SHA, timestamps, source-file order, queue hash, or runtime memory MUST NOT be used as the schedule version.

SV-2 — `assignment_id` is the stable schedule-lineage key for one content item. For the bootstrap migration of the existing queue, `assignment_id` is the existing stable post ID.

SV-3 — A newly scheduled content item starts at `assignment_version = 1`.

SV-4 — `policy_version` is the integer `version` of the owner-approved scheduling policy. The current bootstrap policy is `config/schedule-policy.json.version = 2`, so migrated existing assignments receive `policy_version = 2`.

## Increment semantics

SV-5 — Appending unrelated content MUST NOT increment existing items' `assignment_version`.

SV-6 — Changing an item's active publication slot MUST supersede the prior assignment and increment that item's `assignment_version` exactly once.

SV-7 — Deferral/reschedule increments `assignment_version` because the authoritative slot changed.

SV-8 — Retry or reevaluation of the same assignment without changing its slot MUST NOT increment `assignment_version`.

SV-9 — Content text changes MUST NOT be disguised as an assignment-version change. Content revision/digest is a separate identity.

SV-10 — A scheduling-policy change MUST increment `policy_version`. It MUST NOT rewrite existing assignments by default.

SV-11 — An explicit owner-approved reflow MAY supersede future assignments under a new `policy_version`; each changed item receives a new `assignment_version`.

## Publisher read and proof semantics

SV-12 — Eligibility and dispatch MUST read the exact current assignment from canonical durable scheduling state and bind `assignment_id`, `assignment_version`, `policy_version`, and `content_digest` into immutable publication fence/event evidence.

SV-13 — A publisher or workflow holding a stale `assignment_version`, stale `policy_version` for that assignment, or mismatched `content_digest` MUST fail closed before dispatch.

SV-14 — The publisher MUST NOT reconstruct schedule identity from current policy files or current queue shape after the assignment has been committed. The committed assignment is the authority.

## Bootstrap / migration semantics

SV-15 — Migration of the existing 180-item static queue MUST preserve every current committed resolved slot exactly. Migration MUST NOT reflow the queue.

SV-16 — Each existing item is initialized with:
- `assignment_id = existing post_id`;
- `assignment_version = 1`;
- `policy_version = 2`;
- exact current resolved UTC instant;
- current local scheduling metadata;
- exact current content digest.

SV-17 — The migration MUST prove one-to-one parity between the pre-migration static queue and the durable assignment set before durable assignments become publication-authoritative.

SV-18 — If any existing assignment cannot be mapped unambiguously, activation MUST stop. No guessed version, slot, or digest is permitted.

## Why this matches the product vision

Adding post 181 does not make posts 1–180 stale merely because the queue grew. Per-item assignment versioning gives stale-writer protection without turning every append into a global schedule mutation.

A policy change can coexist with already committed assignments: old items remain evidence-bound to the policy under which they were created; new items use the current policy.

## Acceptance cases

| Case | Setup | Expected |
|---|---|---|
| SV-AC-1 | Append A181 | A1–A180 assignment versions unchanged; A181 gets version 1 |
| SV-AC-2 | Defer A61 | A61 version n is superseded; replacement is n+1 |
| SV-AC-3 | Retry same A61 assignment | Version unchanged |
| SV-AC-4 | Change posting policy | Policy version increments; committed assignments stay fixed unless owner reflow occurs |
| SV-AC-5 | Stale worker wakes on A61 version n after n+1 exists | Refuse before dispatch |
| SV-AC-6 | Existing 180-item bootstrap migration | All slots/digests map one-to-one; each starts assignment_version 1 and policy_version 2 |
| SV-AC-7 | Migration parity mismatch | Activation refuses |
| SV-AC-8 | Current policy file changes after assignment | Publisher still uses the assignment's committed policy/version identity |

## Effect on dependent work

This decision resolves OQ-WF-6 / issue #47. It unblocks the schedule-version portion of #41 and provides the version model consumed by #53, #54, dynamic append work, and eventual #46 activation evidence.
