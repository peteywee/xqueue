<!--tos-doc
{
  "doc_id": "XQ-DOC-ARCH-AUTONOMY-0001",
  "class": "architecture",
  "claims_truth_state": "proposed",
  "written_against": { "head_sha": "0f3fb9c6d974c99ad58f9b135b19e50dcee366de" },
  "depends_on": ["src/autonomy/", "test/autonomy-*.test.mjs", "test/autonomy/", "scripts/autonomy-batch0-evidence.mjs", "docs/contracts/autonomous-decision-contract.md", "package.json"]
}
-->

# XQueue Autonomy — Batch 0 Decision & Failure Model

Status: **proposed**. Nothing in production consumes this model. It changes no publisher, scheduler, Worker, D1, R2, or X behavior.

## What this is

A single, finite decision contract that every future autonomous XQueue component — the #145 production mutation control plane, ZIP/project intake, media intake, XQueue Author, orchestration — must use instead of inventing its own failure semantics:

- eight outcomes (`AUTO_RESOLVE`, `AUTO_RETRY`, `AUTO_DEFER`, `AUTO_IGNORE`, `QUARANTINE`, `OWNER_ATTESTATION_REQUIRED`, `OWNER_APPROVAL_REQUIRED`, `SYSTEM_HALT`);
- a closed 21-dimension observation schema and a fault catalog that maps concrete failures onto it;
- a pure, deterministic decision function;
- a 15-state processing FSM that consumes outcomes and fails closed;
- 30 invariants with executable checks;
- a deterministic chaos harness, an exhaustive compositional oracle, a concurrency/crash simulator, and mutation analysis proving the tests can detect a wrong model.

## Documents

| Document | Purpose |
|---|---|
| `../../contracts/autonomous-decision-contract.md` | Normative contract (ADM-1..ADM-48), acceptance cases, open questions |
| `decision-contract.md` | Pointer + outcome semantics summary |
| `decision-trees.md` | Global escalation tree |
| `decision-trees/<OUTCOME>.md` | Per-outcome trees (happy / degraded / ambiguous / unsafe) |
| `state-machine.md` | FSM states, transitions, evidence, normalization decisions |
| `invariants.md` | Invariant catalog (22 candidates reviewed, 1 strengthened, 8 added) |
| `chaos-model.md` | Harness design, proof shape, what the metrics do and do not cover |
| `scope-and-non-goals.md` | Batch 0 boundary and scope control |

## Code

| Path | Role |
|---|---|
| `src/autonomy/decision-outcomes.mjs` | Outcomes, severity order, per-outcome contracts |
| `src/autonomy/decision-model.mjs` | Observation schema, gates, composition, `decide()` |
| `src/autonomy/state-machine.mjs` | FSM, transition table, contract exits, `transition()` |
| `src/autonomy/invariants.mjs` | Invariant catalog and executable predicates |
| `src/autonomy/fault-catalog.mjs` | Lane baselines and concrete-fault → observation mapping |
| `test/autonomy-*.test.mjs` | Run by `pnpm test` (existing `test/*.test.mjs` glob) |
| `test/autonomy/mutation.test.mjs` | Mutation analysis (~2 min), run by `pnpm verify:autonomy` |
| `test/autonomy/harness/` | Scenarios, oracle, FSM oracle, simulator, mutants, runners |
| `scripts/autonomy-batch0-evidence.mjs` | Regenerates the machine-readable evidence |

## Commands

```bash
pnpm test                    # whole suite, includes the fast autonomy tests
pnpm verify:autonomy         # autonomy tests + mutation analysis
pnpm autonomy:evidence -- --out /tmp/xqueue-batch0-evidence
```

All three require no network, no Cloudflare credentials, no X credentials, and no model credentials. `test/autonomy-isolation.test.mjs` enforces that `src/autonomy/` has no I/O, clock, randomness, network, or credential references, and that no production module imports it.

## Consuming it (for #145 and later)

1. Map every concrete signal onto the observation schema through `fault-catalog.mjs` — do not decide blast radius ad hoc.
2. Call `decide(observation)`; never branch on raw error types.
3. Drive item state only through `transition()`; supply the evidence keys it requires.
4. Assert `checkDecisionInvariants()` around `decide()` at runtime; a violation is a `SYSTEM_HALT`.
5. Resolve the open questions in the contract (OQ-ADM-2..6) before any executor exists.
