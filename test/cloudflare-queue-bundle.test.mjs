import test from 'node:test';
import assert from 'node:assert/strict';

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadLibrary } from '../src/parse.mjs';
import { schedule } from '../src/schedule.mjs';

import {
  BUNDLE_FORMAT,
  CANONICAL_QUEUE_JSON,
  DECLARED_DEFERRED_TAIL,
  DECLARED_QUEUE_COUNT,
  DECLARED_QUEUE_SHA256,
  GENERATED_FROM,
} from '../cloudflare/generated/queue-bundle.mjs';

import {
  EXPECTED_DEFERRED_TAIL,
  EXPECTED_QUEUE_COUNT,
  computeBundleIntegrity,
  decodeBundledQueue,
  readD1QueueMetadata,
  sha256Hex,
  verifyQueueIntegrity,
} from '../cloudflare/src/queue-integrity.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const CANONICAL_SHA256 =
  'a8cda41f869f4e58d2566e5c558fbbd3f7ce89ae6cbf6d138b1e517f363750b7';

/** A minimal fake D1 binding. `rows` is what the SELECT returns. */
function fakeEnv(rows, { throwOnQuery = false } = {}) {
  return {
    DB: {
      prepare(sql) {
        assert.match(sql, /^\s*SELECT\b/, 'D1 access must be read-only SELECT');
        return {
          bind() {
            return this;
          },
          async all() {
            if (throwOnQuery) throw new Error('D1_ERROR: no such table');
            return { results: rows };
          },
        };
      },
    },
  };
}

function healthyEnv() {
  return fakeEnv([
    { key: 'queue.sha256', value: CANONICAL_SHA256 },
    { key: 'queue.count', value: '180' },
  ]);
}

/** Re-serialize a decoded queue back into canonical bytes. */
function canonicalize(queue) {
  return `${JSON.stringify(queue, null, 2)}\n`;
}

/** Build overrides whose declared sha matches the mutated text, so later checks run. */
async function selfConsistent(canonicalText, extra = {}) {
  return {
    canonicalText,
    declaredSha256: await sha256Hex(canonicalText),
    ...extra,
  };
}

test('bundle exposes the documented export surface', () => {
  assert.equal(BUNDLE_FORMAT, 1);
  assert.equal(typeof CANONICAL_QUEUE_JSON, 'string');
  assert.equal(typeof DECLARED_QUEUE_SHA256, 'string');
  assert.equal(DECLARED_QUEUE_COUNT, 180);
  assert.equal(GENERATED_FROM.campaignStart, '2026-08-31');
  assert.equal(GENERATED_FROM.timezone, 'America/Chicago');
  assert.deepEqual(GENERATED_FROM.slots, ['14:30', '22:15']);
  assert.deepEqual(GENERATED_FROM.daysOfWeek, [1, 2, 3, 4, 5]);
  assert.deepEqual(GENERATED_FROM.deferToEnd, [
    'B1',
    'A30',
    'C1',
    'B30',
    'D1',
    'B14',
    'A59',
  ]);
});

test('bundle decodes to exactly 180 posts with 180 unique IDs', () => {
  const queue = decodeBundledQueue();

  assert.equal(queue.length, 180);
  assert.equal(queue.length, EXPECTED_QUEUE_COUNT);
  assert.equal(new Set(queue.map((post) => post.id)).size, 180);
  assert.equal(queue[0].id, 'A1');
  assert.equal(queue[0].pinned, true);
});

test('computed sha256 equals the declared and the canonical literal', async () => {
  const computed = await sha256Hex(CANONICAL_QUEUE_JSON);

  assert.equal(computed, DECLARED_QUEUE_SHA256);
  assert.equal(computed, CANONICAL_SHA256);
  assert.equal(DECLARED_QUEUE_SHA256, CANONICAL_SHA256);
});

test('live regeneration preserves the exact legacy canonical queue projection', () => {
  const policy = JSON.parse(
    readFileSync(join(ROOT, 'config', 'schedule-policy.json'), 'utf8'),
  );
  const posts = loadLibrary(join(ROOT, 'content'));
  const queue = schedule(posts, {
    start: policy.campaignStart,
    slots: policy.slots,
    daysOfWeek: policy.daysOfWeek,
    timezone: policy.timezone,
    deferToEnd: policy.deferToEnd ?? [],
  });

  // #52 adds committed UTC evidence without activating a changed production
  // bundle in this PR. Removing only scheduledAt must reproduce the exact
  // currently-authoritative canonical bytes, proving IDs/content/local slots
  // did not move.
  const legacyProjection = queue.map(({ scheduledAt, ...post }) => post);
  const liveLegacy = `${JSON.stringify(legacyProjection, null, 2)}\n`;

  assert.equal(liveLegacy.length, CANONICAL_QUEUE_JSON.length);
  assert.equal(liveLegacy, CANONICAL_QUEUE_JSON);

  // Separately prove every newly generated assignment carries a canonical
  // committed UTC instant. The production bundle activation is a later,
  // explicit step because adding this field changes canonical queue bytes.
  for (const post of queue) {
    assert.equal(typeof post.scheduledAt, 'string', `${post.id}: scheduledAt missing`);
    const epochMs = Date.parse(post.scheduledAt);
    assert.equal(Number.isFinite(epochMs), true, `${post.id}: scheduledAt invalid`);
    assert.equal(new Date(epochMs).toISOString(), post.scheduledAt);
  }
});

