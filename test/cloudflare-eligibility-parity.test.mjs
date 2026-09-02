import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { scheduledAt } from '../src/post-time.mjs';
import {
  evaluateEligibility,
  isLedgerResolved,
  isSupportedTimeZone,
  resolveScheduledAt,
  STRUCTURAL_FAILURES,
} from '../cloudflare/src/eligibility.mjs';
import { buildMatrix } from '../scripts/build-eligibility-parity-matrix.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MODULE_PATH = join(ROOT, 'cloudflare', 'src', 'eligibility.mjs');

const TZ = 'America/Chicago';

function post(id, scheduledDate, scheduledTime, timezone = TZ) {
  return { id, scheduledDate, scheduledTime, timezone };
}

function ledger({ posted = {}, skipped = {}, inflight = null } = {}) {
  return { version: 1, posted, skipped, spend: 0, inflight };
}

const P1 = post('P1', '2026-09-01', '14:30'); // 2026-09-01T19:30:00.000Z

// ---------------------------------------------------------------------------
// the parity matrix itself
// ---------------------------------------------------------------------------

test('every eligibility parity case matches the local runtime', () => {
  const matrix = buildMatrix();

  assert.ok(matrix.cases.length >= 24, 'matrix must cover the required fixtures');

  const failures = matrix.cases
    .filter((row) => row.verdict !== 'PASS')
    .map((row) => `${row.id}: ${row.divergences.join(' ')}`);

  assert.deepEqual(failures, []);
  assert.equal(matrix.summary.fail, 0);
  assert.equal(matrix.summary.pass, matrix.cases.length);
});

test('the parity matrix covers every required scenario', () => {
  const ids = new Set(buildMatrix().cases.map((row) => row.id));

  for (const required of [
    'before-due',
    'exactly-due',
    'inside-grace',
    'exactly-at-grace-boundary',
    'stale-beyond-grace',
    'already-posted',
    'owner-skipped',
    'inflight-prepared',
    'inflight-publishing',
    'inflight-needs-reconciliation',
    'needs-reconciliation-with-due-post',
    'deferred-tail-B1',
    'deferred-tail-A30',
    'deferred-tail-C1',
    'dst-spring-forward',
    'dst-fall-back',
    'dst-spring-forward-gap-due',
    'dst-fall-back-ambiguous-first-occurrence',
    'queue-order-differs-from-chronological-order',
    'multiple-due-posts',
    'malformed-queue-not-an-array',
    'malformed-ledger-posted-and-skipped',
    'unknown-timezone',
    'negative-grace-minutes',
  ]) {
    assert.ok(ids.has(required), `missing parity case: ${required}`);
  }
});

test('the parity matrix is built against the canonical 180-post queue', () => {
  const matrix = buildMatrix();

  assert.equal(matrix.productionQueue.count, 180);
  assert.equal(
    matrix.productionQueue.sha256,
    '09c36e24207d7720c46d163b83b9cee9465e6ded36221499032c0acee218bbc1',
  );
});

// ---------------------------------------------------------------------------
// worker compatibility of the module itself
// ---------------------------------------------------------------------------

