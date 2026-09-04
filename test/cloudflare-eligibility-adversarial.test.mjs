// cloudflare-eligibility-adversarial.test.mjs
//
// Adversarial review of cloudflare/src/eligibility.mjs.
//
// THE ONLY DANGEROUS DIVERGENCE DIRECTION
//   The local systemd runtime is the sole publication authority. If publication
//   authority were ever mirrored to Cloudflare, the single failure that would
//   actually publish something nobody sanctioned is:
//
//       LOCAL REFUSES  ->  CLOUDFLARE ACCEPTS
//
//   i.e. an input the local pipeline (readState -> normalizeState ->
//   analyzeRuntime -> cmdPost) rejects outright, but for which
//   evaluateEligibility still reports safeToPublish or selects a post.
//
//   The opposite direction (Cloudflare withholds where local proceeds) is
//   fail-closed and is asserted here as an explicitly documented property, not
//   treated as a bug.
//
// This file drives the LOCAL pipeline and the CLOUDFLARE module over the same
// adversarial inputs and asserts the dangerous direction never occurs.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadLibrary } from '../src/parse.mjs';
import { schedule } from '../src/schedule.mjs';
import { normalizeState } from '../src/state-store.mjs';
import { analyzeRuntime, isResolved } from '../src/runtime-health.mjs';
import { isDue, scheduledAt } from '../src/post-time.mjs';

import {
  evaluateEligibility,
  resolveScheduledAt,
  STRUCTURAL_FAILURES,
} from '../cloudflare/src/eligibility.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TZ = 'America/Chicago';

function post(id, scheduledDate, scheduledTime, timezone = TZ) {
  return { id, scheduledDate, scheduledTime, timezone };
}

function ledger({ posted = {}, skipped = {}, spend = 0, inflight = null } = {}) {
  return { version: 1, posted, skipped, spend, inflight };
}

const P1 = post('P1', '2026-09-01', '14:30'); // 2026-09-01T19:30:00.000Z
const NOW = new Date('2026-09-01T19:40:00.000Z');

// ---------------------------------------------------------------------------
// LOCAL reference pipeline
//
// Exactly the sequence a `pnpm post:live` run performs on already-parsed
// inputs: the unique-id validation gate, readState()'s normalizeState, the
// analyzeRuntime health computation, cmdPost's inflight refusal, and
// due.slice(0, 1). Returns either a refusal or the ids a live run would send.
// ---------------------------------------------------------------------------

function localPipeline(queue, rawLedger, { now, graceMinutes = 20 } = {}) {
  if (Array.isArray(queue)) {
    const seen = new Set();
    for (const entry of queue) {
      const id = entry?.id;
      if (seen.has(id)) {
        return { refused: true, stage: 'unique-id gate', message: `duplicate id ${id}` };
      }
      seen.add(id);
    }
  }

  let state;
  try {
    state = normalizeState(rawLedger);
  } catch (error) {
    return { refused: true, stage: 'normalizeState', message: error.message };
  }

  try {
    analyzeRuntime(queue, state, { now, graceMinutes });
  } catch (error) {
    return { refused: true, stage: 'analyzeRuntime', message: error.message };
  }

  if (state.inflight && state.inflight.status !== 'prepared') {
    return {
      refused: true,
      stage: 'cmdPost inflight guard',
      message: `inflight ${state.inflight.status}`,
    };
  }

  let due;
  try {
    due = queue.filter((entry) => !isResolved(state, entry.id) && isDue(entry, now));
  } catch (error) {
    return { refused: true, stage: 'isDue', message: error.message };
  }

  return { refused: false, wouldPublish: due.slice(0, 1).map((entry) => entry.id) };
}

function cloudflare(queue, rawLedger, options) {
  return evaluateEligibility(queue, rawLedger, { maxPublications: 1, ...options });
}

/**
 * The core adversarial invariant. Whenever the local pipeline refuses, the
 * Cloudflare module must also refuse: no selection, no safeToPublish.
 */
