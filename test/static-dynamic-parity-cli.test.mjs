import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

function text(path) {
  return readFileSync(new URL('../' + path, import.meta.url), 'utf8');
}

test('live parity proof is preview-pinned and contains no D1 mutation command', () => {
  const source = text('scripts/preview-static-dynamic-parity.mjs');

  assert.match(source, /PREVIEW_CONFIG/);
  assert.match(source, /PREVIEW_DB/);
  assert.match(source, /assertPreviewConfig/);
  assert.doesNotMatch(source, /\b(?:INSERT|UPDATE|DELETE|REPLACE|ALTER|DROP)\b/);
  assert.doesNotMatch(source, /xqueue-production/);
  assert.doesNotMatch(source, /--file/);
});

test('parity workflow is downstream of successful recovery and read-only', () => {
  const source = text('.github/workflows/preview-static-dynamic-parity.yml');

  assert.match(source, /workflow_run:/);
  assert.match(source, /Preview D1 Recovery Proof/);
  assert.match(source, /workflow_run\.conclusion == 'success'/);
  assert.match(source, /workflow_run\.head_branch == 'main'/);
  assert.match(source, /xqueue-preview-parity-readonly/);
  assert.doesNotMatch(source, /preview:intake:migrate/);
  assert.doesNotMatch(source, /wrangler d1 migrations/);
});

test('cutover record preserves single authority and exact-version rollback safety', () => {
  const source = text('docs/recovery/static-dynamic-cutover-prep.md');

  assert.match(source, /#46 may not change publication authority/i);
  assert.match(source, /halt first/i);
  assert.match(source, /exactly one publication authority/i);
  assert.match(source, /never overwrites newer D1 evidence with an older backup/i);
  assert.match(source, /local\/static publisher is no longer a safe routine rollback authority/i);
  assert.match(source, /Cloudflare exact-version\s+rollback/i);
  assert.match(source, /verified D1\/R2 runtime truth/i);
});
