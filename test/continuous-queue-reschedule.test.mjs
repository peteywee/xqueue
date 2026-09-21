import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import {
  buildDynamicRuntimeSnapshot,
  readDynamicRuntimeRows,
} from '../cloudflare/src/dynamic-runtime-integrity.mjs';
import {
  compareAssignmentFence,
  verifyCurrentAssignmentFence,
} from '../cloudflare/src/assignment-version-fence.mjs';
import {
  nextRuntimeRevision,
  renderRuntimeRevisionInsertSql,
} from '../src/continuous-queue-runtime-write.mjs';
import {
  classifyReplacementReadback,
  planAutomaticReplacements,
  planOwnerPlacement,
  projectReplacementRuntimeRows,
  renderReplacementFrontierClaimSql,
  renderReplacementFrontierReleaseSql,
  renderReplacementItemSql,
  renderReplacementSuccessGuardSql,
} from '../src/continuous-queue-reschedule.mjs';

const POLICY = JSON.parse(
  readFileSync(new URL('../config/schedule-policy.json', import.meta.url), 'utf8'),
);
const NOW = new Date('2026-09-21T14:00:00.000Z');
const RECORDED_AT = '2026-09-21T14:05:00.000Z';
const FRONTIER = '2026-09-26T03:15:00.000Z';

function migration(path) {
  return readFileSync(new URL('../' + path, import.meta.url), 'utf8');
}

function digest(text) {
  return createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');
}

function d1Adapter(db) {
  function statement(sql) {
    let args = [];
    return {
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
      async run() {
        const info = db.prepare(sql).run(...args);
        return { success: true, meta: { changes: Number(info.changes ?? 0) } };
      },
    };
  }
  return { prepare: statement };
}

function seedContent(db, id, body, {
  status = 'scheduled',
  resolvedAt,
  scheduledDate,
  scheduledTime,
  lifecycleState = 'scheduled',
  assignmentGeneration = 1,
} = {}) {
  const d = digest(body);
  db.prepare(
    'INSERT INTO queue_content ' +
    '(content_id,pillar,current_revision,status,generation,created_at,updated_at,intake_state) ' +
    "VALUES (?,'A',1,'active',1,?,?, 'scheduled')",
  ).run(id, RECORDED_AT, RECORDED_AT);

  db.prepare(
    'INSERT INTO queue_content_revisions ' +
    '(content_id,revision,title,body,publication_text,content_digest,figure,source_ref,created_at) ' +
    'VALUES (?,1,?,?,?,?,NULL,?,?)',
  ).run(id, id, body, body, d, 'fixture:#54', RECORDED_AT);

  db.prepare(
    'INSERT INTO queue_assignments ' +
    '(assignment_id,assignment_version,content_id,content_revision,content_digest,target_account,' +
    'policy_version,resolved_at,scheduled_date,scheduled_time,timezone,slot_label,status,' +
    'superseded_by_version,generation,created_at,updated_at,lifecycle_state) ' +
    "VALUES (?,1,?,1,?,'x-primary',2,?,?,?,'America/Chicago','lull',?,NULL,?,?,?,?)",
  ).run(
    id,
    id,
    d,
    resolvedAt,
    scheduledDate,
    scheduledTime,
    status === 'deferred' ? 'active' : 'active',
    assignmentGeneration,
    RECORDED_AT,
    RECORDED_AT,
    lifecycleState,
  );

  return d;
}

