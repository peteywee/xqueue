
> Historical status: this reverse-engineered roadmap drove the continuous-queue program. The implementation has now passed the #46 production cutover; current production authority and rollback instructions live in `docs/RUNBOOK.md`, while #48 tracks remaining program closeout. Future-tense descriptions below are retained as design history and are not current operator instructions.
# XQueue Continuous Queue — Reverse Plan from End Goal to Current State

Status: planning baseline
Written against main: `8fefc81bddcdcf7e444d26e332dccca232c1939a`
Contract package: draft PR #87
Contract head at time of writing: `511832266714c5725cf425e7ea4acf4273c08eb7`
Created: 2026-09-19
Owner: Patrick Craven

## 0. End goal

XQueue is done when Patrick can supply one or many finished, already-approved posts and the system can keep publishing indefinitely without rebuilding or reflowing the existing queue.

The steady-state system has these properties:

1. Approved content can be ingested one at a time or in deterministic batches.
2. Existing committed assignments never move during ordinary append.
3. Every post has an exact content identity/digest.
4. Every scheduled item has an exact durable assignment identity, assignment version, policy version, and resolved UTC instant.
5. New content receives the next valid unoccupied slot after the scheduling frontier.
6. Schedule changes, content changes, skips, deferrals, replacements, and owner reflows are explicit operations with durable evidence.
7. The production publisher reads canonical runtime content and assignments without requiring a Worker deploy for every new post.
8. Media metadata is runtime-addressable; adding a post with media does not require rebuilding a generated Worker manifest.
9. Exactly one production publication authority exists and is enforced in code.
10. Publication fences bind the exact lease, assignment identity/version, policy version, and content digest.
11. Ambiguous publication outcomes stop automation until reconciled.
12. A global halt can stop publication immediately without a deploy and only the owner can clear it.
13. Runtime content, assignments, state, events, authority, and recovery evidence can be backed up, restored, and independently verified.
14. Queue runway is visible and alerts before approved inventory runs low.
15. If approved inventory reaches zero, XQueue publishes nothing rather than inventing filler.
16. Manual writing, bulk conversation distillation, XQueue Author, and future upstream content tools all feed the same intake boundary.
17. Contracts, README, runbook, issue tracker, and production reality describe the same system.

The end-to-end flow is:

```text
finished owner-approved post(s)
          |
          v
validated exact-content intake
          |
          v
canonical runtime content inventory
          |
          v
append-only durable assignment
          |
          v
canonical queue revision / integrity proof
          |
          v
one authorized Cloudflare publisher
          |
          v
lease + exact assignment/content fence
          |
          v
X side effect
          |
          v
durable outcome / reconciliation evidence
```

---

# Reverse Gate 8 — Normal operation is boring

This is the final operational state. Nothing below may be called complete until these user-facing workflows work reliably.

## Single post

Patrick has a finished approved post.

Expected operator experience:

```text
queue add <post>
  -> dry-run by default
  -> validates exact bytes/metadata
  -> shows proposed stable ID and next valid slot
  -> proves no existing assignment changes
  -> apply requires explicit action
  -> reads back exact content + assignment + queue revision
```

## Bulk posts

Patrick finishes or bulk-distills 10/50/100 approved posts.

Expected experience:

```text
queue add-batch <manifest>
  -> stable input digest
  -> deterministic order
  -> dry-run all proposed assignments
  -> default all-or-nothing apply
  -> idempotent exact replay
  -> exact readback after write
```

## Queue monitoring

At any time Patrick can see:

- next post and exact slot;
- number of scheduled future posts;
- days of scheduled runway;
- approved but unscheduled inventory;
- deferred/reconciliation counts;
- current policy version;
- current canonical queue revision;
- current production publisher/authority;
- halt state;
- last successful scheduled invocation;
- last publication outcome;
- next action if anything is unhealthy.

### Hidden work required for Gate 8

This operator surface does not exist today as one coherent workflow. Current CLI commands were designed around generated Markdown -> queue.json -> local state.

