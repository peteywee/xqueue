<!--tos-doc
{
  "doc_id": "XQ-DOC-ARCH-AUTONOMY-0006",
  "class": "architecture",
  "claims_truth_state": "proposed",
  "written_against": { "head_sha": "0f3fb9c6d974c99ad58f9b135b19e50dcee366de" },
  "depends_on": ["src/autonomy/", "test/autonomy/harness/", "test/autonomy-*.test.mjs", "test/autonomy/mutation.test.mjs", "scripts/autonomy-batch0-evidence.mjs"]
}
-->

# Chaos Model and Proof Shape

Status: proposed. Everything here runs locally with no network, no Cloudflare, no X, no model credentials, and no archive parser. Faults are injected into modeled state.

## Five layers of attack

| Layer | What it attacks | Where |
|---|---|---|
| 1. Scenario matrix | 172 hand-authored scenarios (183 decision items) across the nine required families plus post-dispatch edges. Expected outcome, halt scope, retry target, unrelated-work flag, owner notification, and final FSM state are written by hand from the contract, then compared to the model. | `harness/scenarios.mjs`, `autonomy-chaos-matrix.test.mjs`, `autonomy-compound-chaos.test.mjs` |
| 2. Exhaustive compositional oracle | Every gate over its entire declared projection (34,864 points incl. both policies; a Proxy fails the run if a gate reads an undeclared dimension), the composition over every combination of gate verdict classes (15,120), and every gate point lifted to a full observation and checked against all decision invariants (50,528). | `harness/oracle.mjs`, `autonomy-exhaustive.test.mjs` |
| 3. Sampling | Seeded uniform samples of the full space (mostly SYSTEM_HALT, by nature) and seeded near-baseline samples that exercise every outcome. | same |
| 4. Concurrency / crash simulation | Two actors, same input / different inputs / conflicting identity, on the mutation and publication lanes, 36 dispatch×verify fault combinations each, crash-before and crash-after dispatch, every interleaving explored as a memoized state graph. Actors are driven by the real `decide()` and `transition()`. Safety: no duplicate canonical apply, no duplicate external effect, nothing COMPLETE or IGNORED without applied evidence, nothing stranded in EXECUTING/VERIFYING. | `harness/sim.mjs`, `autonomy-concurrency-sim.test.mjs` |
| 5. Mutation analysis | 397 deliberately broken models/FSMs (dropped rules, weakened verdicts, narrowed halt scopes, dangerous retry targets, phase leakage, naive composition, min composition, ignored budgets, disabled validation, trusting-by-default policy, dropped evidence, dropped guards, actor swaps, dropped rows, injected illegal rows, design-review regressions). A surviving mutant is a gap in the tests. | `harness/mutants.mjs`, `test/autonomy/mutation.test.mjs` |

## Why the exhaustive claim covers the full space

`decide(o) = compose(g1(π1 o), …, g5(π5 o))`. Each gate `gi` is total over its projection `πi` (enumerated), and `compose` is total over the product of the gates' verdict classes (enumerated). Therefore `decide` returns a defined outcome for every point of the full 21-dimension product (148,635,648,000 observations) without enumerating it. Because `compose` is maximum-severity, any property of the form "this condition forces at least outcome X" proven at a gate holds everywhere.

What this does **not** prove: that a real adapter maps a real failure onto the right observation. That mapping is `fault-catalog.mjs`, tested only by the scenarios that use it.

## Mutation equivalence is proven, not judged

A mutant that no test kills is labeled *equivalent* only if a machine check shows it cannot change any decision:

- decision mutants — the mutated gate's decisions are identical to the original over the gate's whole projection, lifted with minimal-severity context (all other gates PASS pre-dispatch; EFFECT = AUTO_RESOLVE post-dispatch). Composition is max, so minimal context maximizes visibility; if no difference shows there, none can show anywhere;
- FSM mutants — identical results on all 6,840 attempts, with full evidence and with each evidence key removed.

Anything else is reported as a survivor.

## Results history (preserved, not rewritten)

| Run | What happened | Resolution |
|---|---|---|
| Scenario probe 1 | 13 items failed: the ambiguity catch-all rule matched readback-resolved cases and, because gates take the *strongest* match, overrode every resolution (F-02). | Catch-all excludes proven cases. |
| Simulation 1 | 0 safety violations, but on busy queues an ordinary CAS conflict exhausted retries and **halted the mutation lane** (F-03). | CAS conflict = stale fence → re-plan, defer on exhaustion. |
| FSM oracle 1 | Impossible item records (e.g. `RETRY_WAIT` + dispatched) were accepted and the flag cleared (F-04). | `DISPATCH_CONSISTENT` rejection in both `transition()` and `resumeFromCrash()`. |
| Mutation run 1 | 397 mutants: 290 killed, 65 equivalent, **42 survived** — real test gaps (post-dispatch fence breaches, resume-readback edges, halt-scope precision, missing FSM exit contracts). | +21 scenarios (PD-*), +3 invariants (INV-28..30), FSM contract exits and consistency properties, gate structural checks in the kill suite. |
| Invariant check 2 | Two of *my* predicates were too strict about halt scope; one model rule gave a read-only effect lane scope. | Predicates corrected; effect rules restricted to item lanes. |
| Mutation run 2 | 397 mutants: 335 killed, 62 proven equivalent, **0 survived**. | — |
| Independent review 1 | Read-only unexpected effects could widen from component to lane scope when success/failure contradicted readback because `itemBearing(o)` guarded only the first `E-contradiction` disjunct. | Parenthesized the full contradiction predicate; added regression + invariant coverage. |
| Independent review 2 | `resumeFromCrash()` accepted impossible dispatch/state checkpoints even though `transition()` rejected them. | Shared item-record validation across transition and crash resume; added exhaustive crash-resume oracle + mutant. |
| Mutation run 3 (post-review) | 398 mutants: 336 killed, 62 proven equivalent, **0 survived**; `fsm:resume-skips-dispatch-consistency` killed by crash-resume properties. | Independent-review repair set retained. |
| Independent compound sweep | 9,289 disjoint two-fault combinations across pre/post lanes: **0 severity downgrades, 0 halt-scope narrowing anomalies**. | No additional repair required. |
| Independent 3-actor probes | Same-identity and mixed-fault publication/mutation probes explored 69,200 total states with crashes, lost responses, failed writes and unavailable readback: **0 safety violations**. | No additional repair required. |

## Limits of this evidence

- **Independent review now performed.** The delivered author-produced model was independently attacked after packaging; two semantic/proof defects were found and repaired. This reduces, but does not eliminate, shared abstraction blind spots. The repaired package records those findings separately from the original author evidence.
- **Abstraction.** Coverage percentages are over the declared abstract schema. A failure mode that has no dimension in the schema is invisible to every metric here.
- **Bounded simulation.** The permanent exhaustive simulator matrix remains two actors, two retries, two deferrals, one fault per step. Independent review additionally exercised selected three-actor crash/fault configurations, but this is not an exhaustive three-actor Cartesian proof.
- **No runtime.** Nothing here exercises D1, R2, Workers, or X. Existing XQueue tests cover those paths separately.