function assertNeverMorePermissive(label, queue, rawLedger, options = {}) {
  const opts = { now: NOW, graceMinutes: 20, ...options };
  const local = localPipeline(queue, rawLedger, opts);

  let result;
  assert.doesNotThrow(() => {
    result = cloudflare(queue, rawLedger, opts);
  }, `evaluateEligibility must never throw (${label})`);

  if (local.refused) {
    assert.equal(
      result.safeToPublish,
      false,
      `DANGEROUS: local refuses at ${local.stage} (${local.message}) but Cloudflare reports safeToPublish (${label})`,
    );
    assert.deepEqual(
      result.selection.selected,
      [],
      `DANGEROUS: local refuses at ${local.stage} (${local.message}) but Cloudflare selected ${JSON.stringify(result.selection.selected)} (${label})`,
    );
    assert.ok(
      result.failures.length > 0,
      `local refuses at ${local.stage} but Cloudflare recorded no failure (${label})`,
    );
    return { local, result };
  }

  // Local proceeds: Cloudflare may withhold, but must never select something
  // other than the prefix of what the local live run would publish.
  if (result.selection.selected.length > 0) {
    assert.deepEqual(
      result.selection.selected,
      local.wouldPublish,
      `DANGEROUS: Cloudflare selected ${JSON.stringify(result.selection.selected)} while a local live run would publish ${JSON.stringify(local.wouldPublish)} (${label})`,
    );
  }

  return { local, result };
}

// ---------------------------------------------------------------------------
// 1. CRITICAL — ledger keys that shadow Object.prototype
//
// normalizeState decides "is this id already posted?" with a TRUTHINESS test
// (`if (posted[postId])`), which is true for every inherited Object.prototype
// member. A ledger whose `skipped` map is keyed 'constructor' therefore makes
// the LOCAL runtime throw and refuse to publish at all. Cloudflare used
// hasOwnProperty, accepted the ledger, and reported safeToPublish for a post
// the local runtime would never have reached.
// ---------------------------------------------------------------------------

const PROTOTYPE_KEYS = [
  'constructor',
  'toString',
  'valueOf',
  'hasOwnProperty',
  'isPrototypeOf',
  'propertyIsEnumerable',
  'toLocaleString',
  '__defineGetter__',
];

test('CRITICAL: a skipped key shadowing Object.prototype refuses on both sides', () => {
  for (const key of PROTOTYPE_KEYS) {
    const raw = ledger({
      skipped: { [key]: { at: '2026-09-01T19:00:00.000Z', reason: 'operator skip' } },
    });

    assert.throws(
      () => normalizeState(raw),
      /cannot be both posted and skipped/,
      `local normalizeState must reject a skipped key of "${key}"`,
    );

    const { result } = assertNeverMorePermissive(`skipped key ${key}`, [P1], raw);

    assert.deepEqual(result.failures, ['malformed_ledger']);
    assert.equal(result.selection.blocked, true);
    assert.equal(result.selection.blockReason, 'malformed_ledger');
  }
});

test('CRITICAL: an inflight postId shadowing Object.prototype refuses on both sides', () => {
  for (const key of PROTOTYPE_KEYS) {
    for (const status of ['prepared', 'publishing', 'needs_reconciliation']) {
      const raw = ledger({ inflight: { postId: key, status } });

      assert.throws(
        () => normalizeState(raw),
        /cannot also be posted or skipped/,
        `local normalizeState must reject inflight.postId "${key}"`,
      );

      const { result } = assertNeverMorePermissive(`inflight ${key}/${status}`, [P1], raw);

      // The refusal must be the LEDGER refusal, matching local, not the softer
      // inflight block: local never gets far enough to see the inflight.
      assert.deepEqual(result.failures, ['malformed_ledger']);
      assert.equal(result.selection.blockReason, 'malformed_ledger');
    }
  }
});

test('a prototype-keyed POSTED entry is rejected identically by both sides', () => {
  // posted.constructor is a plain object with a tweetId, so it survives the
  // per-record check; the skipped/posted overlap rule is what must catch it.
  const raw = ledger({
    posted: { constructor: { tweetId: 'tweet-x' } },
    skipped: { constructor: { at: '2026-09-01T19:00:00.000Z', reason: 'dup' } },
  });

  assert.throws(() => normalizeState(raw), /cannot be both posted and skipped/);
  assertNeverMorePermissive('posted+skipped constructor', [P1], raw);
});

// ---------------------------------------------------------------------------
// 2. evaluateEligibility must never throw — array holes
//
// Array.prototype.every SKIPS holes, so a sparse queue passed the shape check
// and then crashed the `for...of` that reads post.id. The local runtime does
// not crash (filter also skips holes); it happily publishes. Cloudflare must
// fail closed instead, and above all must not throw out of a documented
// never-throws entry point.
// ---------------------------------------------------------------------------

test('a sparse (hole-containing) queue fails closed instead of throwing', () => {
  const cases = [
    ['leading hole', [, P1]],
    ['trailing hole', [P1, , ]],
    ['all holes', new Array(3)],
    ['hole between posts', [P1, , post('P2', '2026-09-02', '14:30')]],
  ];

  for (const [label, queue] of cases) {
    let result;
    assert.doesNotThrow(() => {
      result = cloudflare(queue, ledger(), { now: NOW });
    }, `evaluateEligibility must not throw on a sparse queue (${label})`);

    assert.deepEqual(result.failures, ['malformed_queue'], label);
    assert.equal(result.safeToPublish, false, label);
    assert.deepEqual(result.selection.selected, [], label);
  }
});

