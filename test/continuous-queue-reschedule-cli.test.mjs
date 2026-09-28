import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

function text(path) {
  return readFileSync(new URL('../' + path, import.meta.url), 'utf8');
}

test('replacement scheduling supports guarded production while remaining dry-run by default', () => {
  const source = text('scripts/continuous-queue-reschedule.mjs');

  assert.match(source, /database: 'xqueue-preview'/);
  assert.match(source, /config: 'wrangler\.preview\.jsonc'/);
  assert.match(source, /database: 'xqueue-production'/);
  assert.match(source, /config: 'wrangler\.status\.jsonc'/);
  assert.match(source, /if \(!flag\('apply'\)\)/);
  assert.match(source, /readProductionMutationGuard/);
  assert.match(source, /ProductionControlSession/);
  assert.match(source, /xqueue-production-queue-mutation/);
  assert.doesNotMatch(source, /--apply[^)]*true/);
});

test('replacement scheduling uses preview transaction or production D1 batch with exact runtime guards', () => {
  const source = text('scripts/continuous-queue-reschedule.mjs');

  assert.match(source, /BEGIN IMMEDIATE;/);
  assert.match(source, /PRODUCTION_CONTROL\.batch\('deferred-replacement'/);
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
