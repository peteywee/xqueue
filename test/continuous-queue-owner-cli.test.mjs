import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

function text(path) {
  return readFileSync(new URL('../' + path, import.meta.url), 'utf8');
}

test('owner command is hard-pinned to preview and has no production target path', () => {
  const source = text('scripts/continuous-queue-owner-ops.mjs');

  assert.match(source, /const PREVIEW_DB = 'xqueue-preview'/);
  assert.match(source, /const PREVIEW_CONFIG = 'wrangler\.preview\.jsonc'/);
  assert.match(
    source,
    /owner operations are hard-pinned to preview until dynamic cutover/,
  );
  assert.doesNotMatch(source, /xqueue-production/);
  assert.doesNotMatch(source, /fc85026e-bfc8-435f-8bb0-c60e139178a3/);
  assert.doesNotMatch(source, /wrangler\.jsonc/);
});

test('owner command is dry-run by default and requires explicit apply', () => {
  const source = text('scripts/continuous-queue-owner-ops.mjs');

  assert.match(source, /const apply = flag\('apply'\)/);
  assert.match(source, /if \(!apply\)/);
  assert.match(source, /mode: 'dry-run'/);
  assert.doesNotMatch(source, /apply = true/);
});

test('runtime-changing owner operations use one immediate transaction and exact promotion guard', () => {
  const source = text('scripts/continuous-queue-owner-ops.mjs');

  assert.match(source, /BEGIN IMMEDIATE;/);
  assert.match(source, /renderOwnerMutationSuccessGuardSql\(plan\)/);
  assert.match(source, /additionalGuardSql/);
  assert.match(source, /projectOwnerRuntimeRows/);
  assert.match(source, /buildDynamicRuntimeSnapshot/);
  assert.match(source, /source_operation_id/);
  assert.match(source, /remote runtime readback does not match promoted revision/);
});

test('package scripts expose explicit owner actions', () => {
  const pkg = JSON.parse(text('package.json'));

  assert.equal(
    pkg.scripts['queue:revise'],
    'node scripts/continuous-queue-owner-ops.mjs --action revise',
  );
  assert.equal(
    pkg.scripts['queue:rebind'],
    'node scripts/continuous-queue-owner-ops.mjs --action rebind',
  );
  assert.equal(
    pkg.scripts['queue:cancel'],
    'node scripts/continuous-queue-owner-ops.mjs --action cancel',
  );
});