// ---------------------------------------------------------------------------
// 3. `now` must satisfy the same contract analyzeRuntime demands
//
// analyzeRuntime calls now.getTime(). A number or a string therefore makes the
// LOCAL runtime throw. Cloudflare coerced both into an instant and published
// against them: local refuses, Cloudflare accepts.
// ---------------------------------------------------------------------------

test('a `now` the local runtime cannot use is invalid_now, not a coerced instant', () => {
  const rejected = [
    NOW.getTime(),
    '2026-09-01T19:40:00.000Z',
    '2026-09-01',
    undefined,
    null,
    Number.NaN,
    new Date('nonsense'),
    'tomorrow',
    { epoch: NOW.getTime() },
    [NOW.getTime()],
    true,
    { getTime: () => NOW.getTime() },
    { getTime: () => Number.NaN },
    { valueOf: () => NOW.getTime() },
  ];

  for (const now of rejected) {
    const result = cloudflare([P1], ledger(), { now });
    assert.ok(
      result.failures.includes('invalid_now'),
      `expected invalid_now for now=${JSON.stringify(now)}, got ${JSON.stringify(result.failures)}`,
    );
    assert.equal(result.safeToPublish, false);
    assert.deepEqual(result.selection.selected, []);
  }
});

test('a duck-typed clock is refused, because local cmdPost would find NOTHING due', () => {
  // analyzeRuntime only calls now.getTime(), so a { getTime } object survives
  // the health computation locally. But cmdPost selects with isDue(), which
  // compares `scheduledAt(post) <= now` relationally: against a non-Date that
  // comparison is false for every post, so a local live run publishes nothing.
  // Cloudflare must not turn that into a selection.
  const duck = { getTime: () => NOW.getTime() };

  const local = localPipeline([P1], ledger(), { now: duck, graceMinutes: 20 });
  assert.equal(local.refused, false, 'analyzeRuntime tolerates a duck-typed clock');
  assert.deepEqual(local.wouldPublish, [], 'but cmdPost finds nothing due');

  const result = cloudflare([P1], ledger(), { now: duck, graceMinutes: 20 });
  assert.ok(result.failures.includes('invalid_now'));
  assert.deepEqual(result.selection.selected, []);
  assert.equal(result.safeToPublish, false);
});

// ---------------------------------------------------------------------------
// 4. The full refusal surface of normalizeState / analyzeRuntime / scheduledAt
//
// Every documented way the local runtime refuses, driven through both sides.
// ---------------------------------------------------------------------------

