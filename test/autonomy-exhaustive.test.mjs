import test from 'node:test';
import assert from 'node:assert/strict';

import { GATES } from '../src/autonomy/decision-model.mjs';
import {
  exhaustComposition, exhaustGates, exhaustKernel, KERNEL_DIMENSIONS, liftAndCheck, sampleFullSpace,
} from './autonomy/harness/oracle.mjs';
import { sampleNearBaseline } from './autonomy/harness/runner.mjs';

const gates = exhaustGates();

test('every gate is exhaustively enumerated over its declared projection with no structural problems', () => {
  for (const r of gates.report) {
    assert.deepEqual(r.problems, [], r.gate);
    assert.ok(r.points > 0 && r.verdictClasses > 0, r.gate);
  }
  const expected = { SYSTEM: 12288, FENCE: 384, EFFECT: 19200, INPUT: 112, CONTENT: 2880 };
  for (const r of gates.report) assert.equal(r.points, expected[r.gate], r.gate);
  assert.equal(GATES.length, 5);
});

test('composition is exhaustively checked over every combination of gate verdict classes', () => {
  const c = exhaustComposition(gates.classes);
  assert.deepEqual(c.problems, []);
  const expectedCombos = Object.values(gates.classes).reduce((n, cls) => n * cls.length, 1);
  assert.equal(c.combos, expectedCombos);
});

test('every gate-domain point lifted to a full observation satisfies every decision invariant', () => {
  const r = liftAndCheck();
  assert.equal(r.checked, 50528);
  assert.deepEqual(r.violations.map((v) => `${v.id}: ${v.message}`), []);
});

test('Section 12 kernel: all 48 combinations match the independent global tree and invariants', () => {
  const rows = exhaustKernel();
  const size = Object.values(KERNEL_DIMENSIONS).reduce((n, v) => n * v.length, 1);
  assert.equal(rows.length, size);
  assert.equal(size, 48);
  assert.deepEqual(rows.filter((r) => !r.ok || r.invariantViolations.length), []);
});

test('seeded uniform sample of the full 148.6-billion-point space: 0 violations, 0 determinism failures', () => {
  const s = sampleFullSpace(100000);
  assert.equal(s.determinismFailures, 0);
  assert.deepEqual(s.violations.map((v) => v.id), []);
});

test('seeded near-baseline sample (realistic outcome mix): 0 violations, every outcome exercised', () => {
  const s = sampleNearBaseline(50000, 7, 0.12);
  assert.deepEqual(s.violations.map((v) => v.id), []);
  for (const outcome of ['AUTO_RESOLVE', 'AUTO_RETRY', 'AUTO_DEFER', 'AUTO_IGNORE', 'QUARANTINE',
    'OWNER_ATTESTATION_REQUIRED', 'OWNER_APPROVAL_REQUIRED', 'SYSTEM_HALT']) {
    assert.ok((s.outcomes[outcome] ?? 0) > 0, `${outcome} exercised`);
  }
});
