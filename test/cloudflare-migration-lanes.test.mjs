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
  '0006_continuous_queue_shadow.sql',
  '0007_continuous_queue_intake.sql',
  '0008_dynamic_runtime_integrity.sql',
  '0009_deferred_lifecycle.sql',
  '0010_publication_fence_identity.sql',
  '0011_global_publication_halt.sql',
  '0012_reconciliation_determinations.sql',
];

test('default production config uses the production-safe migration lane', () => {
  const production = config('wrangler.jsonc');
  const status = config('wrangler.status.jsonc');
  const publisher = config('wrangler.publisher.jsonc');
  const preview = config('wrangler.preview.jsonc');
  const authority = config('wrangler.authority.jsonc');

  assert.equal(
    production.d1_databases[0].migrations_dir,
    'cloudflare/migrations-production',
  );
  assert.equal(
    status.d1_databases[0].migrations_dir,
    'cloudflare/migrations-production',
  );
  assert.equal(
    publisher.d1_databases[0].migrations_dir,
    'cloudflare/migrations-production',
  );
  assert.equal(
    preview.d1_databases[0].migrations_dir,
    'cloudflare/migrations',
  );
  assert.equal(
    authority.d1_databases[0].migrations_dir,
    'cloudflare/migrations-production',
  );
});

test('production-safe lane preserves history and admits only production authority migrations', () => {
  const files = readdirSync(
    new URL('../cloudflare/migrations-production/', import.meta.url),
  )
    .filter((name) => name.endsWith('.sql'))
    .sort();

  assert.deepEqual(files, [\n    ...SHARED,\n    '0013_authority_ownership.sql',\n    '0014_authority_event_projection.sql',\n  ]);
  assert.equal(files.includes('0004_authority_ownership.sql'), false);
  assert.match(
    text('cloudflare/migrations-production/0013_authority_ownership.sql'),
    /CREATE TABLE authority_state/,
  );
  assert.match(
    text('cloudflare/migrations-production/0013_authority_ownership.sql'),
    /CREATE TABLE authority_events/,
  );
  assert.match(
    text('cloudflare/migrations-production/0014_authority_event_projection.sql'),
    /CREATE TRIGGER authority_events_project_state/,
  );
  assert.match(
    text('cloudflare/migrations-production/0014_authority_event_projection.sql'),
    /RAISE\(ABORT, 'authority event projection failed'\)/,
  );
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
