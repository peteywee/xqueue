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
import {
  readCurrentAssignmentHandle,
} from '../cloudflare/src/assignment-version-fence.mjs';

const TEXT = 'exact publication text';
const SCHEDULED_AT = '2026-09-22T19:30:00.000Z';
const NOW = new Date('2026-09-22T19:29:00.000Z');

function sha256(text) {
  return createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');
}

function migration(name) {
  return readFileSync(
    new URL('../cloudflare/migrations/' + name, import.meta.url),
    'utf8',
  );
}

class Statement {
  constructor(db, sql, params = []) {
    this.db = db;
    this.sql = sql;
    this.params = params;
  }

  bind(...params) {
    return new Statement(this.db, this.sql, params);
  }

  execute() {
    const statement = this.db.prepare(this.sql);
    if (/^\s*SELECT\b/i.test(this.sql)) {
      return {
        success: true,
        results: statement.all(...this.params).map((row) => ({ ...row })),
      };
    }
    statement.run(...this.params);
    return { success: true, results: [] };
  }

  async first() {
    const row = this.db.prepare(this.sql).get(...this.params);
    return row ? { ...row } : null;
  }

  async all() {
    return {
      results: this.db.prepare(this.sql).all(...this.params).map((row) => ({ ...row })),
    };
  }
}

class SqliteD1 {
  constructor(db) {
    this.db = db;
  }

  prepare(sql) {
    return new Statement(this.db, sql);
  }

  async batch(statements) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const results = statements.map((statement) => statement.execute());
      this.db.exec('COMMIT');
      return results;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
}

function fixture() {
  const sqlite = new DatabaseSync(':memory:');

  for (const name of [
    '0001_xqueue_runtime.sql',
    '0002_runtime_evidence.sql',
    '0003_publication_lease.sql',
    '0005_publication_state_generation.sql',
    '0006_continuous_queue_shadow.sql',
    '0007_continuous_queue_intake.sql',
    '0008_dynamic_runtime_integrity.sql',
    '0009_deferred_lifecycle.sql',
    '0010_publication_fence_identity.sql',
  ]) {
    sqlite.exec(migration(name));
  }

  const digest = sha256(TEXT);
  const source = {
    version: 1,
    spend: 0,
    posted: {},
    skipped: {},
    inflight: null,
  };
  const raw = JSON.stringify(source);

  sqlite.prepare(
    "INSERT INTO publication_state " +
    "(post_id,status,scheduled_at,updated_at,generation) " +
    "VALUES ('A1','scheduled',?,?,1)",
  ).run(SCHEDULED_AT, '2026-09-22T18:00:00.000Z');

  sqlite.prepare(
    "INSERT INTO runtime_metadata(key,value,updated_at) " +
    "VALUES ('state.snapshot_json',?,?)",
  ).run(raw, '2026-09-22T18:00:00.000Z');

  sqlite.prepare(
    "INSERT INTO queue_content " +
    "(content_id,pillar,current_revision,status,generation,created_at,updated_at,intake_state) " +
    "VALUES ('A1','A',1,'active',1,?,?, 'scheduled')",
  ).run('2026-09-22T18:00:00.000Z', '2026-09-22T18:00:00.000Z');

  sqlite.prepare(
    "INSERT INTO queue_content_revisions " +
    "(content_id,revision,title,body,publication_text,content_digest,figure,source_ref,created_at) " +
    "VALUES ('A1',1,'A1',?,?,?,NULL,'fixture:#41',?)",
  ).run(TEXT, TEXT, digest, '2026-09-22T18:00:00.000Z');

  sqlite.prepare(
    "INSERT INTO queue_assignments " +
    "(assignment_id,assignment_version,content_id,content_revision,content_digest,target_account," +
    "policy_version,resolved_at,scheduled_date,scheduled_time,timezone,slot_label,status," +
    "superseded_by_version,generation,created_at,updated_at,lifecycle_state) " +
    "VALUES ('A1',1,'A1',1,?,'x-primary',7,?,'2026-09-22','14:30'," +
    "'America/Chicago','lull','active',NULL,4,?,?,'scheduled')",
  ).run(
    digest,
    SCHEDULED_AT,
    '2026-09-22T18:00:00.000Z',
    '2026-09-22T18:00:00.000Z',
  );

  sqlite.prepare(
    "INSERT INTO publication_leases " +
    "(lease_name,owner_token,acquisition_id,generation,acquired_at_ms,expires_at_ms,updated_at_ms) " +
    "VALUES ('publisher','holder-token-1234','acquisition-1234',9,1000,9999999999999,1000)",
  ).run();

  const lease = {
    leaseName: 'publisher',
    ownerToken: 'holder-token-1234',
    acquisitionId: 'acquisition-1234',
    generation: 9,
    acquiredAtMs: 1000,
    expiresAtMs: 9999999999999,
  };
  const assignment = {
    assignment_id: 'A1',
    assignment_version: 1,
    content_id: 'A1',
    policy_version: 7,
    content_digest: digest,
    resolved_at: SCHEDULED_AT,
  };

  return {
    sqlite,
    db: new SqliteD1(sqlite),
    source,
    raw,
    lease,
    assignment,
    digest,
  };
}