test('every local ledger refusal is matched by a Cloudflare refusal', () => {
  const badLedgers = {
    'ledger null': null,
    'ledger undefined': undefined,
    'ledger array': [],
    'ledger string': 'state',
    'ledger number': 7,
    'ledger true': true,
    'posted array': ledger({ posted: [] }),
    'posted string': ledger({ posted: 'x' }),
    'posted zero': ledger({ posted: 0 }),
    'posted false': ledger({ posted: false }),
    'skipped array': ledger({ skipped: [] }),
    'skipped number': ledger({ skipped: 1 }),
    'posted record null': ledger({ posted: { Q1: null } }),
    'posted record array': ledger({ posted: { Q1: [] } }),
    'posted record string': ledger({ posted: { Q1: 'tweet' } }),
    'posted record without tweetId': ledger({ posted: { Q1: {} } }),
    'posted record empty tweetId': ledger({ posted: { Q1: { tweetId: '' } } }),
    'posted record numeric tweetId': ledger({ posted: { Q1: { tweetId: 42 } } }),
    'posted record null tweetId': ledger({ posted: { Q1: { tweetId: null } } }),
    'skipped record null': ledger({ skipped: { Q1: null } }),
    'skipped record array': ledger({ skipped: { Q1: [] } }),
    'skipped record without at': ledger({ skipped: { Q1: { reason: 'r' } } }),
    'skipped record without reason': ledger({ skipped: { Q1: { at: 'a' } } }),
    'skipped record numeric at': ledger({ skipped: { Q1: { at: 1, reason: 'r' } } }),
    'skipped record empty reason': ledger({ skipped: { Q1: { at: 'a', reason: '' } } }),
    'posted and skipped share an id': ledger({
      posted: { Q1: { tweetId: 't' } },
      skipped: { Q1: { at: 'a', reason: 'r' } },
    }),
    'spend NaN': ledger({ spend: Number.NaN }),
    'spend Infinity': ledger({ spend: Number.POSITIVE_INFINITY }),
    'spend negative': ledger({ spend: -0.01 }),
    'spend string': ledger({ spend: '0' }),
    'spend boolean': ledger({ spend: true }),
    'inflight array': ledger({ inflight: [] }),
    'inflight true': ledger({ inflight: true }),
    'inflight number': ledger({ inflight: 1 }),
    'inflight string': ledger({ inflight: 'prepared' }),
    'inflight without postId': ledger({ inflight: { status: 'prepared' } }),
    'inflight empty postId': ledger({ inflight: { postId: '', status: 'prepared' } }),
    'inflight numeric postId': ledger({ inflight: { postId: 5, status: 'prepared' } }),
    'inflight without status': ledger({ inflight: { postId: 'P1' } }),
    'inflight unknown status': ledger({ inflight: { postId: 'P1', status: 'wedged' } }),
    'inflight status null': ledger({ inflight: { postId: 'P1', status: null } }),
    'inflight postId also posted': ledger({
      posted: { Q1: { tweetId: 't' } },
      inflight: { postId: 'Q1', status: 'prepared' },
    }),
    'inflight postId also skipped': ledger({
      skipped: { Q1: { at: 'a', reason: 'r' } },
      inflight: { postId: 'Q1', status: 'prepared' },
    }),
  };

  let refusals = 0;

  for (const [label, raw] of Object.entries(badLedgers)) {
    assert.throws(() => normalizeState(raw), undefined, `local must refuse: ${label}`);
    refusals += 1;
    const { result } = assertNeverMorePermissive(label, [P1], raw);
    assert.deepEqual(result.failures, ['malformed_ledger'], label);
  }

  assert.equal(refusals, Object.keys(badLedgers).length);
});

test('ledgers the local runtime ACCEPTS are accepted identically', () => {
  const accepted = {
    'posted omitted': { version: 1, skipped: {}, spend: 0, inflight: null },
    'posted null (defaulted)': ledger({ posted: null }),
    'skipped null (defaulted)': ledger({ skipped: null }),
    'spend null (defaulted)': ledger({ spend: null }),
    'spend undefined (defaulted)': ledger({ spend: undefined }),
    'inflight undefined (defaulted)': { version: 1, posted: {}, skipped: {}, spend: 0 },
    'bare object': {},
  };

  for (const [label, raw] of Object.entries(accepted)) {
    assert.doesNotThrow(() => normalizeState(raw), `local must accept: ${label}`);
    const { local, result } = assertNeverMorePermissive(label, [P1], raw);
    assert.equal(local.refused, false, label);
    assert.deepEqual(result.selection.selected, local.wouldPublish, label);
    assert.deepEqual(result.failures, [], label);
  }
});

test('every local queue/grace/time refusal is matched by a Cloudflare refusal', () => {
  const q = (d, t, z = TZ) => [{ id: 'P1', scheduledDate: d, scheduledTime: t, timezone: z }];

  const cases = [
    ['queue object', { P1 }, {}],
    ['queue null', null, {}],
    ['queue string', 'not a queue', {}],
    ['queue number', 3, {}],
    ['queue with explicit undefined entry', [undefined, P1], {}],
    ['queue with null entry', [null], {}],
    ['grace NaN', [P1], { graceMinutes: Number.NaN }],
    ['grace negative', [P1], { graceMinutes: -1 }],
    ['grace Infinity', [P1], { graceMinutes: Number.POSITIVE_INFINITY }],
    ['grace string', [P1], { graceMinutes: '20' }],
    ['grace null', [P1], { graceMinutes: null }],
    ['grace boolean', [P1], { graceMinutes: true }],
    ['scheduledDate empty', q('', '14:30'), {}],
    ['scheduledDate null', q(null, '14:30'), {}],
    ['scheduledDate undefined', q(undefined, '14:30'), {}],
    ['scheduledDate zero', q(0, '14:30'), {}],
    ['scheduledTime empty', q('2026-09-01', ''), {}],
    ['scheduledTime null', q('2026-09-01', null), {}],
    ['timezone empty', q('2026-09-01', '14:30', ''), {}],
    ['timezone null', q('2026-09-01', '14:30', null), {}],
    ['timezone unknown', q('2026-09-01', '14:30', 'America/Nowhere'), {}],
    ['timezone Mars/Phobos', q('2026-09-01', '14:30', 'Mars/Phobos'), {}],
    ['timezone numeric', q('2026-09-01', '14:30', 6), {}],
    ['scheduledDate numeric', q(20260901, '14:30'), {}],
    ['scheduledDate not-a-date', q('not-a-date', '14:30'), {}],
    ['scheduledDate ISO datetime', q('2027-01-04T14:30', '14:30'), {}],
    ['scheduledDate trailing junk', q('2026-09-01extra', '14:30'), {}],
    ['scheduledTime without minutes', q('2026-09-01', '14'), {}],
    ['scheduledTime not-a-time', q('2026-09-01', 'noon'), {}],
  ];

  for (const [label, queue, options] of cases) {
    const local = localPipeline(queue, ledger(), { now: NOW, graceMinutes: 20, ...options });
    assert.equal(local.refused, true, `local must refuse: ${label}`);
    assertNeverMorePermissive(label, queue, ledger(), options);
  }
});

