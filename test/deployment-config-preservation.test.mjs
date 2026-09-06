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

test('default Workers Builds config is production identity only and preserves scheduler authority', () => {
  const config = readJsonc('wrangler.jsonc');

  assert.equal(config.name, 'xqueue-production');
  assert.equal(declaresSchedulerMutation(config), false);
  assert.equal(config.d1_databases?.[0]?.database_id, PRODUCTION_DB_ID);
  assert.equal(config.d1_databases?.[0]?.database_name, 'xqueue-production');
  assert.equal(config.d1_databases?.[0]?.preview_database_id, undefined);
});

test('authority deployment is production-only and pins one 15-minute cron', () => {
  const config = readJsonc('wrangler.authority.jsonc');

  assert.equal(config.name, 'xqueue-production');
  assert.deepEqual(config.triggers?.crons, ['*/15 * * * *']);
  assert.equal(config.d1_databases?.[0]?.database_id, PRODUCTION_DB_ID);
  assert.equal(config.d1_databases?.[0]?.database_name, 'xqueue-production');
  assert.equal(config.d1_databases?.[0]?.preview_database_id, undefined);
});

test('explicit preview config is the only tracked preview D1 surface', () => {
  const preview = readJsonc('wrangler.preview.jsonc');

  assert.equal(preview.name, 'xqueue-preview');
  assert.equal(declaresSchedulerMutation(preview), false);
  assert.equal(preview.d1_databases?.[0]?.database_id, PREVIEW_DB_ID);
  assert.equal(preview.d1_databases?.[0]?.database_name, 'xqueue-preview');
  assert.equal(preview.d1_databases?.[0]?.preview_database_id, undefined);
});

test('ordinary and authority production configs identify the same production Worker/storage', () => {
  const normal = readJsonc('wrangler.jsonc');
  const authority = readJsonc('wrangler.authority.jsonc');

  assert.equal(normal.name, authority.name);
  assert.equal(normal.main, authority.main);
  assert.equal(normal.d1_databases?.[0]?.database_id, authority.d1_databases?.[0]?.database_id);
  assert.equal(normal.r2_buckets?.[0]?.bucket_name, authority.r2_buckets?.[0]?.bucket_name);
});

test('empty cron declarations are treated as destructive authority mutations', () => {
  const omitted = { name: 'xqueue-production' };
  const destructiveEmpty = {
    name: 'xqueue-production',
    triggers: { crons: [] },
  };

  assert.equal(declaresSchedulerMutation(omitted), false);
  assert.equal(declaresSchedulerMutation(destructiveEmpty), true);
});

test('cross-environment D1 identities cannot be reintroduced into production configs', () => {
  const normal = JSON.stringify(readJsonc('wrangler.jsonc'));
  const authority = JSON.stringify(readJsonc('wrangler.authority.jsonc'));
  const preview = JSON.stringify(readJsonc('wrangler.preview.jsonc'));

  assert.equal(normal.includes(PREVIEW_DB_ID), false);
  assert.equal(authority.includes(PREVIEW_DB_ID), false);
  assert.equal(preview.includes(PRODUCTION_DB_ID), false);
});
