// Integration tests against the real content library. These are the ones that
// fail when a post is edited badly, which is the whole point of the gate.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadLibrary, renderPost, PILLARS } from '../src/parse.mjs';
import { validate, summarize } from '../src/validate.mjs';
import { schedule } from '../src/schedule.mjs';

const CONTENT = resolve(dirname(fileURLToPath(import.meta.url)), '../content');
const posts = loadLibrary(CONTENT);

test('the library holds 180 posts', () => {
  assert.equal(posts.length, 180);
});

test('the pillar split matches the plan exactly', () => {
  const counts = {};
  for (const p of posts) counts[p.pillar] = (counts[p.pillar] ?? 0) + 1;
  assert.deepEqual(counts, { A: 72, B: 45, C: 36, D: 27 });

  for (const [pillar, n] of Object.entries(counts)) {
    assert.equal(n / posts.length, PILLARS[pillar].share, `${pillar} is off target`);
  }
});

test('post ids are unique and contiguous within each pillar', () => {
  const seen = new Set();
  const byPillar = {};
  for (const p of posts) {
    assert.ok(!seen.has(p.id), `duplicate id ${p.id}`);
    seen.add(p.id);
    (byPillar[p.pillar] ??= []).push(p.seq);
  }
  for (const [pillar, seqs] of Object.entries(byPillar)) {
    const sorted = [...seqs].sort((a, b) => a - b);
    for (let i = 0; i < sorted.length; i++) {
      assert.equal(sorted[i], i + 1, `${pillar} sequence breaks at ${sorted[i]}`);
    }
  }
});

test('every post has a body and a title', () => {
  for (const p of posts) {
    assert.ok(p.body && p.body.length > 40, `${p.id} body too short`);
    assert.ok(p.title && p.title.length > 2, `${p.id} has no title`);
  }
});

test('every labor law post carries the disclaimer', () => {
  const b = posts.filter((p) => p.pillar === 'B');
  assert.equal(b.length, 45);
  for (const p of b) {
    assert.match(renderPost(p), /not legal advice/i, `${p.id} is missing the disclaimer`);
  }
});

test('no post names an employer or claims an unauthorized relationship', () => {
  const findings = validate(posts);
  const blocking = findings.filter(
    (f) => f.level === 'error' && ['employer-name', 'unauthorized-claim'].includes(f.rule),
  );
  assert.deepEqual(blocking, [], JSON.stringify(blocking, null, 2));
});

test('the library validates with zero errors and zero warnings', () => {
  const findings = validate(posts);
  const counts = summarize(findings);
  const shown = findings.filter((f) => f.level !== 'info');
  assert.equal(counts.error, 0, `errors:\n${JSON.stringify(shown, null, 2)}`);
  assert.equal(counts.warn, 0, `warnings:\n${JSON.stringify(shown, null, 2)}`);
});

test('exactly one post is marked as pinned', () => {
  const pinned = posts.filter((p) => p.pinned);
  assert.equal(pinned.length, 1);
  assert.equal(pinned[0].id, 'A1');
});

test('every referenced figure number is plausible', () => {
  // 23 finished diagrams; a reference outside that range is a typo.
  for (const p of posts.filter((x) => x.figure != null)) {
    assert.ok(p.figure >= 1 && p.figure <= 23, `${p.id} references figure ${p.figure}`);
  }
});

test('no post body contains a link', () => {
  // $0.200 vs $0.015 per post, plus the reach penalty.
  for (const p of posts) {
    assert.doesNotMatch(p.body, /https?:\/\//, `${p.id} contains a link`);
  }
});

test('the real library schedules into a clean 90-day calendar', () => {
  const q = schedule(posts, { start: '2026-09-07' });
  const days = {};
  for (const p of q) (days[p.scheduledDate] ??= []).push(p);

  assert.equal(q.length, 180);
  assert.equal(Object.keys(days).length, 90);
  assert.equal(q[0].id, 'A1');
  for (const [date, ps] of Object.entries(days)) {
    assert.equal(ps.length, 2, `${date} has ${ps.length} posts`);
    assert.notEqual(ps[0].pillar, ps[1].pillar, `${date} repeats a pillar`);
  }
});
