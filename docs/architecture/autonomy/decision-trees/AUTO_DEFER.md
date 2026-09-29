<!--tos-doc
{
  "doc_id": "XQ-DOC-ARCH-AUTONOMY-TREE-AUTO_DEFER",
  "class": "architecture",
  "claims_truth_state": "proposed",
  "written_against": { "head_sha": "0f3fb9c6d974c99ad58f9b135b19e50dcee366de" },
  "depends_on": ["src/autonomy/", "test/autonomy/harness/scenarios.mjs", "docs/contracts/autonomous-decision-contract.md"]
}
-->

# Decision tree — `AUTO_DEFER`

Status: proposed. Every scenario ID below is an executed test in `test/autonomy-chaos-matrix.test.mjs` / `test/autonomy-compound-chaos.test.mjs`.

**Question:** Is the work valid but not allowed to execute now, while remaining durable for later governed handling?

**Where it is decided:** SYSTEM/FENCE (publication or dedicated mutation lane halted), FENCE (lease contended), EFFECT (external confirmed not applied), or a retry reason whose escalation target is defer.

```text
AUTO_DEFER?
├── HAPPY PATH
│   ├── when: Publication is halted when a slot comes due, or the dedicated mutation lane is halted before canonical mutation.
│   └── then: AUTO_DEFER -> DEFERRED; no operation crosses the blocked lane
├── DEGRADED PATH
│   ├── when: Another operation holds the lease on the same object; a second resumer arrives.
│   └── then: AUTO_DEFER -> DEFERRED -> PLANNED on next opportunity
├── AMBIGUOUS PATH
│   ├── when: X transport reports not sent / timeout before dispatch / explicit transient refusal (confirmed_not_posted).
│   └── then: AUTO_DEFER from VERIFYING with conclusive_not_applied evidence
└── UNSAFE PATH
    ├── when: External response lost (possibly posted); canonical state untrusted.
    └── then: Never AUTO_DEFER (would treat 'unknown' as 'not posted') -> SYSTEM_HALT
```

| Path | Condition | Result | Scenarios |
|---|---|---|---|
| HAPPY | Publication is halted when a slot comes due, or the mutation lane is halted before canonical mutation. | AUTO_DEFER -> DEFERRED; missed-slot deferral still has no catch-up | CC-05b, CP-11, CP-12 |
| DEGRADED | Another operation holds the lease on the same object; a second resumer arrives. | AUTO_DEFER -> DEFERRED -> PLANNED on next opportunity | CC-01, CC-02, CC-07, RR-05 |
| AMBIGUOUS | X transport reports not sent / timeout before dispatch / explicit transient refusal (confirmed_not_posted). | AUTO_DEFER from VERIFYING with conclusive_not_applied evidence | EX-01, EX-03b, EX-05, EX-08c |
| UNSAFE | External response lost (possibly posted); canonical state untrusted. | Never AUTO_DEFER (would treat 'unknown' as 'not posted') -> SYSTEM_HALT | EX-04, EX-09, CS-02 |

**This outcome must never:**

- Treat failure-to-prove as proof of not-applied (INV-18)
- Leave DEFERRED except to PLANNED or HALTED (ADM-41)
