// cloudflare-media-adversarial.test.mjs — Lane D adversarial / negative tests.
//
// These tests exist to attack the media pipeline, not to describe it. Each one either pins a
// fail-closed guarantee against a hostile input, or pins a TRUST ASSUMPTION so that assumption
// cannot change silently. Nothing here uploads, publishes, or mutates anything.

import test from 'node:test';
import assert from 'node:assert/strict';

import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildMediaRequirements } from '../scripts/build-media-requirements.mjs';
import {
  buildMediaManifest,
  findFigureCandidates,
  manifestSha256,
} from '../scripts/build-media-manifest.mjs';
import {
  BUCKET,
  contentTypeFor,
  parseArgs,
  uploadCommand,
} from '../scripts/r2-media-upload.mjs';
import { listUnrelatedObjects, verifyMediaObjects } from '../cloudflare/src/media-verify.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const UPLOAD_SOURCE = join(ROOT, 'scripts', 'r2-media-upload.mjs');

const sha256Hex = (bytes) => createHash('sha256').update(bytes).digest('hex');

const HONEST = Buffer.from('the-real-figure-bytes', 'utf8');
const IMPOSTOR = Buffer.from('TOTALLY-DIFFERENT-!!!', 'utf8'); // deliberately the same length

function bufferToArrayBuffer(buffer) {
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
}

/** A one-object manifest, correctly sealed, that `overrides` can then deform. */
function oneObjectManifest(overrides = {}) {
  const objects = [
    {
      postId: 'D1',
      figure: 1,
      logicalMediaId: 'figure-0001',
      localSource: 'media/figure-0001.png',
      extension: 'png',
      r2Key: 'media/figures/figure-0001.png',
      byteSize: HONEST.length,
      sha256: sha256Hex(HONEST),
      ...overrides,
    },
  ];
  return { format: 1, objects, manifestSha256: manifestSha256(objects) };
}

/**
 * A bucket that answers exactly what the test tells it to, including lies. Only the read surface
 * exists — there is deliberately no put/delete to call, so a mutating verifier would crash.
 */
function scriptedBucket({ head = null, body = null, list = null } = {}) {
  const calls = [];
  return {
    calls,
    async head(key) {
      calls.push('head');
      return typeof head === 'function' ? head(key) : head;
    },
    async get(key) {
      calls.push('get');
      if (body === null) return null;
      const bytes = typeof body === 'function' ? body(key) : body;
      if (!bytes) return null;
      return { key, arrayBuffer: async () => bufferToArrayBuffer(bytes) };
    },
    async list(options) {
      calls.push('list');
      if (typeof list === 'function') return list(options);
      return list ?? { objects: [], truncated: false, cursor: null };
    },
  };
}

/* ------------------------------------------------------------------ *
 * 1. HASH SOURCE TRUST
 * ------------------------------------------------------------------ */

test('adversarial: a bucket that ASSERTS a checksum for bytes it does not hold is believed', async () => {
  const manifest = oneObjectManifest();

  // The bucket reports the honest object's size and SHA-256 while holding different bytes.
  const asserted = scriptedBucket({
    head: (key) => ({ key, size: IMPOSTOR.length, checksums: { sha256: sha256Hex(HONEST) } }),
    body: IMPOSTOR,
  });
  const result = await verifyMediaObjects({ MEDIA: asserted }, manifest);

  // TRUST ASSUMPTION, pinned deliberately: R2's own recorded sha256 is taken as authoritative and
  // the body is never read. Real R2 only records checksums.sha256 when the uploader supplied it and
  // R2 itself verified the body against it, so this is defensible for R2 — but it is an assumption,
  // and this test exists so that changing it is a visible decision.
  assert.equal(result.ok, true, 'documented behaviour: an R2-asserted checksum is trusted');
  assert.equal(result.objects[0].hashSource, 'r2_checksum');
  assert.equal(asserted.calls.includes('get'), false, 'the body is never read on this path');
  assert.equal(
    result.objects[0].hashTrust,
    'bucket_asserted',
    'a bucket-asserted hash must be reported as such, never as an observed one',
  );
  assert.equal(result.bodyObservedCount, 0);

  // customMetadata is plain user metadata: R2 never verifies it against the body, so ANY writer can
  // set it to anything. It is still ranked above a body digest.
  const metadata = scriptedBucket({
    head: (key) => ({ key, size: IMPOSTOR.length, customMetadata: { sha256: sha256Hex(HONEST) } }),
    body: IMPOSTOR,
  });
  const viaMetadata = await verifyMediaObjects({ MEDIA: metadata }, manifest);
  assert.equal(viaMetadata.ok, true, 'documented behaviour: unverified custom metadata is trusted');
  assert.equal(viaMetadata.objects[0].hashSource, 'custom_metadata');
  assert.equal(viaMetadata.objects[0].hashTrust, 'bucket_asserted');
  assert.equal(metadata.calls.includes('get'), false);

  // Only the body digest is evidence rather than assertion, and it correctly rejects the impostor.
  const observed = scriptedBucket({
    head: (key) => ({ key, size: HONEST.length }),
    body: IMPOSTOR,
  });
  const viaBody = await verifyMediaObjects({ MEDIA: observed }, manifest);
  assert.equal(viaBody.ok, false, 'a body digest catches what an assertion does not');
  assert.equal(viaBody.failures[0].reason, 'hash_mismatch');

  const truthful = scriptedBucket({ head: (key) => ({ key, size: HONEST.length }), body: HONEST });
  const good = await verifyMediaObjects({ MEDIA: truthful }, manifest);
  assert.equal(good.ok, true);
  assert.equal(good.objects[0].hashSource, 'body_digest');
  assert.equal(good.objects[0].hashTrust, 'body_observed');
  assert.equal(good.bodyObservedCount, 1);
});

