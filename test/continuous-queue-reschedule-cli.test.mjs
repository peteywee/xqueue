import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

function text(path) {
  return readFileSync(new URL('../' + path, import.meta.url), 'utf8');
}

test('replacement scheduling command is preview-only and dry-run by default', () => {
  const source = text('scripts/continuous-queue-reschedule.mjs');

  assert.match(source, /const PREVIEW_DB = 'xqueue-preview'/);
  assert.match(source, /const PREVIEW_CONFIG = 'wrangler\.preview\.jsonc'/);
  assert.match(
    source,
    /replacement scheduling is hard-pinned to preview until dynamic cutover/,
  );
  assert.match(source, /if \(!flag\('apply'\)\)/);
  assert.doesNotMatch(source, /xqueue-production/);
  assert.doesNotMatch(source, /--apply[^)]*true/);
});

test('replacement scheduling command uses one immediate transaction and exact runtime guard', () => {
  const source = text('scripts/continuous-queue-reschedule.mjs');

  assert.match(source, /BEGIN IMMEDIATE;/);
  assert.match(source, /renderReplacementFrontierClaimSql/);
  assert.match(source, /renderReplacementSuccessGuardSql/);
  assert.match(source, /renderRuntimeRevisionInsertSql/);
  assert.match(source, /renderReplacementFrontierReleaseSql/);
  assert.match(source, /classifyReplacementReadback/);
});

test('package scripts expose automatic and owner placement separately', () => {
  const pkg = JSON.parse(text('package.json'));

  assert.equal(
    pkg.scripts['queue:reschedule'],
    'node scripts/continuous-queue-reschedule.mjs --mode automatic',
  );
  assert.equal(
    pkg.scripts['queue:place'],
    'node scripts/continuous-queue-reschedule.mjs --mode owner',
  );
});
