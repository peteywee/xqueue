<!--tos-doc
{
  "doc_id": "XQ-DOC-ARCH-AUTONOMY-0002",
  "class": "architecture",
  "claims_truth_state": "proposed",
  "written_against": { "head_sha": "0f3fb9c6d974c99ad58f9b135b19e50dcee366de" },
  "depends_on": ["src/autonomy/", "test/autonomy/harness/", "docs/contracts/autonomous-decision-contract.md"]
}
-->

# Global Escalation Decision Tree

Status: proposed. Normative source: `docs/contracts/autonomous-decision-contract.md`. Reference implementation: `src/autonomy/decision-model.mjs` (`decide`).

## Central invariant

> If XQueue cannot prove that continuing preserves canonical-state integrity, external-side-effect safety, and authority correctness, it must not continue that affected operation.

Blast radius decides which "must not continue":

- the unprovable condition is confined to **one item's own data or identity**, and **no effect may have left the process** → `QUARANTINE`;
- it touches **shared canonical state, authority, a generation fence, or a possibly-applied effect** → `SYSTEM_HALT`, scoped `component` / `lane` / `system`;
- **unknown** blast radius → treated as `system` (ADM-8).

## How the tree is evaluated

The model is compositional: five gates each return their strongest verdict, and the result is the maximum severity. The tree below is the same logic read top-down; the first question that fires a stronger outcome than everything below it decides. Question 3 splits the whole tree into pre-dispatch and post-dispatch branches because the same fact means different things on either side of a dispatch (ADM-10).