test('adversarial: malformed hash encodings never verify — they fall through to the body', async () => {
  const manifest = oneObjectManifest();
  const hex = sha256Hex(HONEST);

  const run = async (sha256, { withBody = true } = {}) => {
    const bucket = scriptedBucket({
      head: (key) => ({ key, size: HONEST.length, checksums: { sha256 } }),
      body: withBody ? HONEST : null,
    });
    const result = await verifyMediaObjects({ MEDIA: bucket }, manifest);
    return result.objects[0];
  };

  // Accepted encodings — normalised, not guessed.
  for (const [label, value] of [
    ['lowercase hex', hex],
    ['uppercase hex', hex.toUpperCase()],
    ['surrounding whitespace', `  ${hex}\n`],
    ['Uint8Array', Uint8Array.from(Buffer.from(hex, 'hex'))],
    ['ArrayBuffer', Uint8Array.from(Buffer.from(hex, 'hex')).buffer],
    ['DataView', new DataView(Uint8Array.from(Buffer.from(hex, 'hex')).buffer)],
  ]) {
    const object = await run(value);
    assert.equal(object.hashSource, 'r2_checksum', `${label} must be decoded, not ignored`);
    assert.equal(object.ok, true);
  }

  // Rejected encodings — must fall through to the stronger source, never be accepted as-is.
  for (const [label, value] of [
    ['truncated 63-char hex', hex.slice(0, 63)],
    ['internal whitespace', `${hex.slice(0, 32)} ${hex.slice(33)}`],
    ['empty string', ''],
    ['null', null],
    ['undefined', undefined],
    ['non-hex 64 chars', 'z'.repeat(64)],
    ['31-byte buffer', Uint8Array.from(Buffer.from(hex.slice(0, 62), 'hex'))],
    ['33-byte buffer', new Uint8Array(33)],
    ['number', 12345],
  ]) {
    const object = await run(value);
    assert.equal(object.hashSource, 'body_digest', `${label} must not be used as a digest`);

    // ...and when the body cannot be read either, absence of evidence is a failure.
    const blind = await run(value, { withBody: false });
    assert.equal(blind.ok, false, `${label} with no readable body must fail closed`);
    assert.equal(blind.reason, 'no_hash_available');
  }

  // An empty customMetadata.sha256 must not short-circuit the body digest.
  const emptyMeta = scriptedBucket({
    head: (key) => ({ key, size: HONEST.length, customMetadata: { sha256: '' } }),
    body: HONEST,
  });
  const result = await verifyMediaObjects({ MEDIA: emptyMeta }, manifest);
  assert.equal(result.ok, true);
  assert.equal(result.objects[0].hashSource, 'body_digest');
});

/* ------------------------------------------------------------------ *
 * 2. SIZE / HASH TYPE CONFUSION
 * ------------------------------------------------------------------ */

