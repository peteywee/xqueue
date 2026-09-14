# XQueue 1.1.0 incident and reliability closeout

Status: proposed closeout record

Source incident: #56

Superseded implementation branch: PR #61

Released baseline: `1.1.0`

Canonical release commit: `b67229cab3580d2375236c63d145857ed3e15bd2`

Annotated release tag: `1.1.0` -> `b67229cab3580d2375236c63d145857ed3e15bd2`

## Purpose

This record closes the loop on the September 2026 scheduler-gap and environment-targeting failures without rewriting the incident history. It records the lessons that survived review, the controls actually shipped in XQueue 1.1.0, the draft designs that were intentionally superseded, and the current evidence supporting the feature-freeze boundary.

This document is not a new runtime contract and does not authorize new production mutation.

## What failed

The original incident combined several independent failure modes:

1. publication authority/readiness was available before scheduler invocation was proven during the valid post window;
2. a missed slot became stale and correctly blocked later automatic publication under fail-closed eligibility;
3. production and preview D1 identities coexisted in deployment configuration, allowing a successful production Worker deploy to bind the wrong D1;
4. partial observation briefly created a reasonable suspicion of failure before durable state proved that a later recovery post had actually succeeded;
5. ordinary deployment configuration later demonstrated that absent/empty external scheduler configuration can destructively alter live control-plane state.

The immediate recovery was completed on 2026-09-04. Post `A16` published at its intended slot and durable D1 state/events plus the remote X post agreed. The later 1.1.0 reliability closeout converted the incident lessons into repository and runtime controls.

## Lessons retained

### 1. Authority, liveness, readiness, and eligibility are separate facts

No one fact is proof of another.

- **Authority** answers who may create the external side effect.
- **Liveness** answers whether the authorized scheduler is actually invoking.
- **Readiness** answers whether dependencies and integrity gates are healthy.
- **Eligibility** answers whether policy permits a particular publication now.

A credential, enabled flag, deploy, healthy dependency, or eligible work item must never be silently promoted into proof of any other category.

### 2. Dangerous environment ambiguity must be impossible to represent

Production and preview resource identities must not coexist inside one deploy surface in a way that leaves target selection to provider interpretation.

Deployment success is not evidence of correct resource identity. The deployed Worker, D1 target, scheduler state, and runtime identity must be read back from authoritative surfaces.

### 3. External-state absence can be destructive

For provider-managed state, an empty or omitted local configuration can have replacement/delete semantics. Ordinary deploy paths must not silently remove privileged external state such as the production Cron Trigger.

Material external control-plane state requires authoritative post-deploy reconciliation.

### 4. Incident classification follows evidence, not expectation

A suspected publication failure is not a confirmed failure merely because a log line, UI observation, scheduler event, or operator expectation is missing.

Where available, classification should correlate:

- scheduled and current time;
- invocation evidence;
- durable publication state and events;
- lease/inflight state;
- queue integrity and eligibility;
- external side-effect identifier/read-back.

Unknown or conflicting evidence remains unknown/indeterminate until reconciled.

### 5. Ambiguous external outcomes fail closed

`confirmed_posted`, `confirmed_not_posted`, and `needs_reconciliation` are distinct durable outcomes. A confirmed not-posted result must not be collapsed into an ambiguous outcome, and an ambiguous result must not be automatically retried until reconciled.

## Controls actually shipped in 1.1.0

The final implementation intentionally differs from draft PR #61 in several places. The principles survived; the obsolete topology did not.

### Environment isolation

- ordinary production Workers Builds configuration targets `xqueue-production` and production D1 only;
- explicit authority configuration targets the same production Worker/D1 and declares the single production Cron Trigger;
- preview D1 access is isolated behind explicit `wrangler.preview.jsonc`;
- production configs contain no `preview_database_id` or preview D1 identity;
- ordinary deploy configuration declares no scheduler mutation;
- environment-isolation regression evidence is part of exact-candidate TSAL proof.

### Scheduler liveness

