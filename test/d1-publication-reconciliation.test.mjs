import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import {
  classifyReconciliationReadback,
  planOwnerReconciliation,
  renderOwnerReconciliationSql,
} from '../src/d1-publication-reconciliation.mjs';

const ATTEMPT = 'attempt-ambiguous-0001';
const POST = 'A1';
const SCHEDULED_AT = '2026-09-21T19:30:00.000Z';
const AMBIGUOUS_AT = '2026-09-21T19:31:00.000Z';
const DETERMINED_AT = '2026-09-21T20:00:00.000Z';
const TEXT = 'Ambiguous publication body.';

function digest(text) {
  return createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');
}

function migration(name) {
  return readFileSync(
    new URL('../cloudflare/migrations/' + name, import.meta.url),
    'utf8',
  );
}

function fixture() {
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

  const contentDigest = digest(TEXT);
  const fenceEvidence = {
    attemptId: ATTEMPT,
    stateGeneration: 2,
    leaseName: 'publisher',
    leaseGeneration: 7,
    leaseOwnerToken: 'holder-token-1234',
    leaseAcquisitionId: 'acquisition-1234',
    leaseAcquiredAtMs: 1000,
    leaseExpiresAtMs: 9999999999999,
    assignmentId: POST,
    assignmentVersion: 1,
    policyVersion: 2,
    contentDigest,
  };
  const ledger = {
    version: 1,
    spend: 1.25,
    posted: {},
    skipped: {},
    inflight: {
      attemptId: ATTEMPT,
      postId: POST,
      title: 'A1',
      contentHash: contentDigest,
      cost: 0.01,
      startedAt: '2026-09-21T19:29:00.000Z',
      status: 'needs_reconciliation',
      publishStartedAt: '2026-09-21T19:29:30.000Z',
      failedAt: AMBIGUOUS_AT,
      lastError: 'ambiguous_timeout',
      publicationFence: fenceEvidence,
    },
  };

  db.prepare(
    "INSERT INTO queue_content " +
    "(content_id,pillar,current_revision,status,generation,created_at,updated_at,intake_state) " +
    "VALUES ('A1','A',1,'active',1,?,?, 'scheduled')",
  ).run('2026-09-21T18:00:00.000Z', '2026-09-21T18:00:00.000Z');

  db.prepare(
    "INSERT INTO queue_content_revisions " +
    "(content_id,revision,title,body,publication_text,content_digest,figure,source_ref,created_at) " +
    "VALUES ('A1',1,'A1',?,?,?,NULL,'fixture:#91',?)",
  ).run(TEXT, TEXT, contentDigest, '2026-09-21T18:00:00.000Z');

  db.prepare(
    "INSERT INTO queue_assignments " +
    "(assignment_id,assignment_version,content_id,content_revision,content_digest,target_account," +
    "policy_version,resolved_at,scheduled_date,scheduled_time,timezone,slot_label,status," +
    "superseded_by_version,generation,created_at,updated_at,lifecycle_state) " +
    "VALUES ('A1',1,'A1',1,?,'x-primary',2,?,'2026-09-21','14:30'," +
    "'America/Chicago','lull','active',NULL,1,?,?,'scheduled')",
  ).run(
    contentDigest,
    SCHEDULED_AT,
    '2026-09-21T18:00:00.000Z',
    '2026-09-21T18:00:00.000Z',
  );

  db.prepare(
    "INSERT INTO publication_state " +
    "(post_id,status,scheduled_at,tweet_id,publishing_at,last_error,updated_at,attempt_id," +
    "reconciled,failed_at,ledger_record_json,generation) " +
    "VALUES ('A1','needs_reconciliation',?,NULL,?,'ambiguous_timeout',?,?," +
    "0,?, ?,3)",
  ).run(
    SCHEDULED_AT,
    '2026-09-21T19:29:30.000Z',
    AMBIGUOUS_AT,
    ATTEMPT,
    AMBIGUOUS_AT,
    JSON.stringify({ ambiguous: true, attemptId: ATTEMPT }),
  );

  db.prepare(
    "INSERT INTO runtime_metadata(key,value,updated_at) " +
    "VALUES ('state.snapshot_json',?,?)",
  ).run(JSON.stringify(ledger), AMBIGUOUS_AT);

  db.prepare(
    "INSERT INTO publication_fences " +
    "(attempt_id,post_id,state_generation,lease_name,lease_generation,lease_owner_token," +
    "lease_acquisition_id,lease_acquired_at_ms,lease_expires_at_ms,assignment_id," +
    "assignment_version,policy_version,content_digest,recorded_at) " +
    "VALUES (?, 'A1',2,'publisher',7,'holder-token-1234','acquisition-1234'," +
    "1000,9999999999999,'A1',1,2,?,?)",
  ).run(ATTEMPT, contentDigest, '2026-09-21T19:29:30.000Z');

  db.prepare(
    "INSERT INTO publication_events(post_id,event_type,event_at,detail) " +
    "VALUES ('A1','needs_reconciliation',?,?)",
  ).run(
    AMBIGUOUS_AT,
    JSON.stringify({
      attemptId: ATTEMPT,
      classification: 'ambiguous',
      reason: 'ambiguous_timeout',
    }),
  );

  return { db, contentDigest, sourceLedger: ledger };
}

