<!--tos-doc
{
  "doc_id": "XQ-DOC-ARCH-AUTONOMY-TREE-AUTO_IGNORE",
  "class": "architecture",
  "claims_truth_state": "proposed",
  "written_against": { "head_sha": "0f3fb9c6d974c99ad58f9b135b19e50dcee366de" },
  "depends_on": ["src/autonomy/", "test/autonomy/harness/scenarios.mjs", "docs/contracts/autonomous-decision-contract.md"]
}
-->

# Decision tree — `AUTO_IGNORE`

Status: proposed. Every scenario ID below is an executed test in `test/autonomy-chaos-matrix.test.mjs` / `test/autonomy-compound-chaos.test.mjs`.

**Question:** Is the object conclusively duplicate, already processed, superseded, or non-actionable — proven from a trusted view?

**Where it is decided:** INPUT (duplicate), FENCE (superseded assignment, identity already committed), EFFECT (resume readback proves applied).

```text
AUTO_IGNORE?
├── HAPPY PATH
│   ├── when: Exact duplicate package / same content digest under another filename / duplicate member.
│   └── then: AUTO_IGNORE -> IGNORED with ignore_basis
├── DEGRADED PATH
│   ├── when: Restart after a completed step; resume readback proves the identity applied.
│   └── then: AUTO_IGNORE -> IGNORED; completed effect is not replayed
├── AMBIGUOUS PATH
│   ├── when: Same logical identity but a different digest; duplicate claimed while the canonical view is unreadable.
│   └── then: Not ignored -> QUARANTINE (conflict) / AUTO_RETRY(read)
└── UNSAFE PATH
    ├── when: Duplicate is also hostile; item already dispatched; another run completed the same identity while this one dispatched.
    └── then: Never AUTO_IGNORE -> QUARANTINE / SYSTEM_HALT
```

| Path | Condition | Result | Scenarios |
|---|---|---|---|
| HAPPY | Exact duplicate package / same content digest under another filename / duplicate member. | AUTO_IGNORE -> IGNORED with ignore_basis | IN-08, IN-09, IN-10 |
| DEGRADED | Restart after a completed step; resume readback proves the identity applied. | AUTO_IGNORE -> IGNORED; completed effect is not replayed | RR-04, ST-08, CP-03 |
| AMBIGUOUS | Same logical identity but a different digest; duplicate claimed while the canonical view is unreadable. | Not ignored -> QUARANTINE (conflict) / AUTO_RETRY(read) | IN-10b, IN-15, CP-19 |
| UNSAFE | Duplicate is also hostile; item already dispatched; another run completed the same identity while this one dispatched. | Never AUTO_IGNORE -> QUARANTINE / SYSTEM_HALT | CP-18, CC-10 |

**This outcome must never:**

- Ignore a post-dispatch item (INV-24)
- Ignore on an untrusted or stale view (severity ordering puts AUTO_IGNORE below AUTO_RETRY)