test('deferred tail is exactly the seven policy-deferred posts with their exact schedules', async () => {
  const expected = [
    {
      id: 'B1',
      scheduledDate: '2027-01-04',
      scheduledTime: '14:30',
      timezone: 'America/Chicago',
    },
    {
      id: 'A30',
      scheduledDate: '2027-01-04',
      scheduledTime: '22:15',
      timezone: 'America/Chicago',
    },
    {
      id: 'C1',
      scheduledDate: '2027-01-05',
      scheduledTime: '14:30',
      timezone: 'America/Chicago',
    },
    {
      id: 'B30',
      scheduledDate: '2027-01-05',
      scheduledTime: '22:15',
      timezone: 'America/Chicago',
    },
    {
      id: 'D1',
      scheduledDate: '2027-01-06',
      scheduledTime: '14:30',
      timezone: 'America/Chicago',
    },
    {
      id: 'B14',
      scheduledDate: '2027-01-06',
      scheduledTime: '22:15',
      timezone: 'America/Chicago',
    },
    {
      id: 'A59',
      scheduledDate: '2027-01-07',
      scheduledTime: '14:30',
      timezone: 'America/Chicago',
    },
  ];

  assert.deepEqual(EXPECTED_DEFERRED_TAIL, expected);
  assert.deepEqual(DECLARED_DEFERRED_TAIL, expected);

  const integrity = await computeBundleIntegrity();
  assert.deepEqual(integrity.deferredTail, expected);
  assert.equal(integrity.declaredMatches, true);

  const queue = decodeBundledQueue();
  for (const post of queue.slice(-7)) {
    assert.equal(post.deferredToEnd, true);
  }
});

test('readD1QueueMetadata returns the queue mirror rows', async () => {
  const metadata = await readD1QueueMetadata(healthyEnv());

  assert.equal(metadata['queue.sha256'], CANONICAL_SHA256);
  assert.equal(metadata['queue.count'], '180');
});

test('verifyQueueIntegrity returns ok against a matching D1 mirror', async () => {
  const verdict = await verifyQueueIntegrity(healthyEnv());

  assert.equal(verdict.ok, true);
  assert.equal(verdict.reason, null);
  assert.equal(verdict.computedSha256, CANONICAL_SHA256);
  assert.equal(verdict.declaredSha256, CANONICAL_SHA256);
  assert.equal(verdict.d1Sha256, CANONICAL_SHA256);
  assert.equal(verdict.count, 180);
  assert.equal(verdict.uniqueIdCount, 180);
  assert.equal(verdict.expectedCount, 180);
  assert.equal(verdict.deferredTail.length, 7);
});

test('verifyQueueIntegrity is ok when D1 omits the optional queue.count row', async () => {
  const verdict = await verifyQueueIntegrity(
    fakeEnv([{ key: 'queue.sha256', value: CANONICAL_SHA256 }]),
  );

  assert.equal(verdict.ok, true);
  assert.equal(verdict.reason, null);
});

// ---------------------------------------------------------------------------
// Negative cases. Every one of these must be ok:false with an exact reason.
// ---------------------------------------------------------------------------

test('negative: unparseable bundle text -> bundle_decode_failed', async () => {
  const verdict = await verifyQueueIntegrity(healthyEnv(), {
    canonicalText: '[{"id": "A1",',
  });

  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, 'bundle_decode_failed');
});

test('negative: queue that is not an array of objects -> bundle_decode_failed', async () => {
  const verdict = await verifyQueueIntegrity(healthyEnv(), {
    canonicalText: '["A1", "A2"]\n',
  });

  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, 'bundle_decode_failed');
});

test('negative: one-byte mutation of the canonical text -> bundle_declared_sha_mismatch', async () => {
  const index = CANONICAL_QUEUE_JSON.indexOf('Operating leverage');
  assert.ok(index > 0);

  const mutated =
    CANONICAL_QUEUE_JSON.slice(0, index) +
    '0perating leverage' +
    CANONICAL_QUEUE_JSON.slice(index + 'Operating leverage'.length);

  assert.equal(mutated.length, CANONICAL_QUEUE_JSON.length);
  assert.notEqual(mutated, CANONICAL_QUEUE_JSON);

  const verdict = await verifyQueueIntegrity(healthyEnv(), {
    canonicalText: mutated,
  });

  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, 'bundle_declared_sha_mismatch');
  assert.notEqual(verdict.computedSha256, CANONICAL_SHA256);
  assert.equal(verdict.declaredSha256, CANONICAL_SHA256);
});

