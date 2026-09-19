import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

function text(path) {
  return readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
}

function config(path) {
  return JSON.parse(text(path));
}

const SHARED = [
  '0001_xqueue_runtime.sql',
  '0002_runtime_evidence.sql',
  '0003_publication_lease.sql',
  '0005_publication_state_generation.sql',
];

test('default production config uses the production-safe migration lane', () => {
  const production = config('wrangler.jsonc');
  const preview = config('wrangler.preview.jsonc');
  const authority = config('wrangler.authority.jsonc');

  assert.equal(
    production.d1_databases[0].migrations_dir,
    'cloudflare/migrations-production',
  );
  assert.equal(
    preview.d1_databases[0].migrations_dir,
    'cloudflare/migrations',
  );
  assert.equal(
    authority.d1_databases[0].migrations_dir,
    'cloudflare/migrations',
  );
});

test('production-safe lane preserves existing migration names and excludes authority schema', () => {
  const files = readdirSync(
    new URL('../cloudflare/migrations-production/', import.meta.url),
  )
    .filter((name) => name.endsWith('.sql'))
    .sort();

  assert.deepEqual(files, SHARED);
  assert.equal(files.includes('0004_authority_ownership.sql'), false);
});

test('production-safe migrations are byte-identical to their canonical shared counterparts', () => {
  for (const name of SHARED) {
    assert.equal(
      text(`cloudflare/migrations-production/${name}`),
      text(`cloudflare/migrations/${name}`),
      `${name} drifted between migration lanes`,
    );
  }
});
