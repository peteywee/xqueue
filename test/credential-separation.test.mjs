import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

function text(path) {
  return readFileSync(new URL('../' + path, import.meta.url), 'utf8');
}

function jsonc(path) {
  return JSON.parse(text(path).replace(/^\s*\/\/.*$/gm, ''));
}

test('status entrypoint is structurally incapable of scheduling or importing publication code', () => {
  const source = text('cloudflare/src/status-worker.mjs');

  assert.match(source, /async fetch\s*\(/);
  assert.doesNotMatch(source, /\bscheduled\s*\(/);
  assert.doesNotMatch(source, /production-publisher|publisher-worker/);
  assert.doesNotMatch(source, /@xdevplatform/);
  assert.doesNotMatch(
    source,
    /X_API_KEY|X_API_SECRET|X_ACCESS_TOKEN|X_ACCESS_SECRET/,
  );
});

test('publisher entrypoint exposes only the scheduled publication role', () => {
  const source = text('cloudflare/src/publisher-worker.mjs');

  assert.match(source, /async scheduled\s*\(/);
  assert.match(source, /production-publisher\.mjs/);
  assert.match(source, /publicationAuthorityEnabled/);
  assert.doesNotMatch(source, /async fetch\s*\(/);
});

test('legacy production descriptor is frozen while target roles are separately addressable', () => {
  const legacy = jsonc('wrangler.jsonc');
  const status = jsonc('wrangler.status.jsonc');
  const publisher = jsonc('wrangler.publisher.jsonc');
  const authority = jsonc('wrangler.authority.jsonc');

  assert.deepEqual(
    { name: legacy.name, main: legacy.main, triggers: legacy.triggers },
    {
      name: 'xqueue-production',
      main: 'cloudflare/src/worker.mjs',
      triggers: undefined,
    },
  );

  assert.deepEqual(
    { name: status.name, main: status.main, triggers: status.triggers },
    {
      name: 'xqueue-production',
      main: 'cloudflare/src/status-worker.mjs',
      triggers: { crons: [] },
    },
  );

  assert.deepEqual(
    { name: publisher.name, main: publisher.main, triggers: publisher.triggers },
    {
      name: 'xqueue-publisher-production',
      main: 'cloudflare/src/publisher-worker.mjs',
      triggers: undefined,
    },
  );

  assert.equal(authority.name, publisher.name);
  assert.equal(authority.main, publisher.main);
  assert.deepEqual(authority.triggers?.crons, ['*/15 * * * *']);
});

test('status role has no configured route or service binding to publisher role', () => {
  const status = jsonc('wrangler.status.jsonc');
  const raw = text('wrangler.status.jsonc');

  assert.equal(status.services, undefined);
  assert.equal(status.dispatch_namespaces, undefined);
  assert.equal(status.durable_objects, undefined);
  assert.equal(raw.includes('xqueue-publisher-production'), false);
});

test('only publisher configs identify the publisher deployment', () => {
  const legacy = text('wrangler.jsonc');
  const status = text('wrangler.status.jsonc');
  const publisher = text('wrangler.publisher.jsonc');
  const authority = text('wrangler.authority.jsonc');

  assert.equal(legacy.includes('xqueue-publisher-production'), false);
  assert.equal(status.includes('xqueue-publisher-production'), false);
  assert.equal(publisher.includes('xqueue-publisher-production'), true);
  assert.equal(authority.includes('xqueue-publisher-production'), true);
});

test('no tracked Wrangler topology descriptor embeds X write credentials', () => {
  const credential =
    /X_API_KEY|X_API_SECRET|X_ACCESS_TOKEN|X_ACCESS_SECRET|consumer_secret|oauth_token/i;

  for (const path of [
    'wrangler.jsonc',
    'wrangler.status.jsonc',
    'wrangler.publisher.jsonc',
    'wrangler.authority.jsonc',
    'wrangler.preview.jsonc',
  ]) {
    assert.doesNotMatch(text(path), credential, path);
  }
});