function state(sqlite) {
  return sqlite.prepare(
    "SELECT status,attempt_id,generation,ledger_record_json " +
    "FROM publication_state WHERE post_id='A1'",
  ).get();
}

function snapshot(sqlite) {
  return sqlite.prepare(
    "SELECT value FROM runtime_metadata WHERE key='state.snapshot_json'",
  ).get().value;
}

function fenceRows(sqlite) {
  return sqlite.prepare(
    'SELECT * FROM publication_fences ORDER BY recorded_at,attempt_id',
  ).all();
}

function events(sqlite) {
  return sqlite.prepare(
    "SELECT event_type,detail FROM publication_events WHERE post_id='A1' ORDER BY id",
  ).all();
}

async function begin(f, overrides = {}) {
  const source = await readPublicationSnapshot(f.db);
  return beginPublishingFence(
    f.db,
    source,
    {
      post: { id: 'A1', title: 'A1' },
      text: TEXT,
      cost: 0.01,
      now: NOW,
      attemptId: 'attempt-exact-1234',
      lease: f.lease,
      assignment: f.assignment,
      ...overrides,
    },
  );
}

test('exact lease and assignment identities create one immutable pre-dispatch fence', async () => {
  const f = fixture();

  const handle = await readCurrentAssignmentHandle(f.db, 'A1');
  assert.equal(handle.assignment_id, 'A1');
  assert.equal(handle.assignment_version, 1);
  assert.equal(handle.policy_version, 7);
  assert.equal(handle.content_digest, f.digest);
  assert.equal(handle.resolved_at, SCHEDULED_AT);

  const publishing = await begin(f, { assignment: handle });

  assert.equal(state(f.sqlite).status, 'publishing');
  assert.equal(state(f.sqlite).generation, 2);

  const rows = fenceRows(f.sqlite);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].attempt_id, 'attempt-exact-1234');
  assert.equal(rows[0].state_generation, 2);
  assert.equal(rows[0].lease_generation, 9);
  assert.equal(rows[0].lease_owner_token, 'holder-token-1234');
  assert.equal(rows[0].lease_acquisition_id, 'acquisition-1234');
  assert.equal(rows[0].assignment_id, 'A1');
  assert.equal(rows[0].assignment_version, 1);
  assert.equal(rows[0].policy_version, 7);
  assert.equal(rows[0].content_digest, f.digest);

  const detail = JSON.parse(events(f.sqlite)[0].detail);
  assert.deepEqual(detail.publicationFence, publishing.publicationFence);
  assert.equal(
    publishing.ledger.inflight.publicationFence.assignmentVersion,
    1,
  );

  assert.throws(
    () => f.sqlite.prepare(
      "UPDATE publication_fences SET policy_version=8 WHERE attempt_id='attempt-exact-1234'",
    ).run(),
    /immutable/,
  );
  assert.throws(
    () => f.sqlite.prepare(
      "DELETE FROM publication_fences WHERE attempt_id='attempt-exact-1234'",
    ).run(),
    /immutable/,
  );
  assert.throws(
    () => f.sqlite.prepare(
      "UPDATE publication_events SET detail='forged' WHERE post_id='A1'",
    ).run(),
    /immutable/,
  );
  assert.throws(
    () => f.sqlite.prepare(
      "DELETE FROM publication_events WHERE post_id='A1'",
    ).run(),
    /immutable/,
  );
});

