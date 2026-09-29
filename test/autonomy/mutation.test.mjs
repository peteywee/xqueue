// Mutation analysis: proves the Batch 0 test oracle can detect a wrong decision model or FSM.
// Lives outside test/*.test.mjs because it takes ~100s; run with `pnpm verify:autonomy`.
import test from 'node:test';
import assert from 'node:assert/strict';

import { runMutationAnalysis } from './harness/mutants.mjs';

test('mutation analysis: every non-equivalent mutant of the decision model and FSM is killed', () => {
  const r = runMutationAnalysis();
  assert.ok(r.total >= 300, `mutant count ${r.total}`);
  assert.deepEqual(r.survivors.map((s) => s.id), []);
  assert.equal(r.killed + r.equivalent, r.total);
  for (const must of ['model:naive-phase-blind-composition', 'compose:min-severity', 'model:retry-budget-ignored',
    'model:default-policy-trusts-external-readback', 'fsm:halt-from-executing-does-not-mark-dispatched',
    'fsm:owner-clear-returns-to-PLANNED', 'fsm:resume-skips-dispatch-consistency',
    'fsm:add:EXECUTING-AUTO_RESOLVE->COMPLETE', 'fsm:add:generator-approval']) {
    assert.equal(r.results.find((x) => x.id === must)?.status, 'killed', must);
  }
});
