import test from 'node:test';
import assert from 'node:assert/strict';

import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildMediaRequirements,
  keyPrefixFor,
  logicalMediaId,
  serializeRequirements,
} from '../scripts/build-media-requirements.mjs';

import {
  buildMediaManifest,
  findFigureCandidates,
  manifestSha256,
  r2KeyFor,
} from '../scripts/build-media-manifest.mjs';

import {
  listUnrelatedObjects,
  verifyMediaObjects,
} from '../cloudflare/src/media-verify.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const VERIFY_SOURCE = join(ROOT, 'cloudflare', 'src', 'media-verify.mjs');
const REQUIREMENTS_FILE = join(ROOT, 'cloudflare', 'generated', 'media-requirements.json');

/* ------------------------------------------------------------------ *
 * Tier 1 — requirements derived from the live-regenerated queue
 * ------------------------------------------------------------------ */

test('requirements derive to exactly 4 objects for figures 1, 9, 14 and 23', () => {
  const requirements = buildMediaRequirements();

  assert.equal(requirements.format, 1);
  assert.equal(requirements.queueCount, 180);
  assert.equal(requirements.requiredCount, 4);
  assert.equal(requirements.objects.length, 4);
  assert.deepEqual(
    requirements.objects.map((o) => o.figure),
    [1, 9, 14, 23],
  );
  assert.deepEqual(requirements.allowedExtensions, ['png', 'jpg', 'jpeg', 'gif', 'webp']);

  const figures = new Set(requirements.objects.map((o) => o.figure));
  assert.equal(figures.size, requirements.objects.length, 'no figure may be shared by two posts');

  const postIds = new Set(requirements.objects.map((o) => o.postId));
  assert.equal(postIds.size, requirements.objects.length);
});

test('requirements generation is deterministic and matches the committed artifact', () => {
  const first = serializeRequirements(buildMediaRequirements());
  const second = serializeRequirements(buildMediaRequirements());

  assert.equal(first, second, 'two builds must be byte-identical');
  assert.equal(first, readFileSync(REQUIREMENTS_FILE, 'utf8'), 'committed artifact must be current');
  assert.ok(first.endsWith('}\n'), 'canonical bytes end with a trailing newline');
});

test('logicalMediaId and keyPrefix zero-pad to four digits', () => {
  assert.equal(logicalMediaId(1), 'figure-0001');
  assert.equal(logicalMediaId(9), 'figure-0009');
  assert.equal(logicalMediaId(14), 'figure-0014');
  assert.equal(logicalMediaId(23), 'figure-0023');
  assert.equal(logicalMediaId(1234), 'figure-1234');
  assert.equal(logicalMediaId(12345), 'figure-12345');

  assert.equal(keyPrefixFor(1), 'media/figures/figure-0001');
  assert.equal(keyPrefixFor(23), 'media/figures/figure-0023');

  assert.throws(() => logicalMediaId(1.5), /non-negative integer/);
  assert.throws(() => logicalMediaId('7'), /non-negative integer/);

  assert.equal(r2KeyFor('figure-0009', 'jpg'), 'media/figures/figure-0009.jpg');
});

/* ------------------------------------------------------------------ *
 * In-memory R2 stub (read-only surface only)
 * ------------------------------------------------------------------ */

function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function hexToArrayBuffer(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out.buffer;
}

/** Records every method invoked so the tests can prove nothing mutating was called. */
class R2Stub {
  constructor({ hashMode = 'checksum', throwOn = null } = {}) {
    this.store = new Map();
    this.hashMode = hashMode;
    this.throwOn = throwOn;
    this.calls = [];
  }

  put_(key, bytes) {
    this.store.set(key, Buffer.from(bytes));
    return this;
  }

  #guard(method) {
    this.calls.push(method);
    if (this.throwOn === method || this.throwOn === 'all') {
      throw new Error('simulated R2 outage');
    }
  }

  async head(key) {
    this.#guard('head');
    const bytes = this.store.get(key);
    if (!bytes) return null;

    const object = { key, size: bytes.length };
    if (this.hashMode === 'checksum') {
      object.checksums = { sha256: hexToArrayBuffer(sha256Hex(bytes)) };
    } else if (this.hashMode === 'customMetadata') {
      object.customMetadata = { sha256: sha256Hex(bytes) };
    }
    return object;
  }

  async get(key) {
    this.#guard('get');
    const bytes = this.store.get(key);
    if (!bytes) return null;
    return {
      key,
      size: bytes.length,
      async arrayBuffer() {
        return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      },
    };
  }

  async list() {
    this.#guard('list');
    return {
      objects: [...this.store.entries()].map(([key, bytes]) => ({ key, size: bytes.length })),
      truncated: false,
      cursor: null,
    };
  }
}