- each real scheduled invocation persists a durable D1 heartbeat;
- `/health` exposes scheduler-liveness state separately from authority/readiness/eligibility;
- liveness includes last invocation, expected next invocation, stale threshold, and freshness state;
- runtime evidence fails when scheduler authority is expected and the heartbeat is absent/stale;
- a separate credential-free GitHub `workflow_run` monitor reacts to scheduled TSAL conformance results, opens one deduplicated incident on failure, and closes it after recovery;
- the monitor has GitHub issue authority only and no Cloudflare or X publication credentials.

### Outcome fidelity

- `confirmed_posted`, `confirmed_not_posted`, and `needs_reconciliation` remain distinct at the D1 state/event boundary;
- ambiguous outcomes remain fail-closed;
- confirmed-not-posted outcomes can return content to scheduled lifecycle rather than fabricating ambiguity.

### External-state preservation

- ordinary deploy configuration cannot declare Cron state;
- privileged scheduler mutation is confined to the explicit authority configuration/path;
- TSAL deployment evidence reads Cloudflare scheduler/deployment state and corroborates it against runtime health.

## Superseded PR #61 material

PR #61 remains useful historical evidence because it captured the incident lessons early, but it must not be merged as implementation.

The following draft details were superseded by the final 1.1.0 design:

- a separate `xqueue-watchdog` Worker topology;
- a preview-safe default Wrangler config as the ordinary deployment model;
- draft policy wording tied to those implementation choices;
- proposed liveness thresholds/notification topology that were replaced by the shipped D1 heartbeat + TSAL observer + GitHub monitor model.

The durable principles from XQ-POL-001/002/003 are retained above in implementation-neutral form.

## Current exact evidence

Fresh scheduled TSAL run: `34815364000`

Observed at: `2026-09-14T06:54Z`

Exact repository candidate: `b67229cab3580d2375236c63d145857ed3e15bd2`

TSAL target: `0.3.2`

Audit result:

- PROVEN: 14
- PARTIAL: 0
- UNPROVEN: 0
- BLOCKING: 0
- warnings: 0

Runtime evidence at that observation:

- service: `xqueue`, status `ok`;
- production publication authority: active;
- scheduler authority: active;
- scheduler heartbeat: fresh;
- last scheduled invocation: `2026-09-14T06:45:20.421Z`;
- queue integrity: 180/180, bundled/declared/expected/D1 hashes agree;
- posted: 13;
- overdue: none;
- inflight: none;
- required media: 4/4 verified;
- D1 reachable;
- R2 reachable.

Deployment evidence at that observation:

- Worker: `xqueue-production`;
- exact Cron: `*/15 * * * *`;
- Cloudflare schedule API: HTTP 200;
- Cloudflare deployment API: HTTP 200;
- active deployment present;
- runtime authority flag/authorization/scheduler authority/live publication authority: all proven.

## Issue disposition

### Safe to retire as completed/superseded by 1.1.0 evidence

- #38 — publication outcome semantics: implemented by 1.1.0 outcome-fidelity controls.
- #56 — production scheduler-gap incident: recovery is complete and permanent reliability controls are in the released baseline.
- #60 — production/preview D1 ambiguity: the original proposed topology was superseded, but the defect itself is structurally eliminated by the 1.1.0 environment model.
- PR #61 — stale implementation branch: preserve this record, then close without merge.

### Keep open unless separately re-scoped or proven

- #58 — liveness implementation is shipped and current liveness is proven, but its original Definition of Done also called for a demonstrated failure-notification/recovery cycle; do not claim that specific operational drill from healthy-run evidence alone.
- #59 — the proposed repeatable local-to-D1 mirror-sync command is not present on `main`; do not close it as implemented.
- #48 and its remaining contract-alignment children — 1.1.0 feature freeze does not automatically prove every older aspirational contract item. They should be explicitly deferred, superseded, or reactivated rather than silently marked complete.

## Freeze boundary

XQueue 1.1.0 satisfies its published freeze criterion: exact released code is deployed, production authority is observable, and fresh scheduled TSAL evidence proves all 14 conformance claims.

Future XQueue code changes should require at least one of:

1. a real production incident;
2. a failed conformance/monitoring gate;
3. a deliberately approved business requirement;
4. a separately approved contract-conformance program reactivation.

Documentation or tracker reconciliation that does not alter runtime behavior may proceed independently, but it must not manufacture evidence or retroactively claim unperformed operational tests.
