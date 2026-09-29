<!--tos-doc
{
  "doc_id": "XQ-DOC-ARCH-AUTONOMY-TREE-AUTO_RESOLVE",
  "class": "architecture",
  "claims_truth_state": "proposed",
  "written_against": { "head_sha": "0f3fb9c6d974c99ad58f9b135b19e50dcee366de" },
  "depends_on": ["src/autonomy/", "test/autonomy/harness/scenarios.mjs", "docs/contracts/autonomous-decision-contract.md"]
}
-->

# Decision tree — `AUTO_RESOLVE`

Status: proposed. Every scenario ID below is an executed test in `test/autonomy-chaos-matrix.test.mjs` / `test/autonomy-compound-chaos.test.mjs`.

**Question:** Is there enough trusted evidence to perform or complete one bounded, idempotent step automatically?

**Where it is decided:** All five gates return PASS (pre-dispatch), or EFFECT proves the outcome applied and no post-dispatch breach exists.

```text
AUTO_RESOLVE?
├── HAPPY PATH
│   ├── when: Trusted canonical state; halt clear (publication) / owner window set (mutation); authority bound; fences current; lease acquired; idempotency present; input valid; claims supported; owner exact-digest approval.
│   └── then: AUTO_RESOLVE -> PLANNED->EXECUTING (may dispatch)
├── DEGRADED PATH
│   ├── when: Owner halt set during the X request, or an unrelated append advanced the runtime generation, but the effect is proven applied under a verified dispatch.
│   └── then: AUTO_RESOLVE -> VERIFYING->COMPLETE (record outcome; halt applies to the next invocation)
├── AMBIGUOUS PATH
│   ├── when: Internal write response lost, readback proves the operation identity applied.
│   └── then: AUTO_RESOLVE -> COMPLETE (no re-issue)
└── UNSAFE PATH
    ├── when: Same success, but a post-dispatch breach exists (lease taken over, approval missing, authority changed) or readback is unavailable/contradictory.
    └── then: Never AUTO_RESOLVE -> SYSTEM_HALT
```

| Path | Condition | Result | Scenarios |
|---|---|---|---|
| HAPPY | Trusted canonical state; halt clear (publication) / owner window set (mutation); authority bound; fences current; lease acquired; idempotency present; input valid; claims supported; owner exact-digest approval. | AUTO_RESOLVE -> PLANNED->EXECUTING (may dispatch) | CS-00, IN-01, CL-01, AI-00, EX-02 |
| DEGRADED | Owner halt set during the X request, or an unrelated append advanced the runtime generation, but the effect is proven applied under a verified dispatch. | AUTO_RESOLVE -> VERIFYING->COMPLETE (record outcome; halt applies to the next invocation) | CP-08, PD-04, PD-08 |
| AMBIGUOUS | Internal write response lost, readback proves the operation identity applied. | AUTO_RESOLVE -> COMPLETE (no re-issue) | ST-02, ST-04, RR-03, RR-08, EX-07c |
| UNSAFE | Same success, but a post-dispatch breach exists (lease taken over, approval missing, authority changed) or readback is unavailable/contradictory. | Never AUTO_RESOLVE -> SYSTEM_HALT | CC-09, CP-15, PD-01, ST-10, EX-10b |

**This outcome must never:**

- Resolve an internal mutation without readback proves_applied (ADM-15)
- Resolve on a stale fence (ADM-21)
- Resolve a duplicate identity (INV-14)