test('adversarial: no size type coerces a hash-mismatching object into being verified', async () => {
  const manifest = oneObjectManifest(); // byteSize 21, sha256 of HONEST

  const withSize = async (size, bytes) => {
    const bucket = scriptedBucket({ head: (key) => ({ key, size }), body: bytes });
    const result = await verifyMediaObjects({ MEDIA: bucket }, manifest);
    return result.objects[0];
  };

  // Coercible sizes are tolerated (Number(head.size)) — documented, and harmless because the hash
  // is still checked against the real bytes.
  for (const size of [21, 21.0, '21', ' 21 ', 21n, [21]]) {
    assert.equal((await withSize(size, HONEST)).ok, true, `size ${String(size)} should pass`);
    const impostor = await withSize(size, IMPOSTOR);
    assert.equal(impostor.ok, false, `size ${String(size)} must not rescue wrong bytes`);
    assert.equal(impostor.reason, 'hash_mismatch');
  }

  // Non-matching or nonsensical sizes fail closed, and the hash is never even consulted.
  for (const [size, reason] of [
    [-21, 'size_mismatch'],
    [Number.NaN, 'size_mismatch'],
    [undefined, 'size_mismatch'],
    [21.5, 'size_mismatch'],
    [{}, 'size_mismatch'],
    [true, 'size_mismatch'],
    [22, 'size_mismatch'],
    [null, 'zero_byte_object'],
    [0, 'zero_byte_object'],
    [[], 'zero_byte_object'],
  ]) {
    const object = await withSize(size, HONEST);
    assert.equal(object.ok, false, `size ${String(size)} must fail`);
    assert.equal(object.reason, reason, `size ${String(size)}`);
    assert.equal(object.hashMatch, false);
  }
});

/* ------------------------------------------------------------------ *
 * 3. COUNTING INTEGRITY
 * ------------------------------------------------------------------ */

test('adversarial: verifiedCount + failures always equals requiredCount, and ok implies full coverage', async () => {
  const good = scriptedBucket({ head: (key) => ({ key, size: HONEST.length }), body: HONEST });
  const cases = [
    ['all good', oneObjectManifest(), good],
    ['malformed key', oneObjectManifest({ r2Key: 'media/figures/figure-1.png' }), good],
    ['zero byteSize', oneObjectManifest({ byteSize: 0 }), good],
    ['negative byteSize', oneObjectManifest({ byteSize: -5 }), good],
    ['missing object', oneObjectManifest(), scriptedBucket({ head: () => null })],
    [
      'no hash available',
      oneObjectManifest(),
      scriptedBucket({ head: (key) => ({ key, size: HONEST.length }), body: null }),
    ],
    [
      'r2 throws',
      oneObjectManifest(),
      {
        calls: [],
        async head() {
          throw new Error('outage');
        },
        async get() {
          throw new Error('outage');
        },
        async list() {
          throw new Error('outage');
        },
      },
    ],
  ];

  for (const [label, manifest, bucket] of cases) {
    const result = await verifyMediaObjects({ MEDIA: bucket }, manifest);

    assert.equal(
      result.verifiedCount + result.failures.length,
      result.requiredCount,
      `${label}: every required object is counted exactly once`,
    );
    assert.equal(result.objects.length, result.requiredCount, `${label}: no object counted twice`);
    if (result.ok) {
      assert.equal(result.verifiedCount, result.requiredCount, `${label}: ok implies full coverage`);
      assert.equal(result.failures.length, 0, `${label}: ok implies no failures`);
    } else {
      assert.ok(
        result.failures.length > 0 || result.requiredCount === 0,
        `${label}: not-ok must name at least one failure unless nothing was required`,
      );
      assert.notEqual(result.reason, null, `${label}: not-ok must always carry a reason`);
    }
  }
});

test('adversarial: the four bucketed counters deliberately do NOT sum to requiredCount', async () => {
  // A consumer must not compute "problems" as missing+size+hash: malformed_r2_key,
  // no_hash_available and r2_unreachable have no counter of their own. `failures` is the truth.
  const bucket = scriptedBucket({ head: (key) => ({ key, size: HONEST.length }), body: HONEST });
  const result = await verifyMediaObjects(
    { MEDIA: bucket },
    oneObjectManifest({ r2Key: 'media/figures/figure-1.png' }),
  );

  const bucketed =
    result.missingCount + result.sizeMismatchCount + result.hashMismatchCount + result.verifiedCount;

  assert.equal(result.ok, false);
  assert.equal(result.requiredCount, 1);
  assert.equal(bucketed, 0, 'malformed_r2_key lands in no counter at all');
  assert.equal(result.failures.length, 1);
  assert.equal(result.failures[0].reason, 'malformed_r2_key');
});

