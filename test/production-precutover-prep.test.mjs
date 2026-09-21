import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  CANONICAL_QUEUE_JSON,
  DECLARED_QUEUE_SHA256,
} from '../cloudflare/generated/queue-bundle.mjs';
import { decodeBundledQueue } from '../cloudflare/src/queue-integrity.mjs';

function text(path) {
  return readFileSync(new URL('../' + path, import.meta.url), 'utf8');
}

test('production prep candidate pins committed UTC on all 180 rows', () => {
  const queue = decodeBundledQueue();
  assert.equal(queue.length, 180);
  assert.equal(
    queue.filter((row) => typeof row.scheduledAt === 'string').length,
    180,
  );
  assert.equal(
    DECLARED_QUEUE_SHA256,
    '1f663cfada29a86ae861adc9f46918e8876b251c0d522517e67e3fdbed45ed7d',
  );
  assert.equal(JSON.parse(CANONICAL_QUEUE_JSON).length, 180);
});

test('prep config keeps the existing cron but disables publication authority', () => {
  const config = JSON.parse(text('wrangler.prep.jsonc'));
  assert.equal(config.name, 'xqueue-production');
  assert.equal(config.main, 'cloudflare/src/worker.mjs');
  assert.equal(config.vars.XQUEUE_PUBLISH_AUTHORITY, 'disabled');
  assert.deepEqual(config.triggers.crons, ['*/15 * * * *']);
  assert.equal(
    config.d1_databases[0].database_id,
    'fc85026e-bfc8-435f-8bb0-c60e139178a3',
  );
  assert.equal(
    config.d1_databases[0].migrations_dir,
    'cloudflare/migrations-production',
  );
});

test('production preparation workflow is manual-only and authority-disable precedes mutation', () => {
  const source = text('.github/workflows/production-precutover-preparation.yml');
  assert.match(source, /workflow_dispatch:/);
  assert.doesNotMatch(source, /\bpush:/);
  assert.match(source, /PREPARE_XQUEUE_PRODUCTION/);

  const deploy = source.indexOf('Deploy fail-closed UTC bundle with Cloudflare authority disabled');
  const inert = source.indexOf('Prove Cloudflare publication is inert before D1 mutation');
  const migrations = source.indexOf('Apply production continuous-queue and recovery schema');
  const seed = source.indexOf('Seed durable queue/runtime and activate committed UTC metadata');

  assert.ok(deploy >= 0 && inert > deploy && migrations > inert && seed > migrations);
  assert.match(source, /authorityFlag !== false/);
  assert.match(source, /livePublication !== false/);
  assert.match(source, /schedulerAuthority !== false/);
});

test('production prep runner requires explicit approval and never calls X', () => {
  const source = text('scripts/production-precutover-prepare.mjs');
  assert.match(source, /XQUEUE_PRODUCTION_PREP_APPROVED/);
  assert.match(source, /PREPARE_XQUEUE_PRODUCTION/);
  assert.match(source, /OLD_QUEUE_SHA/);
  assert.match(source, /unresolved publication attempt/);
  assert.match(source, /active publication lease/);
  assert.doesNotMatch(source, /@xdevplatform|createPostViaClient|uploadMediaBytesViaClient|api\.x\.com/);
});