test('out-of-range but well-formed date/time components roll over identically', () => {
  // These are NOT refusals on either side: Date.UTC normalises them. Both
  // implementations must land on the same instant.
  for (const [d, t] of [
    ['2027-13-45', '14:30'],
    ['2026-09-31', '14:30'],
    ['2026-09-01', '25:99'],
    ['2026-02-30', '00:00'],
  ]) {
    const p = post('R1', d, t);
    assert.equal(
      resolveScheduledAt(p),
      scheduledAt(p).getTime(),
      `instant must match for ${d} ${t}`,
    );
  }
});

// ---------------------------------------------------------------------------
// 5. Documented WITHHOLD-ONLY divergences — asserted in the safe direction
// ---------------------------------------------------------------------------

test('WITHHOLD-ONLY: a queue entry without a usable id is published locally but refused by Cloudflare', () => {
  for (const broken of [
    { scheduledDate: '2026-09-01', scheduledTime: '14:30', timezone: TZ },
    { id: '', scheduledDate: '2026-09-01', scheduledTime: '14:30', timezone: TZ },
    { id: 7, scheduledDate: '2026-09-01', scheduledTime: '14:30', timezone: TZ },
  ]) {
    const local = localPipeline([broken], ledger(), { now: NOW });
    assert.equal(local.refused, false, 'the local runtime does not refuse an id-less entry');
    assert.equal(local.wouldPublish.length, 1, 'the local runtime would publish it');

    const result = cloudflare([broken], ledger(), { now: NOW });
    assert.deepEqual(result.failures, ['malformed_queue']);
    assert.deepEqual(result.selection.selected, [], 'Cloudflare withholds');
    assert.equal(result.safeToPublish, false);
  }
});

test("WITHHOLD-ONLY: a 'prepared' inflight blocks Cloudflare while local recovers and publishes", () => {
  const raw = ledger({ inflight: { postId: 'X9', status: 'prepared' } });
  const local = localPipeline([P1], raw, { now: NOW });

  assert.equal(local.refused, false, 'cmdPost recovers a prepared inflight and proceeds');
  assert.deepEqual(local.wouldPublish, ['P1']);

  const result = cloudflare([P1], raw, { now: NOW });
  assert.equal(result.selection.blocked, true);
  assert.equal(result.selection.blockReason, 'inflight_prepared');
  assert.deepEqual(result.selection.selected, []);
  assert.equal(result.safeToPublish, false);
});

test('WITHHOLD-ONLY: a stale backlog does not block selection but does veto safeToPublish', () => {
  // cmdPost publishes through a stale backlog; only `pnpm runtime:health` fails.
  const now = new Date('2026-09-01T21:00:00.000Z');
  const local = localPipeline([P1], ledger(), { now, graceMinutes: 20 });
  assert.deepEqual(local.wouldPublish, ['P1']);

  const result = cloudflare([P1], ledger(), { now, graceMinutes: 20 });
  assert.deepEqual(result.health.overdue, ['P1']);
  assert.equal(result.health.ok, false);
  assert.deepEqual(result.selection.selected, ['P1'], 'selection still mirrors local');
  assert.equal(result.safeToPublish, false, 'safeToPublish is the extra Cloudflare gate');
});

test('WITHHOLD-ONLY: safeToPublish is never true where the local health report is not ok', () => {
  const probes = [
    ['overdue backlog', [P1], ledger(), new Date('2026-09-01T21:00:00.000Z'), 20],
    ['zero grace', [P1], ledger(), NOW, 0],
    ['inflight prepared', [P1], ledger({ inflight: { postId: 'X9', status: 'prepared' } }), NOW, 20],
  ];

  for (const [label, queue, raw, now, graceMinutes] of probes) {
    const report = analyzeRuntime(queue, normalizeState(raw), { now, graceMinutes });
    assert.equal(report.ok, false, `precondition: local health not ok (${label})`);

    const result = cloudflare(queue, raw, { now, graceMinutes });
    assert.equal(
      result.safeToPublish,
      false,
      `safeToPublish must follow local health.ok (${label})`,
    );
  }
});

