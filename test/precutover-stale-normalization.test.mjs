import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import {
  PRECUTOVER_NORMALIZATION_CANDIDATES_SQL,
  planPrecutoverStaleNormalization,
  renderPrecutoverStaleNormalizationSql,
  verifyPrecutoverNormalizationReadback,
} from '../src/precutover-stale-normalization.mjs';

function queue() {
  return [
    {
      id: 'P1',
      scheduledAt: '2026-09-21T12:00:00.000Z',
      scheduledDate: '2026-09-21',
      scheduledTime: '07:00',
      timezone: 'America/Chicago',
      slot: 'lull',
    },
    {
      id: 'P2',
      scheduledAt: '2026-09-21T12:50:00.000Z',
      scheduledDate: '2026-09-21',
      scheduledTime: '07:50',
      timezone: 'America/Chicago',
      slot: 'post-close',
    },
  ];
}

function candidate(id, resolvedAt, time) {
  return {
    assignment_id: id,
    assignment_version: 1,
    content_id: id,
    content_revision: 1,
    content_digest: 'a'.repeat(64),
    target_account: 'x-primary',
    policy_version: 2,
    resolved_at: resolvedAt,
    scheduled_date: '2026-09-21',
    scheduled_time: time,
    timezone: 'America/Chicago',
    slot_label: id === 'P1' ? 'lull' : 'post-close',
    assignment_status: 'active',
    lifecycle_state: 'scheduled',
    assignment_generation: 1,
    publication_status: 'scheduled',
    publication_generation: 1,
    deferral_state: null,
  };
}

test('pre-cutover plan defers only assignments strictly past grace with exact D1 parity', () => {
  const ledger = {
    version: 1,
    posted: {},
    skipped: {},
    deferred: {},
    spend: 0,
    inflight: null,
  };

  const plan = planPrecutoverStaleNormalization({
    queue: queue(),
    ledger,
    candidates: [
      candidate('P1', '2026-09-21T12:00:00.000Z', '07:00'),
      candidate('P2', '2026-09-21T12:50:00.000Z', '07:50'),
    ],
    now: new Date('2026-09-21T12:20:00.001Z'),
    graceMinutes: 20,
    policyVersion: 2,
  });

  assert.equal(plan.items.length, 1);
  assert.equal(plan.items[0].contentId, 'P1');
  assert.equal(plan.items[0].reason, 'missed_slot_grace_expired');
  assert.equal(plan.nextLedger.deferred.P1.assignmentId, 'P1');
  assert.equal(plan.nextLedger.deferred.P2, undefined);

  const sql = renderPrecutoverStaleNormalizationSql(plan);
  assert.match(sql, /BEGIN IMMEDIATE/);
  assert.match(sql, /state\.snapshot_json/);
  assert.match(sql, /lifecycle_state='deferred'/);
  assert.match(sql, /pending_replacement/);
  assert.doesNotMatch(sql, /@xdevplatform|createPost|api\.x\.com/);
});

test('pre-cutover plan refuses static/D1 missed-set disagreement', () => {
  const ledger = {
    version: 1,
    posted: {},
    skipped: {},
    deferred: {},
    spend: 0,
    inflight: null,
  };

  assert.throws(
    () => planPrecutoverStaleNormalization({
      queue: queue(),
      ledger,
      candidates: [
        candidate('P2', '2026-09-21T12:50:00.000Z', '07:50'),
      ],
      now: new Date('2026-09-21T12:20:00.001Z'),
      graceMinutes: 20,
      policyVersion: 2,
    }),
    /no exact D1 scheduled candidate|missed assignment set mismatch/,
  );
});