async function fixture() {
  const db = new DatabaseSync(':memory:');
  for (let i = 1; i <= 9; i++) {
    const names = {
      1: '0001_xqueue_runtime.sql',
      2: '0002_runtime_evidence.sql',
      3: '0003_publication_lease.sql',
      4: '0004_authority_ownership.sql',
      5: '0005_publication_state_generation.sql',
      6: '0006_continuous_queue_shadow.sql',
      7: '0007_continuous_queue_intake.sql',
      8: '0008_dynamic_runtime_integrity.sql',
      9: '0009_deferred_lifecycle.sql',
    };
    db.exec(migration('cloudflare/migrations/' + names[i]));
  }

  const d1 = digest('deferred-one');
  const d2 = digest('deferred-two');
  const df = digest('future');

  function insertContent(id, body, d) {
    db.prepare(
      'INSERT INTO queue_content ' +
      '(content_id,pillar,current_revision,status,generation,created_at,updated_at,intake_state) ' +
      "VALUES (?,'A',1,'active',1,?,?, 'scheduled')",
    ).run(id, RECORDED_AT, RECORDED_AT);
    db.prepare(
      'INSERT INTO queue_content_revisions ' +
      '(content_id,revision,title,body,publication_text,content_digest,figure,source_ref,created_at) ' +
      'VALUES (?,1,?,?,?,?,NULL,?,?)',
    ).run(id, id, body, body, d, 'fixture:#54', RECORDED_AT);
  }
  insertContent('P1', 'deferred-one', d1);
  insertContent('P2', 'deferred-two', d2);
  insertContent('F1', 'future', df);

  const deferredFixtures = [
    {
      id: 'P1',
      digest: d1,
      resolvedAt: '2026-09-18T19:30:00.000Z',
      scheduledDate: '2026-09-18',
      scheduledTime: '14:30',
      slotLabel: 'lull',
      deferredAt: '2026-09-18T20:00:00.000Z',
    },
    {
      id: 'P2',
      digest: d2,
      resolvedAt: '2026-09-19T03:15:00.000Z',
      scheduledDate: '2026-09-18',
      scheduledTime: '22:15',
      slotLabel: 'post-close',
      deferredAt: '2026-09-19T03:45:00.000Z',
    },
  ];

  for (const item of deferredFixtures) {
    db.prepare(
      'INSERT INTO queue_assignments ' +
      '(assignment_id,assignment_version,content_id,content_revision,content_digest,target_account,' +
      'policy_version,resolved_at,scheduled_date,scheduled_time,timezone,slot_label,status,' +
      'superseded_by_version,generation,created_at,updated_at,lifecycle_state) ' +
      "VALUES (?,1,?,1,?,'x-primary',2,?,?,?,'America/Chicago',?,'active',NULL,2,?,?,'deferred')",
    ).run(
      item.id,
      item.id,
      item.digest,
      item.resolvedAt,
      item.scheduledDate,
      item.scheduledTime,
      item.slotLabel,
      RECORDED_AT,
      RECORDED_AT,
    );

    db.prepare(
      'INSERT INTO queue_deferrals ' +
      '(content_id,content_revision,assignment_id,assignment_version,assignment_generation,' +
      'policy_version,content_digest,target_account,prior_resolved_at,prior_scheduled_date,' +
      'prior_scheduled_time,prior_timezone,prior_slot_label,reason,deferred_at,state,generation,' +
      'replacement_assignment_version) ' +
      "VALUES (?,1,?,1,1,2,?,'x-primary',?,?,?,'America/Chicago',?,'missed_slot_grace_expired',?," +
      "'pending_replacement',1,NULL)",
    ).run(
      item.id,
      item.id,
      item.digest,
      item.resolvedAt,
      item.scheduledDate,
      item.scheduledTime,
      item.slotLabel,
      item.deferredAt,
    );

    db.prepare(
      'INSERT INTO publication_state ' +
      '(post_id,status,scheduled_at,tweet_id,prepared_at,publishing_at,posted_at,skipped_at,' +
      'skip_reason,last_error,updated_at,attempt_id,generation) ' +
      "VALUES (?,'scheduled',?,NULL,NULL,NULL,NULL,NULL,NULL,NULL,?,NULL,3)",
    ).run(item.id, item.resolvedAt, RECORDED_AT);
  }

  db.prepare(
    'INSERT INTO queue_assignments ' +
    '(assignment_id,assignment_version,content_id,content_revision,content_digest,target_account,' +
    'policy_version,resolved_at,scheduled_date,scheduled_time,timezone,slot_label,status,' +
    'superseded_by_version,generation,created_at,updated_at,lifecycle_state) ' +
    "VALUES ('F1',1,'F1',1,?,'x-primary',2,?,'2026-09-25','22:15'," +
    "'America/Chicago','post-close','active',NULL,1,?,?,'scheduled')",
  ).run(df, FRONTIER, RECORDED_AT, RECORDED_AT);

  db.prepare(
    'INSERT INTO queue_intake_frontier ' +
    '(singleton_id,generation,resolved_at,pending_operation_id,last_completed_operation_id,updated_at) ' +
    'VALUES (1,5,?,NULL,NULL,?)',
  ).run(FRONTIER, RECORDED_AT);

  const api = d1Adapter(db);
  const initialRows = await readDynamicRuntimeRows(api);
  const snapshot = await buildDynamicRuntimeSnapshot(initialRows);
  const revision = nextRuntimeRevision({
    currentState: null,
    snapshot,
    recordedAt: RECORDED_AT,
  });
  db.exec(renderRuntimeRevisionInsertSql(revision));

  return { db, api };
}

