// queue-integrity.mjs — fail-closed verification that the queue bundled into
// the Worker is byte-for-byte the canonical production queue, and that the D1
// mirror agrees with it.
//
// Worker-compatible on purpose: no `node:` imports, WebCrypto only. Node 22
// exposes the same globalThis.crypto.subtle, so tests exercise this exact code.
//
// D1 ACCESS IS READ-ONLY. Only SELECT statements appear in this file.

import {
  CANONICAL_QUEUE_JSON,
  DECLARED_DEFERRED_TAIL,
  DECLARED_QUEUE_COUNT,
  DECLARED_QUEUE_SHA256,
} from '../generated/queue-bundle.mjs';

/** The production queue length. Independent of whatever the bundle declares. */
export const EXPECTED_QUEUE_COUNT = 180;

/**
 * The exact deferred rotation tail, asserted independently of the bundle so a
 * regenerated-but-wrong bundle cannot redefine what "correct" means.
 */
export const EXPECTED_DEFERRED_TAIL = [
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
];

const D1_SHA_KEY = 'queue.sha256';
const D1_COUNT_KEY = 'queue.count';

/** SHA-256 hex of the UTF-8 bytes of `text`. */
export async function sha256Hex(text) {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', bytes);

  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Parse the bundled canonical queue text and apply structural checks.
 * Throws on anything that is not an array of post objects carrying the
 * scheduling fields this module verifies.
 */
export function decodeBundledQueue(canonicalText = CANONICAL_QUEUE_JSON) {
  if (typeof canonicalText !== 'string' || canonicalText.length === 0) {
    throw new Error('canonical queue text is missing or not a string');
  }

  const queue = JSON.parse(canonicalText);

  if (!Array.isArray(queue)) {
    throw new Error('canonical queue is not an array');
  }

  for (const post of queue) {
    if (!post || typeof post !== 'object' || Array.isArray(post)) {
      throw new Error('canonical queue contains a non-object entry');
    }
    if (typeof post.id !== 'string' || post.id.length === 0) {
      throw new Error('canonical queue contains a post without a string id');
    }
    if (
      typeof post.scheduledDate !== 'string' ||
      typeof post.scheduledTime !== 'string' ||
      typeof post.timezone !== 'string'
    ) {
      throw new Error(`post ${post.id} is missing scheduling fields`);
    }
  }

  return queue;
}

function tailRow(post) {
  return {
    id: post.id,
    scheduledDate: post.scheduledDate,
    scheduledTime: post.scheduledTime,
    timezone: post.timezone,
  };
}

function sameTail(actual, expected) {
  if (actual.length !== expected.length) return false;

  return actual.every((row, index) => {
    const want = expected[index];
    return (
      row.id === want.id &&
      row.scheduledDate === want.scheduledDate &&
      row.scheduledTime === want.scheduledTime &&
      row.timezone === want.timezone
    );
  });
}

/**
 * Compute the integrity facts of the bundled queue.
 *
 * `overrides` exists so tests can inject a mutated canonical text or mutated
 * declared values without rewriting the generated bundle. Production callers
 * pass nothing and get the real bundle.
 */
export async function computeBundleIntegrity(overrides = {}) {
  const canonicalText = overrides.canonicalText ?? CANONICAL_QUEUE_JSON;
  const declaredSha256 = overrides.declaredSha256 ?? DECLARED_QUEUE_SHA256;
  const declaredCount = overrides.declaredCount ?? DECLARED_QUEUE_COUNT;
  const declaredDeferredTail =
    overrides.declaredDeferredTail ?? DECLARED_DEFERRED_TAIL;

  const sha256 = await sha256Hex(canonicalText);
  const queue = decodeBundledQueue(canonicalText);
  const count = queue.length;
  const uniqueIdCount = new Set(queue.map((post) => post.id)).size;
  const deferredTail = queue
    .slice(Math.max(0, count - EXPECTED_DEFERRED_TAIL.length))
    .map(tailRow);

  return {
    sha256,
    count,
    uniqueIdCount,
    deferredTail,
    declaredMatches:
      sha256 === declaredSha256 &&
      count === declaredCount &&
      declaredCount === EXPECTED_QUEUE_COUNT &&
      uniqueIdCount === count &&
      sameTail(deferredTail, EXPECTED_DEFERRED_TAIL) &&
      sameTail(declaredDeferredTail, EXPECTED_DEFERRED_TAIL),
  };
}

/**
 * READ-ONLY read of the D1 queue mirror metadata.
 * Returns a plain { key: value } map for the two keys we care about.
 * Throws if the binding is absent or the query fails; callers translate that
 * into the `d1_unreachable` reason.
 */
export async function readD1QueueMetadata(env) {
  const db = env?.DB;

  if (!db || typeof db.prepare !== 'function') {
    throw new Error('D1 binding DB is not available');
  }

  const statement = db.prepare(
    `
    SELECT key, value
    FROM runtime_metadata
    WHERE key IN (?, ?)
    `,
  );

  const bound =
    typeof statement.bind === 'function'
      ? statement.bind(D1_SHA_KEY, D1_COUNT_KEY)
      : statement;

  const result = await bound.all();
  const rows = Array.isArray(result) ? result : (result?.results ?? []);
  const metadata = {};

  for (const row of rows) {
    if (row && typeof row.key === 'string') {
      metadata[row.key] = row.value;
    }
  }

  return metadata;
}

/**
 * The fail-closed gate. NEVER throws; always returns a verdict object whose
 * `ok` defaults to false. Absence of evidence is never ok.
 */
export async function verifyQueueIntegrity(env, overrides = {}) {
  const declaredSha256 = overrides.declaredSha256 ?? DECLARED_QUEUE_SHA256;
  const declaredCount = overrides.declaredCount ?? DECLARED_QUEUE_COUNT;

  const verdict = {
    ok: false,
    reason: null,
    computedSha256: null,
    declaredSha256,
    d1Sha256: null,
    count: null,
    uniqueIdCount: null,
    expectedCount: EXPECTED_QUEUE_COUNT,
    deferredTail: null,
  };

  let integrity;

  try {
    integrity = await computeBundleIntegrity(overrides);
  } catch {
    verdict.reason = 'bundle_decode_failed';
    return verdict;
  }

  verdict.computedSha256 = integrity.sha256;
  verdict.count = integrity.count;
  verdict.uniqueIdCount = integrity.uniqueIdCount;
  verdict.deferredTail = integrity.deferredTail;

  if (integrity.sha256 !== declaredSha256) {
    verdict.reason = 'bundle_declared_sha_mismatch';
    return verdict;
  }

  if (integrity.count !== declaredCount || declaredCount !== EXPECTED_QUEUE_COUNT) {
    verdict.reason = 'bundle_count_mismatch';
    return verdict;
  }

  if (integrity.uniqueIdCount !== integrity.count) {
    verdict.reason = 'bundle_duplicate_post_ids';
    return verdict;
  }

  if (!sameTail(integrity.deferredTail, EXPECTED_DEFERRED_TAIL)) {
    verdict.reason = 'bundle_deferred_tail_mismatch';
    return verdict;
  }

  let metadata;

  try {
    metadata = await readD1QueueMetadata(env);
  } catch {
    verdict.reason = 'd1_unreachable';
    return verdict;
  }

  const d1Sha256 = metadata?.[D1_SHA_KEY];

  if (typeof d1Sha256 !== 'string' || d1Sha256.length === 0) {
    verdict.reason = 'd1_queue_sha256_missing';
    return verdict;
  }

  verdict.d1Sha256 = d1Sha256;

  if (d1Sha256 !== integrity.sha256) {
    verdict.reason = 'd1_queue_sha256_mismatch';
    return verdict;
  }

  const rawD1Count = metadata?.[D1_COUNT_KEY];

  if (rawD1Count !== undefined && rawD1Count !== null && `${rawD1Count}` !== '') {
    if (Number(rawD1Count) !== integrity.count) {
      verdict.reason = 'd1_queue_count_mismatch';
      return verdict;
    }
  }

  verdict.ok = true;
  return verdict;
}
