# Decision: Global publication halt

Status: **approved by owner on 2026-09-21**

Issue: #44  
Decision scope: AUTH-14 through AUTH-17 / OQ-AUTH-2

## Decision

The authoritative global publication halt is a singleton, generation-fenced record in the same canonical D1 database used by XQueue publication state.

The publication path must read the halt before lease acquisition and re-read it immediately before every external X write side effect. Missing, unreadable, malformed, or otherwise unverifiable halt state is fail-closed.

Automation/runtime code may set the halt to `true` with a non-empty reason. Runtime code has no clear operation. Clearing is an owner-operated control-plane action executed outside the publishing Worker with owner-held Cloudflare authorization.

Every state transition increments the halt generation exactly once and automatically appends an immutable audit event. A clear transition is rejected by the database unless the actor class is `owner`.

No code deployment is required to set or clear the halt.

## Race semantics

A halt observed before lease acquisition blocks the transaction before authority is acquired.

A halt set after lease acquisition but before an X write blocks the write when the publication path rechecks the halt.

A halt cannot retroactively cancel an external request already handed to X. Any ambiguity after external dispatch continues through the existing reconciliation path.

## Production sequencing

Merging this implementation does not activate Cloudflare publication authority and does not mutate production D1. Preview proof must pass first. Production migration/application remains a separately evidenced production operation.
