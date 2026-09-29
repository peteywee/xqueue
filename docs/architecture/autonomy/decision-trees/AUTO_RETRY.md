<!--tos-doc
{
  "doc_id": "XQ-DOC-ARCH-AUTONOMY-TREE-AUTO_RETRY",
  "class": "architecture",
  "claims_truth_state": "proposed",
  "written_against": { "head_sha": "0f3fb9c6d974c99ad58f9b135b19e50dcee366de" },
  "depends_on": ["src/autonomy/", "test/autonomy/harness/scenarios.mjs", "docs/contracts/autonomous-decision-contract.md"]
}
-->

# Decision tree — `AUTO_RETRY`

Status: proposed. Every scenario ID below is an executed test in `test/autonomy-chaos-matrix.test.mjs` / `test/autonomy-compound-chaos.test.mjs`.

**Question:** Is the failure conclusively transient, with nothing possibly-applied outstanding, so repeating cannot duplicate an effect?

**Where it is decided:** SYSTEM/FENCE/EFFECT gates, retry target plan | read | operation, budget available.

```text
AUTO_RETRY?
├── HAPPY PATH
│   ├── when: A fence went stale before dispatch (runtime generation advanced, halt generation moved but is clear, lease lost pre-dispatch).
│   └── then: AUTO_RETRY(plan) -> RETRY_WAIT -> PLANNED with a fresh fence read
├── DEGRADED PATH
│   ├── when: Canonical read failed before dispatch; or an internal write was explicitly rejected and readback proves it did not apply.
│   └── then: AUTO_RETRY(read) or AUTO_RETRY(operation) with the same idempotency identity
├── AMBIGUOUS PATH
│   ├── when: Internal write response lost; readback proves NOT applied. CAS rejected because another append advanced the generation.
│   └── then: AUTO_RETRY(operation) / AUTO_RETRY(plan); persistent CAS contention -> AUTO_DEFER, never lane halt
└── UNSAFE PATH
    ├── when: External target after dispatch; ambiguous without not-applied proof; idempotency missing; budget exhausted.
    └── then: Never AUTO_RETRY -> AUTO_DEFER / QUARANTINE / SYSTEM_HALT
```

| Path | Condition | Result | Scenarios |
|---|---|---|---|
| HAPPY | A fence went stale before dispatch (runtime generation advanced, halt generation moved but is clear, lease lost pre-dispatch). | AUTO_RETRY(plan) -> RETRY_WAIT -> PLANNED with a fresh fence read | CS-01, CC-04, CC-05, CC-02b, CP-02 |
| DEGRADED | Canonical read failed before dispatch; or an internal write was explicitly rejected and readback proves it did not apply. | AUTO_RETRY(read) or AUTO_RETRY(operation) with the same idempotency identity | CS-09, ST-01, ST-03, AI-01, PD-10 |
| AMBIGUOUS | Internal write response lost; readback proves NOT applied. CAS rejected because another append advanced the generation. | AUTO_RETRY(operation) / AUTO_RETRY(plan); persistent CAS contention -> AUTO_DEFER, never lane halt | EX-08b, RR-02, AI-02, ST-01c, ST-01d |
| UNSAFE | External target after dispatch; ambiguous without not-applied proof; idempotency missing; budget exhausted. | Never AUTO_RETRY -> AUTO_DEFER / QUARANTINE / SYSTEM_HALT | EX-01, EX-04, EX-11, CP-05, CS-09b, ST-01b |

**This outcome must never:**

- Retry an external effect in flight (ADM-12)
- Retry an unproven ambiguous effect (ADM-11)
- Retry with an exhausted budget (ADM-36)
- Re-enter EXECUTING without re-planning (ADM-41)
