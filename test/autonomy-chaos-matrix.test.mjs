import test from 'node:test';
import assert from 'node:assert/strict';

import { HAPPY_REQUIRED, REQUIRED_SCENARIOS, SCENARIOS } from './autonomy/harness/scenarios.mjs';
import { runScenario } from './autonomy/harness/runner.mjs';

const SCENARIO_FIELDS = ['id', 'family', 'polarity', 'covers', 'title', 'injected_fault', 'items'];

for (const scenario of SCENARIOS.filter((s) => s.family !== 'compound')) {
  test(`${scenario.id} [${scenario.family}/${scenario.polarity}] ${scenario.title}`, () => {
    const result = runScenario(scenario);
    const problems = [
      ...result.items.filter((i) => !i.ok).map((i) => `${i.label ?? 'item'}: ${i.problems.join('; ')}`),
      ...result.attempts.filter((a) => !a.ok).map((a) => `fsm attempt ${a.from.state}-${a.event}: ${a.result}`),
    ];
    assert.deepEqual(problems, []);
  });
}

test('every scenario carries the required matrix fields', () => {
  for (const s of SCENARIOS) {
    for (const f of SCENARIO_FIELDS) assert.ok(f in s, `${s.id} missing ${f}`);
    for (const it of s.items) {
      assert.ok(it.observations && it.start && it.expect, s.id);
      for (const f of ['outcome', 'final', 'unrelated', 'notify']) assert.ok(f in it.expect, `${s.id} expect.${f}`);
    }
  }
  assert.equal(new Set(SCENARIOS.map((s) => s.id)).size, SCENARIOS.length, 'scenario ids unique');
});

test('every required scenario bullet (all nine families) is covered by at least one passing scenario', () => {
  const missing = [];
  for (const [family, bullets] of Object.entries(REQUIRED_SCENARIOS)) {
    for (const bullet of bullets) {
      const covering = SCENARIOS.filter((s) => s.covers.includes(bullet));
      if (!covering.length || !covering.some((s) => runScenario(s).ok)) missing.push(`${family}:${bullet}`);
    }
  }
  assert.deepEqual(missing, []);
});

test('every required non-happy bullet is covered by a NEGATIVE scenario', () => {
  const missing = [];
  for (const bullets of Object.values(REQUIRED_SCENARIOS)) {
    for (const bullet of bullets.filter((b) => !HAPPY_REQUIRED.includes(b))) {
      if (!SCENARIOS.some((s) => s.polarity === 'negative' && s.covers.includes(bullet))) missing.push(bullet);
    }
  }
  assert.deepEqual(missing, []);
});

test('negative/chaos scenarios outnumber happy-path scenarios by at least 2:1', () => {
  const happy = SCENARIOS.filter((s) => s.polarity === 'happy').length;
  const negative = SCENARIOS.filter((s) => s.polarity === 'negative').length;
  assert.ok(happy > 0);
  assert.ok(negative >= 2 * happy, `${negative} negative vs ${happy} happy`);
});
