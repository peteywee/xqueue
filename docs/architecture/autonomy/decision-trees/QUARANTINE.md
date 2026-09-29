<!--tos-doc
{
  "doc_id": "XQ-DOC-ARCH-AUTONOMY-TREE-QUARANTINE",
  "class": "architecture",
  "claims_truth_state": "proposed",
  "written_against": { "head_sha": "0f3fb9c6d974c99ad58f9b135b19e50dcee366de" },
  "depends_on": ["src/autonomy/", "test/autonomy/harness/scenarios.mjs", "docs/contracts/autonomous-decision-contract.md"]
}
-->

# Decision tree — `QUARANTINE`

Status: proposed. Every scenario ID below is an executed test in `test/autonomy-chaos-matrix.test.mjs` / `test/autonomy-compound-chaos.test.mjs`.

**Question:** Is the defect confined to this item, with no possibly-applied effect, so only this item needs isolating?

**Where it is decided:** INPUT, CONTENT, FENCE (assignment missing), SYSTEM (item-proven corruption), EFFECT (permanent rejection proven not applied).

```text
QUARANTINE?
├── HAPPY PATH
│   ├── when: Malformed / truncated / unsupported / nested package; required metadata missing; vanished before capture.
│   └── then: QUARANTINE -> QUARANTINED; owner notified; siblings continue
├── DEGRADED PATH
│   ├── when: One item's media object missing or digest/size mismatched; X permanently rejects the content.
│   └── then: QUARANTINE (pre-dispatch, or VERIFYING with conclusive not-applied)
├── AMBIGUOUS PATH
│   ├── when: Uncertain / conflicting / unstable classification; claim contradicted by evidence; generated content asserts authority.
│   └── then: QUARANTINE; attestation is not offered for contradicted claims
└── UNSAFE PATH
    ├── when: Corruption scope unknown or system; possibly-applied effect; approval forged.
    └── then: Never QUARANTINE -> SYSTEM_HALT
```

| Path | Condition | Result | Scenarios |
|---|---|---|---|
| HAPPY | Malformed / truncated / unsupported / nested package; required metadata missing; vanished before capture. | QUARANTINE -> QUARANTINED; owner notified; siblings continue | IN-02, IN-03, IN-07, IN-11, IN-12, IN-14, CP-06 |
| DEGRADED | One item's media object missing or digest/size mismatched; X permanently rejects the content. | QUARANTINE (pre-dispatch, or VERIFYING with conclusive not-applied) | CS-05b, ST-05b, ST-06, ST-07, EX-03 |
| AMBIGUOUS | Uncertain / conflicting / unstable classification; claim contradicted by evidence; generated content asserts authority. | QUARANTINE; attestation is not offered for contradicted claims | CL-02, CL-03, CL-04, AI-04, AI-05, AI-10, CP-04 |
| UNSAFE | Corruption scope unknown or system; possibly-applied effect; approval forged. | Never QUARANTINE -> SYSTEM_HALT | CS-06, CP-07, CP-17, AI-10b |

**This outcome must never:**

- Downgrade a system fault to quarantine (INV-06)
- Delete or auto-release a quarantined item (ADM-47)