---

# Reverse Gate 7 — Recovery is trustworthy

Before normal operation can be called production-complete, the perpetual queue must survive failures without losing newly ingested content or creating duplicate posts.

## Required recovery capabilities

### 7.1 D1 content/assignment backup

The future canonical queue will contain data that does not exist in Git history:

- newly ingested content;
- content revisions;
- assignment versions;
- superseded assignments;
- dynamic queue revisions;
- deferred state;
- append/bulk operation records.

A backup/restore strategy is therefore required.

It must prove:

- exact export identity/hash;
- restore into an isolated target;
- row/event parity;
- assignment/content digest parity;
- no duplicate active slots;
- no loss of publication outcomes;
- generation/version preservation.

**Blind spot:** #59 mirror recovery only mirrors local ledger metadata and is not a backup strategy for future dynamic content/assignments.

### 7.2 D1 reconciliation command

The repo has a local CLI reconciliation path, but the perpetual Cloudflare/D1 runtime needs an operator-safe D1 reconciliation surface for ambiguous publication outcomes.

It must:

- inspect raw evidence;
- never redispatch while outcome is unknown;
- record owner determination;
- preserve original evidence;
- CAS the exact current row/version;
- independently read back the result.

**Blind spot:** there is no dedicated open issue for this future D1 operator workflow.

### 7.3 Rollback

Rollback must answer separately:

1. What happens if new intake/assignment code is bad?
2. What happens if the dynamic queue reader is bad?
3. What happens if Cloudflare publishing is bad?
4. What happens if D1 is unavailable/corrupt?
5. Can we roll back code without rolling back already-ingested data?
6. Can old code understand new schema, or must rollback use a compatibility reader?

Rollback MUST NOT resurrect an older queue snapshot and silently discard newly appended content.

---

# Reverse Gate 6 — Production activation/cutover is proven

This is the future #46 gate after the continuous-queue implementation exists.

## Preconditions

All of the following are complete:

- #41 exact fence evidence;
- #44 global halt;
- #45 credential/deployment authority decision and implementation;
- #52 exact resolved UTC assignment model;
- #53 durable deferred lifecycle;
- #54 durable replacement assignment model;
- canonical runtime content inventory;
- append/bulk ingestion;
- dynamic queue integrity;
- dynamic media metadata;
- D1 backup/restore drill;
- D1 reconciliation command;
- static-queue -> durable-queue migration proof.

## Cutover sequence

The exact implementation may change, but the proof sequence should be:

1. Freeze exact candidate.
2. Prove production schema/backward compatibility.
3. Backfill current 180 content records and assignments.
4. Prove one-to-one parity with the current static queue.
5. Shadow-read dynamic queue beside static queue.
6. Prove identical eligibility/next-selection for a bounded period.
7. Enable dynamic queue as the read authority while publication remains otherwise unchanged.
8. Prove one and only one production publisher.
9. Prove halt behavior.
10. Prove exact publication using dynamic content + assignment evidence.
11. Prove recovery/reconciliation.
12. Retire static bundle as authority.
13. Retire local/systemd publication authority only under explicit rollback criteria.
14. Record exact production evidence.
15. Keep rollback data until the stabilization window is explicitly complete.

## Key rule

Migration is not complete because tables exist.

Migration is complete only when the publisher's authoritative read path uses the durable model and the old path can no longer silently disagree.

---

# Reverse Gate 5 — Publisher consumes dynamic runtime truth

Today's production publisher still imports:

- `cloudflare/generated/queue-bundle.mjs`
- `cloudflare/generated/media-manifest.mjs`

Therefore appending data to D1 alone would not make a new post publishable.

This gate replaces generated deployment-time content with runtime-addressable data while preserving fail-closed integrity.

## 5.1 Canonical runtime content inventory

A runtime-authoritative content store is required.

Logical record needs at least:

