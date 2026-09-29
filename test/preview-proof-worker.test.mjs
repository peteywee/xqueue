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
