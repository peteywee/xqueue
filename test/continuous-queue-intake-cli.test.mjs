import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

function text(path) {
  return readFileSync(new URL('../' + path, import.meta.url), 'utf8');
}

test('intake supports canonical production reads and guarded production apply', () => {
  const source = text('scripts/continuous-queue-intake.mjs');

  assert.match(source, /database: 'xqueue-preview'/);
  assert.match(source, /database: 'xqueue-production'/);
  assert.match(source, /wrangler\.status\.jsonc/);
  assert.match(source, /readProductionMutationGuard/);
  assert.match(source, /ProductionControlSession/);
  assert.match(source, /xqueue-production-queue-mutation/);
  assert.match(source, /--expected-halt-generation/);
});

test('production intake preserves durable staged replay protocol instead of one giant inferred mutation', () => {
  const source = text('scripts/continuous-queue-intake.mjs');
  const core = text('src/continuous-queue-intake.mjs');

  assert.match(source, /PRODUCTION_CONTROL\.batch\('intake-phase'/);
  assert.match(core, /A lost response is not permission to repeat\. Read back first\./);
  assert.match(core, /Ambiguous CAS: inspect the durable frontier before deciding/);
  assert.match(core, /exact replay may resume after readback/);
  assert.match(core, /runtime revision commit is ambiguous or conflicts with the intake plan/);
});

test('intake remains dry-run by default', () => {
  const source = text('scripts/continuous-queue-intake.mjs');

  assert.match(source, /const apply = flag\('apply'\)/);
  assert.match(source, /if \(!apply\)/);
  assert.match(source, /mode: 'dry-run'/);
});