- content_id;
- content_revision/version;
- exact body;
- exact content_digest;
- pillar/category metadata;
- publication rendering metadata;
- media references;
- created/accepted time;
- provenance reference where supplied;
- lifecycle status: approved-unscheduled / scheduled / retired or equivalent.

### Architecture decision still needed

Where does exact post content live at runtime?

Recommended default to evaluate:
- structured text/metadata in D1;
- media bytes in R2;
- exact media identity/hash metadata in D1;
- Git Markdown remains authoring/reference history, not the only runtime publication source.

**Blind spot:** current repo documentation still says `content/*.md` is the content source of truth. The perpetual model requires a deliberate split between authoring source/history and runtime canonical publication content.

## 5.2 Dynamic assignments

Need durable assignment projection and event history containing:

- assignment_id;
- content_id;
- content_digest;
- assignment_version;
- policy_version;
- resolved_at UTC;
- local date/time/timezone;
- active/superseded state;
- superseded assignment reference;
- generation/CAS field;
- created_by owner/automation provenance.

## 5.3 Dynamic queue revision/integrity

The current Worker pins:
- expected count = 180;
- exact queue SHA;
- exact deferred tail.

Future integrity must instead verify a canonical runtime revision.

Required properties:

- deterministic revision digest;
- exact active assignment count;
- no duplicate active content;
- no duplicate occupied slot;
- per-assignment digest/version validity;
- content digest exists and matches;
- revision/generation cannot move backward;
- stale runtime snapshot refuses publication.

A code deploy must not be required solely because item 181 exists.

## 5.4 Dynamic media metadata

Current generated media manifest is hard-coded to four objects.

Future media path must support new content without Worker rebuild:

- content -> media reference stored durably;
- R2 key;
- byte size;
- SHA-256;
- MIME/extension;
- upload/verification status;
- exact binding to content revision.

Publisher verifies the exact referenced R2 object before dispatch.

**Blind spot:** no current issue tracks this migration.

## 5.5 Dynamic readiness/health

`/health` must eventually report runtime integrity based on durable content/assignments/media instead of generated queue/media modules.

---

# Reverse Gate 4 — Durable scheduling lifecycle is complete

This is where existing issues #52, #53, and #54 converge with the new continuous-queue model.

## #52 — exact assignment time

Must finish:

- exact resolved UTC persisted at assignment commit;
- invalid/nonexistent/ambiguous local times rejected;
- runtime does not re-resolve wall clock at dispatch;
- existing 180 slots migrate with exact instant parity.

## #53 — missed slot / deferred

Must finish:

- stale slot cannot dispatch;
- missed content becomes deferred;
- no catch-up burst;
- durable deferral evidence;
- needs_reconciliation never auto-deferred.

## #54 — replacement assignment

Must finish after #53:

- durable supersession;
- deterministic replacement after frontier;
- per-item assignment version increments;
- policy version preserved;
- owner override audited;
- stale wakeup fenced.

## New append operation

Ordinary append and replacement scheduling must share one low-level assignment primitive while remaining different operations:

```text
append:
  no prior assignment
  -> create v1 after frontier

reschedule:
  existing active assignment vN
  -> supersede
  -> create vN+1
```

This prevents two different schedulers from evolving.

---

# Reverse Gate 3 — Intake and queue growth exist

This is the main missing product feature.

## 3.1 Single finished-post intake

Need one command/API boundary whose default mode is dry-run.

It must:

1. accept already-approved finished content;
2. preserve exact text;
3. validate operational rules;
4. allocate/validate stable content identity;
5. compute exact digest;
6. verify no duplicate identity/content conflict;
7. calculate next valid slot using canonical frontier;
8. prove existing assignments unchanged;
9. atomically or safely stage content + assignment;
10. independently read back;
11. return exact resulting IDs/revision.

## 3.2 Approved-unscheduled inventory

Content and assignment cannot be one inseparable write.

If content is valid but scheduling cannot be committed, the system needs an explicit approved-unscheduled state instead of losing the content or inventing a slot.

This also becomes useful for maintaining an inventory buffer.

