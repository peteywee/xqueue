import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const SEED = readFileSync(new URL('../cloudflare/migrations-production/0018_intake_frontier_seed.sql', import.meta.url), 'utf8');

function database() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE queue_assignments (content_id TEXT, status TEXT NOT NULL, resolved_at TEXT NOT NULL);
    CREATE TABLE queue_intake_frontier (
      singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
      generation INTEGER NOT NULL CHECK (generation >= 1),
      resolved_at TEXT NOT NULL,
      pending_operation_id TEXT,
      last_completed_operation_id TEXT,
      updated_at TEXT NOT NULL
    );
  `);
  return db;
}

const frontier = (db) => db.prepare('SELECT * FROM queue_intake_frontier').all().map((row) => ({ ...row }));

test('0018 seeds a missing frontier at the last active slot (assignments loaded after 0007)', () => {
  const db = database();
  const add = db.prepare('INSERT INTO queue_assignments VALUES (?,?,?)');
  add.run('A1', 'active', '2026-10-05T19:30:00.000Z');
  add.run('C1', 'active', '2027-01-07T20:30:00.000Z');
  add.run('OLD', 'superseded', '2027-06-01T00:00:00.000Z');
  db.exec(SEED);
  const [row] = frontier(db);
  assert.equal(row.singleton_id, 1);
  assert.equal(row.generation, 1);
  assert.equal(row.resolved_at, '2027-01-07T20:30:00.000Z', 'only active assignments count');
  assert.equal(row.pending_operation_id, null);
  assert.equal(row.last_completed_operation_id, null);
  // Applying it again changes nothing.
  db.exec(SEED);
  assert.deepEqual(frontier(db), [row]);
});

test('0018 never touches an existing frontier and seeds nothing for an empty queue', () => {
  const db = database();
  db.prepare('INSERT INTO queue_assignments VALUES (?,?,?)').run('A1', 'active', '2027-01-07T20:30:00.000Z');
  db.exec("INSERT INTO queue_intake_frontier VALUES (1, 6, '2027-02-01T00:00:00.000Z', NULL, 'intake-x', '2026-10-01T00:00:00.000Z')");
  const before = frontier(db);
  db.exec(SEED);
  assert.deepEqual(frontier(db), before);

  const empty = database();
  empty.exec(SEED);
  assert.deepEqual(frontier(empty), []);
});

test('0018 is identical in both migration lanes', () => {
  assert.equal(
    readFileSync(new URL('../cloudflare/migrations/0018_intake_frontier_seed.sql', import.meta.url), 'utf8'),
    SEED,
  );
});