/* ------------------------------------------------------------------ *
 * 4. EMPTY / DEGENERATE MANIFESTS
 * ------------------------------------------------------------------ */

test('adversarial: an empty required set is not ok AND says why', async () => {
  const empty = { format: 1, objects: [], manifestSha256: manifestSha256([]) };
  const result = await verifyMediaObjects({ MEDIA: scriptedBucket() }, empty);

  assert.equal(result.ok, false);
  assert.equal(result.requiredCount, 0);
  assert.notEqual(result.reason, null, 'a silent ok:false with reason null is unusable to a caller');
  assert.equal(result.reason, 'empty_required_set');
});

test('adversarial: hostile r2Key shapes are all rejected before the bucket is touched', async () => {
  const bucket = scriptedBucket({ head: (key) => ({ key, size: HONEST.length }), body: HONEST });

  for (const r2Key of [
    '',
    '../',
    'media/figures/figure-0001.png\n',
    '\nmedia/figures/figure-0001.png',
    'media/figures/../../../etc/passwd.png',
    'media/figures/figure-0001.png/../figure-0002.png',
    'MEDIA/FIGURES/FIGURE-0001.PNG',
    'media/figures/figure-1.png',
    'media/figures/figure-00001.png',
    'media/figures/figure-0001.exe',
    'media/figures/figure-0001.png ',
  ]) {
    const result = await verifyMediaObjects({ MEDIA: bucket }, oneObjectManifest({ r2Key }));
    assert.equal(result.ok, false, `r2Key ${JSON.stringify(r2Key)} must be rejected`);
    assert.equal(
      result.failures[0].reason,
      'malformed_r2_key',
      `r2Key ${JSON.stringify(r2Key)}`,
    );
    assert.equal(result.failures[0].present, false);
  }
});

test('adversarial: duplicate keys and non-array objects are rejected whole', async () => {
  const bucket = scriptedBucket({ head: (key) => ({ key, size: HONEST.length }), body: HONEST });

  // Same key, two different hashes — one of them is necessarily a lie.
  const dup = [
    {
      postId: 'D1',
      figure: 1,
      logicalMediaId: 'figure-0001',
      extension: 'png',
      r2Key: 'media/figures/figure-0001.png',
      byteSize: HONEST.length,
      sha256: sha256Hex(HONEST),
    },
    {
      postId: 'A4',
      figure: 9,
      logicalMediaId: 'figure-0001',
      extension: 'png',
      r2Key: 'media/figures/figure-0001.png',
      byteSize: HONEST.length,
      sha256: sha256Hex(IMPOSTOR),
    },
  ];
  const duplicated = { format: 1, objects: dup, manifestSha256: manifestSha256(dup) };
  const result = await verifyMediaObjects({ MEDIA: bucket }, duplicated);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'duplicate_r2_key');
  assert.equal(bucket.calls.length, 0, 'a rejected manifest must not reach R2');

  for (const bad of [
    { format: 1, objects: { 0: 'x' }, manifestSha256: 'x' },
    { format: 1, objects: 'nope', manifestSha256: 'x' },
    { format: 1, manifestSha256: 'x' },
    'a string manifest',
    42,
    [],
  ]) {
    const bogus = await verifyMediaObjects({ MEDIA: scriptedBucket() }, bad);
    assert.equal(bogus.ok, false, `must reject ${JSON.stringify(bad)}`);
    assert.equal(bogus.verifiedCount, 0);
  }
});

test('adversarial: verifyMediaObjects never throws, even on a manifest that attacks the reader', async () => {
  const bucket = { MEDIA: scriptedBucket({ head: (key) => ({ key, size: HONEST.length }), body: HONEST }) };

  const throwingGetter = { format: 1, manifestSha256: 'x' };
  Object.defineProperty(throwingGetter, 'objects', {
    enumerable: true,
    get() {
      throw new Error('objects getter detonated');
    },
  });

  const hostile = [
    throwingGetter,
    new Proxy({}, { get() { throw new Error('proxy detonated'); } }),
    Object.create(null),
  ];

  for (const manifest of hostile) {
    const result = await verifyMediaObjects(bucket, manifest);
    assert.equal(result.ok, false, 'a hostile manifest must fail closed, not raise');
    assert.equal(result.readOnly, true);
    assert.notEqual(result.reason, null);
  }
});

