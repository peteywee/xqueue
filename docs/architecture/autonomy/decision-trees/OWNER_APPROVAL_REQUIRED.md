<!--tos-doc
{
  "doc_id": "XQ-DOC-ARCH-AUTONOMY-TREE-OWNER_APPROVAL_REQUIRED",
  "class": "architecture",
  "claims_truth_state": "proposed",
  "written_against": { "head_sha": "0f3fb9c6d974c99ad58f9b135b19e50dcee366de" },
  "depends_on": ["src/autonomy/", "test/autonomy/harness/scenarios.mjs", "docs/contracts/autonomous-decision-contract.md"]
}
-->

# Decision tree — `OWNER_APPROVAL_REQUIRED`

Status: proposed. Every scenario ID below is an executed test in `test/autonomy-chaos-matrix.test.mjs` / `test/autonomy-compound-chaos.test.mjs`.

**Question:** Does the operation cross an authority, editorial, or policy boundary even though it may be technically valid?

**Where it is decided:** CONTENT (approval missing/mismatch, sensitive material, or meaning drift). A mutation-lane halt is an operational fence and does not manufacture an owner-approval requirement.

```text
OWNER_APPROVAL_REQUIRED?
├── HAPPY PATH
│   ├── when: Candidate awaiting exact-digest approval.
│   └── then: OWNER_APPROVAL_REQUIRED -> WAITING_APPROVAL -> (owner) PLANNED
├── DEGRADED PATH
│   ├── when: Sensitive material; approval digest mismatch plus meaning drift plus sensitivity together.
│   └── then: One approval request; owner exact-digest approval covers it
├── AMBIGUOUS PATH
│   ├── when: Approval exists but its digest or meaning relationship is not yet proven.
│   └── then: OWNER_APPROVAL_REQUIRED until exact-digest authority is established
└── UNSAFE PATH
    ├── when: Approval synthesized by automation; approval missing observed only after dispatch.
    └── then: Never an approval request -> SYSTEM_HALT
```

| Path | Condition | Result | Scenarios |
|---|---|---|---|
| HAPPY | Candidate awaiting exact-digest approval. | OWNER_APPROVAL_REQUIRED -> WAITING_APPROVAL -> (owner) PLANNED | AI-12, AI-09 |
| DEGRADED | Sensitive material; approval digest mismatch plus meaning drift plus sensitivity together. | One approval request; owner exact-digest approval covers it | CL-09, AI-08, CP-13, CL-09c |
| AMBIGUOUS | Approval exists but its exact digest or meaning relationship is not yet proven. | OWNER_APPROVAL_REQUIRED until exact-digest authority is established | AI-09, CP-13 |
| UNSAFE | Approval synthesized by automation; approval missing observed only after dispatch. | Never an approval request -> SYSTEM_HALT | AI-10b, CP-14, CP-15 |

**This outcome must never:**

- Let generated content approve itself (INV-03, INV-20)
- Offer approval as the remedy after dispatch (INV-24)
