import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
  PREVIEW,
  PRODUCTION,
  WATCHDOG,
  parseStrictJsonConfig,
  validatePreviewConfig,
  validateProductionConfig,
  validateWatchdogConfig,
  verifyRepositoryEnvironmentConfigs,
} from '../scripts/verify-environment-config.mjs';

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

const production = parseStrictJsonConfig(
  fs.readFileSync(new URL('../wrangler.authority.jsonc', import.meta.url), 'utf8'),
  'wrangler.authority.jsonc',
);

const preview = parseStrictJsonConfig(
  fs.readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8'),
  'wrangler.jsonc',
);

const watchdog = parseStrictJsonConfig(
  fs.readFileSync(new URL('../wrangler.watchdog.jsonc', import.meta.url), 'utf8'),
  'wrangler.watchdog.jsonc',
);

test('repository environment configs are structurally isolated', () => {
  const result = verifyRepositoryEnvironmentConfigs(
    new URL('..', import.meta.url).pathname,
  );

  assert.equal(result.ok, true);
  assert.equal(result.production.databaseId, PRODUCTION.databaseId);
  assert.equal(result.preview.databaseId, PREVIEW.databaseId);
  assert.equal(result.watchdog.worker, WATCHDOG.workerName);
  assert.equal(result.watchdog.publicationCapability, false);
});

test('production config accepts the pinned production-only shape', () => {
  assert.equal(validateProductionConfig(production), true);
});

test('preview config accepts the pinned preview-only inert shape', () => {
  assert.equal(validatePreviewConfig(preview), true);
});

test('watchdog config accepts production D1 read/write metadata with no publication surface', () => {
  assert.equal(validateWatchdogConfig(watchdog), true);
  assert.equal('r2_buckets' in watchdog, false);
});

test('production config rejects preview_database_id even when production database_id is correct', () => {
  const hostile = clone(production);
  hostile.d1_databases[0].preview_database_id = PREVIEW.databaseId;

  assert.throws(
    () => validateProductionConfig(hostile),
    /must not contain preview_database_id/,
  );
});

test('production config rejects the preview D1 as its database_id', () => {
  const hostile = clone(production);
  hostile.d1_databases[0].database_id = PREVIEW.databaseId;

  assert.throws(
    () => validateProductionConfig(hostile),
    /production DB id does not match/,
  );
});

test('production config rejects missing publication cron', () => {
  const hostile = clone(production);
  hostile.triggers.crons = [];

  assert.throws(
    () => validateProductionConfig(hostile),
    /must define exactly one cron/,
  );
});

test('preview config rejects production D1 identity', () => {
  const hostile = clone(preview);
  hostile.d1_databases[0].database_name = PRODUCTION.databaseName;
  hostile.d1_databases[0].database_id = PRODUCTION.databaseId;

  assert.throws(
    () => validatePreviewConfig(hostile),
    /preview DB name must be|preview DB id does not match|production D1 identity/,
  );
});

test('preview config rejects publication cron registration', () => {
  const hostile = clone(preview);
  hostile.triggers.crons = [PRODUCTION.cron];

  assert.throws(
    () => validatePreviewConfig(hostile),
    /preview config must not register publication cron triggers/,
  );
});

test('watchdog config rejects R2 media capability', () => {
  const hostile = clone(watchdog);
  hostile.r2_buckets = [{ binding: 'MEDIA', bucket_name: 'xqueue-media' }];

  assert.throws(
    () => validateWatchdogConfig(hostile),
    /must not bind R2 publication media/,
  );
});

test('watchdog config rejects publication authority or X credential names', () => {
  for (const secret of [
    'XQUEUE_PUBLISH_AUTHORITY',
    'X_API_KEY',
    'X_API_SECRET',
    'X_ACCESS_TOKEN',
    'X_ACCESS_SECRET',
  ]) {
    const hostile = clone(watchdog);
    hostile.vars = { [secret]: 'forbidden' };
    assert.throws(
      () => validateWatchdogConfig(hostile),
      /forbidden publication capability/,
    );
  }
});

test('watchdog config rejects the publication Worker module', () => {
  const hostile = clone(watchdog);
  hostile.main = 'cloudflare/src/worker.mjs';

  assert.throws(
    () => validateWatchdogConfig(hostile),
    /watchdog main must be/,
  );
});

test('strict parser fails closed rather than guessing JSONC semantics', () => {
  assert.throws(
    () => parseStrictJsonConfig('{ // ambiguous\n "name": "x"\n}', 'fixture'),
    /must remain strict JSON-compatible JSONC/,
  );
});
