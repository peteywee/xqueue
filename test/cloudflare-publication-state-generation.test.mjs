import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import {
  beginPublishingFence,
  persistPublicationOutcome,
  readPublicationSnapshot,
} from '../cloudflare/src/publication-ledger.mjs';

function readMigration(name) {
  return readFileSync(
    new URL(`../cloudflare/migrations/${name}`, import.meta.url),
    'utf8',
  );
}

function statement(sqlite, sql, params = []) {
  return {
    sql,
    params,
    bind(...next) {
      return statement(sqlite, sql, next);
    },
    async first() {
      return sqlite.prepare(sql).get(...params) ?? null;
    },
  };
}

function d1(sqlite) {
  return {
    prepare(sql) {
      return statement(sqlite, sql);
    },
    async batch(statements) {
      sqlite.exec('BEGIN IMMEDIATE');
      try {
        const results = statements.map((entry) => {
          const sql = entry.sql.trim();
          if (/^SELECT\b/i.test(sql)) {
            return {
              success: true,
              results: sqlite.prepare(sql).all(...entry.params),
            };
          }
          sqlite.prepare(sql).run(...entry.params);
          return { success: true, results: [] };
        });
        sqlite.exec('COMMIT');
        return results;
      } catch (error) {
        sqlite.exec('ROLLBACK');
        throw error;
      }
    },
  };
}

function ledger() {
  return {
    version: 1,
    spend: 0,
    posted: {},
    skipped: {},
    inflight: null,
  };
}

function sha256(text) {
  return createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');
}

function enablePublicationFence(sqlite, text) {
  for (const name of [
    '0006_continuous_queue_shadow.sql',
    '0007_continuous_queue_intake.sql',
    '0008_dynamic_runtime_integrity.sql',
    '0009_deferred_lifecycle.sql',
    '0010_publication_fence_identity.sql',
  ]) {
    sqlite.exec(readMigration(name));
  }

  const contentDigest = sha256(text);
  sqlite.prepare(
    "INSERT INTO queue_content " +
    "(content_id,pillar,current_revision,status,generation,created_at,updated_at,intake_state) " +
    "VALUES ('A1','A',1,'active',1,?,?, 'scheduled')",
  ).run('2026-09-15T17:00:00.000Z', '2026-09-15T17:00:00.000Z');

  sqlite.prepare(
    "INSERT INTO queue_content_revisions " +
    "(content_id,revision,title,body,publication_text,content_digest,figure,source_ref,created_at) " +
    "VALUES ('A1',1,'A1',?,?,?,NULL,'fixture',?)",
  ).run(text, text, contentDigest, '2026-09-15T17:00:00.000Z');

  sqlite.prepare(
    "INSERT INTO queue_assignments " +
    "(assignment_id,assignment_version,content_id,content_revision,content_digest,target_account," +
    "policy_version,resolved_at,scheduled_date,scheduled_time,timezone,slot_label,status," +
    "superseded_by_version,generation,created_at,updated_at,lifecycle_state) " +
    "VALUES ('A1',1,'A1',1,?,'x-primary',2,'2026-09-15T18:00:00.000Z'," +
    "'2026-09-15','13:00','America/Chicago','lull','active',NULL,1,?,?,'scheduled')",
  ).run(
    contentDigest,
    '2026-09-15T17:00:00.000Z',
    '2026-09-15T17:00:00.000Z',
  );

  sqlite.prepare(
    "INSERT INTO publication_leases " +
    "(lease_name,owner_token,acquisition_id,generation,acquired_at_ms,expires_at_ms,updated_at_ms) " +
    "VALUES ('publisher','fixture-owner-token','fixture-acquisition-id',1,1000,9999999999999,1000)",
  ).run();

  return {
    lease: {
      leaseName: 'publisher',
      ownerToken: 'fixture-owner-token',
      acquisitionId: 'fixture-acquisition-id',
      generation: 1,
      acquiredAtMs: 1000,
      expiresAtMs: 9999999999999,
    },
    assignment: {
      assignment_id: 'A1',
      assignment_version: 1,
      content_id: 'A1',
      policy_version: 2,
      content_digest: contentDigest,
      resolved_at: '2026-09-15T18:00:00.000Z',
    },
  };
}

