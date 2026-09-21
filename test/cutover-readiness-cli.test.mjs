import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

function text(path) {
  return readFileSync(new URL('../' + path, import.meta.url), 'utf8');
}

test('production cutover readiness probe is hard-pinned read-only', () => {
  const source = text('scripts/production-cutover-readiness.mjs');

  assert.match(source, /PRODUCTION_DB = 'xqueue-production'/);
  assert.match(source, /PRODUCTION_CONFIG = 'wrangler\.jsonc'/);
  assert.match(source, /--command/);
  assert.doesNotMatch(source, /--file/);
  assert.doesNotMatch(source, /\b(?:INSERT|UPDATE|DELETE|REPLACE|ALTER|DROP|CREATE)\b/);
  assert.doesNotMatch(source, /wrangler\s+deploy/);
  assert.doesNotMatch(source, /post:live|createPostViaClient|uploadMedia/);
});

test('cutover readiness workflow uploads evidence even when the gate is blocked', () => {
  const source = text('.github/workflows/production-cutover-readiness.yml');

  assert.match(source, /Production Cutover Readiness/);
  assert.match(source, /pnpm cutover:readiness/);
  assert.match(source, /if: \$\{\{ always\(\) \}\}/);
  assert.match(source, /xqueue-production-cutover-readiness/);
  assert.doesNotMatch(source, /wrangler deploy/);
  assert.doesNotMatch(source, /preview:intake:migrate/);
});

test('cutover readiness workflow is an observer, not an authority lane', () => {
  const source = text('.github/workflows/production-cutover-readiness.yml');

  assert.match(source, /permissions:\s*\n\s*contents: read/);
  assert.doesNotMatch(source, /XQUEUE_PUBLICATION_AUTHORITY/);
  assert.doesNotMatch(source, /halt:clear|halt:set/);
  assert.doesNotMatch(source, /post:live/);
});
