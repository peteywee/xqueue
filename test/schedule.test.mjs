import { test } from 'node:test';
import assert from 'node:assert/strict';

import { schedule, stats, PILLAR_CYCLE } from '../src/schedule.mjs';

/** Build a synthetic library with the same shape as the real one. */
function library({ A = 72, B = 45, C = 36, D = 27 } = {}) {
  const out = [];
  for (const [pillar, n] of Object.entries({ A, B, C, D })) {
    for (let i = 1; i <= n; i++) {
      out.push({
        id: `${pillar}${i}`, pillar, seq: i, title: `${pillar} ${i}`,
        figure: null, pinned: pillar === 'A' && i === 1,
        body: `Body for ${pillar}${i}`, sourceFile: 'synthetic', sourceLine: i,
      });
    }
  }
  return out;
}

const byDay = (q) => {
  const m = {};
  for (const p of q) (m[p.scheduledDate] ??= []).push(p);
  return m;
};

test('the pillar cycle hits the 40/25/20/15 split exactly', () => {
  const counts = { A: 0, B: 0, C: 0, D: 0 };
  for (const day of PILLAR_CYCLE) for (const p of day) counts[p]++;
  assert.deepEqual(counts, { A: 8, B: 5, C: 4, D: 3 });
  const total = 20;
  assert.equal(counts.A / total, 0.40);
  assert.equal(counts.B / total, 0.25);
  assert.equal(counts.C / total, 0.20);
  assert.equal(counts.D / total, 0.15);
});

test('no day in the cycle repeats a pillar', () => {
  for (const [i, day] of PILLAR_CYCLE.entries()) {
    assert.notEqual(day[0], day[1], `cycle day ${i + 1} repeats ${day[0]}`);
  }
});

test('schedules every post exactly once', () => {
  const lib = library();
  const q = schedule(lib, { start: '2026-09-07' });
  assert.equal(q.length, lib.length);
  assert.equal(new Set(q.map((p) => p.id)).size, lib.length);
});

test('180 posts fill 90 posting days at two a day', () => {
  const q = schedule(library(), { start: '2026-09-07' });
  const days = byDay(q);
  assert.equal(Object.keys(days).length, 90);
  for (const [date, posts] of Object.entries(days)) {
    assert.equal(posts.length, 2, `${date} has ${posts.length} posts`);
  }
});

test('no scheduled day carries two posts from the same pillar', () => {
  const q = schedule(library(), { start: '2026-09-07' });
  for (const [date, posts] of Object.entries(byDay(q))) {
    assert.notEqual(posts[0].pillar, posts[1].pillar, `${date}: two ${posts[0].pillar} posts`);
  }
});

test('the pinned post publishes first', () => {
  const q = schedule(library(), { start: '2026-09-07' });
  assert.equal(q[0].pinned, true);
  assert.equal(q[0].id, 'A1');
  assert.equal(q[0].slot, 'lull');
  assert.equal(q[0].scheduledDate, '2026-09-07');
});

test('every date and time pairing is unique', () => {
  const q = schedule(library(), { start: '2026-09-07' });
  const slots = q.map((p) => `${p.scheduledDate}T${p.scheduledTime}`);
  assert.equal(new Set(slots).size, slots.length);
});

test('slots are assigned lull then post-close', () => {
  const q = schedule(library(), { start: '2026-09-07' });
  for (const posts of Object.values(byDay(q))) {
    assert.equal(posts[0].slot, 'lull');
    assert.equal(posts[1].slot, 'post-close');
    assert.ok(posts[0].scheduledTime < posts[1].scheduledTime);
  }
});

test('only configured weekdays are used', () => {
  const q = schedule(library(), { start: '2026-09-07', daysOfWeek: [1, 2, 3, 4, 5] });
  for (const p of q) {
    const dow = new Date(`${p.scheduledDate}T12:00:00Z`).getUTCDay();
    assert.ok(dow >= 1 && dow <= 5, `${p.scheduledDate} is day ${dow}`);
  }
});

test('a seven-day cadence compresses the calendar', () => {
  const five = schedule(library(), { start: '2026-09-07', daysOfWeek: [1, 2, 3, 4, 5] });
  const seven = schedule(library(), { start: '2026-09-07', daysOfWeek: [0, 1, 2, 3, 4, 5, 6] });
  assert.ok(seven[seven.length - 1].scheduledDate < five[five.length - 1].scheduledDate);
  assert.equal(Object.keys(byDay(seven)).length, 90);
});

test('the stride spreads topics instead of running in numeric order', () => {
  const q = schedule(library(), { start: '2026-09-07' });
  const a = q.filter((p) => p.pillar === 'A').map((p) => p.seq);
  let adjacent = 0;
  for (let i = 1; i < a.length; i++) if (Math.abs(a[i] - a[i - 1]) <= 2) adjacent++;
  assert.equal(adjacent, 0, `${adjacent} A-posts landed within 2 of the previous one`);
});

test('scheduling is deterministic', () => {
  const a = schedule(library(), { start: '2026-09-07' });
  const b = schedule(library(), { start: '2026-09-07' });
  assert.deepEqual(a.map((p) => p.id), b.map((p) => p.id));
});

test('custom slot times are honoured', () => {
  const q = schedule(library(), { start: '2026-09-07', slots: ['09:00', '17:30'] });
  assert.equal(q[0].scheduledTime, '09:00');
  assert.equal(q[1].scheduledTime, '17:30');
});

test('an unbalanced library still schedules every post', () => {
  const lib = library({ A: 10, B: 2, C: 1, D: 1 });
  const q = schedule(lib, { start: '2026-09-07' });
  assert.equal(q.length, 14);
  assert.equal(new Set(q.map((p) => p.id)).size, 14);
});

test('stats reports the split and the runway', () => {
  const s = stats(schedule(library(), { start: '2026-09-07' }));
  assert.equal(s.posts, 180);
  assert.equal(s.postingDays, 90);
  assert.equal(s.weeks, 18);
  assert.deepEqual(s.byPillar, { A: 72, B: 45, C: 36, D: 27 });
  assert.equal(s.shares.A, '40%');
  assert.equal(s.first, '2026-09-07');
});
