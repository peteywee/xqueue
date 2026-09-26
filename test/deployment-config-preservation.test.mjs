import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PRODUCTION_DB_ID = 'fc85026e-bfc8-435f-8bb0-c60e139178a3';
const PREVIEW_DB_ID = 'f5f9bea9-e88c-41ab-9407-70356079a638';

function readJsonc(relativePath) {
  const raw = fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
  return JSON.parse(raw.replace(/^\s*\/\/.*$/gm, ''));
}

function declaresSchedulerMutation(config) {
  return Object.prototype.hasOwnProperty.call(config, 'triggers');
}

test('legacy Workers Builds descriptor remains frozen until #46 activation', () => {
  const config = readJsonc('wrangler.jsonc');

  assert.equal(config.name, 'xqueue-production');
  assert.equal(config.main, 'cloudflare/src/worker.mjs');
  assert.equal(declaresSchedulerMutation(config), false);
  assert.equal(config.d1_databases?.[0]?.database_id, PRODUCTION_DB_ID);
  assert.equal(config.d1_databases?.[0]?.database_name, 'xqueue-production');
});

test('target status deployment is production identity, status-only entrypoint, and scheduler-free', () => {
  const config = readJsonc('wrangler.status.jsonc');

  assert.equal(config.name, 'xqueue-production');
  assert.equal(config.main, 'cloudflare/src/status-worker.mjs');
  assert.equal(declaresSchedulerMutation(config), true);
  assert.deepEqual(config.triggers?.crons, []);
  assert.equal(config.d1_databases?.[0]?.database_id, PRODUCTION_DB_ID);
  assert.equal(config.d1_databases?.[0]?.database_name, 'xqueue-production');
  assert.equal(config.d1_databases?.[0]?.preview_database_id, undefined);
});

test('inert publisher deployment is a separate Worker with no scheduler', () => {
  const config = readJsonc('wrangler.publisher.jsonc');

  assert.equal(config.name, 'xqueue-publisher-production');
  assert.equal(config.main, 'cloudflare/src/publisher-worker.mjs');
  assert.equal(declaresSchedulerMutation(config), false);
  assert.equal(config.vars?.XQUEUE_PUBLISH_AUTHORITY, 'disabled');
  assert.equal(config.d1_databases?.[0]?.database_id, PRODUCTION_DB_ID);
  assert.equal(config.d1_databases?.[0]?.database_name, 'xqueue-production');
  assert.equal(config.d1_databases?.[0]?.preview_database_id, undefined);
});

test('authority deployment targets only publisher Worker and pins one 15-minute cron', () => {
  const config = readJsonc('wrangler.authority.jsonc');

  assert.equal(config.name, 'xqueue-publisher-production');
  assert.equal(config.main, 'cloudflare/src/publisher-worker.mjs');
  assert.deepEqual(config.triggers?.crons, ['*/15 * * * *']);
  assert.equal(config.vars?.XQUEUE_PUBLISH_AUTHORITY, 'enabled');
  assert.equal(
    config.d1_databases?.[0]?.migrations_dir,
    'cloudflare/migrations-production',
  );
  assert.equal(config.d1_databases?.[0]?.database_id, PRODUCTION_DB_ID);
  assert.equal(config.d1_databases?.[0]?.database_name, 'xqueue-production');
  assert.equal(config.d1_databases?.[0]?.preview_database_id, undefined);
});

test('status and publisher roles share storage but not deployment identity or entrypoint', () => {
  const status = readJsonc('wrangler.status.jsonc');
  const publisher = readJsonc('wrangler.publisher.jsonc');
  const authority = readJsonc('wrangler.authority.jsonc');

  assert.notEqual(status.name, publisher.name);
  assert.notEqual(status.main, publisher.main);
  assert.equal(publisher.name, authority.name);
  assert.equal(publisher.main, authority.main);
  assert.equal(
    status.d1_databases?.[0]?.database_id,
    publisher.d1_databases?.[0]?.database_id,
  );
  assert.equal(
    status.r2_buckets?.[0]?.bucket_name,
    publisher.r2_buckets?.[0]?.bucket_name,
  );
});

test('explicit preview config remains isolated from all production topology configs', () => {
  const preview = readJsonc('wrangler.preview.jsonc');
  const production = [
    readJsonc('wrangler.jsonc'),
    readJsonc('wrangler.status.jsonc'),
    readJsonc('wrangler.publisher.jsonc'),
    readJsonc('wrangler.authority.jsonc'),
  ];

  assert.equal(preview.name, 'xqueue-preview');
  assert.equal(declaresSchedulerMutation(preview), false);
  assert.equal(preview.d1_databases?.[0]?.database_id, PREVIEW_DB_ID);
  assert.equal(preview.d1_databases?.[0]?.database_name, 'xqueue-preview');

  for (const config of production) {
    assert.equal(JSON.stringify(config).includes(PREVIEW_DB_ID), false);
  }
  assert.equal(JSON.stringify(preview).includes(PRODUCTION_DB_ID), false);
});

test('empty cron declarations remain destructive authority mutations', () => {
  const omitted = { name: 'xqueue-production' };
  const destructiveEmpty = {
    name: 'xqueue-production',
    triggers: { crons: [] },
  };

  assert.equal(declaresSchedulerMutation(omitted), false);
  assert.equal(declaresSchedulerMutation(destructiveEmpty), true);
});