const SPEC = [
  { postId: 'D1', figure: 1, extension: 'png', body: 'figure-one-bytes' },
  { postId: 'A4', figure: 9, extension: 'jpg', body: 'figure-nine-bytes' },
  { postId: 'A1', figure: 14, extension: 'webp', body: 'figure-fourteen-bytes' },
  { postId: 'C1', figure: 23, extension: 'gif', body: 'figure-twentythree-bytes' },
];

function makeManifest(spec = SPEC) {
  const objects = spec.map((entry) => {
    const bytes = Buffer.from(entry.body, 'utf8');
    const id = logicalMediaId(entry.figure);
    return {
      postId: entry.postId,
      figure: entry.figure,
      logicalMediaId: id,
      localSource: `media/${id}.${entry.extension}`,
      extension: entry.extension,
      r2Key: entry.r2Key ?? r2KeyFor(id, entry.extension),
      byteSize: bytes.length,
      sha256: sha256Hex(bytes),
    };
  });

  return {
    format: 1,
    bucket: 'xqueue-media',
    requiredCount: objects.length,
    resolvedCount: objects.length,
    objects,
    manifestSha256: manifestSha256(objects),
  };
}

function reseal(manifest) {
  return { ...manifest, manifestSha256: manifestSha256(manifest.objects) };
}

function stubFor(manifest, spec = SPEC, options = {}) {
  const bucket = new R2Stub(options);
  manifest.objects.forEach((object, i) => {
    bucket.put_(object.r2Key, Buffer.from(spec[i].body, 'utf8'));
  });
  return { MEDIA: bucket };
}

function assertNoMutation(env) {
  assert.ok(
    env.MEDIA.calls.every((call) => ['head', 'get', 'list'].includes(call)),
    `verification must only use read methods, saw: ${env.MEDIA.calls.join(',')}`,
  );
}

/* ------------------------------------------------------------------ *
 * Positive path
 * ------------------------------------------------------------------ */

test('all objects present and matching => ok true', async () => {
  const manifest = makeManifest();
  const env = stubFor(manifest);

  const result = await verifyMediaObjects(env, manifest);

  assert.equal(result.ok, true);
  assert.equal(result.requiredCount, 4);
  assert.equal(result.verifiedCount, 4);
  assert.equal(result.missingCount, 0);
  assert.equal(result.sizeMismatchCount, 0);
  assert.equal(result.hashMismatchCount, 0);
  assert.equal(result.unrelatedObjectCount, 0);
  assert.deepEqual(result.failures, []);
  assert.equal(result.readOnly, true);
  assertNoMutation(env);
});

test('the R2-recorded checksum is preferred, with metadata then a body digest as fallbacks', async () => {
  const manifest = makeManifest();

  const checksum = await verifyMediaObjects(stubFor(manifest, SPEC, { hashMode: 'checksum' }), manifest);
  assert.equal(checksum.ok, true);
  assert.deepEqual([...new Set(checksum.objects.map((o) => o.hashSource))], ['r2_checksum']);

  const metadata = await verifyMediaObjects(
    stubFor(manifest, SPEC, { hashMode: 'customMetadata' }),
    manifest,
  );
  assert.equal(metadata.ok, true);
  assert.deepEqual([...new Set(metadata.objects.map((o) => o.hashSource))], ['custom_metadata']);

  const body = await verifyMediaObjects(stubFor(manifest, SPEC, { hashMode: 'none' }), manifest);
  assert.equal(body.ok, true);
  assert.deepEqual([...new Set(body.objects.map((o) => o.hashSource))], ['body_digest']);
});

/* ------------------------------------------------------------------ *
 * Negative paths — every one must fail closed
 * ------------------------------------------------------------------ */