function candidate(db) {
  return {
    publicationState: {
      ...db.prepare(
        "SELECT post_id,status,tweet_id,attempt_id,generation,reconciled," +
        "scheduled_at,last_error,failed_at,ledger_record_json " +
        "FROM publication_state WHERE post_id='A1'",
      ).get(),
    },
    publicationFence: {
      ...db.prepare(
        'SELECT * FROM publication_fences WHERE attempt_id=?',
      ).get(ATTEMPT),
    },
    snapshotRaw: db.prepare(
      "SELECT value FROM runtime_metadata WHERE key='state.snapshot_json'",
    ).get().value,
  };
}

function readback(db, plan) {
  return {
    determination: db.prepare(
      'SELECT * FROM publication_reconciliation_determinations WHERE determination_id=?',
    ).get(plan.determination_id) ?? null,
    publicationState: db.prepare(
      "SELECT post_id,status,tweet_id,attempt_id,generation,reconciled," +
      "scheduled_at,last_error,failed_at,ledger_record_json " +
      "FROM publication_state WHERE post_id='A1'",
    ).get(),
    snapshotRaw: db.prepare(
      "SELECT value FROM runtime_metadata WHERE key='state.snapshot_json'",
    ).get().value,
    events: db.prepare(
      "SELECT event_type,event_at,detail FROM publication_events WHERE post_id='A1' ORDER BY id",
    ).all(),
  };
}

test('owner confirmed-posted reconciliation preserves ambiguity evidence and advances exact state', () => {
  const { db } = fixture();
  const source = candidate(db);
  const ambiguityBefore = db.prepare(
    "SELECT id,event_type,event_at,detail FROM publication_events WHERE event_type='needs_reconciliation'",
  ).get();

  const plan = planOwnerReconciliation({
    ...source,
    outcome: 'confirmed_posted',
    tweetId: 'tweet-991',
    reason: 'owner verified exact post on X timeline',
    determinedAt: DETERMINED_AT,
  });

  db.exec(renderOwnerReconciliationSql(plan));
  assert.equal(classifyReconciliationReadback(plan, readback(db, plan)), 'complete');

  const state = readback(db, plan).publicationState;
  assert.equal(state.status, 'posted');
  assert.equal(state.tweet_id, 'tweet-991');
  assert.equal(state.attempt_id, ATTEMPT);
  assert.equal(state.reconciled, 1);
  assert.equal(state.generation, 4);

  const ledger = JSON.parse(readback(db, plan).snapshotRaw);
  assert.equal(ledger.inflight, null);
  assert.equal(ledger.posted.A1.tweetId, 'tweet-991');
  assert.equal(ledger.posted.A1.reconciled, true);
  assert.equal(ledger.posted.A1.reconciliationDeterminationId, plan.determination_id);
  assert.equal(ledger.spend, 1.26);

  const ambiguityAfter = db.prepare(
    "SELECT id,event_type,event_at,detail FROM publication_events WHERE event_type='needs_reconciliation'",
  ).get();
  assert.deepEqual(ambiguityAfter, ambiguityBefore);

  const determination = readback(db, plan).determination;
  assert.equal(determination.actor_class, 'owner');
  assert.equal(determination.outcome, 'confirmed_posted');
  assert.equal(determination.tweet_id, 'tweet-991');

  assert.throws(
    () => db.prepare(
      "UPDATE publication_reconciliation_determinations SET reason='forged' WHERE determination_id=?",
    ).run(plan.determination_id),
    /immutable/,
  );
  assert.throws(
    () => db.prepare(
      'DELETE FROM publication_reconciliation_determinations WHERE determination_id=?',
    ).run(plan.determination_id),
    /immutable/,
  );

  const eventCount = db.prepare('SELECT COUNT(*) AS n FROM publication_events').get().n;
  db.exec(renderOwnerReconciliationSql(plan));
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM publication_events').get().n, eventCount);
  assert.equal(
    db.prepare('SELECT COUNT(*) AS n FROM publication_reconciliation_determinations').get().n,
    1,
  );
});

