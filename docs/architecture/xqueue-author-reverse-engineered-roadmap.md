# XQueue Author — Reverse-Engineered Roadmap

**Status:** implementation roadmap  
**Tracking:** #75 / PR #76  
**Baseline:** XQueue 1.1.0 remains the frozen publication runtime  
**First production target:** XQueue 1.2.0 authoring release

## End state

The end state is a continuous, evidence-backed content engine that can discover useful material from Patrick's work, preserve where every idea came from, distill reusable knowledge, propose the right output form, and prepare publishable artifacts without ever giving generation systems approval or publication authority.

```text
source universe
  conversations / GitHub / docs / notes / audits / evidence
        |
        v
Context Engine or direct/manual source intake
        |
        v
normalization + segmentation
        |
        v
claim / idea extraction
        |
        v
knowledge units
  failures / lessons / principles / decisions / examples / questions
        |
        v
trust + evidence classification
        |
        +---- blocked/internal/research/attestation
        |
        v
artifact planner
   /        |        \
 post      blog      lesson
   \        |        /
        generation
            |
        validation
            |
       owner review
            |
   exact-digest approval
      /      |       \
 content   blog     lesson
 *.md      flow     library
   |
 existing XQueue runtime
 build -> schedule -> publish -> ledger
```

The system may later learn from approved artifacts and performance, but that feedback can only influence **suggestions**. It never elevates its own output to truth, owner approval, or publication authority.

## The finish line: XQueue 1.2.0

Version 1.2.0 is production-complete when all of the following are true:

1. Manual/direct source ingestion works.
2. Generated content can be ingested but cannot prove its own assertions.
3. Sources are normalized, segmented, and provenance-addressable.
4. Knowledge units can represent failures, lessons, principles, decisions, examples, questions, claims, frameworks, and observations.
5. Unsupported experiential claims require owner attestation.
6. Current-factual claims can be blocked pending research/fresh evidence.
7. `post`, `blog`, and `lesson` candidates are supported.
8. Post candidates reuse the existing XQueue validator and authoritative content corpus.
9. Review shows provenance, support state, validation, and unresolved risk.
10. Exact candidate digest approval by Patrick is mandatory.
11. Editing a candidate after approval invalidates the approval.
12. Post promotion into `content/*.md` is deterministic and idempotent.
13. Blog and lesson promotion remain separate from X publication authority.
14. CI passes with no live AI credentials.
15. Provider outages cannot mutate authoritative content or publication state.
16. Context Engine availability is optional; authoring still works with direct/manual sources.
17. Existing XQueue scheduler/publisher semantics and ledgers remain unchanged.
18. Exact-head XQueue verification and TSAL conformance are green.

That is the fixed definition of done for the first production authoring feature. Anything beyond it is an extension, not a reason to delay 1.2.0.

## Reverse-engineered dependency chain

### Stage 7 — Feedback and opportunity engine

**Endgame capability:** the system can propose *what to make next*.

Requires publication analytics, used-vs-unused angle tracking, content-gap detection, ranking of candidate knowledge units, quality/cost metrics, and feedback rules that cannot rewrite historical source truth.

Exit: XQueue can surface evidence-backed content opportunities without inventing experience or facts.

### Stage 6 — Context Engine integration

Requires a read-only provider-neutral context adapter, provenance-preserving retrieval, project/source filtering, freshness/canonical-reference checks, privacy filtering, and an approved-knowledge feedback interface.

Exit: XQueue can discover relevant material across projects and conversations without knowing or depending on the storage provider.

### Stage 5 — Production authoring release 1.2.0

Requires one real provider adapter, bounded generation, post/blog/lesson validation, review/approval flow, deterministic/idempotent promotion, CI mocks, usage/cost limits, and runbook/recovery guidance.

Exit: Patrick can safely go from source material to an approved post, blog, or lesson in production.

### Stage 4 — Evidence and voice hardening

Requires unsupported-claim detection, experiential attestation workflow, current-fact freshness policy, privacy classification, a style profile derived from the approved corpus, near-duplicate/reused-angle tracking, and adversarial fixtures for fake clients, fake metrics, fabricated history, legal overstatement, and sensitive material.

Exit: generated drafts are reliably evidence-bound and aligned to Patrick's approved publishing voice.

### Stage 3 — Real AI generation

Requires a provider-neutral generator interface, structured generation contract, timeout/retry policy, candidate/token/cost bounds, prompt/template versioning, provider/model/input provenance, and malformed-output fail-closed behavior.

Exit: a real model can create useful candidate artifacts without obtaining authority over content or publication.

### Stage 2 — Deterministic local distillation

Requires source normalization, deterministic segmentation, conservative claim classification, knowledge-unit lifecycle, artifact planning, fake/static deterministic generation, reviewable candidate creation, and reuse of the existing post policy validator.

Exit: source -> knowledge -> plan -> candidate -> validation works with no model, network, or Context Engine dependency.

### Stage 1 — Approval and promotion mechanics

Requires exact-digest owner approval, edit-invalidates-approval semantics, deterministic post-ID allocation, idempotent promotion records, parser-compatible post rendering, separate blog/lesson destinations, and no direct draft-to-publish path.

Exit: a candidate can cross the authority boundary only after explicit approval and only into its allowed artifact domain.

### Stage 0 — Contracts and negative controls

Requires source, knowledge-unit, candidate, and approval schemas; the provider-neutral read-only Context Source boundary; and fail-closed contract tests.

Exit: architecture rules are executable constraints rather than documentation.

**Current state:** Stage 0 exists in draft PR #76 and is green on the existing XQueue gates.

## Permanent red lines

These are architectural prohibitions, not backlog items:

- no model in the scheduled publication transaction;
- no generated assertion treated as true merely because a model generated it;
- no autonomous owner approval;
- no direct draft -> queue -> publish path;
- no Context Engine record outranking canonical source-of-truth rules;
- no second scheduler;
- no second publication ledger;
- no AI/provider outage allowed to make the existing publisher unhealthy;
- no hidden scope expansion from authoring into production authority.

## Build strategy

Work should be batched by independence, not merely chronology.

**Batch A — deterministic core:** Stage 1 + Stage 2 pure functions, contracts, and negative tests can advance in parallel.

**Batch B — hardening:** evidence rules, privacy, voice, duplicate/angle analysis, and review packet construction can advance in parallel after Batch A contracts stabilize.

**Batch C — adapters:** live model provider and Context Engine integration can be developed independently behind frozen interfaces, then integrated only after their negative tests pass.

**Batch D — release:** CLI/UX, documentation, cost telemetry, exact-head CI, independent verification, and release closeout.

At every batch boundary:
1. freeze the exact candidate;
2. run normal XQueue verification;
3. run TSAL conformance;
4. inspect negative controls;
5. widen scope only if the prior batch is proven.
