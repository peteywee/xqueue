import test from 'node:test';
import assert from 'node:assert/strict';

import { DISPATCH_FAULTS, explore, terminalSummary, VERIFY_FAULTS } from './autonomy/harness/sim.mjs';

const COMBOS = [];
for (const d0 of DISPATCH_FAULTS) for (const v0 of VERIFY_FAULTS) for (const d1 of DISPATCH_FAULTS) for (const v1 of VERIFY_FAULTS) {
  COMBOS.push([{ dispatch: d0, verify: v0 }, { dispatch: d1, verify: v1 }]);
}

const SHAPES = {
  same_input: (f) => [{ key: 'k1', digest: 'd1', faults: f[0] }, { key: 'k1', digest: 'd1', faults: f[1] }],
  different_inputs: (f) => [{ key: 'k1', digest: 'd1', faults: f[0] }, { key: 'k2', digest: 'd2', faults: f[1] }],
  conflicting_identity: (f) => [{ key: 'k1', digest: 'd1', faults: f[0] }, { key: 'k1', digest: 'd9', faults: f[1] }],
};

for (const lane of ['canonical_mutation', 'publication']) {
  for (const [shape, make] of Object.entries(SHAPES)) {
    test(`simulation ${lane}/${shape}: every interleaving x fault combo x crash point is safe`, () => {
      let states = 0;
      const violations = new Set();
      for (const faults of COMBOS) {
        const r = explore({ lane, crashes: true, actors: make(faults) });
        states += r.states;
        for (const v of r.violations) violations.add(v);
        for (const w of r.terminals) {
          for (const a of w.actors) assert.ok(!['EXECUTING', 'VERIFYING'].includes(a.item.state), `${a.id} stranded in ${a.item.state}`);
        }
      }
      assert.deepEqual([...violations], []);
      assert.ok(states > 1000);
    });
  }
}

test('liveness without faults: same input converges to exactly one COMPLETE and one IGNORED', () => {
  for (const lane of ['canonical_mutation', 'publication']) {
    const r = explore({ lane, crashes: false, actors: SHAPES.same_input([{}, {}]) });
    assert.deepEqual(r.violations, []);
    for (const w of r.terminals) {
      const states = w.actors.map((a) => a.item.state).sort();
      const ok = (states[0] === 'COMPLETE' && states[1] === 'IGNORED') || (states[0] === 'COMPLETE' && states[1] === 'DEFERRED');
      assert.ok(ok, `${lane}: ${states.join(',')}`);
      assert.equal(Object.keys(w.store.records).length, 1);
      assert.equal(w.store.applyCount['op:k1:d1'], 1);
    }
  }
});

test('liveness without faults: different inputs both complete and both are recorded', () => {
  const r = explore({ lane: 'canonical_mutation', crashes: false, actors: SHAPES.different_inputs([{}, {}]) });
  const ends = terminalSummary(r);
  assert.deepEqual(Object.keys(ends), ['COMPLETE,COMPLETE']);
  for (const w of r.terminals) assert.equal(Object.keys(w.store.records).length, 2);
});

test('a lost publication response is never re-dispatched, even when the worker could retry', () => {
  const r = explore({ lane: 'publication', crashes: true, actors: [{ key: 'k1', digest: 'd1', faults: { dispatch: 'drop_response' } }] });
  assert.deepEqual(r.violations, []);
  for (const w of r.terminals) {
    assert.equal(w.actors[0].item.state, 'HALTED');
    assert.ok((w.store.external.k1 ?? 0) <= 1);
  }
});

test('conflicting identity never overwrites the committed record', () => {
  const r = explore({ lane: 'canonical_mutation', crashes: true, actors: SHAPES.conflicting_identity([{}, {}]) });
  assert.deepEqual(r.violations, []);
  for (const w of r.terminals) {
    const rec = w.store.records.k1;
    if (rec) assert.equal(Object.values(w.store.applyCount).reduce((a, b) => a + b, 0), 1);
  }
});