/* ------------------------------------------------------------------ *
 * 5. PROTOTYPE POLLUTION
 * ------------------------------------------------------------------ */

test('adversarial: __proto__ / constructor keys pollute nothing and verify nothing', async () => {
  const polluting = JSON.parse(
    '{"format":1,"objects":[],"manifestSha256":"x","__proto__":{"pwned":true}}',
  );
  await verifyMediaObjects({ MEDIA: scriptedBucket() }, polluting);
  assert.equal({}.pwned, undefined, 'Object.prototype must be untouched');

  // A bucket listing entries named __proto__ / constructor must be reported as ordinary strays.
  const listing = scriptedBucket({
    head: (key) => ({ key, size: HONEST.length }),
    body: HONEST,
    list: () => ({
      objects: [
        { key: '__proto__', size: 1 },
        { key: 'constructor', size: 1 },
        { key: 'media/figures/figure-0001.png', size: HONEST.length },
      ],
      truncated: false,
      cursor: null,
    }),
  });
  const result = await verifyMediaObjects({ MEDIA: listing }, oneObjectManifest());
  assert.equal(result.ok, true, 'strays never invalidate the required set');
  assert.deepEqual(
    result.unrelatedObjects.map((o) => o.key),
    ['__proto__', 'constructor'],
  );
  assert.equal({}.pwned, undefined);
  assert.equal(Object.prototype.hasOwnProperty.call(Object.prototype, 'polluted'), false);

  // The upload helper's content-type lookup must not walk the prototype chain.
  for (const extension of ['__proto__', 'constructor', 'toString', 'valueOf', 'hasOwnProperty']) {
    assert.throws(
      () => contentTypeFor(extension),
      /Unsupported media extension/,
      `contentTypeFor(${extension}) must refuse, not return a prototype member`,
    );
  }
});

/* ------------------------------------------------------------------ *
 * 6. LISTING PAGINATION
 * ------------------------------------------------------------------ */

function pagingBucket(total, { pageSize = 1 } = {}) {
  const keys = Array.from({ length: total }, (_, i) => `stray/${String(i).padStart(6, '0')}.bin`);
  const seen = [];
  return {
    seen,
    async head(key) {
      return { key, size: HONEST.length };
    },
    async get(key) {
      return { key, arrayBuffer: async () => bufferToArrayBuffer(HONEST) };
    },
    async list(options) {
      const start = options?.cursor ? Number(options.cursor) : 0;
      seen.push(options?.cursor ?? null);
      const slice = keys.slice(start, start + pageSize);
      const next = start + pageSize;
      return {
        objects: slice.map((key) => ({ key, size: 1 })),
        truncated: next < keys.length,
        cursor: next < keys.length ? String(next) : null,
      };
    },
  };
}

test('adversarial: a truncated listing is actually paginated, not silently first-page-only', async () => {
  const bucket = pagingBucket(7);
  const listed = await listUnrelatedObjects({ MEDIA: bucket }, { objects: [] });

  assert.equal(listed.ok, true);
  assert.equal(listed.count, 7, 'every page must be walked');
  assert.deepEqual(bucket.seen, [null, '1', '2', '3', '4', '5', '6'], 'the cursor must be threaded');
  assert.equal(listed.complete, true);
});

test('adversarial: a listing capped by the page limit must not claim to be complete', async () => {
  const bucket = pagingBucket(250);
  const listed = await listUnrelatedObjects({ MEDIA: bucket }, { objects: [] });

  // The 100-page ceiling is a deliberate guard against an unbounded loop. It is only safe if the
  // caller can tell a capped listing from an exhaustive one.
  assert.equal(listed.count, 100, 'the page ceiling holds');
  assert.equal(listed.complete, false, 'a capped listing must report itself as partial');

  // truncated:true with no cursor is the other way a listing ends early.
  const cursorless = {
    MEDIA: {
      async list() {
        return { objects: [{ key: 'stray/a.bin', size: 1 }], truncated: true, cursor: null };
      },
    },
  };
  const stalled = await listUnrelatedObjects(cursorless, { objects: [] });
  assert.equal(stalled.complete, false, 'truncated without a cursor is also incomplete');
});