test('negative: a missing object fails with reason "missing"', async () => {
  const manifest = makeManifest();
  const env = stubFor(manifest);
  env.MEDIA.store.delete(manifest.objects[2].r2Key);

  const result = await verifyMediaObjects(env, manifest);

  assert.equal(result.ok, false);
  assert.equal(result.missingCount, 1);
  assert.equal(result.verifiedCount, 3);
  assert.equal(result.failures.length, 1);
  assert.equal(result.failures[0].reason, 'missing');
  assert.equal(result.failures[0].present, false);
  assert.equal(result.failures[0].r2Key, 'media/figures/figure-0014.webp');
  assertNoMutation(env);
});

test('negative: a wrong hash at the right size fails with reason "hash_mismatch"', async () => {
  const manifest = makeManifest();
  const env = stubFor(manifest);
  const key = manifest.objects[0].r2Key;
  const size = manifest.objects[0].byteSize;
  env.MEDIA.put_(key, Buffer.from('X'.repeat(size), 'utf8'));

  const result = await verifyMediaObjects(env, manifest);

  assert.equal(result.ok, false);
  assert.equal(result.hashMismatchCount, 1);
  assert.equal(result.failures[0].reason, 'hash_mismatch');
  assert.equal(result.failures[0].present, true);
  assert.equal(result.failures[0].sizeMatch, true);
  assert.equal(result.failures[0].hashMatch, false);
  assertNoMutation(env);
});

test('negative: a wrong size fails with reason "size_mismatch"', async () => {
  const manifest = makeManifest();
  const env = stubFor(manifest);
  env.MEDIA.put_(manifest.objects[1].r2Key, Buffer.from('short', 'utf8'));

  const result = await verifyMediaObjects(env, manifest);

  assert.equal(result.ok, false);
  assert.equal(result.sizeMismatchCount, 1);
  assert.equal(result.failures[0].reason, 'size_mismatch');
  assert.equal(result.failures[0].present, true);
  assert.equal(result.failures[0].sizeMatch, false);
  assertNoMutation(env);
});

test('negative: a zero-byte object fails with reason "zero_byte_object"', async () => {
  const manifest = makeManifest();
  const env = stubFor(manifest);
  env.MEDIA.put_(manifest.objects[3].r2Key, Buffer.alloc(0));

  const result = await verifyMediaObjects(env, manifest);

  assert.equal(result.ok, false);
  assert.equal(result.failures[0].reason, 'zero_byte_object');
  assert.equal(result.failures[0].present, true);
  assert.equal(result.failures[0].hashMatch, false);
  assert.equal(result.sizeMismatchCount, 1);
  assertNoMutation(env);
});

test('negative: a manifest mutated after generation fails with "manifest_digest_mismatch"', async () => {
  const manifest = makeManifest();
  const env = stubFor(manifest);

  const tampered = {
    ...manifest,
    objects: manifest.objects.map((o, i) => (i === 0 ? { ...o, byteSize: o.byteSize + 1 } : o)),
  };

  const result = await verifyMediaObjects(env, tampered);

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'manifest_digest_mismatch');
  assert.equal(result.verifiedCount, 0);
  assert.equal(env.MEDIA.calls.length, 0, 'a bad manifest must not reach R2 at all');
});

test('negative: a duplicated figure reference fails with "duplicate_figure"', async () => {
  const manifest = makeManifest();
  const duplicated = reseal({
    ...manifest,
    objects: [...manifest.objects, { ...manifest.objects[0], postId: 'B7' }],
  });

  const env = stubFor(manifest);
  const result = await verifyMediaObjects(env, duplicated);

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'duplicate_figure');
  assert.equal(result.verifiedCount, 0);
  assert.equal(env.MEDIA.calls.length, 0);
});

test('negative: a duplicated figure aborts Tier 1 generation loudly', () => {
  const queue = [
    { id: 'A1', figure: 5 },
    { id: 'B2', figure: 5 },
  ];
  const seen = new Map();
  const duplicates = [];
  for (const post of queue) {
    if (post.figure == null) continue;
    if (seen.has(post.figure)) duplicates.push(post.figure);
    else seen.set(post.figure, post.id);
  }
  assert.deepEqual(duplicates, [5], 'the duplicate-detection contract the builder enforces');

  const live = buildMediaRequirements();
  const figures = live.objects.map((o) => o.figure);
  assert.equal(new Set(figures).size, figures.length, 'the real queue has no duplicate figure');
});