function fixture() {
  const sqlite = new DatabaseSync(':memory:');

  for (const name of [
    '0001_xqueue_runtime.sql',
    '0002_runtime_evidence.sql',
    '0003_publication_lease.sql',
    '0004_authority_ownership.sql',
  ]) {
    sqlite.exec(readMigration(name));
  }

  const source = ledger();
  const raw = JSON.stringify(source);

  sqlite.prepare(`
    INSERT INTO publication_state (
      post_id,
      status,
      scheduled_at,
      updated_at
    ) VALUES (?, 'scheduled', ?, ?)
  `).run(
    'A1',
    '2026-09-15T18:00:00.000Z',
    '2026-09-15T17:00:00.000Z',
  );

  sqlite.prepare(`
    INSERT INTO runtime_metadata (key, value, updated_at)
    VALUES ('state.snapshot_json', ?, ?)
  `).run(raw, '2026-09-15T17:00:00.000Z');

  return { sqlite, db: d1(sqlite), source, raw };
}

function stateRow(sqlite) {
  return sqlite.prepare(`
    SELECT
      status,
      attempt_id,
      generation,
      updated_at,
      ledger_record_json
    FROM publication_state
    WHERE post_id = 'A1'
  `).get();
}

function snapshotRaw(sqlite) {
  return sqlite.prepare(`
    SELECT value
    FROM runtime_metadata
    WHERE key = 'state.snapshot_json'
  `).get().value;
}

function events(sqlite) {
  return sqlite.prepare(`
    SELECT event_type, detail
    FROM publication_events
    WHERE post_id = 'A1'
    ORDER BY id
  `).all();
}

test('generation migration backfills existing rows at 1 and defaults new rows to 1', () => {
  const { sqlite } = fixture();

  sqlite.exec(readMigration('0005_publication_state_generation.sql'));

  assert.equal(Number(stateRow(sqlite).generation), 1);

  sqlite.prepare(`
    INSERT INTO publication_state (
      post_id,
      status,
      scheduled_at,
      updated_at
    ) VALUES (?, 'scheduled', ?, ?)
  `).run(
    'A2',
    '2026-09-15T19:00:00.000Z',
    '2026-09-15T17:00:00.000Z',
  );

  const added = sqlite.prepare(`
    SELECT generation
    FROM publication_state
    WHERE post_id = 'A2'
  `).get();

  assert.equal(Number(added.generation), 1);
});

test('generation cannot be written below 1', () => {
  const { sqlite } = fixture();
  sqlite.exec(readMigration('0005_publication_state_generation.sql'));

  assert.throws(
    () => sqlite.prepare(`
      UPDATE publication_state
      SET generation = 0
      WHERE post_id = 'A1'
    `).run(),
    /CHECK constraint failed/,
  );

  assert.equal(Number(stateRow(sqlite).generation), 1);
});

test('publishing and outcome transitions advance generation exactly once and persist generation evidence', async () => {
  const { sqlite, db } = fixture();
  sqlite.exec(readMigration('0005_publication_state_generation.sql'));

  const fence = enablePublicationFence(sqlite, 'generation fenced post');
  const source = await readPublicationSnapshot(db);
  const publishing = await beginPublishingFence(
    db,
    source,
    {
      post: { id: 'A1', title: 'A1' },
      text: 'generation fenced post',
      cost: 0.01,
      now: new Date('2026-09-15T18:00:00.000Z'),
      attemptId: 'attempt-generation-1',
      ...fence,
    },
  );

  assert.equal(publishing.publicationStateGeneration, 2);
  assert.equal(stateRow(sqlite).status, 'publishing');
  assert.equal(Number(stateRow(sqlite).generation), 2);

  const publishingEvents = events(sqlite);
  assert.equal(publishingEvents.length, 1);
  assert.equal(
    JSON.parse(publishingEvents[0].detail).stateGeneration,
    2,
  );

  const completed = await persistPublicationOutcome(
    db,
    publishing,
    {
      post: { id: 'A1' },
      outcome: {
        classification: 'confirmed_not_posted',
        reason: 'explicit_http_refusal_429',
      },
      now: new Date('2026-09-15T18:01:00.000Z'),
    },
  );

  assert.equal(completed.publicationStateGeneration, 3);
  assert.equal(stateRow(sqlite).status, 'scheduled');
  assert.equal(Number(stateRow(sqlite).generation), 3);

  const durable = JSON.parse(stateRow(sqlite).ledger_record_json);
  assert.equal(durable.stateGeneration, 3);

  const outcomeEvents = events(sqlite);
  assert.equal(outcomeEvents.length, 2);
  assert.equal(
    JSON.parse(outcomeEvents[1].detail).stateGeneration,
    3,
  );
});