// ---------------------------------------------------------------------------
// 6. maxPublications is the one knob that can exceed the local decision
// ---------------------------------------------------------------------------

test('maxPublications defaults to the local cap of one and is caller-opt-in above it', () => {
  const queue = [P1, post('M2', '2026-09-01', '14:31'), post('M3', '2026-09-01', '14:32')];
  const now = new Date('2026-09-01T19:40:00.000Z');

  const local = localPipeline(queue, ledger(), { now, graceMinutes: 4320 });
  assert.deepEqual(local.wouldPublish, ['P1'], 'a live run publishes at most one post');

  // Default and explicit 1 both match the local cap.
  assert.deepEqual(
    evaluateEligibility(queue, ledger(), { now, graceMinutes: 4320 }).selection.selected,
    ['P1'],
  );

  // DOCUMENTED RISK: a caller asking for more gets more. Nothing in Cloudflare
  // acts on this, and the parity matrix pins maxPublications to 1, but any
  // future mirror must keep it at 1 to stay inside the local decision.
  const widened = evaluateEligibility(queue, ledger(), {
    now,
    graceMinutes: 4320,
    maxPublications: 3,
  });
  assert.deepEqual(widened.selection.selected, ['P1', 'M2', 'M3']);
  assert.ok(
    widened.selection.selected.length > local.wouldPublish.length,
    'maxPublications above 1 exceeds the local per-run cap by construction',
  );
});

// ---------------------------------------------------------------------------
// 7. Grace, clock and time-zone parity for inputs BOTH sides accept
// ---------------------------------------------------------------------------

test('accepted graceMinutes values produce identical health arithmetic', () => {
  const queue = [P1, post('P2', '2026-09-01', '14:35'), post('P3', '2026-09-02', '14:30')];
  const now = new Date('2026-09-01T19:55:00.000Z');

  for (const graceMinutes of [0, 0.5, 1, 19, 20, 21, 1440, 1e9]) {
    const report = analyzeRuntime(queue, normalizeState(ledger()), { now, graceMinutes });
    const result = cloudflare(queue, ledger(), { now, graceMinutes });

    assert.deepEqual(result.health.due, report.due.map((p) => p.id), `due @grace ${graceMinutes}`);
    assert.deepEqual(
      result.health.overdue,
      report.overdue.map((p) => p.id),
      `overdue @grace ${graceMinutes}`,
    );
    assert.equal(result.health.ok, report.ok, `ok @grace ${graceMinutes}`);
    assert.equal(
      result.health.next,
      report.next ? report.next.id : null,
      `next @grace ${graceMinutes}`,
    );
  }
});

test('a queue mixing time zones orders due by ARRAY order and next by INSTANT', () => {
  // Array order and chronological order genuinely disagree here.
  const queue = [
    post('TOK', '2026-09-02', '04:00', 'Asia/Tokyo'),      // 2026-09-01T19:00:00Z
    post('CHI', '2026-09-01', '14:30', 'America/Chicago'), // 2026-09-01T19:30:00Z
    post('LON', '2026-09-01', '20:15', 'Europe/London'),   // 2026-09-01T19:15:00Z
  ];

  for (const entry of queue) {
    assert.equal(resolveScheduledAt(entry), scheduledAt(entry).getTime(), entry.id);
  }

  const now = new Date('2026-09-01T19:40:00.000Z');
  const report = analyzeRuntime(queue, normalizeState(ledger()), { now, graceMinutes: 600 });
  const result = cloudflare(queue, ledger(), { now, graceMinutes: 600 });

  assert.deepEqual(result.health.due, ['TOK', 'CHI', 'LON'], 'array order, not chronological');
  assert.deepEqual(result.health.due, report.due.map((p) => p.id));
  assert.deepEqual(result.selection.selected, ['TOK']);

  // Same posts a year out, deliberately re-ordered so that array order and
  // chronological order disagree: [CHI 19:30Z, LON 19:15Z, TOK 19:00Z].
  // `next` must be the chronologically earliest (TOK), i.e. the LAST element.
  const future = [queue[1], queue[2], queue[0]].map((entry) => ({
    ...entry,
    scheduledDate: entry.scheduledDate.replace('2026', '2027'),
  }));
  assert.deepEqual(future.map((p) => p.id), ['CHI', 'LON', 'TOK']);

  const futureReport = analyzeRuntime(future, normalizeState(ledger()), { now, graceMinutes: 20 });
  const futureResult = cloudflare(future, ledger(), { now, graceMinutes: 20 });
  assert.equal(futureResult.health.next, 'TOK', 'next is by instant, not array order');
  assert.equal(futureResult.health.next, futureReport.next.id);
  assert.deepEqual(futureResult.health.due, [], 'nothing is due a year early');
});