## 3.3 Bulk intake

Need deterministic manifest/batch identity and idempotency.

Questions the implementation must answer:

- all-or-nothing by default?
- max batch size?
- stable order source?
- how to reconcile a partial/ambiguous multi-row write?
- how to resume a large batch safely?
- how to distinguish exact replay from altered batch contents?

The contract currently recommends default all-or-nothing behavior.

## 3.4 Content revision after scheduling

A hidden operational need:

What if Patrick discovers a typo or wants to change a scheduled post?

Do NOT mutate published intent invisibly.

Required model:

- content revision is explicit;
- original revision retained;
- assignment either remains bound to old digest or is explicitly rebound/superseded;
- if due/publishing, edits fail closed;
- posted content is immutable historical evidence.

This needs an owner-facing operation and tests.

## 3.5 Cancellation / removal

A perpetual queue also needs a safe answer to:
"Do not publish this future post."

Do not physically delete evidence.

Likely operation:
- owner skip/cancel with durable reason;
- assignment retired/superseded;
- optional replacement slot remains separate.

This must align with existing owner-only skip semantics.

## 3.6 Stable ID policy

Current IDs are pillar/campaign-shaped (A1, B1, etc.).

Before indefinite growth, define whether:
- pillar IDs continue indefinitely (A73, A74...);
- content receives a global opaque ID plus display ID;
- external batch tools may supply IDs.

Identity must not depend on queue position because queue position changes over time.

---

# Reverse Gate 2 — Publication safety is complete

## #41 — exact publication fence

Now unblocked.

Fence/event must bind:

- lease generation/holder;
- assignment_id;
- assignment_version;
- policy_version;
- content_digest;
- dispatch begin;
- attempt/outcome.

Any stale mismatch refuses before side effect.

## #44 — global halt

Still a real owner/architecture decision.

End-state requirement:

- durable;
- read at publication start;
- fail closed if unreadable;
- automation may set;
- only owner may clear;
- set/clear evidence append-only;
- no deploy required.

Recommended architecture to evaluate:
- D1 singleton control projection + append-only halt events;
- owner-clear command with explicit owner authentication/authorization;
- generation/CAS so stale clear cannot erase a newer halt.

## #45 — structural credential separation

Current Worker serves `/health` and scheduled publication from the same deployable that can receive X credentials.

End-state question:
Should non-publishing HTTP/control paths be structurally incapable of X writes?

Recommended target to evaluate:
- control/read-only Worker: health/status/operator read surfaces, no X write secrets;
- publisher Worker: scheduled/explicit publication execution, X write secrets;
- common D1/R2 storage;
- exact authority record identifies publisher deployment.

Do not split solely for aesthetic reasons; split if the security/authority invariant justifies the added deployment complexity.

## Account/API-level operating policy

Also verify/document:
- X rate-limit behavior;
- media upload ambiguity;
- post length/rules;
- account identity check;
- cost tracking if still desired;
- explicit no automated replies/DM/follow/like scope.

These must not accidentally creep into the continuous queue publisher.

---

# Reverse Gate 1 — Contracts and work tracking are coherent

Before implementation branches multiply, the normative target must live on main and the tracker must represent all real work.

## 1.1 Merge/activate the product intent deliberately

PR #87 currently exists only as a draft.

Before implementation treats it as normative:
- review it;
- resolve any contradictions with the older v0.2.0 contracts;
- merge the approved contract package;
- mark each document's status accurately;
- do not call implementation verified merely because the contract merged.

## 1.2 Bring required SCHED material onto main

Issue #42 is closed, but the scheduling contract is still only on the retained alignment branch.

That is governance debt.

The requirements consumed by #52/#53/#54 should exist in the normal mainline contract set before their implementation is accepted.

## 1.3 Consolidate old and new contract vocabulary

Need one authoritative vocabulary for:
- content;
- content revision;
- assignment;
- assignment version;
- policy version;
- queue revision;
- lifecycle state;
- transaction outcome;
- publication authority;
- lease;
- halt;
- reconciliation.

