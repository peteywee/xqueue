import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

function readMigration(name) {
  return readFileSync(
    new URL(`../cloudflare/migrations/${name}`, import.meta.url),
    'utf8',
  );
}

function fixtureBeforeGenerationMigration() {
  const sqlite = new DatabaseSync(':memory:');

  for (const name of [
    '0001_xqueue_runtime.sql',
    '0002_runtime_evidence.sql',
    '0003_publication_lease.sql',
    '0004_append_only_event_ledgers.sql',
  ]) {
    sqlite.exec(readMigration(name));
  }

  sqlite.prepare(`
    INSERT INTO publication_state (
      post_id,
      status,
      scheduled_at,
      updated_at
    ) VALUES (?, 'scheduled', ?, ?)
  `).run(
    'A1',
    '2026-09-04T12:00:00.000Z',
    '2026-09-04T11:00:00.000Z',
  );

  return sqlite;
}

test('generation migration backfills existing rows at generation 1', () => {
  const sqlite = fixtureBeforeGenerationMigration();
  sqlite.exec(readMigration('0005_publication_state_generation.sql'));

  const row = sqlite.prepare(`
    SELECT generation
    FROM publication_state
    WHERE post_id = 'A1'
  `).get();

  assert.equal(Number(row.generation), 1);
});

test('new publication_state rows default to generation 1', () => {
  const sqlite = fixtureBeforeGenerationMigration();
  sqlite.exec(readMigration('0005_publication_state_generation.sql'));

  sqlite.prepare(`
    INSERT INTO publication_state (
      post_id,
      status,
      scheduled_at,
      updated_at
    ) VALUES (?, 'scheduled', ?, ?)
  `).run(
    'A2',
    '2026-09-04T13:00:00.000Z',
    '2026-09-04T11:00:00.000Z',
  );

  const row = sqlite.prepare(`
    SELECT generation
    FROM publication_state
    WHERE post_id = 'A2'
  `).get();

  assert.equal(Number(row.generation), 1);
});

test('generation cannot be written below 1', () => {
  const sqlite = fixtureBeforeGenerationMigration();
  sqlite.exec(readMigration('0005_publication_state_generation.sql'));

  assert.throws(
    () => sqlite.prepare(`
      UPDATE publication_state
      SET generation = 0
      WHERE post_id = 'A1'
    `).run(),
    /CHECK constraint failed/,
  );

  const row = sqlite.prepare(`
    SELECT generation
    FROM publication_state
    WHERE post_id = 'A1'
  `).get();

  assert.equal(Number(row.generation), 1);
});

test('exact-version CAS advances once and stale replay changes zero rows', () => {
  const sqlite = fixtureBeforeGenerationMigration();
  sqlite.exec(readMigration('0005_publication_state_generation.sql'));

  const transition = sqlite.prepare(`
    UPDATE publication_state
    SET
      status = 'publishing',
      generation = generation + 1,
      updated_at = ?1
    WHERE post_id = ?2
      AND status = 'scheduled'
      AND generation = ?3
  `);

  const first = transition.run(
    '2026-09-04T12:00:01.000Z',
    'A1',
    1,
  );
  assert.equal(Number(first.changes), 1);

  const stale = transition.run(
    '2026-09-04T12:00:02.000Z',
    'A1',
    1,
  );
  assert.equal(Number(stale.changes), 0);

  const row = sqlite.prepare(`
    SELECT status, generation, updated_at
    FROM publication_state
    WHERE post_id = 'A1'
  `).get();

  assert.equal(row.status, 'publishing');
  assert.equal(Number(row.generation), 2);
  assert.equal(row.updated_at, '2026-09-04T12:00:01.000Z');
});
