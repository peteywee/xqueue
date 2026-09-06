import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function readJsonc(relativePath) {
  const raw = fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
  return JSON.parse(raw.replace(/^\s*\/\/.*$/gm, ''));
}

function declaresSchedulerMutation(config) {
  return Object.prototype.hasOwnProperty.call(config, 'triggers');
}

test('default deployment config does not declare scheduler state', () => {
  const config = readJsonc('wrangler.jsonc');
  assert.equal(
    declaresSchedulerMutation(config),
    false,
    'ordinary deploys must omit triggers so they preserve externally managed scheduler authority',
  );
});

test('authority deployment config explicitly pins exactly one 15-minute cron', () => {
  const config = readJsonc('wrangler.authority.jsonc');
  assert.deepEqual(config.triggers?.crons, ['*/15 * * * *']);
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

test('default and authority configs identify the same production Worker and storage', () => {
  const normal = readJsonc('wrangler.jsonc');
  const authority = readJsonc('wrangler.authority.jsonc');

  assert.equal(normal.name, 'xqueue-production');
  assert.equal(authority.name, normal.name);
  assert.equal(authority.main, normal.main);
  assert.equal(
    authority.d1_databases?.[0]?.database_id,
    normal.d1_databases?.[0]?.database_id,
  );
  assert.equal(
    authority.r2_buckets?.[0]?.bucket_name,
    normal.r2_buckets?.[0]?.bucket_name,
  );
});
