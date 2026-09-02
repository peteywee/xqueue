import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import {
  BUCKET,
  downloadCommand,
  verifyRemoteBytes,
} from '../scripts/r2-media-upload.mjs';

const HONEST = Buffer.from('the-real-figure-bytes', 'utf8');
const IMPOSTOR = Buffer.from('TOTALLY-DIFFERENT-!!!', 'utf8');

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function object(overrides = {}) {
  return {
    r2Key: 'media/figures/figure-0001.png',
    byteSize: HONEST.length,
    sha256: sha256(HONEST),
    ...overrides,
  };
}

test('R2 readback command is read-only, exact-bucket, and never uses unsupported --info', () => {
  const destination = '/tmp/xqueue-r2-verification.bin';
  const argv = downloadCommand(object(), destination);

  assert.equal(BUCKET, 'xqueue-media');
  assert.deepEqual(argv.slice(0, 4), ['wrangler', 'r2', 'object', 'get']);
  assert.equal(argv[4], 'xqueue-media/media/figures/figure-0001.png');
  assert.equal(argv[5], '--file');
  assert.equal(argv[6], destination);
  assert.equal(argv[7], '--remote');
  assert.equal(argv.includes('--info'), false);

  for (const forbidden of ['put', 'delete', 'sync', 'prune']) {
    assert.equal(argv.includes(forbidden), false, `${forbidden} must not appear in readback argv`);
  }
});

test('remote byte verification requires exact size and SHA-256', () => {
  const expected = object();

  const good = verifyRemoteBytes(expected, HONEST);
  assert.equal(good.ok, true);
  assert.equal(good.reason, null);
  assert.equal(good.sizeMatch, true);
  assert.equal(good.hashMatch, true);

  const wrongHash = verifyRemoteBytes(expected, IMPOSTOR);
  assert.equal(IMPOSTOR.length, HONEST.length, 'fixture must isolate the hash gate');
  assert.equal(wrongHash.ok, false);
  assert.equal(wrongHash.reason, 'hash_mismatch');
  assert.equal(wrongHash.sizeMatch, true);
  assert.equal(wrongHash.hashMatch, false);

  const wrongSize = verifyRemoteBytes(expected, Buffer.from('short', 'utf8'));
  assert.equal(wrongSize.ok, false);
  assert.equal(wrongSize.reason, 'size_mismatch');
  assert.equal(wrongSize.sizeMatch, false);
});

test('hostile manifest key remains a single argv value under the fixed bucket prefix', () => {
  const hostile = object({ r2Key: '../../../other-bucket/x.png; rm -rf /' });
  const argv = downloadCommand(hostile, '/tmp/object.bin');

  assert.equal(argv[4], `xqueue-media/${hostile.r2Key}`);
  assert.ok(argv[4].startsWith('xqueue-media/'));
  assert.equal(argv.length, 8);
  assert.ok(argv.every((part) => typeof part === 'string'));
});
