// cloudflare-production-publisher-media.test.mjs — the publisher's own media gate.
//
// media-verify.mjs pins a TRUST ASSUMPTION: when R2 asserts a checksum, the verifier believes it
// without reading the bytes (see cloudflare-media-adversarial.test.mjs). The compensating control
// is prepareSelectedMedia in production-publisher.mjs, which re-reads the body and re-checks its
// size and SHA-256 against the D1-bound manifest before any byte can be uploaded to X. These tests
// execute that control directly. The bucket fakes expose only the read surface.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { productionPublisherInternals } from '../cloudflare/src/production-publisher.mjs';

const { prepareSelectedMedia } = productionPublisherInternals;

const sha256Hex = (bytes) => createHash('sha256').update(bytes).digest('hex');

const HONEST = Buffer.from('the-real-figure-bytes', 'utf8');
const IMPOSTOR = Buffer.from('TOTALLY-DIFFERENT-!!!', 'utf8'); // deliberately the same length

const POST = Object.freeze({ id: 'D1', figure: 1, contentRevision: 3 });

function bufferToArrayBuffer(buffer) {
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
}

function mediaRow(overrides = {}) {
  return {
    content_id: 'D1',
    content_revision: 3,
    figure: 1,
    status: 'ready',
    logical_media_id: 'figure-0001',
    r2_key: 'media/figures/figure-0001.png',
    extension: 'png',
    mime_type: 'image/png',
    byte_size: HONEST.length,
    sha256: sha256Hex(HONEST),
    ...overrides,
  };
}

function snapshot(rows = [mediaRow()]) {
  return { media: rows };
}

/** A bucket that answers what the test tells it to, including lies. No write API exists. */
function scriptedBucket({ head = 'honest', body = HONEST } = {}) {
  const calls = [];
  const honestHead = (key) => ({
    key,
    size: HONEST.length,
    checksums: { sha256: sha256Hex(HONEST) },
    httpMetadata: { contentType: 'image/png' },
  });
  return {
    calls,
    async head(key) {
      calls.push('head');
      if (head === 'honest') return honestHead(key);
      return typeof head === 'function' ? head(key, honestHead(key)) : head;
    },
    async get(key) {
      calls.push('get');
      if (body === null) return null;
      return { key, arrayBuffer: async () => bufferToArrayBuffer(body) };
    },
    async list() {
      calls.push('list');
      return { objects: [], truncated: false, cursor: null };
    },
  };
}

/** Any call fails the test: proves a refusal happened before R2 was touched. */
function untouchableBucket() {
  const fail = () => {
    throw new Error('R2 must not be read on this path');
  };
  return { head: fail, get: fail, list: fail };
}

test('a post without a figure needs no media and never touches R2', async () => {
  const result = await prepareSelectedMedia(
    { MEDIA: untouchableBucket() },
    { ...POST, figure: null },
    snapshot(),
  );

  assert.deepEqual(result, { ok: true, required: false, bytes: null, mediaObject: null });
});

test('a figure post without a dynamic media snapshot is refused', async () => {
  for (const runtimeSnapshot of [null, undefined, {}, { media: 'not-an-array' }]) {
    const result = await prepareSelectedMedia(
      { MEDIA: untouchableBucket() },
      POST,
      runtimeSnapshot,
    );
    assert.deepEqual(result, { ok: false, reason: 'dynamic_media_snapshot_unavailable' });
  }
});

test('media rows must bind exactly one ready row to the exact content, revision, and figure', async () => {
  const cases = [
    ['no rows', []],
    ['row not ready', [mediaRow({ status: 'pending' })]],
    ['stale content revision', [mediaRow({ content_revision: 2 })]],
    ['different figure', [mediaRow({ figure: 2 })]],
    ['different content', [mediaRow({ content_id: 'D2' })]],
    ['ambiguous: two matching rows', [mediaRow(), mediaRow()]],
  ];

  for (const [label, rows] of cases) {
    const result = await prepareSelectedMedia(
      { MEDIA: untouchableBucket() },
      POST,
      snapshot(rows),
    );
    assert.deepEqual(result, { ok: false, reason: 'selected_dynamic_media_mismatch' }, label);
  }
});

test('a verifier failure is surfaced with its per-object reason', async () => {
  const missing = await prepareSelectedMedia(
    { MEDIA: scriptedBucket({ head: null }) },
    POST,
    snapshot(),
  );
  assert.deepEqual(missing, { ok: false, reason: 'missing' });

  const wrongMime = await prepareSelectedMedia(
    {
      MEDIA: scriptedBucket({
        head: (key, honest) => ({ ...honest, httpMetadata: { contentType: 'image/gif' } }),
      }),
    },
    POST,
    snapshot(),
  );
  assert.deepEqual(wrongMime, { ok: false, reason: 'mime_mismatch' });
});

test('bytes that differ from an R2-asserted checksum are caught by the body re-hash', async () => {
  // The bucket asserts the honest size and SHA-256 but holds different bytes of the same length.
  // The verifier trusts the asserted checksum (pinned elsewhere); the publisher must not.
  const bucket = scriptedBucket({ body: IMPOSTOR });
  const result = await prepareSelectedMedia({ MEDIA: bucket }, POST, snapshot());

  assert.deepEqual(result, { ok: false, reason: 'media_body_hash_mismatch' });
  assert.equal('bytes' in result, false, 'no bytes are handed on for upload');
  assert.equal(bucket.calls.filter((call) => call === 'get').length, 1, 'the body was actually read');
});

test('a body whose length differs from the manifest is refused before hashing', async () => {
  const result = await prepareSelectedMedia(
    { MEDIA: scriptedBucket({ body: Buffer.concat([HONEST, Buffer.from('+')]) }) },
    POST,
    snapshot(),
  );

  assert.deepEqual(result, { ok: false, reason: 'media_body_size_mismatch' });
});

test('an object that verifies by head but has no readable body is refused', async () => {
  const result = await prepareSelectedMedia(
    { MEDIA: scriptedBucket({ body: null }) },
    POST,
    snapshot(),
  );

  assert.deepEqual(result, { ok: false, reason: 'media_body_missing' });
});

test('honest bytes are returned exactly, bound to the manifest object', async () => {
  const result = await prepareSelectedMedia(
    { MEDIA: scriptedBucket() },
    POST,
    snapshot(),
  );

  assert.equal(result.ok, true);
  assert.equal(result.required, true);
  assert.ok(result.bytes instanceof Uint8Array);
  assert.deepEqual(Buffer.from(result.bytes), HONEST);
  assert.equal(result.mediaObject.r2Key, 'media/figures/figure-0001.png');
  assert.equal(result.mediaObject.sha256, sha256Hex(HONEST));
  assert.equal(result.mediaObject.byteSize, HONEST.length);
});