test('owner confirmed-not-posted clears the ambiguous attempt without authorizing blind retry', () => {
  const { db } = fixture();
  const plan = planOwnerReconciliation({
    ...candidate(db),
    outcome: 'confirmed_not_posted',
    reason: 'owner verified no matching post exists on X',
    determinedAt: DETERMINED_AT,
  });

  db.exec(renderOwnerReconciliationSql(plan));
  assert.equal(classifyReconciliationReadback(plan, readback(db, plan)), 'complete');

  const state = readback(db, plan).publicationState;
  assert.equal(state.status, 'scheduled');
  assert.equal(state.attempt_id, null);
  assert.equal(state.tweet_id, null);
  assert.equal(state.reconciled, 1);
  assert.equal(state.generation, 4);
  assert.equal(state.scheduled_at, SCHEDULED_AT);

  const ledger = JSON.parse(readback(db, plan).snapshotRaw);
  assert.equal(ledger.inflight, null);
  assert.equal(Object.hasOwn(ledger.posted, 'A1'), false);
  assert.equal(ledger.spend, 1.25);

  const durable = JSON.parse(state.ledger_record_json);
  assert.equal(durable.automaticRetryAllowed, false);
  assert.equal(durable.classification, 'confirmed_not_posted');
  assert.equal(durable.reconciliationDeterminationId, plan.determination_id);
});

test('snapshot drift refuses reconciliation without leaving a false owner determination', () => {
  const { db } = fixture();
  const plan = planOwnerReconciliation({
    ...candidate(db),
    outcome: 'confirmed_not_posted',
    reason: 'owner verified no matching post exists on X',
    determinedAt: DETERMINED_AT,
  });

  db.prepare(
    "UPDATE runtime_metadata SET value=?,updated_at=? WHERE key='state.snapshot_json'",
  ).run(
    JSON.stringify({ version: 1, spend: 1.25, posted: {}, skipped: {}, inflight: { drift: true } }),
    '2026-09-21T19:59:00.000Z',
  );

  const before = db.prepare(
    "SELECT status,attempt_id,generation,reconciled FROM publication_state WHERE post_id='A1'",
  ).get();

  db.exec(renderOwnerReconciliationSql(plan));

  assert.deepEqual(
    db.prepare(
      "SELECT status,attempt_id,generation,reconciled FROM publication_state WHERE post_id='A1'",
    ).get(),
    before,
  );
  assert.equal(
    db.prepare('SELECT COUNT(*) AS n FROM publication_reconciliation_determinations').get().n,
    0,
  );
  assert.equal(
    db.prepare(
      "SELECT COUNT(*) AS n FROM publication_events WHERE event_type LIKE 'reconciled_%'",
    ).get().n,
    0,
  );
});

test('stale generation refuses reconciliation without evidence mutation', () => {
  const { db } = fixture();
  const plan = planOwnerReconciliation({
    ...candidate(db),
    outcome: 'confirmed_posted',
    tweetId: 'tweet-991',
    reason: 'owner verified exact post on X timeline',
    determinedAt: DETERMINED_AT,
  });

  db.prepare(
    "UPDATE publication_state SET generation=4 WHERE post_id='A1'",
  ).run();

  db.exec(renderOwnerReconciliationSql(plan));

  assert.equal(
    db.prepare('SELECT COUNT(*) AS n FROM publication_reconciliation_determinations').get().n,
    0,
  );
  assert.equal(
    db.prepare(
      "SELECT COUNT(*) AS n FROM publication_events WHERE event_type='reconciled_posted'",
    ).get().n,
    0,
  );
});

test('reconciliation refuses unsupported or insufficient owner determinations', () => {
  const { db } = fixture();
  const source = candidate(db);

  assert.throws(
    () => planOwnerReconciliation({
      ...source,
      outcome: 'confirmed_posted',
      reason: 'missing tweet ID',
      determinedAt: DETERMINED_AT,
    }),
    /tweet_id/,
  );
  assert.throws(
    () => planOwnerReconciliation({
      ...source,
      outcome: 'other',
      reason: 'unsupported',
      determinedAt: DETERMINED_AT,
    }),
    /outcome/,
  );
  assert.throws(
    () => planOwnerReconciliation({
      ...source,
      outcome: 'confirmed_not_posted',
      tweetId: 'not-valid-here',
      reason: 'contradictory',
      determinedAt: DETERMINED_AT,
    }),
    /tweet_id is invalid/,
  );
});
