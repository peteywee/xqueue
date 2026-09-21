import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import {
  applicationTableNames,
  buildLogicalBackup,
  compareBackupToRows,
  renderLogicalRestoreSql,
  verifyLogicalBackup,
} from '../src/d1-logical-backup.mjs';

function migration(name) {
  return readFileSync(
    new URL('../cloudflare/migrations/' + name, import.meta.url),
    'utf8',
  );
}

function digest(text) {
  return createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');
}

function sourceDb() {
  const db = new DatabaseSync(':memory:');
  for (const name of [
    '0001_xqueue_runtime.sql',
    '0002_runtime_evidence.sql',
    '0003_publication_lease.sql',
    '0004_authority_ownership.sql',
    '0005_publication_state_generation.sql',
    '0006_continuous_queue_shadow.sql',
    '0007_continuous_queue_intake.sql',
    '0008_dynamic_runtime_integrity.sql',
    '0009_deferred_lifecycle.sql',
    '0010_publication_fence_identity.sql',
    '0011_global_publication_halt.sql',
    '0012_reconciliation_determinations.sql',
  ]) {
    db.exec(migration(name));
  }

  const d1 = digest('backup post one');
  const d2 = digest('backup post two');

  for (const [id, body, d, resolvedAt, date, time] of [
    ['A1', 'backup post one', d1, '2026-09-22T19:30:00.000Z', '2026-09-22', '14:30'],
    ['A2', 'backup post two', d2, '2026-09-23T03:15:00.000Z', '2026-09-22', '22:15'],
  ]) {
    db.prepare(
      "INSERT INTO queue_content " +
      "(content_id,pillar,current_revision,status,generation,created_at,updated_at,intake_state) " +
      "VALUES (?,'A',1,'active',1,?,?, 'scheduled')",
    ).run(id, '2026-09-21T18:00:00.000Z', '2026-09-21T18:00:00.000Z');
    db.prepare(
      "INSERT INTO queue_content_revisions " +
      "(content_id,revision,title,body,publication_text,content_digest,figure,source_ref,created_at) " +
      "VALUES (?,1,?,?,?,?,NULL,'fixture:#91',?)",
    ).run(id, id, body, body, d, '2026-09-21T18:00:00.000Z');
    db.prepare(
      "INSERT INTO queue_assignments " +
      "(assignment_id,assignment_version,content_id,content_revision,content_digest,target_account," +
      "policy_version,resolved_at,scheduled_date,scheduled_time,timezone,slot_label,status," +
      "superseded_by_version,generation,created_at,updated_at,lifecycle_state) " +
      "VALUES (?,1,?,1,?,'x-primary',2,?,?,?,'America/Chicago','slot'," +
      "'active',NULL,1,?,?,'scheduled')",
    ).run(
      id,
      id,
      d,
      resolvedAt,
      date,
      time,
      '2026-09-21T18:00:00.000Z',
      '2026-09-21T18:00:00.000Z',
    );
    db.prepare(
      "INSERT INTO publication_state(post_id,status,scheduled_at,updated_at,generation) " +
      "VALUES (?,'scheduled',?,?,1)",
    ).run(id, resolvedAt, '2026-09-21T18:00:00.000Z');
    db.prepare(
      "INSERT INTO queue_content_events(content_id,revision,event_type,event_at,detail) " +
      "VALUES (?,1,'fixture_created',?,'{}')",
    ).run(id, '2026-09-21T18:00:00.000Z');
    db.prepare(
      "INSERT INTO queue_assignment_events(assignment_id,assignment_version,event_type,event_at,detail) " +
      "VALUES (?,1,'fixture_assigned',?,'{}')",
    ).run(id, '2026-09-21T18:00:00.000Z');
  }

  db.prepare(
    "INSERT INTO runtime_metadata(key,value,updated_at) VALUES ('state.snapshot_json',?,?)",
  ).run(
    JSON.stringify({
      version: 1,
      spend: 0,
      posted: {},
      skipped: {},
      inflight: null,
    }),
    '2026-09-21T18:00:00.000Z',
  );

  db.prepare(
    "INSERT INTO queue_runtime_revisions " +
    "(generation,revision_digest,active_assignment_count,approved_unscheduled_count," +
    "media_required_count,media_ready_count,previous_revision_digest,source_operation_id,created_at) " +
    "VALUES (1,?,2,0,0,0,NULL,NULL,?)",
  ).run('a'.repeat(64), '2026-09-21T18:00:00.000Z');

  return db;
}

function schemaRows(db) {
  return db.prepare(
    "SELECT type,name,tbl_name,sql FROM sqlite_schema " +
    "WHERE sql IS NOT NULL AND type IN ('table','index','trigger','view') " +
    "ORDER BY type,name",
  ).all().map((row) => ({ ...row }));
}

