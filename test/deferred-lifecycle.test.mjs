import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import {
  deferMissedStaticAssignments,
  isMissedResolvedAt,
} from '../src/deferred-lifecycle.mjs';
import { normalizeState } from '../src/state-store.mjs';
import {
  classifyMissedAssignment,
  deferOneMissedAssignment,
  MISSED_REASON,
} from '../cloudflare/src/deferred-lifecycle.mjs';

function migration(path) {
  return readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
}

function d1Adapter(db) {
  function statement(sql) {
    let args = [];
    return {
      sql,
      bind(...values) {
        args = values;
        return this;
      },
      async all() {
        return { results: db.prepare(sql).all(...args) };
      },
      async first() {
        return db.prepare(sql).get(...args) ?? null;
      },
      _args() {
        return args;
      },
    };
  }

  return {
    prepare: statement,
    async batch(statements) {
      const out = [];
      db.exec('BEGIN');
      try {
        for (const stmt of statements) {
          const sql = stmt.sql.trim();
          const args = stmt._args();
          if (/^SELECT\b/i.test(sql)) {
            out.push({ results: db.prepare(stmt.sql).all(...args) });
          } else {
            db.prepare(stmt.sql).run(...args);
            out.push({ results: [] });
          }
        }
        db.exec('COMMIT');
        return out;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
  };
}

function baseRow(overrides = {}) {
  return {
    assignment_id: 'P1',
    assignment_version: 1,
    content_id: 'P1',
    content_revision: 1,
    content_digest: 'a'.repeat(64),
    target_account: 'x-primary',
    policy_version: 2,
    resolved_at: '2026-09-21T12:00:00.000Z',
    scheduled_date: '2026-09-21',
    scheduled_time: '07:00',
    timezone: 'America/Chicago',
    slot_label: 'lull',
    assignment_status: 'active',
    lifecycle_state: 'scheduled',
    assignment_generation: 1,
    publication_status: 'scheduled',
    publication_generation: 1,
    deferral_state: null,
    ...overrides,
  };
}

test('missed boundary is strict: exact resolved_at + grace remains current', () => {
  const resolvedAt = '2026-09-21T12:00:00.000Z';

  assert.equal(
    isMissedResolvedAt(resolvedAt, {
      now: new Date('2026-09-21T12:20:00.000Z'),
      graceMinutes: 20,
    }),
    false,
  );

  assert.equal(
    isMissedResolvedAt(resolvedAt, {
      now: new Date('2026-09-21T12:20:00.001Z'),
      graceMinutes: 20,
    }),
    true,
  );
});

test('needs_reconciliation and inflight publication states cannot auto-defer', () => {
  const now = new Date('2026-09-21T12:30:00.000Z');

  assert.deepEqual(
    classifyMissedAssignment(
      baseRow({ publication_status: 'needs_reconciliation' }),
      { now, graceMinutes: 20 },
    ),
    {
      action: 'protected',
      reason: 'needs_reconciliation_requires_determination',
    },
  );

  for (const publication_status of ['prepared', 'publishing']) {
    assert.equal(
      classifyMissedAssignment(
        baseRow({ publication_status }),
        { now, graceMinutes: 20 },
      ).action,
      'protected',
    );
  }
});

test('local rollback moves missed work to deferred, never skipped', () => {
  const queue = [{
    id: 'P1',
    scheduledAt: '2026-09-21T12:00:00.000Z',
    scheduledDate: '2026-09-21',
    scheduledTime: '07:00',
    timezone: 'America/Chicago',
    slot: 'lull',
  }];
  const state = {
    version: 1,
    posted: {},
    skipped: {},
    deferred: {},
    spend: 0,
    inflight: null,
  };

  const result = deferMissedStaticAssignments(queue, state, {
    now: new Date('2026-09-21T12:20:00.001Z'),
    graceMinutes: 20,
    policyVersion: 2,
  });

  assert.equal(result.deferred.length, 1);
  assert.equal(state.skipped.P1, undefined);
  assert.equal(state.deferred.P1.reason, MISSED_REASON);
  assert.equal(state.deferred.P1.assignmentId, 'P1');
  assert.equal(state.deferred.P1.assignmentVersion, 1);
  assert.equal(state.deferred.P1.policyVersion, 2);
  assert.equal(state.deferred.P1.resolvedAt, '2026-09-21T12:00:00.000Z');

  const normalized = normalizeState(state);
  assert.equal(normalized.deferred.P1.reason, MISSED_REASON);
});

test('local rollback never transforms an inflight reconciliation item', () => {
  const queue = [{
    id: 'P1',
    scheduledAt: '2026-09-21T12:00:00.000Z',
    scheduledDate: '2026-09-21',
    scheduledTime: '07:00',
    timezone: 'America/Chicago',
    slot: 'lull',
  }];
  const state = {
    version: 1,
    posted: {},
    skipped: {},
    deferred: {},
    spend: 0,
    inflight: {
      postId: 'P1',
      status: 'needs_reconciliation',
    },
  };

  const result = deferMissedStaticAssignments(queue, state, {
    now: new Date('2026-09-21T13:00:00.000Z'),
    graceMinutes: 20,
    policyVersion: 2,
  });

  assert.equal(result.deferred.length, 0);
  assert.deepEqual(state.deferred, {});
});

test('0009 durable transition removes dispatch authority and appends exact evidence', async () => {
  const db = new DatabaseSync(':memory:');
  db.exec(migration('cloudflare/migrations/0001_xqueue_runtime.sql'));
  db.exec(migration('cloudflare/migrations/0002_runtime_evidence.sql'));
  db.exec(migration('cloudflare/migrations/0003_publication_lease.sql'));
  db.exec(migration('cloudflare/migrations/0004_authority_ownership.sql'));
  db.exec(migration('cloudflare/migrations/0005_publication_state_generation.sql'));
  db.exec(migration('cloudflare/migrations/0006_continuous_queue_shadow.sql'));
  db.exec(migration('cloudflare/migrations/0007_continuous_queue_intake.sql'));
  db.exec(migration('cloudflare/migrations/0008_dynamic_runtime_integrity.sql'));
  db.exec(migration('cloudflare/migrations/0009_deferred_lifecycle.sql'));

  const digest = 'a'.repeat(64);
  const at = '2026-09-21T11:00:00.000Z';

  db.exec(`
    INSERT INTO queue_content
      (content_id,pillar,current_revision,status,generation,created_at,updated_at,intake_state)
    VALUES ('P1','A',1,'active',1,'${at}','${at}','scheduled');

    INSERT INTO queue_content_revisions
      (content_id,revision,title,body,publication_text,content_digest,figure,source_ref,created_at)
    VALUES ('P1',1,'p1','body','body','${digest}',NULL,'fixture','${at}');

    INSERT INTO queue_assignments
      (assignment_id,assignment_version,content_id,content_revision,content_digest,target_account,
       policy_version,resolved_at,scheduled_date,scheduled_time,timezone,slot_label,status,
       superseded_by_version,generation,created_at,updated_at,lifecycle_state)
    VALUES
      ('P1',1,'P1',1,'${digest}','x-primary',2,
       '2026-09-21T12:00:00.000Z','2026-09-21','07:00','America/Chicago','lull',
       'active',NULL,1,'${at}','${at}','scheduled');

    INSERT INTO publication_state
      (post_id,status,scheduled_at,tweet_id,prepared_at,publishing_at,posted_at,
       skipped_at,skip_reason,last_error,updated_at,generation)
    VALUES
      ('P1','scheduled','2026-09-21T12:00:00.000Z',NULL,NULL,NULL,NULL,
       NULL,NULL,NULL,'${at}',1);
  `);

  const dbApi = d1Adapter(db);
  const row = baseRow();

  const result = await deferOneMissedAssignment(dbApi, row, {
    now: new Date('2026-09-21T12:20:00.001Z'),
    graceMinutes: 20,
  });

  assert.equal(result.status, 'deferred');
  assert.equal(result.reason, MISSED_REASON);

  const assignment = db.prepare(
    "SELECT status,lifecycle_state,generation FROM queue_assignments WHERE content_id='P1'",
  ).get();
  assert.deepEqual(
    assignment,
    { status: 'active', lifecycle_state: 'deferred', generation: 2 },
  );

  const deferral = db.prepare(
    "SELECT * FROM queue_deferrals WHERE content_id='P1'",
  ).get();
  assert.equal(deferral.state, 'pending_replacement');
  assert.equal(deferral.assignment_version, 1);
  assert.equal(deferral.policy_version, 2);
  assert.equal(deferral.prior_resolved_at, '2026-09-21T12:00:00.000Z');
  assert.equal(deferral.reason, MISSED_REASON);

  assert.equal(
    db.prepare("SELECT COUNT(*) AS n FROM queue_assignment_events WHERE event_type='deferred'").get().n,
    1,
  );
  assert.equal(
    db.prepare("SELECT COUNT(*) AS n FROM queue_deferral_events WHERE event_type='deferred'").get().n,
    1,
  );

  const replay = await deferOneMissedAssignment(dbApi, row, {
    now: new Date('2026-09-21T12:21:00.000Z'),
    graceMinutes: 20,
  });
  assert.equal(replay.status, 'already_deferred');
  assert.equal(
    db.prepare("SELECT COUNT(*) AS n FROM queue_deferrals WHERE content_id='P1'").get().n,
    1,
  );
});

test('deferral evidence events are append-only', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(migration('cloudflare/migrations/0001_xqueue_runtime.sql'));
  db.exec(migration('cloudflare/migrations/0002_runtime_evidence.sql'));
  db.exec(migration('cloudflare/migrations/0003_publication_lease.sql'));
  db.exec(migration('cloudflare/migrations/0004_authority_ownership.sql'));
  db.exec(migration('cloudflare/migrations/0005_publication_state_generation.sql'));
  db.exec(migration('cloudflare/migrations/0006_continuous_queue_shadow.sql'));
  db.exec(migration('cloudflare/migrations/0007_continuous_queue_intake.sql'));
  db.exec(migration('cloudflare/migrations/0008_dynamic_runtime_integrity.sql'));
  db.exec(migration('cloudflare/migrations/0009_deferred_lifecycle.sql'));

  // Trigger existence is itself part of the schema proof; attempts to rewrite
  // evidence must abort.
  const triggers = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'queue_deferral_events_no_%' ORDER BY name",
  ).all().map((row) => row.name);

  assert.deepEqual(triggers, [
    'queue_deferral_events_no_delete',
    'queue_deferral_events_no_update',
  ]);
});
