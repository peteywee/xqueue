import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

function text(path) {
  return readFileSync(new URL('../' + path, import.meta.url), 'utf8');
}

test('owner command supports preview plus explicitly guarded production target', () => {
  const source = text('scripts/continuous-queue-owner-ops.mjs');

  assert.match(source, /database: 'xqueue-preview'/);
  assert.match(source, /config: 'wrangler\.preview\.jsonc'/);
  assert.match(source, /database: 'xqueue-production'/);
  assert.match(source, /config: 'wrangler\.status\.jsonc'/);
  assert.match(source, /readProductionMutationGuard/);
  assert.match(source, /ProductionControlSession/);
  assert.match(source, /--expected-halt-generation/);
  assert.match(source, /xqueue-production-queue-mutation/);
  assert.doesNotMatch(source, /production mutation control plane is tracked by #145/);
});

test('owner command is dry-run by default and production mutation requires explicit apply', () => {
  const source = text('scripts/continuous-queue-owner-ops.mjs');

  assert.match(source, /const apply = flag\('apply'\)/);
  assert.match(source, /if \(!apply\)/);
  assert.match(source, /mode: 'dry-run'/);
  assert.doesNotMatch(source, /apply = true/);
});

test('preview owner operations retain immediate transaction while production uses D1 batch bridge', () => {
  const source = text('scripts/continuous-queue-owner-ops.mjs');

  assert.match(source, /BEGIN IMMEDIATE;/);
  assert.match(source, /PRODUCTION_CONTROL\.batch\('owner-operation'/);
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
