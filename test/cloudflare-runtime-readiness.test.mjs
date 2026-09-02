import test from 'node:test';
import assert from 'node:assert/strict';

import { manifestSha256 } from '../scripts/build-media-manifest.mjs';
import {
  renderWorkerManifest,
  sanitizeManifest,
} from '../scripts/build-cloudflare-media-manifest.mjs';
import { decodeBundledQueue } from '../cloudflare/src/queue-integrity.mjs';
import {
  evaluateAuthorityReadiness,
  readMirroredLedger,
} from '../cloudflare/src/runtime-readiness.mjs';
import worker from '../cloudflare/src/worker.mjs';

function fullyResolvedLedger() {
  const posted = {};
  for (const post of decodeBundledQueue()) {
    posted[post.id] = {
      tweetId: `test-${post.id}`,
      at: '2026-09-02T00:00:00.000Z',
    };
  }

  return {
    version: 1,
    posted,
    skipped: {},
    spend: 0,
    inflight: null,
  };
}

function readinessDb(ledger = fullyResolvedLedger()) {
  return {
    prepare(sql) {
      if (/sqlite_master/.test(sql)) {
        return {
          async first() {
            return { count: 8 };
          },
        };
      }

      if (/runtime_metadata/.test(sql) && /state\.snapshot_json/.test(sql)) {
        return {
          async first() {
            return { value: JSON.stringify(ledger) };
          },
        };
      }

      if (/FROM\s+publication_leases/i.test(sql)) {
        return {
          async first() {
            return null;
          },
        };
      }

      if (/FROM\s+runtime_metadata/i.test(sql)) {
        return {
          bind() {
            return this;
          },
          async all() {
            return {
              results: [
                {
                  key: 'queue.sha256',
                  value: '09c36e24207d7720c46d163b83b9cee9465e6ded36221499032c0acee218bbc1',
                },
                { key: 'queue.count', value: '180' },
              ],
            };
          },
        };
      }

      throw new Error(`unexpected SQL in readiness test: ${sql}`);
    },
  };
}

test('mirrored ledger read is exact JSON evidence and never mutates D1', async () => {
  const ledger = fullyResolvedLedger();
  const result = await readMirroredLedger({ DB: readinessDb(ledger) });

  assert.equal(result.ok, true);
  assert.deepEqual(result.ledger, ledger);
});

test('authority readiness stays unauthorized and fails closed until real media evidence is generated', async () => {
  const result = await evaluateAuthorityReadiness(
    {
      DB: readinessDb(),
      MEDIA: {},
    },
    { now: new Date('2026-09-02T12:00:00.000Z') },
  );

  assert.equal(result.authorized, false);
  assert.equal(result.readOnly, true);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'authority_readiness_incomplete');
  assert.equal(result.gates.mirroredLedger, true);
  assert.equal(result.gates.eligibility, true);
  assert.equal(result.gates.leaseSchema, true);
  assert.equal(result.gates.media, false);
  assert.equal(result.media.reason, 'media_manifest_not_configured');
});

test('Worker health exposes readiness without converting it into authority', async () => {
  const env = {
    DB: readinessDb(),
    MEDIA: {
      async list() {
        return { objects: [] };
      },
    },
  };

  const response = await worker.fetch(new Request('https://x/health'), env);
  assert.equal(response.status, 200);

  const body = await response.json();
  assert.equal(body.status, 'ok');
  assert.equal(body.queueIntegrity.ok, true);
  assert.equal(body.authorityReadiness.authorized, false);
  assert.equal(body.authorityReadiness.ok, false);
  assert.equal(body.livePublication, false);
  assert.equal(body.schedulerAuthority, false);
});

test('Worker media manifest generator strips local paths and pins the canonical four objects', () => {
  const objects = [
    ['D1', 1],
    ['A4', 9],
    ['A1', 14],
    ['C1', 23],
  ].map(([postId, figure]) => {
    const logicalMediaId = `figure-${String(figure).padStart(4, '0')}`;
    return {
      postId,
      figure,
      logicalMediaId,
      localSource: `/private/local/path/${logicalMediaId}.png`,
      extension: 'png',
      r2Key: `media/figures/${logicalMediaId}.png`,
      byteSize: 10 + figure,
      sha256: String(figure).padStart(64, '0'),
    };
  });

  const manifest = {
    format: 1,
    objects,
    manifestSha256: manifestSha256(objects),
  };

  const sanitized = sanitizeManifest(manifest);
  assert.equal(sanitized.objects.length, 4);
  assert.equal('localSource' in sanitized.objects[0], false);
  assert.equal(sanitized.manifestSha256, manifest.manifestSha256);

  const source = renderWorkerManifest(manifest);
  assert.match(source, /MEDIA_MANIFEST_CONFIGURED = true/);
  assert.equal(source.includes('/private/local/path/'), false);
  assert.equal(source.includes('figure-0023.png'), true);
});