function frontier(db) {
  return db.prepare('SELECT * FROM queue_intake_frontier WHERE singleton_id=1').get();
}

function runtimeState(db) {
  return db.prepare(
    'SELECT generation,revision_digest,active_assignment_count,approved_unscheduled_count,' +
    'media_required_count,media_ready_count,source_operation_id,created_at AS updated_at ' +
    'FROM queue_runtime_revisions ORDER BY generation DESC LIMIT 1',
  ).get();
}

function occupied(db) {
  return db.prepare(
    'SELECT target_account,resolved_at,status,lifecycle_state FROM queue_assignments ' +
    "WHERE status='active' AND lifecycle_state='scheduled' ORDER BY resolved_at",
  ).all();
}

function pendingDeferrals(db) {
  return db.prepare(
    'SELECT ' +
    'a.assignment_id,a.assignment_version,a.content_id,a.content_revision,a.content_digest,' +
    'a.target_account,a.policy_version,a.generation AS assignment_generation,' +
    'a.status AS assignment_status,a.lifecycle_state,' +
    'd.generation AS deferral_generation,d.state AS deferral_state,d.prior_resolved_at,' +
    'd.prior_scheduled_date,d.prior_scheduled_time,d.prior_timezone,d.prior_slot_label,' +
    'p.status AS publication_status,p.generation AS publication_generation,' +
    'p.attempt_id AS publication_attempt_id,' +
    'c.pillar,c.intake_state,r.title,r.body,r.publication_text,' +
    'r.content_digest AS revision_content_digest,r.figure,r.source_ref ' +
    'FROM queue_assignments a ' +
    'JOIN queue_deferrals d ON d.content_id=a.content_id ' +
    'AND d.assignment_id=a.assignment_id AND d.assignment_version=a.assignment_version ' +
    'JOIN publication_state p ON p.post_id=a.content_id ' +
    'JOIN queue_content c ON c.content_id=a.content_id ' +
    'JOIN queue_content_revisions r ON r.content_id=a.content_id AND r.revision=a.content_revision ' +
    "WHERE a.status='active' AND a.lifecycle_state='deferred' " +
    "AND d.state='pending_replacement' ORDER BY d.prior_resolved_at,a.content_id",
  ).all();
}

async function buildTransaction(db, plan) {
  const rows = await readDynamicRuntimeRows(d1Adapter(db));
  const projected = projectReplacementRuntimeRows(plan, rows);
  const snapshot = await buildDynamicRuntimeSnapshot(projected);
  const revision = nextRuntimeRevision({
    currentState: runtimeState(db),
    snapshot,
    sourceOperationId: plan.operation_id,
    recordedAt: RECORDED_AT,
  });

  return [
    'BEGIN IMMEDIATE;',
    renderReplacementFrontierClaimSql(plan, RECORDED_AT),
    ...plan.items.map((item) => renderReplacementItemSql(plan, item, RECORDED_AT)),
    renderRuntimeRevisionInsertSql(revision, {
      additionalGuardSql: renderReplacementSuccessGuardSql(plan),
    }),
    renderReplacementFrontierReleaseSql(plan, RECORDED_AT),
    'COMMIT;',
  ].join('\n');
}