function rowsByTable(db, schema) {
  const out = {};
  for (const name of applicationTableNames(schema)) {
    const quoted = '"' + name.replaceAll('"', '""') + '"';
    out[name] = db.prepare('SELECT * FROM ' + quoted).all().map((row) => ({ ...row }));
  }
  return out;
}

function backup(db) {
  const schema = schemaRows(db);
  return buildLogicalBackup({
    environment: 'test',
    database: 'xqueue-recovery-fixture',
    schemaRows: schema,
    rowsByTable: rowsByTable(db, schema),
    migrations: [
      { id: 1, name: '0001_xqueue_runtime.sql', applied_at: 1 },
      { id: 12, name: '0012_reconciliation_determinations.sql', applied_at: 12 },
    ],
    createdAt: '2026-09-21T20:00:00.000Z',
  });
}

test('logical backup has stable per-table and whole-backup identity', () => {
  const db = sourceDb();
  const one = backup(db);
  const two = backup(db);

  assert.equal(verifyLogicalBackup(one), true);
  assert.equal(one.backupId, two.backupId);
  assert.equal(one.backupHash, two.backupHash);
  assert.equal(one.schemaHash, two.schemaHash);
  assert.equal(one.tables.queue_content.rowCount, 2);
  assert.equal(one.tables.queue_assignments.rowCount, 2);
  assert.equal(one.tables.publication_state.rowCount, 2);
  assert.equal(one.tables.queue_content_events.rowCount, 2);
  assert.equal(one.tables.queue_assignment_events.rowCount, 2);
  assert.equal(one.tables.publication_halt_state.rowCount, 1);
  assert.equal(one.tables.publication_halt_events.rowCount, 1);
});

test('isolated restore recreates exact application-table parity and integrity', () => {
  const source = sourceDb();
  const artifact = backup(source);
  const restored = new DatabaseSync(':memory:');

  restored.exec(renderLogicalRestoreSql(artifact));

  assert.equal(
    restored.prepare('PRAGMA integrity_check').get().integrity_check,
    'ok',
  );
  assert.deepEqual(restored.prepare('PRAGMA foreign_key_check').all(), []);

  const parity = compareBackupToRows(
    artifact,
    rowsByTable(restored, artifact.schema),
  );
  assert.equal(parity.ok, true);
  assert.deepEqual(parity.differences, []);

  assert.equal(
    restored.prepare(
      "SELECT COUNT(*) AS n FROM queue_assignments a " +
      "JOIN queue_content_revisions r " +
      "ON r.content_id=a.content_id AND r.revision=a.content_revision " +
      "WHERE a.content_digest<>r.content_digest",
    ).get().n,
    0,
  );
  assert.equal(
    restored.prepare(
      "SELECT COUNT(*) AS n FROM (" +
      "SELECT target_account,resolved_at,COUNT(*) AS c FROM queue_assignments " +
      "WHERE status='active' AND lifecycle_state='scheduled' " +
      "GROUP BY target_account,resolved_at HAVING COUNT(*)>1)",
    ).get().n,
    0,
  );
});

test('backup verification rejects altered row data or manifest hashes', () => {
  const artifact = backup(sourceDb());

  const altered = structuredClone(artifact);
  altered.data.queue_content.rows[0].pillar = 'B';
  assert.throws(() => verifyLogicalBackup(altered), /identity\/hash/);

  const alteredManifest = structuredClone(artifact);
  alteredManifest.tables.queue_assignments.rowsHash = 'f'.repeat(64);
  assert.throws(() => verifyLogicalBackup(alteredManifest), /table hash|identity\/hash/);
});

test('restore catches uniqueness corruption instead of silently normalizing it', () => {
  const source = sourceDb();
  const artifact = backup(source);
  const broken = structuredClone(artifact);
  broken.data.queue_assignments.rows[1].resolved_at =
    broken.data.queue_assignments.rows[0].resolved_at;

  // Rebuild identity so the artifact is internally self-consistent but semantically invalid.
  const rebuilt = buildLogicalBackup({
    environment: broken.environment,
    database: broken.database,
    schemaRows: broken.schema,
    rowsByTable: Object.fromEntries(
      Object.entries(broken.data).map(([name, table]) => [name, table.rows]),
    ),
    migrations: broken.migrations,
    createdAt: broken.createdAt,
  });

  const restored = new DatabaseSync(':memory:');
  assert.throws(
    () => restored.exec(renderLogicalRestoreSql(rebuilt)),
    /UNIQUE constraint failed/,
  );
});