test('negative: reordered queue -> bundle_declared_sha_mismatch', async () => {
  const queue = decodeBundledQueue();
  const swapped = [...queue];
  [swapped[0], swapped[1]] = [swapped[1], swapped[0]];

  const verdict = await verifyQueueIntegrity(healthyEnv(), {
    canonicalText: canonicalize(swapped),
  });

  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, 'bundle_declared_sha_mismatch');
});

test('negative: reordered deferred tail -> bundle_deferred_tail_mismatch', async () => {
  const queue = decodeBundledQueue();
  const reordered = [...queue];
  const last = reordered.length - 1;
  [reordered[last - 2], reordered[last]] = [reordered[last], reordered[last - 2]];

  const verdict = await verifyQueueIntegrity(
    healthyEnv(),
    await selfConsistent(canonicalize(reordered)),
  );

  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, 'bundle_deferred_tail_mismatch');
  assert.equal(verdict.deferredTail[4].id, 'A59');
});

test('negative: altered scheduled time in the tail -> bundle_deferred_tail_mismatch', async () => {
  const queue = decodeBundledQueue();
  const altered = queue.map((post, index) =>
    index === queue.length - 1 ? { ...post, scheduledTime: '14:31' } : post,
  );

  const verdict = await verifyQueueIntegrity(
    healthyEnv(),
    await selfConsistent(canonicalize(altered)),
  );

  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, 'bundle_deferred_tail_mismatch');
});

test('negative: missing post -> bundle_count_mismatch', async () => {
  const queue = decodeBundledQueue();
  const short = queue.filter((post) => post.id !== 'A2');

  assert.equal(short.length, 179);

  const verdict = await verifyQueueIntegrity(
    healthyEnv(),
    await selfConsistent(canonicalize(short)),
  );

  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, 'bundle_count_mismatch');
  assert.equal(verdict.count, 179);
  assert.equal(verdict.expectedCount, 180);
});

test('negative: duplicated post -> bundle_duplicate_post_ids', async () => {
  const queue = decodeBundledQueue();
  const duplicated = queue.map((post, index) =>
    index === 1 ? { ...post, id: queue[0].id } : post,
  );

  assert.equal(duplicated.length, 180);

  const verdict = await verifyQueueIntegrity(
    healthyEnv(),
    await selfConsistent(canonicalize(duplicated)),
  );

  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, 'bundle_duplicate_post_ids');
  assert.equal(verdict.uniqueIdCount, 179);
});

test('negative: declared count that is not 180 -> bundle_count_mismatch', async () => {
  const verdict = await verifyQueueIntegrity(healthyEnv(), {
    declaredCount: 179,
  });

  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, 'bundle_count_mismatch');
});

test('negative: D1 query throws -> d1_unreachable', async () => {
  const verdict = await verifyQueueIntegrity(fakeEnv([], { throwOnQuery: true }));

  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, 'd1_unreachable');
  assert.equal(verdict.computedSha256, CANONICAL_SHA256);
});

test('negative: missing D1 queue.sha256 row -> d1_queue_sha256_missing', async () => {
  const verdict = await verifyQueueIntegrity(
    fakeEnv([{ key: 'queue.count', value: '180' }]),
  );

  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, 'd1_queue_sha256_missing');
  assert.equal(verdict.d1Sha256, null);
});

test('negative: D1 sha differing by one character -> d1_queue_sha256_mismatch', async () => {
  const off = `19c36e24207d7720c46d163b83b9cee9465e6ded36221499032c0acee218bbc1`;
  assert.equal(off.length, CANONICAL_SHA256.length);

  const verdict = await verifyQueueIntegrity(
    fakeEnv([
      { key: 'queue.sha256', value: off },
      { key: 'queue.count', value: '180' },
    ]),
  );

  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, 'd1_queue_sha256_mismatch');
  assert.equal(verdict.d1Sha256, off);
});

test('negative: D1 count disagreeing -> d1_queue_count_mismatch', async () => {
  const verdict = await verifyQueueIntegrity(
    fakeEnv([
      { key: 'queue.sha256', value: CANONICAL_SHA256 },
      { key: 'queue.count', value: '179' },
    ]),
  );

  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, 'd1_queue_count_mismatch');
});

test('verifyQueueIntegrity never throws on a missing or malformed env', async () => {
  for (const env of [undefined, null, {}, { DB: null }, { DB: {} }]) {
    const verdict = await verifyQueueIntegrity(env);

    assert.equal(verdict.ok, false);
    assert.equal(verdict.reason, 'd1_unreachable');
  }
});

test('ok defaults to false: an empty D1 result set is not evidence of health', async () => {
  const verdict = await verifyQueueIntegrity(fakeEnv([]));

  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, 'd1_queue_sha256_missing');
});
