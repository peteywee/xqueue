<!--tos-doc
{
  "doc_id": "XQ-DOC-ARCH-AUTONOMY-TREE-OWNER_ATTESTATION_REQUIRED",
  "class": "architecture",
  "claims_truth_state": "proposed",
  "written_against": { "head_sha": "0f3fb9c6d974c99ad58f9b135b19e50dcee366de" },
  "depends_on": ["src/autonomy/", "test/autonomy/harness/scenarios.mjs", "docs/contracts/autonomous-decision-contract.md"]
}
-->

# Decision tree — `OWNER_ATTESTATION_REQUIRED`

Status: proposed. Every scenario ID below is an executed test in `test/autonomy-chaos-matrix.test.mjs` / `test/autonomy-compound-chaos.test.mjs`.

**Question:** Does a factual, experiential, personal, provenance- or currency-sensitive assertion lack trusted support, so only Patrick can attest?

**Where it is decided:** CONTENT (promoting lanes, pre-dispatch).

```text
OWNER_ATTESTATION_REQUIRED?
├── HAPPY PATH
│   ├── when: Generated candidate contains an experiential claim with no owner-attested source.
│   └── then: OWNER_ATTESTATION_REQUIRED -> WAITING_ATTESTATION -> (owner) CLASSIFIED
├── DEGRADED PATH
│   ├── when: Current fact older than freshness policy; unsupported factual claim.
│   └── then: OWNER_ATTESTATION_REQUIRED (owner attests or supplies fresh evidence)
├── AMBIGUOUS PATH
│   ├── when: Unsupported claim and missing approval together; owner unavailable.
│   └── then: Attestation first (severity), item stays parked; no timeout exit
└── UNSAFE PATH
    ├── when: Claim contradicted by evidence; same claim observed after dispatch.
    └── then: Never attestation -> QUARANTINE / SYSTEM_HALT
```

| Path | Condition | Result | Scenarios |
|---|---|---|---|
| HAPPY | Generated candidate contains an experiential claim with no owner-attested source. | OWNER_ATTESTATION_REQUIRED -> WAITING_ATTESTATION -> (owner) CLASSIFIED | AI-06 |
| DEGRADED | Current fact older than freshness policy; unsupported factual claim. | OWNER_ATTESTATION_REQUIRED (owner attests or supplies fresh evidence) | AI-07, AI-07b |
| AMBIGUOUS | Unsupported claim and missing approval together; owner unavailable. | Attestation first (severity), item stays parked; no timeout exit | CP-20, CP-04 |
| UNSAFE | Claim contradicted by evidence; same claim observed after dispatch. | Never attestation -> QUARANTINE / SYSTEM_HALT | AI-05, CP-15 |

**This outcome must never:**

- Accept attestation from actor automation or generator (ADM-42, ADM-48)
- Time out into progress (INV-26)
