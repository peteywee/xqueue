import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

function fixture() {
  const sqlite = new DatabaseSync(':memory:');

  for (const path of [
    '../cloudflare/migrations/0001_xqueue_runtime.sql',
    '../cloudflare/migrations/0002_runtime_evidence.sql',
    '../cloudflare/migrations/0003_publication_lease.sql',
    '../cloudflare/migrations/0004_append_only_event_ledgers.sql',
  ]) {
    sqlite.exec(readFileSync(new URL(path, import.meta.url), 'utf8'));
  }

  sqlite.prepare(`
    INSERT INTO publication_state (
      post_id,
      status,
      scheduled_at,
      updated_at
    ) VALUES (?, 'scheduled', ?, ?)
  `).run('A1', '2026-09-04T12:00:00.000Z', '2026-09-04T11:00:00.000Z');

  return sqlite;
}

function insertPublicationEvent(sqlite, detail = 'original') {
  return sqlite.prepare(`
    INSERT INTO publication_events (
      post_id,
      event_type,
      event_at,
      detail
    ) VALUES (?, ?, ?, ?)
  `).run('A1', 'test_event', '2026-09-04T11:01:00.000Z', detail);
}

function insertLeaseEvent(sqlite, acquisitionId = 'test-acquisition-0001') {
  return sqlite.prepare(`
    INSERT INTO publication_lease_events (
      lease_name,
      generation,
      owner_token,
      acquisition_id,
      event_type,
      event_at_ms,
      detail
    ) VALUES ('publisher', 1, 'test-owner-token', ?, 'acquired', 1000, 'test')
  `).run(acquisitionId);
}

test('publication_events remains insertable but rejects UPDATE and DELETE', () => {
  const sqlite = fixture();

  insertPublicationEvent(sqlite);

  assert.throws(
    () => sqlite.prepare(`UPDATE publication_events SET detail = 'tampered' WHERE id = 1`).run(),
    /publication_events is append-only/,
  );

  assert.throws(
    () => sqlite.prepare('DELETE FROM publication_events WHERE id = 1').run(),
    /publication_events is append-only/,
  );

  const row = sqlite.prepare('SELECT detail FROM publication_events WHERE id = 1').get();
  assert.equal(row.detail, 'original');

  insertPublicationEvent(sqlite, 'second');
  const count = sqlite.prepare('SELECT COUNT(*) AS count FROM publication_events').get();
  assert.equal(Number(count.count), 2);
});

test('publication_lease_events remains insertable but rejects UPDATE and DELETE', () => {
  const sqlite = fixture();

  insertLeaseEvent(sqlite);

  assert.throws(
    () => sqlite.prepare(`UPDATE publication_lease_events SET detail = 'tampered' WHERE id = 1`).run(),
    /publication_lease_events is append-only/,
  );

  assert.throws(
    () => sqlite.prepare('DELETE FROM publication_lease_events WHERE id = 1').run(),
    /publication_lease_events is append-only/,
  );

  const row = sqlite.prepare('SELECT detail FROM publication_lease_events WHERE id = 1').get();
  assert.equal(row.detail, 'test');

  insertLeaseEvent(sqlite, 'test-acquisition-0002');
  const count = sqlite.prepare('SELECT COUNT(*) AS count FROM publication_lease_events').get();
  assert.equal(Number(count.count), 2);
});
