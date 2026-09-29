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
    raw.prepare('SELECT generation,active_operation_id FROM mutation_lane_state WHERE singleton_id=1').get(),
    { generation: 2, active_operation_id: controlPlan.operation_id },
  );
  assert.deepEqual(
    raw.prepare('SELECT generation,pending_operation_id FROM queue_intake_frontier WHERE singleton_id=1').get(),
    { generation: 6, pending_operation_id: intakePlan.operation_id },
  );
  assert.deepEqual(
    raw.prepare('SELECT state,effect_state,resulting_runtime_generation FROM mutation_operations WHERE operation_id=?')
      .get(controlPlan.operation_id),
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

  const completion = intakeCompletionEvidence(controlPlan, runtimeRevision);
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
    raw.prepare('SELECT generation,active_operation_id FROM mutation_lane_state WHERE singleton_id=1').get(),
    { generation: 2, active_operation_id: null },
  );
  assert.deepEqual(
    raw.prepare('SELECT pending_operation_id,last_completed_operation_id FROM queue_intake_frontier WHERE singleton_id=1').get(),
    { pending_operation_id: null, last_completed_operation_id: intakePlan.operation_id },
  );
  assert.deepEqual(
    raw.prepare('SELECT state,outcome,effect_state,evidence_digest FROM mutation_operations WHERE operation_id=?')
      .get(controlPlan.operation_id),
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
    raw.prepare('SELECT generation,active_operation_id FROM mutation_lane_state WHERE singleton_id=1').get(),
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
