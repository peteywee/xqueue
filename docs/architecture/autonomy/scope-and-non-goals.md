<!--tos-doc
{
  "doc_id": "XQ-DOC-ARCH-AUTONOMY-0007",
  "class": "architecture",
  "claims_truth_state": "proposed",
  "written_against": { "head_sha": "0f3fb9c6d974c99ad58f9b135b19e50dcee366de" },
  "depends_on": ["src/autonomy/", "docs/architecture/source-of-truth.md", "docs/RUNBOOK.md"]
}
-->

# Batch 0 Scope and Non-Goals

Status: proposed.

## In scope (Batch 0)

- Decision contract for eight outcomes; per-outcome and global decision trees.
- Finite state machine, human- and machine-readable.
- Invariant catalog with executable checks.
- Pure local decision model, FSM, fault catalog.
- Deterministic chaos harness, exhaustive oracle, concurrency simulator, mutation analysis.
- Evidence generator and verification package.

## Explicit non-goals (not implemented, not started)

Universal ZIP ingestion; real archive extraction; production queue mutation; #145 implementation; new or changed Workers; D1 or R2 writes; X/Twitter calls; publishing or scheduling changes; AI-provider integration; prompt pipelines; automatic content approval; automatic owner attestation; GitHub-to-X automation; analytics; UI/dashboards; Context Engine integration; deployments; Cloudflare configuration; secrets; new infrastructure; merging to `main`; any change to publication authority.

## Change footprint

Only new files under `src/autonomy/`, `test/autonomy*`, `docs/architecture/autonomy/`, `docs/contracts/autonomous-decision-contract.md`, `scripts/autonomy-batch0-evidence.mjs`, plus two `package.json` script entries (`verify:autonomy`, `autonomy:evidence`). `test/autonomy-isolation.test.mjs` fails if any production module imports the model or the model gains I/O.

## Scope control

| Proposed or discovered work | Belongs to | Status |
|---|---|---|
| Decision model, FSM, invariants, chaos validation | BATCH 0 | Done in this batch |
| Durable lane-scoped halt representation (OQ-ADM-2) | #145 | Recorded only |
| Backup freshness as a mutation precondition (OQ-ADM-5) | #145 | Recorded only |
| Retry budgets and inline readback attempt counts (OQ-ADM-3) | #145 | Recorded only |
| Mapping D1/R2/X errors onto effect classes (OQ-ADM-6) | #145 (D1/R2), existing publisher classifier (X) | Recorded only |
| Archive parser, traversal/symlink/bomb detectors | ZIP INGESTION | Modeled as observations only |
| Classifier confidence/stability signals | CLASSIFICATION | Modeled as `classification` only |
| Media digest/size readback adapters | MEDIA INTAKE | Modeled only |
| Claim support, freshness, sensitivity signals | XQUEUE AUTHOR | Modeled only; existing `src/authoring/evidence-risk.mjs` is the likely source |
| Multi-item orchestration, lanes, budgets at runtime | AUTONOMOUS ORCHESTRATION | Recorded only |
| Authoritative automated X readback (OQ-ADM-1) | FUTURE / OPTIONAL (owner policy) | Default stays `false` |
| Production mutation-lane transport and activation (#145) | OUT OF BATCH 0 | Batch 0 defines the decision semantics; #145 supplies the dedicated no-X mutation lane, durable halt/fence and real adapters. Routine safe mutation does not require the global publication halt. |