test('adversarial: a failed or partial stray listing is never reported as "no strays"', async () => {
  const listFails = {
    MEDIA: {
      async head(key) {
        return { key, size: HONEST.length };
      },
      async get(key) {
        return { key, arrayBuffer: async () => bufferToArrayBuffer(HONEST) };
      },
      async list() {
        throw new Error('list denied');
      },
    },
  };

  const result = await verifyMediaObjects(listFails, oneObjectManifest());

  // The required objects are fine, so `ok` must stay true — strays never gate `ok`. But the summary
  // must not present a failed listing as an observed absence of strays.
  assert.equal(result.ok, true);
  assert.equal(result.unrelatedObjectCount, 0);
  assert.equal(result.unrelatedListing.ok, false, 'the listing failure must be surfaced');
  assert.equal(result.unrelatedListing.reason, 'r2_unreachable');
  assert.equal(result.unrelatedListing.complete, false);

  const capped = await verifyMediaObjects({ MEDIA: pagingBucket(250) }, oneObjectManifest());
  assert.equal(capped.ok, true);
  assert.equal(capped.unrelatedListing.ok, true);
  assert.equal(capped.unrelatedListing.complete, false, 'a capped listing is visible in the summary');
});

/* ------------------------------------------------------------------ *
 * 7. REQUIREMENTS GENERATOR — forced duplicate figure
 * ------------------------------------------------------------------ */

/** A synthetic project root (outside the repo) holding exactly one 20-slot pillar cycle. */
function syntheticRoot(annotations) {
  const root = mkdtempSync(join(tmpdir(), 'xqueue-adv-root-'));
  mkdirSync(join(root, 'config'));
  mkdirSync(join(root, 'content'));
  writeFileSync(
    join(root, 'config', 'schedule-policy.json'),
    JSON.stringify(
      {
        version: 99,
        campaignStart: '2026-08-31',
        timezone: 'America/Chicago',
        slots: ['14:30', '22:15'],
        daysOfWeek: [1, 2, 3, 4, 5],
        deferToEnd: [],
      },
      null,
      2,
    ),
  );

  const counts = { A: 8, B: 5, C: 4, D: 3 };
  const files = { A: '20-pillar-a.md', B: '30-pillar-b.md', C: '40-pillar-c.md', D: '50-pillar-d.md' };
  for (const [pillar, n] of Object.entries(counts)) {
    let md = `### Pillar ${pillar} — Synthetic\n\n`;
    for (let i = 1; i <= n; i++) {
      const id = `${pillar}${i}`;
      const note = annotations[id] ? ` *(${annotations[id]})*` : '';
      md += `**${id} · Title ${i}**${note}\n\`\`\`\nBody for ${id}.\n\`\`\`\n\n`;
    }
    writeFileSync(join(root, 'content', files[pillar]), md);
  }
  return root;
}