test('stale outcome replay changes neither snapshot nor state and appends no misleading event', async () => {
  const { sqlite, db } = fixture();
  sqlite.exec(readMigration('0005_publication_state_generation.sql'));

  const fence = enablePublicationFence(sqlite, 'stale replay proof');
  const source = await readPublicationSnapshot(db);
  const publishing = await beginPublishingFence(
    db,
    source,
    {
      post: { id: 'A1', title: 'A1' },
      text: 'stale replay proof',
      cost: 0.01,
      now: new Date('2026-09-15T18:00:00.000Z'),
      attemptId: 'attempt-replay-0001',
      ...fence,
    },
  );

  await persistPublicationOutcome(
    db,
    publishing,
    {
      post: { id: 'A1' },
      outcome: {
        classification: 'confirmed_not_posted',
        reason: 'explicit_http_refusal_429',
      },
      now: new Date('2026-09-15T18:01:00.000Z'),
    },
  );

  const rawBeforeReplay = snapshotRaw(sqlite);
  const stateBeforeReplay = stateRow(sqlite);
  const eventsBeforeReplay = events(sqlite);

  await assert.rejects(
    () => persistPublicationOutcome(
      db,
      publishing,
      {
        post: { id: 'A1' },
        outcome: {
          classification: 'confirmed_not_posted',
          reason: 'explicit_http_refusal_429',
        },
        now: new Date('2026-09-15T18:02:00.000Z'),
      },
    ),
    /publication outcome snapshot did not change exactly one row/,
  );

  assert.equal(snapshotRaw(sqlite), rawBeforeReplay);
  assert.deepEqual(stateRow(sqlite), stateBeforeReplay);
  assert.deepEqual(events(sqlite), eventsBeforeReplay);
});

test('concurrent publishing contenders produce one generation winner and one event', async () => {
  const { sqlite, db } = fixture();
  sqlite.exec(readMigration('0005_publication_state_generation.sql'));

  const fence = enablePublicationFence(sqlite, 'same contender text');
  const source = await readPublicationSnapshot(db);

  const results = await Promise.allSettled([
    beginPublishingFence(
      db,
      source,
      {
        post: { id: 'A1', title: 'A1' },
        text: 'same contender text',
        cost: 0.01,
        now: new Date('2026-09-15T18:00:00.000Z'),
        attemptId: 'attempt-contender-1',
        ...fence,
      },
    ),
    beginPublishingFence(
      db,
      source,
      {
        post: { id: 'A1', title: 'A1' },
        text: 'same contender text',
        cost: 0.01,
        now: new Date('2026-09-15T18:00:00.000Z'),
        attemptId: 'attempt-contender-2',
        ...fence,
      },
    ),
  ]);

  assert.equal(
    results.filter((result) => result.status === 'fulfilled').length,
    1,
  );
  assert.equal(
    results.filter((result) => result.status === 'rejected').length,
    1,
  );

  const row = stateRow(sqlite);
  assert.equal(row.status, 'publishing');
  assert.equal(Number(row.generation), 2);
  assert.equal(events(sqlite).length, 1);

  const stored = JSON.parse(snapshotRaw(sqlite));
  assert.equal(stored.inflight.attemptId, row.attempt_id);
});
