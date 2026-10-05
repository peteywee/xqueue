import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
  createIntakeMutationControlPlan,
  intakeMutationCheckpointEvidence,
  verifyIntakeMutationCompletion,
} from '../src/mutation-intake-adapter.mjs';
import {
  intakeCompletionEvidence,
  prepareIntakeAtomicApply,
  prepareIntakeAtomicFinalize,
  projectIntakeRuntimeRevision,
  readIntakeMutationCompletion,
} from '../src/mutation-intake-d1.mjs';

function sha256(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

class D1Statement {
  constructor(db, sql) {
    this.db = db;
    this.sql = sql;
    this.args = [];
  }

  bind(...args) {
    this.args = args;
    return this;
  }

  async run() {
    const info = this.db.prepare(this.sql).run(...this.args);
    return { success: true, meta: { changes: Number(info.changes) } };
  }

  async first() {
    return this.db.prepare(this.sql).get(...this.args) ?? null;
  }
}

class SqliteD1 {
  constructor(db) {
    this.db = db;
  }

  prepare(sql) {
    return new D1Statement(this.db, sql);
  }

  async batch(statements) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const out = [];
      for (const statement of statements) out.push(await statement.run());
      this.db.exec('COMMIT');
      return out;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
}

function loadSchema(db) {
  const dir = join(process.cwd(), 'cloudflare', 'migrations');
  for (const name of readdirSync(dir).filter((x) => /^\d+.*\.sql$/.test(x)).sort()) {
    db.exec(readFileSync(join(dir, name), 'utf8'));
  }
}

function fixture() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys=ON');
  loadSchema(db);

  db.prepare(
    'INSERT INTO queue_intake_frontier ' +
      '(singleton_id,generation,resolved_at,pending_operation_id,last_completed_operation_id,updated_at) ' +
      'VALUES (1,5,?,NULL,NULL,?)',
  ).run('2026-09-29T10:00:00.000Z', '2026-09-29T10:00:00.000Z');

  db.prepare(
    'INSERT INTO queue_runtime_revisions ' +
      '(generation,revision_digest,active_assignment_count,approved_unscheduled_count,media_required_count,media_ready_count,' +
      'previous_revision_digest,source_operation_id,created_at) VALUES (11,?,0,0,0,0,?,NULL,?)',
  ).run('a'.repeat(64), 'b'.repeat(64), '2026-09-29T10:00:00.000Z');

  return { raw: db, d1: new SqliteD1(db) };
}

function plans() {
  const body = 'Approved atomic intake test body.';
  const contentDigest = sha256(body);
  const intakePlan = {
    operation_id: 'intake-' + 'd'.repeat(24),
    plan_digest: 'd'.repeat(64),
    batch_digest: 'c'.repeat(64),
    count: 1,
    expected_frontier_generation: 5,
    expected_frontier_resolved_at: '2026-09-29T10:00:00.000Z',
    proposed_frontier_resolved_at: '2026-09-30T10:00:00.000Z',
    baseline_assignment_hash: 'b'.repeat(64),
    expected_runtime_generation: 11,
    expected_runtime_revision_digest: 'a'.repeat(64),
    target_account: 'x-primary',
    policy_version: 2,
    items: [{
      ordinal: 0,
      content_id: 'I-ATOMIC-1',
      content_digest: contentDigest,
      pillar: 'A',
      title: 'Atomic test',
      body,
      publication_text: body,
      source_ref: 'test',
      assignment_id: 'I-ATOMIC-1',
      assignment_version: 1,
      content_revision: 1,
      target_account: 'x-primary',
      policy_version: 2,
      resolved_at: '2026-09-30T10:00:00.000Z',
      scheduled_date: '2026-09-30',
      scheduled_time: '05:00',
      timezone: 'America/Chicago',
      slot_label: 'lull',
    }],
  };

  const state = {
    haltState: { halted: 0, generation: 1 },
    laneState: { generation: 1, active_operation_id: null },
    runtimeState: { generation: 11, revision_digest: 'a'.repeat(64) },
  };
  const controlPlan = createIntakeMutationControlPlan({ intakePlan, ...state });
  return { intakePlan, controlPlan, state };
}