Avoid a situation where old v0.2.0 docs say "schedule_version" while the new package means a composite identity but both remain independently normative.

## 1.4 Create missing implementation issues

The current open issue list does not independently track several required work packages.

Create bounded issues for at least:

A. canonical runtime content inventory + schema;
B. durable assignment/event schema + 180-item backfill;
C. append-only single intake command;
D. deterministic bulk intake;
E. dynamic queue revision/integrity;
F. dynamic media metadata/R2 binding;
G. D1 reconciliation operator command;
H. D1 backup/restore drill;
I. runway monitoring/alerting;
J. static-bundle -> dynamic-runtime cutover/shadow parity;
K. content revision/cancel owner operations;
L. docs/runbook/source-of-truth migration.

These should roll up into #48 or a replacement continuous-queue tracker.

## 1.5 Retire stale administrative trackers when superseded

#48 is currently useful because it still tracks real work.

#49 is an administrative milestone record. Once the new continuous-queue roadmap/milestone becomes the accepted planning source, decide whether #49 is:
- updated to the new program, or
- closed as superseded.

Do not keep two roadmap issues describing different end states.

---

# NOW — exact current position

## Proven/implemented

- Cloudflare production publisher is live.
- Current static 180-post queue is healthy.
- #38 durable outcome semantics: complete.
- #39 append-only publication/lease events: complete.
- #42 scheduling contract drafting issue: closed, although file is not on main.
- #43 publication_state generation/CAS: complete and merged.
- #47 schedule identity decision: closed; decision text currently lives on PR #87.
- #59 authority-safe mirror recovery foundation: complete.
- XQueue Author: implemented.
- owner-authenticated authoring approval machinery: implemented.
- production D1 has generation migration 0005.
- exact-head CI/TSAL evidence on current main passed after #43.

## Implemented but tied to the finite architecture

- Markdown content source;
- static schedule generation;
- generated Worker queue bundle;
- hard-coded expected queue count/hash;
- generated four-object media manifest;
- runtime eligibility over bundled queue + mirrored ledger;
- local `state.json` recovery heritage.

## Open existing work

- #41 publication fence evidence.
- #44 global halt.
- #45 credential/deployable separation.
- #46 final canonical state / authority activation.
- #52 exact UTC assignment.
- #53 deferred lifecycle.
- #54 replacement assignment.
- #48 tracker.
- #49 administrative milestone record.

## Missing tracked work revealed by the restated vision

- runtime canonical content inventory;
- durable perpetual assignment store/backfill;
- append API/CLI;
- batch ingestion;
- approved-unscheduled inventory;
- dynamic queue revision;
- dynamic media metadata;
- D1 reconciliation;
- dynamic data backup/restore;
- content revision/cancellation semantics;
- runway alerts;
- static -> dynamic shadow migration;
- source-of-truth/readme/runbook rewrite.

---

# Recommended forward execution order from NOW

Although this document is written backward, implementation should proceed in this order:

1. **Contract/mainline cleanup**
   - finish PR #87 review;
   - land the approved continuous-queue contracts;
   - bring the required SCHED contract into main;
   - reconcile vocabulary;
   - create missing implementation issues.

2. **Finish #52**
   - resolved UTC assignment primitive.
   - This is foundational to all durable assignments.

3. **Design and build canonical content + assignment schema**
   - content records/revisions;
   - assignments/events;
   - queue revision metadata;
   - media metadata;
   - generation/CAS.

4. **Build exact 180-item migration/backfill in non-authoritative mode**
   - zero slot/content drift;
   - deterministic parity.

5. **Build append-only intake**
   - single dry-run/apply;
   - approved-unscheduled support;
   - readback/idempotency.

6. **Build bulk intake**
   - deterministic manifest;
   - stale-frontier refusal;
   - replay/reconciliation.

7. **Build dynamic queue integrity + dynamic media readiness**
   - remove code-deploy requirement for new posts.

8. **Implement #53**
   - missed -> deferred.