```text
Q0  Is the observation complete and in-schema? Is the policy valid?
    no  -> SYSTEM_HALT (component)                                 [ADM-5, ADM-6]

Q1  Is canonical state trustworthy?
    corrupt, scope = item, not dispatched      -> QUARANTINE          [CS-11, CS-05b]
    corrupt, scope = system/unknown/none       -> SYSTEM_HALT (system) [CS-02, CS-06, CS-10, CP-07]
    unreadable, not dispatched                 -> AUTO_RETRY(read); budget exhausted -> SYSTEM_HALT (lane) [CS-09, CS-09b]
    trusted but a fault scope is reported      -> SYSTEM_HALT (component, inconsistent observation) [CS-13]

Q2  Is authority correct for a mutating lane?
    unknown                                    -> SYSTEM_HALT (system)      [ADM-24]
    this runtime not bound to durable authority -> SYSTEM_HALT (component)  [CP-10]
    changed after plan, not dispatched         -> AUTO_RETRY(plan); exhausted -> SYSTEM_HALT (lane) [CC-06, CC-06b]

Q3  Has an effect possibly occurred? (effect != none)
    |
    +-- NO (pre-dispatch) ----------------------------------------------------------
    |   Q4  Halt fence
    |       unreadable (mutating)                -> SYSTEM_HALT (lane)       [PD-09]
    |       generation changed since plan        -> AUTO_RETRY(plan)         [CC-05, CC-05c]
    |       publication and halt set             -> AUTO_DEFER               [CC-05b, CP-12]
    |       canonical mutation while mutation lane halted -> AUTO_DEFER [CP-11]
    |   Q5  Version fence / concurrency
    |       duplicate active assignment          -> SYSTEM_HALT (system)     [CS-04]
    |       assignment missing / no fence evidence -> QUARANTINE             [CS-05, PD-19]
    |       assignment superseded                -> AUTO_IGNORE              [CS-03]
    |       runtime generation stale / lease lost -> AUTO_RETRY(plan)        [CS-01, CC-03]
    |       lease held by another operation      -> AUTO_DEFER               [CC-01, CC-02]
    |       identity already committed           -> AUTO_IGNORE              [CC-01b, RR-09]
    |   Q6  Resume check (did a prior run already apply this identity?)
    |       readback proves applied              -> AUTO_IGNORE              [RR-04, ST-08]
    |       readback unavailable                 -> AUTO_RETRY(read)         [PD-10]
    |       readback contradictory               -> SYSTEM_HALT (lane)       [PD-11]
    |   Q7  Is the action idempotent and inside its lane capability?
    |       no idempotency identity              -> QUARANTINE               [kernel]
    |       external effect planned on mutation/staging lane -> SYSTEM_HALT (component) [CP-19, PD-20]
    |   Q8  Is the source trustworthy?
    |       malformed / unsupported / conflicting / vanished -> QUARANTINE   [IN-02..IN-14]
    |       hostile (traversal, symlink, bomb, injection) -> QUARANTINE + security notice [IN-04..IN-06, CL-06]
    |       duplicate                            -> AUTO_IGNORE              [IN-09, IN-10]
    |       classification uncertain             -> QUARANTINE               [CL-02..CL-04]
    |   Q9  Human authority
    |       approval synthesized                 -> SYSTEM_HALT (system)     [AI-10b]
    |       content asserts authority/approval   -> QUARANTINE               [AI-10, AI-11, CL-07]
    |       restricted material / contradicted claim -> QUARANTINE           [AI-05, AI-08b]
    |       factual attestation required         -> OWNER_ATTESTATION_REQUIRED [AI-06, AI-07]
    |       approval required (missing, mismatch, sensitive, drift) -> OWNER_APPROVAL_REQUIRED [AI-12, CL-09, CP-13]
    |   Q10 Nothing fired                        -> AUTO_RESOLVE (advance one pipeline step) [CS-00, IN-01]
    |
    +-- YES (post-dispatch) ---------------------------------------------------------
        Q11 Were dispatch preconditions verified, with an idempotency identity, inside the lane capability?
            no                                   -> SYSTEM_HALT (lane)       [CP-16, PD-15, PD-13]
        Q12 Did anything the dispatch depended on break?
            authority changed/unbound, assignment superseded/missing, lease lost,
            same identity completed elsewhere, canonical unreadable/corrupt,
            checkpoint stale/corrupt, item invariant or approval changed
                                                 -> SYSTEM_HALT (lane; system if canonical corrupt or approval forged) [PD-01..PD-07, CP-09, CP-14, CP-15, CC-09, CC-10]
            owner halt set mid-flight, unrelated runtime append -> no effect on recording [CP-08, PD-04, PD-08]
        Q13 Is the external/internal outcome conclusive?
            success, external                     -> AUTO_RESOLVE (record)   [EX-02]
            success, internal, readback applied   -> AUTO_RESOLVE            [ST-02]
            success, internal, readback missing   -> SYSTEM_HALT (lane)      [ST-10, RR-08b]
            explicit failure, external            -> transient: AUTO_DEFER; permanent: QUARANTINE [EX-01, EX-03, EX-05]
            explicit failure, internal, readback proves not applied
                                                 -> CAS/stale runtime: AUTO_RETRY(plan)->AUTO_DEFER [ST-01c, ST-01d]
                                                 -> transient: AUTO_RETRY(operation)->SYSTEM_HALT [ST-01, ST-01b]
                                                 -> permanent: QUARANTINE
            explicit failure, internal, no readback proof -> SYSTEM_HALT (lane) [PD-17]
            readback contradicts the response     -> SYSTEM_HALT (lane)      [EX-10b, ST-05]
        Q14 Ambiguous (possibly applied)?
            internal, readback proves applied     -> AUTO_RESOLVE            [EX-07c, RR-03, ST-04]
            internal, readback proves not applied -> AUTO_RETRY(operation)   [EX-08b, RR-02]
            external, default policy              -> SYSTEM_HALT (lane, needs_reconciliation) [EX-04, EX-06, EX-07, EX-08]
            readback unavailable/contradictory/not performed -> SYSTEM_HALT (lane) [EX-09, EX-10, CP-05]
```

## Questions from the work order and where they are answered

| Question | Tree node |
|---|---|
| Is canonical state trustworthy? | Q1 |
| Is the problem item-local or system-wide? | Q1, Q5, Q12 (scope rules) |
| Has an external side effect possibly occurred? | Q3 |
| Is the external outcome conclusive? | Q13 |
| Is readback possible? | Q6, Q13, Q14 |
| Is retry provably safe? | Q13, Q14 (only internal + proven not applied + idempotent) |
| Is the action idempotent? | Q7, Q11 |
| Has authority changed? | Q2, Q12 |
| Has halt generation changed? | Q4 |
| Has runtime generation changed? | Q5, Q12 |
| Is another operation concurrently mutating the same object? | Q5, Q12 |
| Is the source trustworthy? | Q8 |
| Is human factual attestation required? | Q9 |
| Is human approval required? | Q4 (mutation window), Q9 |
| Can unrelated safe work continue? | Every decision's `unrelatedWorkContinues` (ADM-28, ADM-29) |

## Verification

The tree's Section 12 projection (48 combinations of canonical trust × side effect × retry safety × item-locality × owner authority) is re-expressed independently in `test/autonomy/harness/oracle.mjs#kernelExpected` and compared against `decide()`: 48/48 match. The full tree is the union of the gate rules, exhaustively enumerated (see `chaos-model.md`).