async function projected(intakePlan, controlPlan, state) {
  return projectIntakeRuntimeRevision({
    intakePlan,
    controlPlan,
    currentRuntimeState: state.runtimeState,
    assignments: [],
    deferred: [],
    approvedUnscheduled: [],
    media: [],
    recordedAt: '2026-09-29T10:05:00.000Z',
  });
}

test('atomic intake apply commits canonical writes in VERIFYING and finalize releases both fences', async () => {
  const { raw, d1 } = fixture();
  const { intakePlan, controlPlan, state } = plans();
  const runtimeRevision = await projected(intakePlan, controlPlan, state);
  const checkpoint = intakeMutationCheckpointEvidence(
    controlPlan,
    'bookmark_12345',
    '2026-09-29T10:04:00.000Z',
  );

  const apply = prepareIntakeAtomicApply({
    db: d1,
    controlPlan,
    intakePlan,
    runtimeRevision,
    checkpointEvidence: checkpoint,
    recordedAt: '2026-09-29T10:05:00.000Z',
  });

  assert.ok(apply.statements.length > 10);
  assert.equal(apply.statements.some((x) => /\bBEGIN\b|\bCOMMIT\b/i.test(x.sql)), false);
  assert.equal(apply.statements.some((x) => /INSERT OR IGNORE/i.test(x.sql)), false);

  await d1.batch(apply.statements);

  assert.deepEqual(
    { ...raw.prepare('SELECT generation,active_operation_id FROM mutation_lane_state WHERE singleton_id=1').get() },
    { generation: 2, active_operation_id: controlPlan.operation_id },
  );
  assert.deepEqual(
    { ...raw.prepare('SELECT generation,pending_operation_id FROM queue_intake_frontier WHERE singleton_id=1').get() },
    { generation: 6, pending_operation_id: intakePlan.operation_id },
  );
  assert.deepEqual(
    { ...raw.prepare('SELECT state,effect_state,resulting_runtime_generation FROM mutation_operations WHERE operation_id=?')
      .get(controlPlan.operation_id) },
    { state: 'VERIFYING', effect_state: 'applied', resulting_runtime_generation: 12 },
  );
  assert.equal(
    raw.prepare('SELECT intake_state FROM queue_content WHERE content_id=?').get('I-ATOMIC-1').intake_state,
    'scheduled',
  );
  assert.equal(
    raw.prepare('SELECT source_operation_id FROM queue_runtime_revisions WHERE generation=12').get().source_operation_id,
    controlPlan.operation_id,
  );

  const observed = await readIntakeMutationCompletion({ db: d1, controlPlan, intakePlan });
  const completion = intakeCompletionEvidence(controlPlan, observed);
  assert.equal(verifyIntakeMutationCompletion(controlPlan, completion.observed).ok, true);

  const finalize = prepareIntakeAtomicFinalize({
    db: d1,
    controlPlan,
    intakePlan,
    runtimeRevision,
    completionEvidence: completion,
    recordedAt: '2026-09-29T10:06:00.000Z',
  });
  await d1.batch(finalize.statements);

  assert.deepEqual(
    { ...raw.prepare('SELECT generation,active_operation_id FROM mutation_lane_state WHERE singleton_id=1').get() },
    { generation: 2, active_operation_id: null },
  );
  assert.deepEqual(
    { ...raw.prepare('SELECT pending_operation_id,last_completed_operation_id FROM queue_intake_frontier WHERE singleton_id=1').get() },
    { pending_operation_id: null, last_completed_operation_id: intakePlan.operation_id },
  );
  assert.deepEqual(
    { ...raw.prepare('SELECT state,outcome,effect_state,evidence_digest FROM mutation_operations WHERE operation_id=?')
      .get(controlPlan.operation_id) },
    {
      state: 'COMPLETE',
      outcome: 'AUTO_RESOLVE',
      effect_state: 'applied',
      evidence_digest: completion.evidence_digest,
    },
  );

  raw.close();
});