function readback(db, plan) {
  const items = plan.items.map((item) => {
    const oldRow = db.prepare(
      'SELECT status,superseded_by_version FROM queue_assignments ' +
      'WHERE assignment_id=? AND assignment_version=?',
    ).get(item.assignment_id, item.assignment_version);
    const newRow = db.prepare(
      'SELECT status,lifecycle_state,assignment_version,content_digest,policy_version,resolved_at ' +
      'FROM queue_assignments WHERE assignment_id=? AND assignment_version=?',
    ).get(item.assignment_id, item.to_assignment_version);
    const deferral = db.prepare(
      'SELECT state,replacement_assignment_version FROM queue_deferrals WHERE content_id=?',
    ).get(item.content_id);
    const pub = db.prepare(
      'SELECT status,scheduled_at FROM publication_state WHERE post_id=?',
    ).get(item.content_id);

    return {
      content_id: item.content_id,
      old_status: oldRow?.status,
      old_superseded_by_version: oldRow?.superseded_by_version,
      new_status: newRow?.status,
      new_lifecycle_state: newRow?.lifecycle_state,
      new_assignment_version: newRow?.assignment_version,
      new_content_digest: newRow?.content_digest,
      new_policy_version: newRow?.policy_version,
      new_resolved_at: newRow?.resolved_at,
      deferral_state: deferral?.state,
      replacement_assignment_version: deferral?.replacement_assignment_version,
      publication_status: pub?.status,
      publication_scheduled_at: pub?.scheduled_at,
    };
  });

  return {
    frontier: frontier(db),
    runtimeRevision: db.prepare(
      'SELECT * FROM queue_runtime_revisions WHERE source_operation_id=?',
    ).get(plan.operation_id),
    items,
  };
}

test('automatic replacement ordering is deterministic by prior instant then content id', async () => {
  const { db } = await fixture();
  const base = pendingDeferrals(db);
  const tied = base.map((row) => ({
    ...row,
    prior_resolved_at: '2026-09-18T19:30:00.000Z',
  }));
  const deferrals = tied.reverse();

  const a = planAutomaticReplacements({
    deferrals,
    frontier: frontier(db),
    runtimeState: runtimeState(db),
    policy: POLICY,
    occupiedAssignments: occupied(db),
    now: NOW,
  });
  const b = planAutomaticReplacements({
    deferrals: [...deferrals].reverse(),
    frontier: frontier(db),
    runtimeState: runtimeState(db),
    policy: POLICY,
    occupiedAssignments: occupied(db),
    now: NOW,
  });

  assert.equal(a.plan_digest, b.plan_digest);
  assert.equal(a.operation_id, b.operation_id);
  assert.deepEqual(a.items.map((item) => item.content_id), ['P1', 'P2']);
  assert.deepEqual(a.items.map((item) => item.to_assignment_version), [2, 2]);
  assert.deepEqual(a.items.map((item) => item.resolved_at), [
    '2026-09-28T19:30:00.000Z',
    '2026-09-29T03:15:00.000Z',
  ]);
  assert.equal(a.proposed_frontier_resolved_at, '2026-09-29T03:15:00.000Z');
});