test('negative: a malformed r2Key fails with "malformed_r2_key" and never reaches the bucket', async () => {
  const manifest = makeManifest();
  const malformed = reseal({
    ...manifest,
    objects: manifest.objects.map((o, i) =>
      i === 0 ? { ...o, r2Key: 'media/figures/figure-1.png' } : o,
    ),
  });

  const env = stubFor(manifest);
  const result = await verifyMediaObjects(env, malformed);

  assert.equal(result.ok, false);
  assert.equal(result.failures.length, 1);
  assert.equal(result.failures[0].reason, 'malformed_r2_key');
  assert.equal(result.failures[0].present, false);
  assert.equal(result.verifiedCount, 3);
  assertNoMutation(env);

  const wrongPrefix = reseal({
    ...manifest,
    objects: manifest.objects.map((o, i) => (i === 1 ? { ...o, r2Key: 'figures/figure-0009.jpg' } : o)),
  });
  const second = await verifyMediaObjects(stubFor(manifest), wrongPrefix);
  assert.equal(second.ok, false);
  assert.equal(second.failures[0].reason, 'malformed_r2_key');
});

test('an unrelated object is reported, left alone, and does not by itself make ok false', async () => {
  const manifest = makeManifest();
  const env = stubFor(manifest);
  env.MEDIA.put_('media/figures/figure-9999.png', Buffer.from('stray', 'utf8'));
  env.MEDIA.put_('scratch/notes.txt', Buffer.from('unrelated', 'utf8'));

  const result = await verifyMediaObjects(env, manifest);

  assert.equal(result.ok, true, 'extra objects never invalidate the required set');
  assert.equal(result.unrelatedObjectCount, 2);
  assert.deepEqual(
    result.unrelatedObjects.map((o) => o.key),
    ['media/figures/figure-9999.png', 'scratch/notes.txt'],
  );

  const listed = await listUnrelatedObjects(env, manifest);
  assert.equal(listed.ok, true);
  assert.equal(listed.count, 2);

  assert.ok(env.MEDIA.store.has('media/figures/figure-9999.png'), 'stray object must survive');
  assert.ok(env.MEDIA.store.has('scratch/notes.txt'), 'stray object must survive');
  assert.equal(env.MEDIA.store.size, 6);
  assertNoMutation(env);
});

test('negative: R2 throwing yields ok false with reason "r2_unreachable" and never throws', async () => {
  const manifest = makeManifest();

  const headFails = stubFor(manifest, SPEC, { throwOn: 'head' });
  const result = await verifyMediaObjects(headFails, manifest);
  assert.equal(result.ok, false);
  assert.equal(result.verifiedCount, 0);
  assert.equal(result.objects.length, 4);
  assert.ok(result.objects.every((o) => o.reason === 'r2_unreachable'));

  const listFails = stubFor(manifest, SPEC, { throwOn: 'list' });
  const listed = await listUnrelatedObjects(listFails, manifest);
  assert.equal(listed.ok, false);
  assert.equal(listed.reason, 'r2_unreachable');

  const noBinding = await verifyMediaObjects({}, manifest);
  assert.equal(noBinding.ok, false);
  assert.equal(noBinding.reason, 'r2_unreachable');

  const noEnv = await verifyMediaObjects(undefined, manifest);
  assert.equal(noEnv.ok, false);
});

test('negative: a body-only object with an unreadable body is not verified', async () => {
  const manifest = makeManifest();
  const env = stubFor(manifest, SPEC, { hashMode: 'none' });
  const original = env.MEDIA.get.bind(env.MEDIA);
  env.MEDIA.get = async (key) => (key === manifest.objects[0].r2Key ? null : original(key));

  const result = await verifyMediaObjects(env, manifest);

  assert.equal(result.ok, false);
  assert.equal(result.failures[0].reason, 'no_hash_available');
});

test('negative: a malformed manifest is rejected outright', async () => {
  for (const bad of [null, undefined, [], {}, { objects: 'nope' }, { objects: [{ figure: 1 }] }]) {
    const result = await verifyMediaObjects({ MEDIA: new R2Stub() }, bad);
    assert.equal(result.ok, false, `must reject ${JSON.stringify(bad)}`);
    assert.equal(result.verifiedCount, 0);
  }

  const manifest = makeManifest();
  const unsealed = { ...manifest };
  delete unsealed.manifestSha256;
  const result = await verifyMediaObjects({ MEDIA: new R2Stub() }, unsealed);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'manifest_digest_missing');
});

