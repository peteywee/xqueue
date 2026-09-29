import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

function text(path) {
  return readFileSync(new URL('../' + path, import.meta.url), 'utf8');
}

function json(path) {
  return JSON.parse(text(path));
}

test('only status descriptor owns the live xqueue-production Worker identity', () => {
  const paths = [
    'wrangler.jsonc',
    'wrangler.prep.jsonc',
    'wrangler.status.jsonc',
    'wrangler.publisher.jsonc',
    'wrangler.authority.jsonc',
    'wrangler.preview.jsonc',
  ];
  const owners = paths.filter((path) => json(path).name === 'xqueue-production');
  assert.deepEqual(owners, ['wrangler.status.jsonc']);
});

test('legacy and precutover descriptors are retired deployment identities', () => {
  const legacy = json('wrangler.jsonc');
  const prep = json('wrangler.prep.jsonc');

  assert.equal(legacy.name, 'xqueue-legacy-compat-retired');
  assert.equal(legacy.main, 'cloudflare/src/worker.mjs');
  assert.equal(legacy.triggers, undefined);

  assert.equal(prep.name, 'xqueue-precutover-retired');
  assert.equal(prep.main, 'cloudflare/src/worker.mjs');
  assert.equal(prep.triggers, undefined);
  assert.equal(prep.vars?.XQUEUE_PUBLISH_AUTHORITY, 'disabled');
});

test('historical precutover workflow has no production mutation command', () => {
  const source = text('.github/workflows/production-precutover-preparation.yml');
  assert.match(source, /Retired/);
  assert.match(source, /cannot deploy or mutate production/);
  assert.match(source, /exit 1/);
  assert.doesNotMatch(source, /wrangler deploy/);
  assert.doesNotMatch(source, /d1 migrations apply/);
});

test('historical direct release script refuses before any deployment', () => {
  const source = text('scripts/finalize-xqueue-1.1.0.sh');
  const refusal = source.indexOf('retired after canonical activation');
  const deploy = source.indexOf('wrangler deploy');

  assert.ok(refusal >= 0);
  assert.ok(deploy > refusal);
  assert.match(source.slice(0, deploy), /exit 1/);
});

test('precutover Node mutation entrypoints hard-refuse after activation', () => {
  for (const path of [
    'scripts/production-precutover-prepare.mjs',
    'scripts/production-precutover-normalize.mjs',
  ]) {
    const source = text(path);
    const main = source.indexOf('function main');
    const refusal = source.indexOf('retired after #46 canonical activation', main);
    assert.ok(main >= 0, path);
    assert.ok(refusal > main, path);
  }
});

test('package precutover aliases are refusal-only', () => {
  const pkg = JSON.parse(text('package.json'));
  for (const name of [
    'production:precutover:prepare',
    'production:precutover:normalize',
  ]) {
    assert.match(pkg.scripts[name], /STOP: retired after #46/);
    assert.doesNotMatch(pkg.scripts[name], /production-precutover-(?:prepare|normalize)\.mjs/);
  }
});

test('main-push TSAL waits for status-role reconciliation before production evidence', () => {
  const source = text('.github/workflows/tsal-conformance.yml');
  const wait = source.indexOf('Wait for post-push status-role reconciliation');
  const runtime = source.indexOf('Collect read-only production runtime evidence');

  assert.ok(wait >= 0);
  assert.ok(runtime > wait);
  assert.match(source, /post_push_status_role_reconciliation_timeout/);
  assert.match(source, /Date\.now\(\) \+ 180_000/);
});