test('time zones both runtimes accept resolve to the same instant', () => {
  for (const zone of ['UTC', 'utc', 'Etc/GMT+6', 'Etc/GMT-14', 'Asia/Kathmandu', 'Pacific/Chatham', 'Australia/Lord_Howe', 'America/Chicago']) {
    const entry = post('Z', '2027-04-11', '13:45', zone);
    assert.equal(resolveScheduledAt(entry), scheduledAt(entry).getTime(), zone);
  }
});

// ---------------------------------------------------------------------------
// 8. The real 180-post production queue: the deferred tail
// ---------------------------------------------------------------------------

function productionQueue() {
  const policy = JSON.parse(readFileSync(join(ROOT, 'config', 'schedule-policy.json'), 'utf8'));
  return schedule(loadLibrary(join(ROOT, 'content')), {
    start: policy.campaignStart,
    slots: policy.slots,
    daysOfWeek: policy.daysOfWeek,
    timezone: policy.timezone,
    deferToEnd: policy.deferToEnd ?? [],
  });
}

test('the deferred tail becomes eligible only at or after its deferred instant', () => {
  const queue = productionQueue();
  assert.equal(queue.length, 180);

  const tail = [
    ['B1', '2027-01-04T20:30:00.000Z'],
    ['A30', '2027-01-05T04:15:00.000Z'],
    ['C1', '2027-01-05T20:30:00.000Z'],
    ['B30', '2027-01-06T04:15:00.000Z'],
    ['D1', '2027-01-06T20:30:00.000Z'],
    ['B14', '2027-01-07T04:15:00.000Z'],
    ['A59', '2027-01-07T20:30:00.000Z'],
  ];

  // The tail sits at the very end of the queue, in this order.
  assert.deepEqual(queue.slice(-7).map((p) => p.id), tail.map(([id]) => id));

  const outstanding = tail.map(([id]) => id);

  for (const [index, [id, instantIso]] of tail.entries()) {
    const entry = queue.find((p) => p.id === id);
    assert.ok(entry.deferredToEnd, `${id} is a deferred post`);
    assert.equal(
      resolveScheduledAt(entry),
      Date.parse(instantIso),
      `${id} resolves to its deferred instant`,
    );
    assert.equal(resolveScheduledAt(entry), scheduledAt(entry).getTime(), `${id} parity`);

    // Ledger: everything before this tail entry is published.
    const posted = {};
    for (const p of queue) {
      if (!outstanding.slice(index).includes(p.id)) {
        posted[p.id] = { tweetId: `mirror-${p.id}`, at: '2026-09-01T00:00:00.000Z' };
      }
    }
    const raw = ledger({ posted });
    const grace = 10_000_000; // never overdue, so health stays ok

    // One millisecond BEFORE the deferred instant: not due, nothing selected.
    const before = cloudflare(queue, raw, {
      now: new Date(Date.parse(instantIso) - 1),
      graceMinutes: grace,
    });
    assert.deepEqual(before.selection.selected, [], `${id} not selected before its instant`);
    assert.equal(before.safeToPublish, false, `${id} not safe before its instant`);
    assert.equal(before.health.next, id, `${id} is the next post`);

    // EXACTLY at the deferred instant: due (inclusive) and selected.
    const at = cloudflare(queue, raw, {
      now: new Date(instantIso),
      graceMinutes: grace,
    });
    assert.deepEqual(at.selection.selected, [id], `${id} selected exactly at its instant`);
    assert.equal(at.safeToPublish, true, `${id} safe exactly at its instant`);

    // Parity with the local live decision at that same instant.
    const local = localPipeline(queue, raw, { now: new Date(instantIso), graceMinutes: grace });
    assert.deepEqual(local.wouldPublish, [id], `${id} local parity`);
  }
});