test('stale frontier aborts and rolls back the lane claim and every canonical write', async () => {
  const { raw, d1 } = fixture();
  const { intakePlan, controlPlan, state } = plans();
  const runtimeRevision = await projected(intakePlan, controlPlan, state);
  const checkpoint = intakeMutationCheckpointEvidence(
    controlPlan,
    'bookmark_12345',
    '2026-09-29T10:04:00.000Z',
  );

  raw.prepare(
    'UPDATE queue_intake_frontier SET generation=6,resolved_at=? WHERE singleton_id=1',
  ).run('2026-09-29T11:00:00.000Z');

  const apply = prepareIntakeAtomicApply({
    db: d1,
    controlPlan,
    intakePlan,
    runtimeRevision,
    checkpointEvidence: checkpoint,
    recordedAt: '2026-09-29T10:05:00.000Z',
  });

  await assert.rejects(d1.batch(apply.statements));

  assert.deepEqual(
    { ...raw.prepare('SELECT generation,active_operation_id FROM mutation_lane_state WHERE singleton_id=1').get() },
    { generation: 1, active_operation_id: null },
  );
  assert.equal(
    raw.prepare('SELECT COUNT(*) AS n FROM mutation_operations').get().n,
    0,
  );
  assert.equal(
    raw.prepare('SELECT COUNT(*) AS n FROM queue_content WHERE content_id=?').get('I-ATOMIC-1').n,
    0,
  );
  assert.equal(
    raw.prepare('SELECT MAX(generation) AS generation FROM queue_runtime_revisions').get().generation,
    11,
  );

  raw.close();
});

test('checkpoint and projected runtime are mandatory exact fences', async () => {
  const { raw, d1 } = fixture();
  const { intakePlan, controlPlan, state } = plans();
  const runtimeRevision = await projected(intakePlan, controlPlan, state);
  const checkpoint = intakeMutationCheckpointEvidence(
    controlPlan,
    'bookmark_12345',
    '2026-09-29T10:04:00.000Z',
  );

  assert.throws(() => prepareIntakeAtomicApply({
    db: d1,
    controlPlan,
    intakePlan,
    runtimeRevision,
    checkpointEvidence: { ...checkpoint, expected_lane_generation: 99 },
    recordedAt: '2026-09-29T10:05:00.000Z',
  }), /checkpoint lane generation mismatch/);

  assert.throws(() => prepareIntakeAtomicApply({
    db: d1,
    controlPlan,
    intakePlan,
    runtimeRevision: { ...runtimeRevision, previous_revision_digest: 'f'.repeat(64) },
    checkpointEvidence: checkpoint,
    recordedAt: '2026-09-29T10:05:00.000Z',
  }), /projected runtime revision does not match/);

  raw.close();
});


test('completion reader distinguishes canonical contradiction from read unavailability', async () => {
  const { raw, d1 } = fixture();
  const { intakePlan, controlPlan, state } = plans();
  const runtimeRevision = await projected(intakePlan, controlPlan, state);
  const checkpoint = intakeMutationCheckpointEvidence(
    controlPlan,
    'bookmark_12345',
    '2026-09-29T10:04:00.000Z',
  );
  const apply = prepareIntakeAtomicApply({
    db: d1,
    controlPlan,
    intakePlan,
    runtimeRevision,
    checkpointEvidence: checkpoint,
    recordedAt: '2026-09-29T10:05:00.000Z',
  });
  await d1.batch(apply.statements);

  await assert.rejects(
    () => readIntakeMutationCompletion({
      db: d1,
      controlPlan: { ...controlPlan, plan_digest: 'f'.repeat(64) },
      intakePlan,
    }),
    (error) =>
      error?.readback === 'contradictory' &&
      /mutation operation readback is not exact applied state/.test(error.message),
  );

  await assert.rejects(
    () => readIntakeMutationCompletion({
      db: d1,
      controlPlan: {
        ...controlPlan,
        plan_context: { ...controlPlan.plan_context, intake_plan_digest: 'e'.repeat(64) },
      },
      intakePlan,
    }),
    (error) =>
      error?.readback === 'contradictory' &&
      /intake plan digest does not match mutation plan/.test(error.message),
  );

  const unavailableDb = {
    prepare() {
      throw new Error('network timeout reading D1');
    },
  };
  await assert.rejects(
    () => readIntakeMutationCompletion({
      db: unavailableDb,
      controlPlan,
      intakePlan,
    }),
    (error) =>
      error?.readback === 'unavailable' &&
      /network timeout reading D1/.test(error.message),
  );

  raw.close();
});