9. **Implement #54**
   - durable replacement/reschedule using the same assignment primitive.

10. **Implement #41**
    - exact assignment/content/lease identity in publication fence.
    - This can start earlier in parallel once schema contracts freeze, but must finish against the final assignment model.

11. **Resolve/implement #44 and #45**
    - authority safety before final cutover.

12. **Build D1 reconciliation + backup/restore**
    - prove recovery before making dynamic state canonical.

13. **Shadow dynamic runtime against static production**
    - identical next/due/selection evidence.

14. **#46 cutover**
    - dynamic D1 content + assignments become canonical;
    - one publisher;
    - static bundle loses authority;
    - exact rollback evidence.

15. **Runway monitoring and operational polish**
    - target/warning/critical thresholds;
    - clear operator status;
    - bulk-distillation handoff.

16. **Retire compatibility paths and stale docs**
    - only after stabilization evidence.

---

# Parallelization map

Can proceed in parallel after contracts/schema freeze:

```text
                 +--> #41 fence evidence
                 |
#52 -> schema ---+--> intake / bulk
                 |
                 +--> dynamic integrity/media
                 |
                 +--> #53 -> #54

#44 halt --------------------+
#45 credential separation ---+--> #46
recovery/backup -------------+
shadow migration ------------+
```

Do NOT parallelize across these authority boundaries:

- do not activate dynamic queue before migration parity;
- do not make D1 canonical before recovery exists;
- do not retire static/local rollback before #46 evidence;
- do not let ingestion imply publication authority;
- do not make a content write and call it scheduled unless assignment readback succeeds.

---

# The highest-risk things we were not seeing

1. **Dynamic schedule alone is insufficient.** The publisher's actual post body still comes from a generated Worker bundle.
2. **Media is also deployment-time data.** New media-bearing posts need a dynamic metadata path.
3. **The future canonical queue contains unique production data not reproducible from Git.** It therefore needs backup/restore.
4. **Local mirror recovery is not future D1 queue recovery.**
5. **There is no current D1-native reconciliation operator path for ambiguous outcomes.**
6. **Editing or cancelling a future post needs explicit lifecycle semantics.**
7. **Stable content ID policy must stop depending on finite campaign position.**
8. **Old contract text is not on main and can conflict with the new vocabulary.**
9. **The issue tracker does not yet represent much of the new product work.**
10. **A rollback of code after dynamic data starts accumulating can itself lose logical access to newer data unless compatibility is designed.**
11. **The source-of-truth model must change deliberately: Git Markdown, D1 runtime content, assignments, and evidence need clearly separated roles.**
12. **A policy change and a schedule reflow are not the same action.**
13. **Runway counts only publishable approved inventory; drafts/candidates do not prevent queue exhaustion.**
14. **Perpetual append creates concurrency problems at the frontier.** Two simultaneous adds must not receive the same slot; frontier allocation needs CAS/transactional serialization.
15. **Batch failure semantics matter.** A network error halfway through 100 posts cannot be handled by "run it again" without per-item/batch idempotency.
16. **Schema evolution after cutover needs backward-compatible deployment sequencing.** A Worker rollback must not misread newer assignment/content schema.

---

# Definition of program complete

The continuous-queue program closes only when:

- Patrick can add one approved finished post without moving anything already scheduled;
- Patrick can add a deterministic bulk batch with the same invariant;
- neither operation requires a Worker deploy;
- new text and media are publishable from runtime canonical storage;
- one canonical durable assignment state exists;
- one production publisher exists;
- exact assignment/content/lease evidence surrounds every X side effect;
- stale/missed/ambiguous outcomes fail closed;
- deferred/replacement semantics are durable;
- halt/recovery/backup/restore are proven;
- queue runway is visible;
- static 180-post assumptions are removed from production authority;
- contracts, issues, docs, runbook, tests, and live production all agree.

Until all of those are true, XQueue is a strong finite publisher evolving toward the perpetual system—not yet the final system.