test('the Cloudflare eligibility module has no Node or local-runtime dependencies', () => {
  const source = readFileSync(MODULE_PATH, 'utf8');

  assert.equal(/from\s+'node:/.test(source), false, 'no node: imports');
  assert.equal(/require\(/.test(source), false, 'no CommonJS require');
  assert.equal(/\.\.\/\.\.\/src\//.test(source), false, 'no import from src/');
  assert.equal(/\bfetch\(/.test(source), false, 'no network');
  assert.equal(/\benv\.DB\b/.test(source), false, 'no D1 access');
});

test('evaluateEligibility does not mutate its arguments', () => {
  const queue = Object.freeze([Object.freeze({ ...P1 })]);
  const state = Object.freeze({
    version: 1,
    posted: Object.freeze({}),
    skipped: Object.freeze({}),
    spend: 0,
    inflight: null,
  });

  const result = evaluateEligibility(queue, state, {
    now: new Date('2026-09-01T19:40:00.000Z'),
  });

  assert.deepEqual(result.selection.selected, ['P1']);
  assert.deepEqual(queue, [{ ...P1 }]);
});

// ---------------------------------------------------------------------------
// wall-clock resolution, including the DST boundaries
// ---------------------------------------------------------------------------

const INSTANTS = [
  ['2026-08-31', '14:30', '2026-08-31T19:30:00.000Z', 'campaign start, CDT'],
  ['2026-12-01', '14:30', '2026-12-01T20:30:00.000Z', 'CST'],
  ['2027-01-04', '14:30', '2027-01-04T20:30:00.000Z', 'deferred tail B1'],
  ['2027-01-04', '22:15', '2027-01-05T04:15:00.000Z', 'deferred tail A30'],
  ['2027-01-05', '14:30', '2027-01-05T20:30:00.000Z', 'deferred tail C1'],
  ['2027-03-14', '01:30', '2027-03-14T07:30:00.000Z', 'spring forward, before the gap (CST)'],
  ['2027-03-14', '02:30', '2027-03-14T07:30:00.000Z', 'spring forward, NONEXISTENT wall clock'],
  ['2027-03-14', '03:30', '2027-03-14T08:30:00.000Z', 'spring forward, after the gap (CDT)'],
  ['2027-03-14', '14:30', '2027-03-14T19:30:00.000Z', 'spring-forward day, afternoon (CDT)'],
  ['2027-11-07', '01:30', '2027-11-07T06:30:00.000Z', 'fall back, AMBIGUOUS wall clock (first/CDT)'],
  ['2027-11-07', '02:30', '2027-11-07T08:30:00.000Z', 'fall back, after the repeat (CST)'],
  ['2027-11-07', '14:30', '2027-11-07T20:30:00.000Z', 'fall-back day, afternoon (CST)'],
];

for (const [scheduledDate, scheduledTime, expected, label] of INSTANTS) {
  test(`resolveScheduledAt matches src/post-time.mjs: ${scheduledDate} ${scheduledTime} (${label})`, () => {
    const spec = { scheduledDate, scheduledTime, timezone: TZ };

    assert.equal(new Date(resolveScheduledAt(spec)).toISOString(), expected);
    assert.equal(resolveScheduledAt(spec), scheduledAt(spec).getTime());
  });
}

test('a nonexistent spring-forward wall clock collapses onto the instant before the gap', () => {
  assert.equal(
    resolveScheduledAt({ scheduledDate: '2027-03-14', scheduledTime: '02:30', timezone: TZ }),
    resolveScheduledAt({ scheduledDate: '2027-03-14', scheduledTime: '01:30', timezone: TZ }),
  );
});

test('an ambiguous fall-back wall clock resolves to the first (CDT) occurrence', () => {
  const first = Date.parse('2027-11-07T06:30:00.000Z');
  const second = Date.parse('2027-11-07T07:30:00.000Z');

  const resolved = resolveScheduledAt({
    scheduledDate: '2027-11-07',
    scheduledTime: '01:30',
    timezone: TZ,
  });

  assert.equal(resolved, first);
  assert.notEqual(resolved, second);
});

test('isSupportedTimeZone accepts IANA zones and rejects nonsense', () => {
  assert.equal(isSupportedTimeZone('America/Chicago'), true);
  assert.equal(isSupportedTimeZone('UTC'), true);
  assert.equal(isSupportedTimeZone('Mars/Phobos'), false);
  assert.equal(isSupportedTimeZone(''), false);
  assert.equal(isSupportedTimeZone(undefined), false);
});

// ---------------------------------------------------------------------------
// ledger resolution
// ---------------------------------------------------------------------------

test('isLedgerResolved covers posted, skipped, unknown and absent ledgers', () => {
  const state = ledger({
    posted: { A1: { tweetId: '1' } },
    skipped: { B1: { at: 'x', reason: 'y' } },
  });

  assert.equal(isLedgerResolved(state, 'A1'), true);
  assert.equal(isLedgerResolved(state, 'B1'), true);
  assert.equal(isLedgerResolved(state, 'C1'), false);
  assert.equal(isLedgerResolved(null, 'A1'), false);
});

// ---------------------------------------------------------------------------
// boundaries, restated directly against the module
// ---------------------------------------------------------------------------

test('due is inclusive of the scheduled instant', () => {
  const before = evaluateEligibility([P1], ledger(), {
    now: new Date('2026-09-01T19:29:59.999Z'),
  });
  const at = evaluateEligibility([P1], ledger(), {
    now: new Date('2026-09-01T19:30:00.000Z'),
  });

  assert.deepEqual(before.health.due, []);
  assert.deepEqual(at.health.due, ['P1']);
  assert.equal(at.safeToPublish, true);
});

test('overdue is strict about the grace cutoff', () => {
  const atCutoff = evaluateEligibility([P1], ledger(), {
    now: new Date('2026-09-01T19:50:00.000Z'),
    graceMinutes: 20,
  });
  const pastCutoff = evaluateEligibility([P1], ledger(), {
    now: new Date('2026-09-01T19:50:00.001Z'),
    graceMinutes: 20,
  });

  assert.deepEqual(atCutoff.health.overdue, []);
  assert.equal(atCutoff.health.ok, true);
  assert.deepEqual(pastCutoff.health.overdue, ['P1']);
  assert.equal(pastCutoff.health.ok, false);
});

test('a stale backlog withholds safeToPublish but never blocks the local selection', () => {
  const result = evaluateEligibility([P1], ledger(), {
    now: new Date('2026-09-01T21:00:00.000Z'),
    graceMinutes: 20,
  });

  assert.equal(result.selection.blocked, false);
  assert.equal(result.selection.blockReason, null);
  assert.deepEqual(result.selection.selected, ['P1']);
  assert.deepEqual(result.failures, []);
  assert.equal(result.health.ok, false);
  assert.equal(result.safeToPublish, false);
});

test('due and overdue preserve queue array order, next is chronological', () => {
  const later = post('Z1', '2026-09-01', '22:15');
  const earlier = post('Y1', '2026-09-01', '14:30');
  const future = post('X1', '2026-09-03', '14:30');
  const sooner = post('W1', '2026-09-02', '14:30');

  const result = evaluateEligibility([later, earlier, future, sooner], ledger(), {
    now: new Date('2026-09-02T03:15:00.000Z'),
    graceMinutes: 720,
  });

  assert.deepEqual(result.health.due, ['Z1', 'Y1']);
  assert.deepEqual(result.selection.selected, ['Z1']);
  assert.equal(result.health.next, 'W1');
});

test('maxPublications caps the selection and defaults to one', () => {
  const queue = [P1, post('M2', '2026-09-01', '22:15'), post('M3', '2026-09-02', '14:30')];
  const now = new Date('2026-09-02T20:00:00.000Z');

  assert.deepEqual(
    evaluateEligibility(queue, ledger(), { now, graceMinutes: 4320 }).selection.selected,
    ['P1'],
  );
  assert.deepEqual(
    evaluateEligibility(queue, ledger(), { now, graceMinutes: 4320, maxPublications: 2 })
      .selection.selected,
    ['P1', 'M2'],
  );
  assert.deepEqual(
    evaluateEligibility(queue, ledger(), { now, graceMinutes: 4320, maxPublications: 0 })
      .selection.selected,
    [],
  );
});

// ---------------------------------------------------------------------------
// fail-closed reason codes
// ---------------------------------------------------------------------------

function assertFailsClosed(result, code) {
  assert.ok(
    result.failures.includes(code),
    `expected failure ${code}, got ${JSON.stringify(result.failures)}`,
  );
  assert.equal(result.safeToPublish, false);
  assert.deepEqual(result.selection.selected, []);
}

const NOW = new Date('2026-09-01T19:40:00.000Z');

test('malformed_queue: queue is not an array', () => {
  const result = evaluateEligibility({ P1 }, ledger(), { now: NOW });
  assertFailsClosed(result, 'malformed_queue');
  assert.equal(result.selection.blocked, true);
  assert.equal(result.selection.blockReason, 'malformed_queue');
});

test('malformed_queue: an entry is missing a scheduling field or an id', () => {
  for (const broken of [
    { id: 'P1', scheduledDate: '2026-09-01', timezone: TZ },
    { id: 'P1', scheduledTime: '14:30', timezone: TZ },
    { id: 'P1', scheduledDate: '2026-09-01', scheduledTime: '14:30' },
    { scheduledDate: '2026-09-01', scheduledTime: '14:30', timezone: TZ },
    null,
  ]) {
    assertFailsClosed(
      evaluateEligibility([broken], ledger(), { now: NOW }),
      'malformed_queue',
    );
  }
});

test('duplicate_post_ids', () => {
  assertFailsClosed(
    evaluateEligibility([P1, post('P1', '2026-09-02', '14:30')], ledger(), { now: NOW }),
    'duplicate_post_ids',
  );
});

test('malformed_ledger: every normalizeState invariant', () => {
  const cases = [
    null,
    undefined,
    [],
    'nope',
    { posted: [] },
    { posted: {}, skipped: [] },
    { posted: { P1: { at: 'x' } } },
    { posted: {}, skipped: { P1: { reason: 'x' } } },
    { posted: {}, skipped: { P1: { at: 'x' } } },
    {
      posted: { P1: { tweetId: '1' } },
      skipped: { P1: { at: 'x', reason: 'y' } },
    },
    { posted: {}, skipped: {}, spend: -1 },
    { posted: {}, skipped: {}, spend: Number.NaN },
    { posted: {}, skipped: {}, inflight: {} },
    { posted: {}, skipped: {}, inflight: { postId: 'P1' } },
    { posted: {}, skipped: {}, inflight: { postId: 'P1', status: 'wedged' } },
    { posted: {}, skipped: {}, inflight: { postId: '', status: 'prepared' } },
    {
      posted: { P1: { tweetId: '1' } },
      skipped: {},
      inflight: { postId: 'P1', status: 'publishing' },
    },
    {
      posted: {},
      skipped: { P1: { at: 'x', reason: 'y' } },
      inflight: { postId: 'P1', status: 'publishing' },
    },
  ];

  for (const broken of cases) {
    assertFailsClosed(
      evaluateEligibility([P1], broken, { now: NOW }),
      'malformed_ledger',
    );
  }
});

test('invalid_grace', () => {
  for (const graceMinutes of [-1, Number.NaN, Number.POSITIVE_INFINITY, '20', null]) {
    assertFailsClosed(
      evaluateEligibility([P1], ledger(), { now: NOW, graceMinutes }),
      'invalid_grace',
    );
  }
});

test('unknown_timezone', () => {
  assertFailsClosed(
    evaluateEligibility([post('P1', '2026-09-01', '14:30', 'Mars/Phobos')], ledger(), {
      now: NOW,
    }),
    'unknown_timezone',
  );
});

test('invalid_now is a Cloudflare-only guard that withholds', () => {
  for (const now of [undefined, null, 'not-a-date', new Date('nonsense'), Number.NaN]) {
    assertFailsClosed(
      evaluateEligibility([P1], ledger(), { now }),
      'invalid_now',
    );
  }
});

test('invalid_max_publications is a Cloudflare-only guard that withholds', () => {
  for (const maxPublications of [-1, 1.5, '1', null]) {
    assertFailsClosed(
      evaluateEligibility([P1], ledger(), { now: NOW, maxPublications }),
      'invalid_max_publications',
    );
  }
});

test('inflight_prepared blocks read-only evaluation (fail-closed divergence from local live recovery)', () => {
  const result = evaluateEligibility([P1], ledger({
    inflight: { postId: 'P1', status: 'prepared' },
  }), { now: NOW });

  assertFailsClosed(result, 'inflight_prepared');
  assert.equal(result.selection.blocked, true);
  assert.equal(result.selection.blockReason, 'inflight_prepared');
  assert.deepEqual(result.health.due, ['P1']);
  assert.equal(result.health.ok, false);
});

test('inflight_publishing blocks', () => {
  const result = evaluateEligibility([P1], ledger({
    inflight: { postId: 'P1', status: 'publishing' },
  }), { now: NOW });

  assertFailsClosed(result, 'inflight_publishing');
  assert.equal(result.selection.blockReason, 'inflight_publishing');
});

test('inflight_needs_reconciliation blocks even when another post is due', () => {
  const result = evaluateEligibility([P1, post('P2', '2026-09-02', '14:30')], ledger({
    inflight: { postId: 'P2', status: 'needs_reconciliation' },
  }), { now: NOW });

  assertFailsClosed(result, 'inflight_needs_reconciliation');
  assert.equal(result.selection.blockReason, 'inflight_needs_reconciliation');
  assert.deepEqual(result.health.due, ['P1']);
});

test('every structural failure suppresses the health projection inputs', () => {
  for (const code of STRUCTURAL_FAILURES) {
    assert.equal(typeof code, 'string');
  }

  const result = evaluateEligibility('not a queue', ledger(), { now: NOW });

  assert.equal(result.health.ok, false);
  assert.deepEqual(result.health.due, []);
  assert.deepEqual(result.health.overdue, []);
  assert.equal(result.health.next, null);
});