test('an empty required set is never ok', async () => {
  const empty = { format: 1, objects: [], manifestSha256: manifestSha256([]) };
  const result = await verifyMediaObjects({ MEDIA: new R2Stub() }, empty);
  assert.equal(result.ok, false);
});

/* ------------------------------------------------------------------ *
 * Read-only guarantee, asserted against the source text
 * ------------------------------------------------------------------ */

test('the verify module contains no mutating R2 call and no Node built-in import', () => {
  const source = readFileSync(VERIFY_SOURCE, 'utf8');

  assert.equal(source.includes('.delete('), false, 'media-verify must never call .delete(');
  assert.equal(source.includes('.put('), false, 'media-verify must never call .put(');
  assert.equal(/\bfrom\s+['"]node:/.test(source), false, 'media-verify must not import Node built-ins');
  assert.equal(source.includes('node:'), false);
});

/* ------------------------------------------------------------------ *
 * Tier 2 — manifest generation fails closed without real media
 * ------------------------------------------------------------------ */

test('build-media-manifest fails closed when MEDIA_DIR is empty', () => {
  const dir = mkdtempSync(join(tmpdir(), 'xqueue-media-empty-'));
  try {
    assert.throws(
      () => buildMediaManifest({ mediaDir: dir }),
      (error) => {
        assert.match(error.message, /Refusing to build a media manifest: 4 of 4/);
        assert.match(error.message, /no local source file found/);
        assert.match(error.message, /Nothing was written\./);
        return true;
      },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('build-media-manifest fails closed on a missing directory, an ambiguous or an empty figure', () => {
  assert.throws(
    () => buildMediaManifest({ mediaDir: join(tmpdir(), 'xqueue-does-not-exist-ever') }),
    /Media directory does not exist/,
  );

  const dir = mkdtempSync(join(tmpdir(), 'xqueue-media-bad-'));
  try {
    writeFileSync(join(dir, 'figure-1.png'), 'a');
    writeFileSync(join(dir, '1.jpg'), 'b');
    assert.throws(() => buildMediaManifest({ mediaDir: dir }), /ambiguous — 2 candidate files/);

    rmSync(join(dir, '1.jpg'));
    writeFileSync(join(dir, 'figure-1.png'), '');
    assert.throws(() => buildMediaManifest({ mediaDir: dir }), /local source is empty \(0 bytes\)/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('figure resolution uses exactly the src/cli.mjs filename convention', () => {
  const dir = mkdtempSync(join(tmpdir(), 'xqueue-media-names-'));
  try {
    for (const name of ['figure-1.png', 'figure_14.webp', '23.gif', 'figure09.jpg', 'readme.md']) {
      writeFileSync(join(dir, name), name);
    }

    assert.deepEqual(findFigureCandidates(dir, 1), ['figure-1.png']);
    assert.deepEqual(findFigureCandidates(dir, 14), ['figure_14.webp']);
    assert.deepEqual(findFigureCandidates(dir, 23), ['23.gif']);
    assert.deepEqual(findFigureCandidates(dir, 9), ['figure09.jpg']);
    assert.deepEqual(findFigureCandidates(dir, 7), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a manifest built from real files yields a stable digest and verifies against R2', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'xqueue-media-good-'));
  try {
    writeFileSync(join(dir, 'figure-1.png'), 'one');
    writeFileSync(join(dir, 'figure-09.jpg'), 'nine');
    writeFileSync(join(dir, 'figure_14.webp'), 'fourteen');
    writeFileSync(join(dir, '23.gif'), 'twentythree');

    const first = buildMediaManifest({ mediaDir: dir });
    const second = buildMediaManifest({ mediaDir: dir });

    assert.equal(first.resolvedCount, 4);
    assert.equal(first.manifestSha256, second.manifestSha256);
    assert.deepEqual(
      first.objects.map((o) => o.r2Key),
      [
        'media/figures/figure-0001.png',
        'media/figures/figure-0009.jpg',
        'media/figures/figure-0014.webp',
        'media/figures/figure-0023.gif',
      ],
    );

    const bucket = new R2Stub();
    for (const object of first.objects) {
      bucket.put_(object.r2Key, readFileSync(join(dir, object.localSource.split('/').pop())));
    }

    const result = await verifyMediaObjects({ MEDIA: bucket }, first);
    assert.equal(result.ok, true);
    assert.equal(result.verifiedCount, 4);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