test('no deferred tail post is ever selected at a pre-deferral position in the campaign', () => {
  const queue = productionQueue();
  const deferred = new Set([
    'B1',
    'A30',
    'C1',
    'B30',
    'D1',
    'B14',
    'A59',
  ]);
  const firstTailInstant = Date.parse('2027-01-04T20:30:00.000Z');

  // Walk the whole campaign: at every non-deferred post's instant, with only
  // that post outstanding is impossible, so instead sweep with an EMPTY ledger
  // and confirm the deferred posts never appear in `due` before their instant.
  for (const entry of queue) {
    const instant = resolveScheduledAt(entry);
    if (instant >= firstTailInstant) continue;

    const result = cloudflare(queue, ledger(), {
      now: new Date(instant),
      graceMinutes: 10_000_000,
    });

    for (const id of result.health.due) {
      assert.ok(
        !deferred.has(id),
        `${id} must not be due at ${new Date(instant).toISOString()} (position of ${entry.id})`,
      );
    }
  }
});

// ---------------------------------------------------------------------------
// 9. Structural properties that make two internal guards provably redundant
//
// Mutation testing found three mutants of cloudflare/src/eligibility.mjs that
// no fixture can kill, because they are EQUIVALENT — they cannot change any
// observable output. Recording why is more honest than inventing a fixture
// that pretends to cover them:
//
//   * `failures.length === 0` inside safeToPublish, and
//     `failures.length > 0` inside the selection gate.
//     Every failure code that does not return early is structural, and the
//     only failure pushed after the structural early return is an inflight
//     block — which already sets `blocked`. Both conditions are therefore
//     implied by `!blocked`. The test below pins that reasoning.
//
//   * `resolveScheduledAt`'s four correction passes reduced to two.
//     The correction is guess(n+1) = target - offset(guess(n)); at a DST gap
//     the offset sequence enters a two-cycle, so EVERY even pass count lands
//     on the same instant. A sweep of 16,257,024 wall clocks across 36 zones
//     from 1980 to 2035 found no case where two passes differ from four.
//     Odd counts do differ and ARE covered: one pass and three passes are both
//     killed by the existing spring-forward-gap fixtures.
// ---------------------------------------------------------------------------

test('every non-structural failure code implies a blocked selection', () => {
  const inflightCodes = new Set([
    'inflight_prepared',
    'inflight_publishing',
    'inflight_needs_reconciliation',
  ]);

  const sweep = [
    [[P1], ledger(), { now: NOW }],
    [[P1], ledger(), { now: NOW, graceMinutes: -1 }],
    [[P1], ledger(), { now: 'nope' }],
    [[P1], ledger(), { now: NOW, maxPublications: -1 }],
    [[P1], null, { now: NOW }],
    [{ P1 }, ledger(), { now: NOW }],
    [[P1, P1], ledger(), { now: NOW }],
    [[post('P1', '2026-09-01', '14:30', 'Mars/Phobos')], ledger(), { now: NOW }],
    [[P1], ledger({ inflight: { postId: 'X9', status: 'prepared' } }), { now: NOW }],
    [[P1], ledger({ inflight: { postId: 'X9', status: 'publishing' } }), { now: NOW }],
    [[P1], ledger({ inflight: { postId: 'X9', status: 'needs_reconciliation' } }), { now: NOW }],
    [[P1], ledger({ skipped: { toString: { at: 'a', reason: 'r' } } }), { now: NOW }],
  ];

  for (const [queue, raw, options] of sweep) {
    const result = cloudflare(queue, raw, options);

    for (const code of result.failures) {
      assert.ok(
        STRUCTURAL_FAILURES.includes(code) || inflightCodes.has(code),
        `unclassified failure code ${code}`,
      );
    }

    const nonStructural = result.failures.filter(
      (code) => !STRUCTURAL_FAILURES.includes(code),
    );

    if (nonStructural.length > 0) {
      assert.equal(
        result.selection.blocked,
        true,
        `a non-structural failure must block: ${JSON.stringify(result.failures)}`,
      );
      assert.ok(inflightCodes.has(result.selection.blockReason));
    }

    if (result.failures.length > 0) {
      assert.equal(result.safeToPublish, false);
      assert.deepEqual(result.selection.selected, []);
    }
  }
});

test('DOCUMENTED RESIDUAL: a queue entry with a throwing accessor throws on BOTH sides', () => {
  // evaluateEligibility documents itself as never throwing. That holds for
  // every value reachable from JSON. It does NOT hold for an object with a
  // throwing getter — but neither does the local runtime survive one, so this
  // is not the dangerous direction: both sides refuse, loudly.
  const evil = {
    get id() { throw new Error('boom'); },
    scheduledDate: '2026-09-01',
    scheduledTime: '14:30',
    timezone: TZ,
  };

  assert.throws(() => analyzeRuntime([evil], normalizeState(ledger()), { now: NOW }), /boom/);
  assert.throws(() => cloudflare([evil], ledger(), { now: NOW }), /boom/);
});
