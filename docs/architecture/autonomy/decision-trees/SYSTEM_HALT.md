<!--tos-doc
{
  "doc_id": "XQ-DOC-ARCH-AUTONOMY-TREE-SYSTEM_HALT",
  "class": "architecture",
  "claims_truth_state": "proposed",
  "written_against": { "head_sha": "0f3fb9c6d974c99ad58f9b135b19e50dcee366de" },
  "depends_on": ["src/autonomy/", "test/autonomy/harness/scenarios.mjs", "docs/contracts/autonomous-decision-contract.md"]
}
-->

# Decision tree — `SYSTEM_HALT`

Status: proposed. Every scenario ID below is an executed test in `test/autonomy-chaos-matrix.test.mjs` / `test/autonomy-compound-chaos.test.mjs`.

**Question:** Could continuing corrupt canonical truth, duplicate an external effect, violate authority, lose recoverability, or run on materially ambiguous state?

**Where it is decided:** Any gate; scope component / lane / system; widest wins.

```text
SYSTEM_HALT?
├── HAPPY PATH
│   ├── when: Unmistakable integrity failure: runtime digest mismatch, schema or migration mismatch, duplicate active slot.
│   └── then: SYSTEM_HALT (system) -> HALTED; nothing continues
├── DEGRADED PATH
│   ├── when: Lane-local: provider outage exhausts the staging lane; runtime not bound to authority stops only itself.
│   └── then: SYSTEM_HALT (lane / component); other lanes continue
├── AMBIGUOUS PATH
│   ├── when: Possibly-applied effect with no conclusive readback; stale checkpoint that recorded a dispatch.
│   └── then: SYSTEM_HALT (lane, needs_reconciliation); exit only by owner reconciliation
└── UNSAFE (for the halt itself) PATH
    ├── when: Automation or the triggering component tries to clear the halt, retry, or re-plan a possibly-dispatched halted item.
    └── then: Rejected by the FSM; halt persists
```

| Path | Condition | Result | Scenarios |
|---|---|---|---|
| HAPPY | Unmistakable integrity failure: runtime digest mismatch, schema or migration mismatch, duplicate active slot. | SYSTEM_HALT (system) -> HALTED; nothing continues | CS-02, CS-04, CS-07, CS-08 |
| DEGRADED | Lane-local: provider outage exhausts the staging lane; runtime not bound to authority stops only itself. | SYSTEM_HALT (lane / component); other lanes continue | AI-01b, CP-10, PD-02 |
| AMBIGUOUS | Possibly-applied effect with no conclusive readback; stale checkpoint that recorded a dispatch. | SYSTEM_HALT (lane, needs_reconciliation); exit only by owner reconciliation | EX-04, EX-06, EX-09, RR-06b, CP-05 |
| UNSAFE (for the halt itself) | Automation or the triggering component tries to clear the halt, retry, or re-plan a possibly-dispatched halted item. | Rejected by the FSM; halt persists | CC-08, CP-05 |

**This outcome must never:**

- Be cleared by any automated actor (INV-22)
- Let a halted, possibly-dispatched item re-plan without reconciliation (ADM-43)
