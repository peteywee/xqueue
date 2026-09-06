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

test('default deployment is preview-only and cannot mutate scheduler authority', () => {
  const config = readJsonc('wrangler.jsonc');

  assert.equal(config.name, 'xqueue-preview');
  assert.equal(declaresSchedulerMutation(config), false);
  assert.equal(config.d1_databases?.[0]?.database_id, PREVIEW_DB_ID);
  assert.equal(config.d1_databases?.[0]?.database_name, 'xqueue-preview');
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

test('production and preview Worker/D1 identities are structurally distinct', () => {
  const preview = readJsonc('wrangler.jsonc');
  const production = readJsonc('wrangler.authority.jsonc');

  assert.notEqual(preview.name, production.name);
  assert.notEqual(
    preview.d1_databases?.[0]?.database_id,
    production.d1_databases?.[0]?.database_id,
  );
  assert.equal(preview.main, production.main);
});

test('empty cron declarations are treated as destructive authority mutations', () => {
  const omitted = { name: 'xqueue-preview' };
  const destructiveEmpty = {
    name: 'xqueue-production',
    triggers: { crons: [] },
  };

  assert.equal(declaresSchedulerMutation(omitted), false);
  assert.equal(declaresSchedulerMutation(destructiveEmpty), true);
});

test('cross-environment D1 identities cannot be reintroduced', () => {
  const preview = readJsonc('wrangler.jsonc');
  const production = readJsonc('wrangler.authority.jsonc');
  const previewText = JSON.stringify(preview);
  const productionText = JSON.stringify(production);

  assert.equal(previewText.includes(PRODUCTION_DB_ID), false);
  assert.equal(productionText.includes(PREVIEW_DB_ID), false);
});