test('readback requires exact deferred assignment and durable deferral evidence', () => {
  const ledger = {
    version: 1,
    posted: {},
    skipped: {},
    deferred: {},
    spend: 0,
    inflight: null,
  };
  const plan = planPrecutoverStaleNormalization({
    queue: queue(),
    ledger,
    candidates: [
      candidate('P1', '2026-09-21T12:00:00.000Z', '07:00'),
      candidate('P2', '2026-09-21T12:50:00.000Z', '07:50'),
    ],
    now: new Date('2026-09-21T12:20:00.001Z'),
    graceMinutes: 20,
    policyVersion: 2,
  });
  const item = plan.items[0];

  assert.equal(
    verifyPrecutoverNormalizationReadback(plan, {
      snapshotRaw: plan.nextLedgerRaw,
      assignments: [{
        content_id: item.contentId,
        assignment_id: item.assignmentId,
        assignment_version: item.assignmentVersion,
        policy_version: item.policyVersion,
        resolved_at: item.resolvedAt,
        lifecycle_state: 'deferred',
        assignment_generation: item.assignmentGeneration + 1,
      }],
      deferrals: [{
        content_id: item.contentId,
        assignment_id: item.assignmentId,
        assignment_version: item.assignmentVersion,
        reason: item.reason,
        deferred_at: item.deferredAt,
        state: 'pending_replacement',
      }],
    }),
    true,
  );
});

test('candidate query excludes already-posted and otherwise non-schedulable assignments', () => {
  const db = new DatabaseSync(':memory:');
  db.exec([
    'CREATE TABLE queue_assignments (',
    ' assignment_id TEXT, assignment_version INTEGER, content_id TEXT, content_revision INTEGER,',
    ' content_digest TEXT, target_account TEXT, policy_version INTEGER, resolved_at TEXT,',
    ' scheduled_date TEXT, scheduled_time TEXT, timezone TEXT, slot_label TEXT,',
    ' status TEXT, lifecycle_state TEXT, generation INTEGER);',
    'CREATE TABLE publication_state (post_id TEXT, status TEXT, attempt_id TEXT, generation INTEGER);',
    'CREATE TABLE queue_deferrals (content_id TEXT, state TEXT);',
  ].join(' '));

  const insertAssignment = db.prepare([
    'INSERT INTO queue_assignments (',
    'assignment_id,assignment_version,content_id,content_revision,content_digest,',
    'target_account,policy_version,resolved_at,scheduled_date,scheduled_time,',
    'timezone,slot_label,status,lifecycle_state,generation',
    ') VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
  ].join(' '));
  const insertPublication = db.prepare(
    'INSERT INTO publication_state (post_id,status,attempt_id,generation) VALUES (?,?,?,?)',
  );

  for (const [id, status, attemptId] of [
    ['POSTED', 'posted', null],
    ['READY', 'scheduled', null],
    ['INFLIGHT', 'scheduled', 'attempt-1'],
    ['RECON', 'needs_reconciliation', 'attempt-2'],
  ]) {
    insertAssignment.run(
      id, 1, id, 1, 'a'.repeat(64), 'x-primary', 2,
      '2026-09-21T12:00:00.000Z', '2026-09-21', '07:00',
      'America/Chicago', 'lull', 'active', 'scheduled', 1,
    );
    insertPublication.run(id, status, attemptId, 1);
  }

  insertAssignment.run(
    'DEFERRED', 1, 'DEFERRED', 1, 'a'.repeat(64), 'x-primary', 2,
    '2026-09-21T12:00:00.000Z', '2026-09-21', '07:00',
    'America/Chicago', 'lull', 'active', 'scheduled', 1,
  );
  insertPublication.run('DEFERRED', 'scheduled', null, 1);
  db.prepare('INSERT INTO queue_deferrals (content_id,state) VALUES (?,?)')
    .run('DEFERRED', 'pending_replacement');

  const rows = db.prepare(PRECUTOVER_NORMALIZATION_CANDIDATES_SQL).all();

  assert.deepEqual(rows.map((row) => row.content_id), ['READY']);
  assert.equal(rows[0].publication_status, 'scheduled');
  assert.equal(rows[0].deferral_state, null);
});