test('exact completion readback refuses corrupted canonical item state', async () => {
  const { raw, d1 } = fixture();
  const { intakePlan, controlPlan, state } = plans();
  const runtimeRevision = await projected(intakePlan, controlPlan, state);
  const checkpoint = intakeMutationCheckpointEvidence(
    controlPlan,
    'bookmark_12345',
    '2026-09-29T10:04:00.000Z',
  );

  const apply = prepareIntakeAtomicApply({
    db: d1,
    controlPlan,
    intakePlan,
    runtimeRevision,
    checkpointEvidence: checkpoint,
    recordedAt: '2026-09-29T10:05:00.000Z',
  });
  await d1.batch(apply.statements);

  raw.prepare(
    "UPDATE queue_content SET intake_state='approved_unscheduled' WHERE content_id=?",
  ).run('I-ATOMIC-1');

  const observed = await readIntakeMutationCompletion({ db: d1, controlPlan, intakePlan });
  assert.equal(observed.items[0].readback_status, 'conflict');
  assert.throws(
    () => intakeCompletionEvidence(controlPlan, observed),
    /completion readback is not exact/,
  );

  raw.close();
});

// The publisher fences every post on its publication_state row and treats a
// missing row as protected, so guarded intake must keep active assignments and
// publication_state in exact set parity.
async function appliedIntake() {
  const { raw, d1 } = fixture();
  const { intakePlan, controlPlan, state } = plans();
  const runtimeRevision = await projected(intakePlan, controlPlan, state);
  const checkpoint = intakeMutationCheckpointEvidence(controlPlan, 'bookmark_12345', '2026-09-29T10:04:00.000Z');
  const apply = prepareIntakeAtomicApply({
    db: d1, controlPlan, intakePlan, runtimeRevision, checkpointEvidence: checkpoint, recordedAt: '2026-09-29T10:05:00.000Z',
  });
  await d1.batch(apply.statements);
  return { raw, d1, intakePlan, controlPlan, runtimeRevision };
}

test('guarded intake writes a scheduled publication_state row with every assignment', async () => {
  const { raw, d1, intakePlan, controlPlan, runtimeRevision } = await appliedIntake();
  assert.deepEqual(
    { ...raw.prepare(
      'SELECT status,scheduled_at,scheduled_date,scheduled_time,timezone,slot,title,attempt_id,tweet_id,generation ' +
        'FROM publication_state WHERE post_id=?',
    ).get('I-ATOMIC-1') },
    {
      status: 'scheduled',
      scheduled_at: '2026-09-30T10:00:00.000Z',
      scheduled_date: '2026-09-30',
      scheduled_time: '05:00',
      timezone: 'America/Chicago',
      slot: 'lull',
      title: 'Atomic test',
      attempt_id: null,
      tweet_id: null,
      generation: 1,
    },
  );
  const parity = (sql) => raw.prepare(sql).get().n;
  assert.equal(parity(
    "SELECT COUNT(*) n FROM queue_assignments a LEFT JOIN publication_state p ON p.post_id=a.content_id WHERE a.status='active' AND p.post_id IS NULL",
  ), 0);
  assert.equal(parity(
    "SELECT COUNT(*) n FROM publication_state p LEFT JOIN queue_assignments a ON a.content_id=p.post_id AND a.status='active' WHERE a.content_id IS NULL",
  ), 0);

  const observed = await readIntakeMutationCompletion({ db: d1, controlPlan, intakePlan });
  const completion = intakeCompletionEvidence(controlPlan, observed);
  await d1.batch(prepareIntakeAtomicFinalize({
    db: d1, controlPlan, intakePlan, runtimeRevision, completionEvidence: completion, recordedAt: '2026-09-29T10:06:00.000Z',
  }).statements);
  assert.equal(raw.prepare('SELECT state FROM mutation_operations WHERE operation_id=?').get(controlPlan.operation_id).state, 'COMPLETE');
  raw.close();
});