test('replacement atomically supersedes old versions, advances frontier, and promotes runtime truth', async () => {
  const { db } = await fixture();
  const plan = planAutomaticReplacements({
    deferrals: pendingDeferrals(db),
    frontier: frontier(db),
    runtimeState: runtimeState(db),
    policy: POLICY,
    occupiedAssignments: occupied(db),
    now: NOW,
  });

  const sql = await buildTransaction(db, plan);
  db.exec(sql);

  assert.equal(classifyReplacementReadback(plan, readback(db, plan)), 'complete');

  for (const item of plan.items) {
    const versions = db.prepare(
      'SELECT assignment_version,status,lifecycle_state,superseded_by_version ' +
      'FROM queue_assignments WHERE assignment_id=? ORDER BY assignment_version',
    ).all(item.assignment_id);
    assert.equal(versions.length, 2);
    assert.equal(versions[0].status, 'superseded');
    assert.equal(versions[0].superseded_by_version, 2);
    assert.equal(versions[1].status, 'active');
    assert.equal(versions[1].lifecycle_state, 'scheduled');

    const deferral = db.prepare(
      'SELECT state,generation,replacement_assignment_version FROM queue_deferrals WHERE content_id=?',
    ).get(item.content_id);
    assert.equal(deferral.state, 'replaced');
    assert.equal(deferral.generation, 2);
    assert.equal(deferral.replacement_assignment_version, 2);

    const pub = db.prepare(
      'SELECT status,scheduled_at,generation FROM publication_state WHERE post_id=?',
    ).get(item.content_id);
    assert.equal(pub.status, 'scheduled');
    assert.equal(pub.scheduled_at, item.resolved_at);
    assert.equal(pub.generation, 4);
  }

  assert.equal(frontier(db).generation, 6);
  assert.equal(frontier(db).pending_operation_id, null);
  assert.equal(frontier(db).last_completed_operation_id, plan.operation_id);
  assert.equal(runtimeState(db).generation, 2);
  assert.equal(runtimeState(db).source_operation_id, plan.operation_id);
  assert.equal(
    db.prepare("SELECT COUNT(*) n FROM queue_deferral_events WHERE event_type='replaced'").get().n,
    2,
  );

  const beforeReplay = db.prepare('SELECT COUNT(*) n FROM queue_assignment_events').get().n;
  db.exec(sql);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM queue_assignment_events').get().n, beforeReplay);
  assert.equal(runtimeState(db).generation, 2);
});

test('a stale runtime head or occupied target slot prevents any replacement mutation', async () => {
  {
    const { db } = await fixture();
    const plan = planAutomaticReplacements({
      deferrals: pendingDeferrals(db),
      frontier: frontier(db),
      runtimeState: runtimeState(db),
      policy: POLICY,
      occupiedAssignments: occupied(db),
      now: NOW,
    });
    const sql = await buildTransaction(db, plan);
    const current = runtimeState(db);
    db.prepare(
      'INSERT INTO queue_runtime_revisions ' +
      '(generation,revision_digest,active_assignment_count,approved_unscheduled_count,' +
      'media_required_count,media_ready_count,previous_revision_digest,source_operation_id,created_at) ' +
      'VALUES (2,?,1,0,0,0,?,NULL,?)',
    ).run('e'.repeat(64), current.revision_digest, RECORDED_AT);

    db.exec(sql);
    assert.equal(
      db.prepare("SELECT COUNT(*) n FROM queue_assignments WHERE assignment_version=2").get().n,
      0,
    );
    assert.equal(frontier(db).generation, 5);
  }

  {
    const { db } = await fixture();
    const plan = planAutomaticReplacements({
      deferrals: pendingDeferrals(db),
      frontier: frontier(db),
      runtimeState: runtimeState(db),
      policy: POLICY,
      occupiedAssignments: occupied(db),
      now: NOW,
    });
    const target = plan.items[0];
    const sql = await buildTransaction(db, plan);
    const d = digest('collision');
    db.prepare(
      'INSERT INTO queue_content ' +
      "(content_id,pillar,current_revision,status,generation,created_at,updated_at,intake_state) " +
      "VALUES ('COLLIDE','A',1,'active',1,?,?,'scheduled')",
    ).run(RECORDED_AT, RECORDED_AT);
    db.prepare(
      'INSERT INTO queue_content_revisions ' +
      "(content_id,revision,title,body,publication_text,content_digest,figure,source_ref,created_at) " +
      "VALUES ('COLLIDE',1,'c','collision','collision',?,NULL,'fixture',?)",
    ).run(d, RECORDED_AT);
    db.prepare(
      'INSERT INTO queue_assignments ' +
      '(assignment_id,assignment_version,content_id,content_revision,content_digest,target_account,' +
      'policy_version,resolved_at,scheduled_date,scheduled_time,timezone,slot_label,status,' +
      'superseded_by_version,generation,created_at,updated_at,lifecycle_state) ' +
      "VALUES ('COLLIDE',1,'COLLIDE',1,?,'x-primary',2,?,?,?,'America/Chicago',?," +
      "'active',NULL,1,?,?,'scheduled')",
    ).run(
      d,
      target.resolved_at,
      target.scheduled_date,
      target.scheduled_time,
      target.slot_label,
      RECORDED_AT,
      RECORDED_AT,
    );

    db.exec(sql);
    assert.equal(
      db.prepare("SELECT COUNT(*) n FROM queue_assignments WHERE assignment_id='P1' AND assignment_version=2").get().n,
      0,
    );
    assert.equal(frontier(db).generation, 5);
  }
});

