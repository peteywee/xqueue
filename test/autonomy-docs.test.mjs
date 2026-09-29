import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { OUTCOMES } from '../src/autonomy/decision-outcomes.mjs';
import { SCENARIOS } from './autonomy/harness/scenarios.mjs';

const ROOT = new URL('..', import.meta.url).pathname;
const CONTRACT = readFileSync(join(ROOT, 'docs/contracts/autonomous-decision-contract.md'), 'utf8');
const ARCH = join(ROOT, 'docs/architecture/autonomy');
const TREES = join(ARCH, 'decision-trees');
const ids = new Set(SCENARIOS.map((s) => s.id));

function expand(prefix, a, b) {
  const out = [];
  for (let n = Number(a); n <= Number(b); n += 1) out.push(`${prefix}-${String(n).padStart(a.length, '0')}`);
  return out;
}

function scenarioRefs(text) {
  const refs = new Set();
  for (const m of text.matchAll(/\b(IN|CS|CC|EX|ST|CL|AI|RR|CP|PD)-(\d{2})(b|c|d)?\b(?:\.\.(?:\1-)?(\d{2}))?/g)) {
    if (m[4]) for (const r of expand(m[1], m[2], m[4])) refs.add(r);
    else refs.add(`${m[1]}-${m[2]}${m[3] ?? ''}`);
  }
  return refs;
}

test('every scenario ID cited in the contract and architecture docs is an executed scenario', () => {
  const files = [
    ['contract', CONTRACT],
    ...readdirSync(ARCH).filter((f) => f.endsWith('.md')).map((f) => [f, readFileSync(join(ARCH, f), 'utf8')]),
    ...readdirSync(TREES).map((f) => [f, readFileSync(join(TREES, f), 'utf8')]),
  ];
  const missing = [];
  for (const [name, text] of files) for (const ref of scenarioRefs(text)) if (!ids.has(ref)) missing.push(`${name}: ${ref}`);
  assert.deepEqual(missing, []);
});

test('ADM requirement IDs are unique, contiguous, and every one is proved by an acceptance case', () => {
  const defined = [...CONTRACT.matchAll(/\*\*ADM-(\d+)\*\*/g)].map((m) => Number(m[1]));
  assert.deepEqual(defined, Array.from({ length: defined.length }, (_, i) => i + 1));
  const proved = new Set();
  for (const row of CONTRACT.split('\n').filter((l) => l.startsWith('| ADM-AC-'))) {
    const cell = row.split('|')[2];
    for (const m of cell.matchAll(/ADM-(\d+)(?:\.\.ADM-(\d+))?/g)) {
      const end = m[2] ? Number(m[2]) : Number(m[1]);
      for (let n = Number(m[1]); n <= end; n += 1) proved.add(n);
    }
  }
  assert.deepEqual(defined.filter((n) => !proved.has(n)), []);
});

test('contract anchor block is present and the contract is proposed, not active', () => {
  assert.match(CONTRACT, /^<!--tos-doc/);
  assert.match(CONTRACT, /"claims_truth_state": "proposed"/);
  assert.doesNotMatch(CONTRACT, /Status \| active/);
});

test('one decision tree per outcome, each with happy, degraded, ambiguous and unsafe paths', () => {
  const files = readdirSync(TREES).map((f) => f.replace(/\.md$/, '')).sort();
  assert.deepEqual(files, [...OUTCOMES].sort());
  for (const outcome of OUTCOMES) {
    const text = readFileSync(join(TREES, `${outcome}.md`), 'utf8');
    for (const path of ['HAPPY PATH', 'DEGRADED PATH', 'AMBIGUOUS PATH', 'UNSAFE']) assert.ok(text.includes(path), `${outcome} ${path}`);
  }
});