test('adversarial: a figure shared by two posts aborts Tier 1 and names the conflict', () => {
  const control = syntheticRoot({ A1: 'attach figure 7', B1: 'attach figure 8' });
  try {
    const requirements = buildMediaRequirements({ root: control });
    assert.equal(requirements.requiredCount, 2, 'the harness itself must be able to build');
    assert.deepEqual(
      requirements.objects.map((o) => [o.postId, o.figure]),
      [['A1', 7], ['B1', 8]],
    );
  } finally {
    rmSync(control, { recursive: true, force: true });
  }

  const conflicted = syntheticRoot({ A1: 'attach figure 7', B1: 'attach figure 7' });
  try {
    assert.throws(
      () => buildMediaRequirements({ root: conflicted }),
      (error) => {
        assert.match(error.message, /Refusing to build media requirements/);
        assert.match(error.message, /figure 7 referenced by (A1 and B1|B1 and A1)/);
        assert.match(error.message, /Each figure must map to exactly one post/);
        return true;
      },
      'a shared figure must abort loudly, never dedupe silently',
    );
  } finally {
    rmSync(conflicted, { recursive: true, force: true });
  }

  const triple = syntheticRoot({
    A1: 'attach figure 7',
    B1: 'attach figure 7',
    C1: 'attach figure 7',
  });
  try {
    assert.throws(() => buildMediaRequirements({ root: triple }), (error) => {
      assert.equal(error.message.match(/figure 7 referenced by/g).length, 2, 'both conflicts named');
      return true;
    });
  } finally {
    rmSync(triple, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ *
 * 8. MANIFEST BUILDER — filename resolution boundaries
 * ------------------------------------------------------------------ */

function fixtureDir(entries) {
  const dir = mkdtempSync(join(tmpdir(), 'xqueue-adv-media-'));
  for (const [name, content] of Object.entries(entries)) writeFileSync(join(dir, name), content);
  return dir;
}

test('adversarial: figure N must not match a filename that merely ENDS in N', () => {
  const dir = fixtureDir({
    'figure-1.png': 'one',
    'figure-11.png': 'eleven',
    'figure-21.png': 'twentyone',
    'figure-101.png': 'onehundredone',
    'figure-10.png': 'ten',
    'figure-9.jpg': 'nine',
    'figure-19.jpg': 'nineteen',
    'figure-14.webp': 'fourteen',
    'figure-114.webp': 'onefourteen',
    'figure-23.gif': 'twentythree',
    'figure-123.gif': 'onetwentythree',
  });
  try {
    assert.deepEqual(findFigureCandidates(dir, 1), ['figure-1.png'], 'figure 1 is not figure 11/21/101');
    assert.deepEqual(findFigureCandidates(dir, 9), ['figure-9.jpg'], 'figure 9 is not figure 19');
    assert.deepEqual(findFigureCandidates(dir, 14), ['figure-14.webp']);
    assert.deepEqual(findFigureCandidates(dir, 23), ['figure-23.gif']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('adversarial: a realistic media directory of 30 figures resolves the 4 required ones', () => {
  // The live library numbers figures 1..N. If figure 1 collides with figure-11/figure-21 the whole
  // media pipeline is unusable: the manifest can never be built, so nothing can ever be uploaded.
  const entries = {};
  for (let i = 1; i <= 30; i++) entries[`figure-${i}.png`] = `bytes-of-figure-${i}`;
  const dir = fixtureDir(entries);
  try {
    const manifest = buildMediaManifest({ mediaDir: dir });
    assert.equal(manifest.resolvedCount, 4);
    assert.deepEqual(
      manifest.objects.map((o) => o.r2Key),
      [
        'media/figures/figure-0001.png',
        'media/figures/figure-0009.png',
        'media/figures/figure-0014.png',
        'media/figures/figure-0023.png',
      ],
    );
    // Each object must carry the bytes of ITS OWN figure, not a numeric neighbour's.
    for (const object of manifest.objects) {
      assert.equal(object.sha256, sha256Hex(Buffer.from(`bytes-of-figure-${object.figure}`, 'utf8')));
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('adversarial: the accepted-name convention still mirrors src/cli.mjs figurePath', () => {
  const dir = fixtureDir({ 'readme.md': 'x', 'figure-1.png.bak': 'x', 'figure-1.txt': 'x' });
  try {
    assert.deepEqual(findFigureCandidates(dir, 1), [], '.bak and unknown extensions never match');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  for (const name of ['figure-1.png', 'figure_1.PNG', 'figure1.jpg', '1.gif', '01.webp', 'figure-001.png']) {
    const one = fixtureDir({ [name]: 'x' });
    try {
      assert.deepEqual(findFigureCandidates(one, 1), [name], `${name} must resolve figure 1`);
    } finally {
      rmSync(one, { recursive: true, force: true });
    }
  }

  const ambiguous = fixtureDir({ 'figure-1.png': 'a', '1.jpg': 'b' });
  try {
    assert.equal(findFigureCandidates(ambiguous, 1).length, 2, 'genuine ambiguity is still detected');
  } finally {
    rmSync(ambiguous, { recursive: true, force: true });
  }
});

test('adversarial: a directory or dangling symlink named like a figure fails closed, readably', () => {
  const dir = fixtureDir({
    'figure-9.jpg': 'nine',
    'figure-14.webp': 'fourteen',
    'figure-23.gif': 'twentythree',
  });
  mkdirSync(join(dir, 'figure-1.png'));
  try {
    assert.throws(
      () => buildMediaManifest({ mediaDir: dir }),
      (error) => {
        assert.match(error.message, /Refusing to build a media manifest/);
        assert.match(error.message, /figure 1 \(post D1, figure-0001\)/);
        assert.match(error.message, /not a regular file/);
        assert.equal(error.code, undefined, 'must not surface a raw EISDIR/ENOENT');
        return true;
      },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  const linked = fixtureDir({
    'figure-9.jpg': 'nine',
    'figure-14.webp': 'fourteen',
    'figure-23.gif': 'twentythree',
  });
  symlinkSync(join(linked, 'nowhere-at-all.png'), join(linked, 'figure-1.png'));
  try {
    assert.throws(
      () => buildMediaManifest({ mediaDir: linked }),
      (error) => {
        assert.match(error.message, /Refusing to build a media manifest/);
        assert.match(error.message, /figure 1 \(post D1, figure-0001\)/);
        assert.equal(error.code, undefined, 'must not surface a raw ENOENT');
        return true;
      },
    );
  } finally {
    rmSync(linked, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ *
 * 9. UPLOAD HELPER — no path to an unconfirmed or redirected upload
 * ------------------------------------------------------------------ */

test('adversarial: nothing but the exact --confirm token leaves dry-run mode', () => {
  for (const argv of [
    [],
    ['--dry-run'],
    ['--confirm=true'],
    ['--confirm=1'],
    ['--CONFIRM'],
    ['-y'],
    ['--yes'],
    ['--force'],
    ['--no-dry-run'],
    ['confirm'],
    ['--confirm-not-really'],
    ['x --confirm'],
    ['--conf', 'irm'],
    ['--bucket', 'someone-elses-bucket'],
    ['--file', '/etc/passwd'],
  ]) {
    const parsed = parseArgs(argv);
    assert.equal(parsed.dryRun, true, `${JSON.stringify(argv)} must stay a dry run`);
    assert.equal(parsed.confirm, false);
  }

  assert.equal(parseArgs(['--confirm']).dryRun, false, 'the explicit token, and only it, confirms');
  assert.equal(parseArgs(['--dry-run', '--confirm']).explicitDryRun, true, 'the conflict is detectable');
});

test('adversarial: no manifest content can redirect the upload or inject an argument', () => {
  assert.equal(BUCKET, 'xqueue-media');

  const hostile = [
    { r2Key: 'media/figures/figure-0001.png; rm -rf /', extension: 'png', localSource: 'media/a.png' },
    { r2Key: '$(id)', extension: 'png', localSource: 'media/a.png' },
    { r2Key: '--remote', extension: 'png', localSource: 'media/a.png' },
    { r2Key: '../../../other-bucket/x.png', extension: 'PNG', localSource: 'media/a.png' },
  ];

  for (const object of hostile) {
    const argv = uploadCommand(object);
    assert.equal(argv[0], 'wrangler');
    assert.deepEqual(argv.slice(1, 4), ['r2', 'object', 'put']);
    assert.equal(argv[4], `xqueue-media/${object.r2Key}`, 'the bucket prefix is not escapable');
    assert.ok(argv[4].startsWith('xqueue-media/'), 'no key can become a wrangler flag');
    assert.equal(argv.filter((a) => a === '--file').length, 1);
    // argv is passed to spawnSync as a list, so no element is ever shell-interpreted.
    assert.ok(argv.every((a) => typeof a === 'string'));
  }

  for (const extension of ['exe', 'png;id', 'svg', '', null, undefined, 'png ']) {
    assert.throws(() => contentTypeFor(extension), /Unsupported media extension/);
  }
  assert.equal(contentTypeFor('PNG'), 'image/png');
});

test('adversarial: the upload helper has no delete, sync, prune or publication path', () => {
  const source = readFileSync(UPLOAD_SOURCE, 'utf8');
  const code = source
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('//'))
    .join('\n');

  for (const forbidden of [
    'shell: true',
    'shell:true',
    'execSync',
    'exec(',
    'X_API',
    'X_ACCESS',
    'X_BEARER',
    'twitter',
    'api.x.com',
    'cron',
  ]) {
    assert.equal(code.includes(forbidden), false, `upload helper must not contain ${forbidden}`);
  }

  for (const verb of ['delete', 'rm', 'sync', 'prune', 'mirror']) {
    assert.equal(
      new RegExp(`['"\`]${verb}['"\`]`).test(code),
      false,
      `upload helper must never pass "${verb}" to wrangler`,
    );
  }

  // The only wrangler subcommands present are `object put` and the read-only `object get --info`.
  const subcommands = [...code.matchAll(/'(put|get|delete|list)'/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(subcommands)].sort(), ['get', 'put']);
  assert.ok(code.includes("'--info'"), 'the post-upload check stays read-only');
});
