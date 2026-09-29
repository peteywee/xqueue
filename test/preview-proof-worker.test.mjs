import { createPreviewProofWorker } from '../cloudflare/src/preview-proof-worker.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

function text(path) {
  return readFileSync(new URL('../' + path, import.meta.url), 'utf8');
}

function jsonc(path) {
  return JSON.parse(text(path).replace(/^\s*\/\/.*$/gm, ''));
}

test('preview proof Worker is a read-only unscheduled role with preview D1 and shared R2', () => {
  const config = jsonc('wrangler.preview-proof.jsonc');
  assert.equal(config.name, 'xqueue-preview-proof');
  assert.equal(config.main, 'cloudflare/src/preview-proof-worker.mjs');
  assert.equal(config.triggers, undefined);
  assert.equal(config.vars?.XQUEUE_PUBLISH_AUTHORITY, undefined);
  assert.equal(config.d1_databases?.[0]?.database_name, 'xqueue-preview');
  assert.equal(config.d1_databases?.[0]?.database_id, 'f5f9bea9-e88c-41ab-9407-70356079a638');
  assert.equal(config.r2_buckets?.[0]?.bucket_name, 'xqueue-media');
});

test('preview proof Worker cannot schedule or reach publication code', () => {
  const source = text('cloudflare/src/preview-proof-worker.mjs');
  assert.match(source, /async fetch\s*\(/);
  assert.doesNotMatch(source, /\bscheduled\s*\(/);
  assert.doesNotMatch(source, /production-publisher|publisher-worker|@xdevplatform/);
  assert.doesNotMatch(source, /X_API_KEY|X_API_SECRET|X_ACCESS_TOKEN|X_ACCESS_SECRET/);
  assert.doesNotMatch(source, /\.put\(|\.delete\(/);
  assert.match(source, /env\.MEDIA\.get\(/);
  assert.match(source, /crypto\.subtle\.digest\('SHA-256'/);
});

test('preview runtime proof no longer shells out to raw R2 object API', () => {
  const source = text('scripts/preview-dynamic-runtime-proof.mjs');
  assert.equal(source.includes("'r2',\n        'object',\n        'get'"), false);
  assert.equal(source.includes('"r2",\n        "object",\n        "get"'), false);
  assert.match(source, /http:\/\/127\.0\.0\.1:8787\/proof/);
  assert.match(source, /preview-proof-worker-r2-binding/);
});

test('preview workflow runs proof role only as an ephemeral remote-dev session', () => {
  const source = text('.github/workflows/preview-dynamic-runtime.yml');
  assert.match(source, /wrangler dev --remote --config wrangler\.preview-proof\.jsonc --port 8787/);
  assert.match(source, /XQUEUE_PREVIEW_PROOF_URL=http:\/\/127\.0\.0\.1:8787\/proof/);
  assert.doesNotMatch(source, /wrangler deploy --config wrangler\.preview-proof\.jsonc/);
  assert.match(source, /trap cleanup EXIT/);
});


function runtimeFixture() {
  return {
    ok: true,
    reason: null,
    generation: 3,
    revisionDigest: 'a'.repeat(64),
    activeAssignmentCount: 181,
    approvedUnscheduledCount: 0,
    deferredCount: 9,
    mediaRequiredCount: 1,
    mediaReadyCount: 1,
    media: {
      ok: true,
      requiredCount: 1,
      verifiedCount: 1,
      failures: [],
      objects: [
        {
          r2Key: 'media/figures/figure-0001.png',
          expected: {
            byteSize: 4,
            sha256: 'b'.repeat(64),
          },
        },
      ],
    },
    snapshot: {
      secretQueuedContent: 'must never be returned',
    },
  };
}

function proofEnv(body = new Uint8Array([1, 2, 3, 4]).buffer) {
  return {
    MEDIA: {
      async get() {
        if (body === null) return null;
        return {
          async arrayBuffer() {
            return body;
          },
        };
      },
    },
  };
}

test('proof fetch returns only read-only integrity metadata on success', async () => {
  const worker = createPreviewProofWorker({
    verifyRuntime: async () => runtimeFixture(),
    hashBytes: async () => 'b'.repeat(64),
  });
  const response = await worker.fetch(
    new Request('https://proof.local/proof'),
    proofEnv(),
  );
  assert.equal(response.status, 200);
  const body = await response.json();

  assert.equal(body.status, 'ok');
  assert.equal(body.role, 'read-only-proof');
  assert.equal(body.publicationCapable, false);
  assert.equal(body.schedulerAuthority, false);
  assert.equal(body.dynamicRuntime.generation, 3);
  assert.equal(body.mediaBodyProof.ok, true);
  assert.equal(body.mediaBodyProof.bodyObservedCount, 1);
  assert.equal(JSON.stringify(body).includes('secretQueuedContent'), false);
  assert.equal(JSON.stringify(body).includes('must never be returned'), false);
});

test('proof fetch fails closed on missing media and hash mismatch', async () => {
  const missingWorker = createPreviewProofWorker({
    verifyRuntime: async () => runtimeFixture(),
    hashBytes: async () => 'b'.repeat(64),
  });
  const missingResponse = await missingWorker.fetch(
    new Request('https://proof.local/proof'),
    proofEnv(null),
  );
  assert.equal(missingResponse.status, 503);
  const missing = await missingResponse.json();
  assert.equal(missing.mediaBodyProof.ok, false);
  assert.equal(missing.mediaBodyProof.reason, 'media_missing');

  const mismatchWorker = createPreviewProofWorker({
    verifyRuntime: async () => runtimeFixture(),
    hashBytes: async () => 'c'.repeat(64),
  });
  const mismatchResponse = await mismatchWorker.fetch(
    new Request('https://proof.local/proof'),
    proofEnv(),
  );
  assert.equal(mismatchResponse.status, 503);
  const mismatch = await mismatchResponse.json();
  assert.equal(mismatch.mediaBodyProof.ok, false);
  assert.equal(mismatch.mediaBodyProof.reason, 'hash_mismatch');
});

test('proof fetch fails closed on runtime verification failure and hides storage work', async () => {
  let gets = 0;
  const worker = createPreviewProofWorker({
    verifyRuntime: async () => ({ ok: false, reason: 'runtime_revision_digest_mismatch' }),
  });
  const response = await worker.fetch(
    new Request('https://proof.local/proof'),
    {
      MEDIA: {
        async get() {
          gets += 1;
          return null;
        },
      },
    },
  );
  assert.equal(response.status, 503);
  assert.equal(gets, 0);
  const body = await response.json();
  assert.equal(body.status, 'error');
  assert.equal(body.dynamicRuntime.reason, 'runtime_revision_digest_mismatch');
  assert.equal(body.mediaBodyProof, null);
});

test('proof fetch exposes no alternate route', async () => {
  const worker = createPreviewProofWorker({
    verifyRuntime: async () => {
      throw new Error('should not run');
    },
  });
  const response = await worker.fetch(
    new Request('https://proof.local/anything-else'),
    proofEnv(),
  );
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: 'not_found' });
});