test('outcome evidence retains the exact immutable publication fence identity', async () => {
  const f = fixture();
  const publishing = await begin(f);

  const completed = await persistPublicationOutcome(
    f.db,
    publishing,
    {
      post: { id: 'A1' },
      outcome: {
        classification: 'confirmed_not_posted',
        reason: 'explicit_http_refusal_429',
      },
      now: new Date('2026-09-22T19:31:00.000Z'),
    },
  );

  assert.equal(completed.publicationStateGeneration, 3);
  const durable = JSON.parse(state(f.sqlite).ledger_record_json);
  assert.deepEqual(durable.publicationFence, publishing.publicationFence);

  const outcomeDetail = JSON.parse(events(f.sqlite)[1].detail);
  assert.deepEqual(outcomeDetail.publicationFence, publishing.publicationFence);
  assert.equal(fenceRows(f.sqlite).length, 1);
});

test('stale or mismatched lease handles cannot create valid-looking fence evidence', async () => {
  const mutations = [
    { label: 'generation', apply: (lease) => ({ ...lease, generation: 10 }) },
    { label: 'holder', apply: (lease) => ({ ...lease, ownerToken: 'other-holder-token' }) },
    { label: 'acquisition', apply: (lease) => ({ ...lease, acquisitionId: 'other-acquisition' }) },
    { label: 'acquired-at', apply: (lease) => ({ ...lease, acquiredAtMs: 1001 }) },
  ];

  for (const mutation of mutations) {
    const f = fixture();
    const beforeState = state(f.sqlite);
    const beforeSnapshot = snapshot(f.sqlite);

    await assert.rejects(
      begin(f, { lease: mutation.apply(f.lease) }),
      /publication identity fence did not change exactly one row/,
      mutation.label,
    );

    assert.equal(fenceRows(f.sqlite).length, 0, mutation.label);
    assert.equal(events(f.sqlite).length, 0, mutation.label);
    assert.deepEqual(state(f.sqlite), beforeState, mutation.label);
    assert.equal(snapshot(f.sqlite), beforeSnapshot, mutation.label);
  }
});

test('stale assignment version or policy cannot create fence evidence', async () => {
  const mutations = [
    {
      label: 'assignment-version',
      apply: (assignment) => ({ ...assignment, assignment_version: 2 }),
    },
    {
      label: 'policy-version',
      apply: (assignment) => ({ ...assignment, policy_version: 8 }),
    },
  ];

  for (const mutation of mutations) {
    const f = fixture();
    const beforeState = state(f.sqlite);
    const beforeSnapshot = snapshot(f.sqlite);

    await assert.rejects(
      begin(f, { assignment: mutation.apply(f.assignment) }),
      /publication identity fence did not change exactly one row/,
      mutation.label,
    );

    assert.equal(fenceRows(f.sqlite).length, 0, mutation.label);
    assert.equal(events(f.sqlite).length, 0, mutation.label);
    assert.deepEqual(state(f.sqlite), beforeState, mutation.label);
    assert.equal(snapshot(f.sqlite), beforeSnapshot, mutation.label);
  }
});

test('content digest and scheduled instant mismatches fail before dispatch evidence can exist', async () => {
  {
    const f = fixture();
    await assert.rejects(
      begin(f, {
        assignment: {
          ...f.assignment,
          content_digest: 'b'.repeat(64),
        },
      }),
      /content digest does not match publication text/,
    );
    assert.equal(fenceRows(f.sqlite).length, 0);
    assert.equal(events(f.sqlite).length, 0);
    assert.equal(state(f.sqlite).status, 'scheduled');
  }

  {
    const f = fixture();
    await assert.rejects(
      begin(f, {
        assignment: {
          ...f.assignment,
          resolved_at: '2026-09-22T20:30:00.000Z',
        },
      }),
      /resolved_at does not match publication_state/,
    );
    assert.equal(fenceRows(f.sqlite).length, 0);
    assert.equal(events(f.sqlite).length, 0);
    assert.equal(state(f.sqlite).status, 'scheduled');
  }
});

test('assignment changed after handle read is rejected by the SQL fence', async () => {
  const f = fixture();
  const captured = await readCurrentAssignmentHandle(f.db, 'A1');

  f.sqlite.prepare(
    "UPDATE queue_assignments SET policy_version=8,generation=generation+1 " +
    "WHERE assignment_id='A1' AND assignment_version=1",
  ).run();

  await assert.rejects(
    begin(f, { assignment: captured }),
    /publication identity fence did not change exactly one row/,
  );

  assert.equal(fenceRows(f.sqlite).length, 0);
  assert.equal(events(f.sqlite).length, 0);
  assert.equal(state(f.sqlite).status, 'scheduled');
});