test('owner placement may use a future policy-valid hole before the frontier and is separately audited', async () => {
  const { db } = await fixture();
  const row = pendingDeferrals(db).find((item) => item.content_id === 'P1');
  const plan = planOwnerPlacement({
    deferral: row,
    frontier: frontier(db),
    runtimeState: runtimeState(db),
    policy: POLICY,
    occupiedAssignments: occupied(db),
    scheduledDate: '2026-09-23',
    scheduledTime: '14:30',
    now: NOW,
    reason: 'owner chose an earlier future opening',
  });

  assert.equal(plan.mode, 'owner');
  assert.equal(plan.items[0].resolved_at, '2026-09-23T19:30:00.000Z');
  assert.equal(plan.proposed_frontier_resolved_at, FRONTIER);

  db.exec(await buildTransaction(db, plan));
  assert.equal(classifyReplacementReadback(plan, readback(db, plan)), 'complete');
  assert.equal(frontier(db).resolved_at, FRONTIER);
  assert.equal(frontier(db).generation, 6);
  assert.equal(
    db.prepare(
      "SELECT COUNT(*) n FROM queue_assignment_events WHERE event_type='owner_replacement_assigned'",
    ).get().n,
    1,
  );
  assert.equal(
    db.prepare("SELECT COUNT(*) n FROM queue_deferral_events WHERE event_type='owner_replaced'").get().n,
    1,
  );
});

test('owner placement rejects invalid, occupied, and past slots', async () => {
  const { db } = await fixture();
  const row = pendingDeferrals(db)[0];
  const common = {
    deferral: row,
    frontier: frontier(db),
    runtimeState: runtimeState(db),
    policy: POLICY,
    occupiedAssignments: occupied(db),
    now: NOW,
    reason: 'owner test',
  };

  assert.throws(
    () => planOwnerPlacement({
      ...common,
      scheduledDate: '2026-09-26',
      scheduledTime: '14:30',
    }),
    /not policy-valid/,
  );
  assert.throws(
    () => planOwnerPlacement({
      ...common,
      scheduledDate: '2026-09-23',
      scheduledTime: '09:00',
    }),
    /not a policy slot/,
  );
  assert.throws(
    () => planOwnerPlacement({
      ...common,
      scheduledDate: '2026-09-18',
      scheduledTime: '14:30',
    }),
    /future/,
  );
  assert.throws(
    () => planOwnerPlacement({
      ...common,
      scheduledDate: '2026-09-25',
      scheduledTime: '22:15',
    }),
    /already occupied/,
  );
});