test('completion readback refuses a missing or inexact publication_state row', async () => {
  for (const [name, corrupt] of [
    ['missing', "DELETE FROM publication_state WHERE post_id='I-ATOMIC-1'"],
    ['wrong time', "UPDATE publication_state SET scheduled_at='2026-09-30T11:00:00.000Z' WHERE post_id='I-ATOMIC-1'"],
    ['wrong slot', "UPDATE publication_state SET slot='rush' WHERE post_id='I-ATOMIC-1'"],
    ['wrong date', "UPDATE publication_state SET scheduled_date='2026-10-01' WHERE post_id='I-ATOMIC-1'"],
    ['wrong wall time', "UPDATE publication_state SET scheduled_time='06:00' WHERE post_id='I-ATOMIC-1'"],
    ['wrong zone', "UPDATE publication_state SET timezone='UTC' WHERE post_id='I-ATOMIC-1'"],
    ['skipped', "UPDATE publication_state SET status='skipped',skipped_at='2026-09-29T10:05:30.000Z',skip_reason='x' WHERE post_id='I-ATOMIC-1'"],
    ['scheduled but claimed by an attempt', "UPDATE publication_state SET attempt_id='attempt-1234' WHERE post_id='I-ATOMIC-1'"],
    ['publishing without an attempt', "UPDATE publication_state SET status='publishing' WHERE post_id='I-ATOMIC-1'"],
    ['posted without an attempt', "UPDATE publication_state SET status='posted',tweet_id='1999' WHERE post_id='I-ATOMIC-1'"],
  ]) {
    const { raw, d1, intakePlan, controlPlan } = await appliedIntake();
    raw.exec(corrupt);
    const observed = await readIntakeMutationCompletion({ db: d1, controlPlan, intakePlan });
    assert.notEqual(observed.items[0].readback_status, 'applied', name);
    assert.throws(() => intakeCompletionEvidence(controlPlan, observed), /completion readback is not exact/, name);
    raw.close();
  }
});

test('finalize aborts atomically if the publication_state row changed after readback', async () => {
  for (const [name, corrupt] of [
    ['scheduled but claimed by an attempt', "UPDATE publication_state SET attempt_id='attempt-1234' WHERE post_id='I-ATOMIC-1'"],
    ['slot changed', "UPDATE publication_state SET slot='rush' WHERE post_id='I-ATOMIC-1'"],
    ['date changed', "UPDATE publication_state SET scheduled_date='2026-10-01' WHERE post_id='I-ATOMIC-1'"],
    ['wall time changed', "UPDATE publication_state SET scheduled_time='06:00' WHERE post_id='I-ATOMIC-1'"],
    ['zone changed', "UPDATE publication_state SET timezone='UTC' WHERE post_id='I-ATOMIC-1'"],
  ]) {
    const { raw, d1, intakePlan, controlPlan, runtimeRevision } = await appliedIntake();
    const observed = await readIntakeMutationCompletion({ db: d1, controlPlan, intakePlan });
    const completion = intakeCompletionEvidence(controlPlan, observed);
    raw.exec(corrupt);
    await assert.rejects(d1.batch(prepareIntakeAtomicFinalize({
      db: d1, controlPlan, intakePlan, runtimeRevision, completionEvidence: completion, recordedAt: '2026-09-29T10:06:00.000Z',
    }).statements), undefined, name);
    assert.deepEqual(
      { ...raw.prepare('SELECT state,effect_state FROM mutation_operations WHERE operation_id=?').get(controlPlan.operation_id) },
      { state: 'VERIFYING', effect_state: 'applied' },
      name,
    );
    assert.equal(raw.prepare('SELECT active_operation_id FROM mutation_lane_state WHERE singleton_id=1').get().active_operation_id, controlPlan.operation_id, name);
    raw.close();
  }
});

test('finalize still commits when the publisher claims the post between readback and finalize', async () => {
  const { raw, d1, intakePlan, controlPlan, runtimeRevision } = await appliedIntake();
  const observed = await readIntakeMutationCompletion({ db: d1, controlPlan, intakePlan });
  const completion = intakeCompletionEvidence(controlPlan, observed);
  raw.exec("UPDATE publication_state SET status='publishing',attempt_id='attempt-1234',generation=generation+1 WHERE post_id='I-ATOMIC-1'");
  await d1.batch(prepareIntakeAtomicFinalize({
    db: d1, controlPlan, intakePlan, runtimeRevision, completionEvidence: completion, recordedAt: '2026-09-29T10:06:00.000Z',
  }).statements);
  assert.equal(raw.prepare('SELECT state FROM mutation_operations WHERE operation_id=?').get(controlPlan.operation_id).state, 'COMPLETE');
  raw.close();
});