test('stale assignment versions fail closed at the reusable publication fence', async () => {
  const { db, api } = await fixture();
  const plan = planAutomaticReplacements({
    deferrals: pendingDeferrals(db),
    frontier: frontier(db),
    runtimeState: runtimeState(db),
    policy: POLICY,
    occupiedAssignments: occupied(db),
    now: NOW,
  });
  db.exec(await buildTransaction(db, plan));

  const item = plan.items[0];
  const current = db.prepare(
    'SELECT assignment_id,assignment_version,content_id,content_digest,policy_version,' +
    'status,lifecycle_state FROM queue_assignments ' +
    'WHERE assignment_id=? AND assignment_version=?',
  ).get(item.assignment_id, item.to_assignment_version);

  assert.equal(compareAssignmentFence({
    assignment_id: item.assignment_id,
    assignment_version: item.assignment_version,
    content_id: item.content_id,
    policy_version: item.prior_policy_version,
    content_digest: item.content_digest,
  }, current).ok, false);

  const stale = await verifyCurrentAssignmentFence(api, {
    assignment_id: item.assignment_id,
    assignment_version: item.assignment_version,
    content_id: item.content_id,
    policy_version: item.prior_policy_version,
    content_digest: item.content_digest,
  });
  assert.deepEqual(stale.reason, 'stale_assignment_identity');

  const exact = await verifyCurrentAssignmentFence(api, {
    assignment_id: item.assignment_id,
    assignment_version: item.to_assignment_version,
    content_id: item.content_id,
    policy_version: item.policy_version,
    content_digest: item.content_digest,
  });
  assert.equal(exact.ok, true);
});

test('concurrent plans sharing one frontier cannot both claim scheduling authority', async () => {
  const { db } = await fixture();
  const rows = pendingDeferrals(db);
  const base = {
    frontier: frontier(db),
    runtimeState: runtimeState(db),
    policy: POLICY,
    occupiedAssignments: occupied(db),
    now: NOW,
  };

  const first = planAutomaticReplacements({ ...base, deferrals: [rows[0]] });
  const second = planAutomaticReplacements({ ...base, deferrals: [rows[1]] });

  // Both candidates are frozen against the same starting frontier/runtime.
  // Only one may win; the second must fail closed when replayed afterward.
  const firstSql = await buildTransaction(db, first);
  const secondSql = await buildTransaction(db, second);
  db.exec(firstSql);
  db.exec(secondSql);

  assert.equal(
    db.prepare(
      "SELECT COUNT(*) n FROM queue_assignments WHERE assignment_id=? AND assignment_version=2",
    ).get(rows[1].assignment_id).n,
    0,
  );
  assert.equal(frontier(db).last_completed_operation_id, first.operation_id);
});


test('losing same-item replacement plan cannot append false evidence', async () => {
  const { db } = await fixture();
  const row = pendingDeferrals(db).find((item) => item.content_id === 'P1');
  const base = {
    deferral: row,
    frontier: frontier(db),
    runtimeState: runtimeState(db),
    policy: POLICY,
    occupiedAssignments: occupied(db),
    now: NOW,
  };

  const first = planOwnerPlacement({
    ...base,
    scheduledDate: '2026-09-23',
    scheduledTime: '14:30',
    reason: 'first owner placement',
  });
  const losing = planOwnerPlacement({
    ...base,
    scheduledDate: '2026-09-24',
    scheduledTime: '14:30',
    reason: 'losing owner placement',
  });

  const firstSql = await buildTransaction(db, first);
  const losingSql = await buildTransaction(db, losing);

  db.exec(firstSql);
  const assignmentEventsBefore = db.prepare(
    "SELECT COUNT(*) n FROM queue_assignment_events",
  ).get().n;
  const deferralEventsBefore = db.prepare(
    "SELECT COUNT(*) n FROM queue_deferral_events",
  ).get().n;

  db.exec(losingSql);

  assert.equal(
    db.prepare("SELECT COUNT(*) n FROM queue_assignment_events").get().n,
    assignmentEventsBefore,
  );
  assert.equal(
    db.prepare("SELECT COUNT(*) n FROM queue_deferral_events").get().n,
    deferralEventsBefore,
  );
  assert.equal(
    db.prepare(
      "SELECT COUNT(*) n FROM queue_assignment_events WHERE detail LIKE ?",
    ).get('%' + losing.operation_id + '%').n,
    0,
  );
  assert.equal(
    db.prepare(
      "SELECT COUNT(*) n FROM queue_deferral_events WHERE detail LIKE ?",
    ).get('%' + losing.operation_id + '%').n,
    0,
  );

  const current = db.prepare(
    "SELECT resolved_at FROM queue_assignments WHERE assignment_id='P1' AND assignment_version=2",
  ).get();
  assert.equal(current.resolved_at, first.items[0].resolved_at);
});
