import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { createIntakeMutationControlPlan } from '../src/mutation-intake-adapter.mjs';
import { projectIntakeRuntimeRevision } from '../src/mutation-intake-d1.mjs';
import { runIntakeMutation } from '../src/mutation-intake-runner.mjs';
import {
  classifyD1TransportException,
  createD1MutationTransport,
} from '../src/mutation-control-transport.mjs';

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

  async all() {
    return { results: this.db.prepare(this.sql).all(...this.args) };
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
  const raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys=ON');
  loadSchema(raw);

  raw.prepare(
    'INSERT INTO queue_intake_frontier ' +
      '(singleton_id,generation,resolved_at,pending_operation_id,last_completed_operation_id,updated_at) ' +
      'VALUES (1,5,?,NULL,NULL,?)',
  ).run('2026-09-29T10:00:00.000Z', '2026-09-29T10:00:00.000Z');

  raw.prepare(
    'INSERT INTO queue_runtime_revisions ' +
      '(generation,revision_digest,active_assignment_count,approved_unscheduled_count,media_required_count,media_ready_count,' +
      'previous_revision_digest,source_operation_id,created_at) VALUES (11,?,0,0,0,0,?,NULL,?)',
  ).run('a'.repeat(64), 'b'.repeat(64), '2026-09-29T10:00:00.000Z');

  const db = new SqliteD1(raw);
  let checkpointCalls = 0;
  const transport = createD1MutationTransport({
    db,
    accountId: 'acct',
    databaseId: 'db',
    apiToken: 'token',
    fetchImpl: async () => {
      checkpointCalls++;
      return {
        ok: true,
        json: async () => ({
          success: true,
          result: { bookmark: 'bookmark_12345' },
        }),
      };
    },
  });

  return {
    raw,
    db,
    transport,
    checkpointCalls: () => checkpointCalls,
  };
}

function plans({ count = 1 } = {}) {
  const items = [];
  for (let index = 0; index < count; index++) {
    const body = 'Approved adversarial intake body ' + (index + 1) + '.';
    const contentDigest = sha256(body);
    items.push({
      ordinal: index,
      content_id: 'I-ADV-' + (index + 1),
      content_digest: contentDigest,
      pillar: 'A',
      title: 'Adversarial ' + (index + 1),
      body,
      publication_text: body,
      source_ref: 'adversarial-test',
      assignment_id: 'I-ADV-' + (index + 1),
      assignment_version: 1,
      content_revision: 1,
      target_account: 'x-primary',
      policy_version: 2,
      resolved_at: index === 0
        ? '2026-09-30T10:00:00.000Z'
        : '2026-10-01T10:00:00.000Z',
      scheduled_date: index === 0 ? '2026-09-30' : '2026-10-01',
      scheduled_time: '05:00',
      timezone: 'America/Chicago',
      slot_label: 'lull',
    });
  }

  const intakePlan = {
    operation_id: 'intake-' + 'd'.repeat(24),
    plan_digest: 'd'.repeat(64),
    batch_digest: 'c'.repeat(64),
    count,
    expected_frontier_generation: 5,
    expected_frontier_resolved_at: '2026-09-29T10:00:00.000Z',
    proposed_frontier_resolved_at: items.at(-1).resolved_at,
    baseline_assignment_hash: 'b'.repeat(64),
    expected_runtime_generation: 11,
    expected_runtime_revision_digest: 'a'.repeat(64),
    target_account: 'x-primary',
    policy_version: 2,
    items,
  };

  const state = {
    haltState: { halted: 0, generation: 1 },
    laneState: { generation: 1, active_operation_id: null },
    runtimeState: { generation: 11, revision_digest: 'a'.repeat(64) },
  };

  return {
    intakePlan,
    state,
    controlPlan: createIntakeMutationControlPlan({ intakePlan, ...state }),
  };
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

test('exact replay is idempotent and does not capture a second checkpoint', async () => {
  const fx = fixture();
  const { intakePlan, controlPlan, state } = plans();
  const revision = await projected(intakePlan, controlPlan, state);

  const first = await runIntakeMutation({
    intakePlan,
    controlPlan,
    runtimeRevision: revision,
    transport: fx.transport,
    recordedAt: '2026-09-29T10:05:00.000Z',
  });
  const second = await runIntakeMutation({
    intakePlan,
    controlPlan,
    runtimeRevision: revision,
    transport: fx.transport,
    recordedAt: '2026-09-29T10:07:00.000Z',
  });

  assert.equal(first.status, 'applied');
  assert.equal(second.status, 'already_applied');
  assert.equal(fx.checkpointCalls(), 1);
  assert.equal(
    fx.raw.prepare(
      'SELECT COUNT(*) AS n FROM queue_runtime_revisions WHERE source_operation_id=?',
    ).get(controlPlan.operation_id).n,
    1,
  );

  fx.raw.close();
});

test('halt-generation race after preflight fails closed before canonical apply', async () => {
  const fx = fixture();
  const { intakePlan, controlPlan, state } = plans();
  const revision = await projected(intakePlan, controlPlan, state);
  let batchCalls = 0;

  const transport = {
    ...fx.transport,
    async captureCheckpoint() {
      const bookmark = await fx.transport.captureCheckpoint();
      fx.raw.prepare(
        "UPDATE mutation_lane_halt_state SET halted=1,generation=2,reason='race',actor_class='automation',updated_at=? " +
          'WHERE singleton_id=1 AND halted=0 AND generation=1',
      ).run('2026-09-29T10:04:30.000Z');
      return bookmark;
    },
    async batch(statements) {
      batchCalls++;
      return fx.transport.batch(statements);
    },
  };

  const result = await runIntakeMutation({
    intakePlan,
    controlPlan,
    runtimeRevision: revision,
    transport,
    recordedAt: '2026-09-29T10:05:00.000Z',
  });

  assert.equal(result.status, 'blocked');
  assert.equal(batchCalls, 1);
  assert.equal(
    fx.raw.prepare('SELECT COUNT(*) AS n FROM mutation_operations').get().n,
    0,
  );
  assert.deepEqual(
    { ...fx.raw.prepare(
      'SELECT generation,active_operation_id FROM mutation_lane_state WHERE singleton_id=1',
    ).get() },
    { generation: 1, active_operation_id: null },
  );

  fx.raw.close();
});

test('concurrent lane claim after preflight cannot be overwritten by intake', async () => {
  const fx = fixture();
  const { intakePlan, controlPlan, state } = plans();
  const revision = await projected(intakePlan, controlPlan, state);

  const transport = {
    ...fx.transport,
    async captureCheckpoint() {
      const bookmark = await fx.transport.captureCheckpoint();
      fx.raw.prepare(
        "UPDATE mutation_lane_state SET generation=2,active_operation_id='other-operation',actor_class='automation',updated_at=? " +
          'WHERE singleton_id=1 AND generation=1 AND active_operation_id IS NULL',
      ).run('2026-09-29T10:04:30.000Z');
      return bookmark;
    },
  };

  const result = await runIntakeMutation({
    intakePlan,
    controlPlan,
    runtimeRevision: revision,
    transport,
    recordedAt: '2026-09-29T10:05:00.000Z',
  });

  assert.equal(result.status, 'blocked');
  assert.equal(
    fx.raw.prepare('SELECT COUNT(*) AS n FROM mutation_operations').get().n,
    0,
  );
  assert.deepEqual(
    { ...fx.raw.prepare(
      'SELECT generation,active_operation_id FROM mutation_lane_state WHERE singleton_id=1',
    ).get() },
    { generation: 2, active_operation_id: 'other-operation' },
  );

  fx.raw.close();
});

test('lost finalize response after commit is recovered from COMPLETE readback', async () => {
  const fx = fixture();
  const { intakePlan, controlPlan, state } = plans();
  const revision = await projected(intakePlan, controlPlan, state);
  let batchCalls = 0;

  const transport = {
    ...fx.transport,
    async batch(statements) {
      batchCalls++;
      if (batchCalls === 2) {
        await fx.transport.batch(statements);
        throw new Error('network timeout after finalize commit');
      }
      return fx.transport.batch(statements);
    },
  };

  const result = await runIntakeMutation({
    intakePlan,
    controlPlan,
    runtimeRevision: revision,
    transport,
    recordedAt: '2026-09-29T10:05:00.000Z',
  });

  assert.equal(result.status, 'applied');
  assert.equal(result.phase, 'finalize_readback');
  assert.equal(result.recovered, true);
  assert.equal(batchCalls, 2);
  assert.equal(
    fx.raw.prepare(
      'SELECT state FROM mutation_operations WHERE operation_id=?',
    ).get(controlPlan.operation_id).state,
    'COMPLETE',
  );

  fx.raw.close();
});

test('contradictory item readback blocks finalize and leaves the lane claimed', async () => {
  const fx = fixture();
  const { intakePlan, controlPlan, state } = plans();
  const revision = await projected(intakePlan, controlPlan, state);
  let batchCalls = 0;

  const transport = {
    ...fx.transport,
    async batch(statements) {
      batchCalls++;
      const result = await fx.transport.batch(statements);
      if (batchCalls === 1) {
        fx.raw.prepare(
          "UPDATE queue_content SET intake_state='approved_unscheduled' WHERE content_id=?",
        ).run('I-ADV-1');
      }
      return result;
    },
  };

  const result = await runIntakeMutation({
    intakePlan,
    controlPlan,
    runtimeRevision: revision,
    transport,
    recordedAt: '2026-09-29T10:05:00.000Z',
  });

  assert.equal(result.status, 'blocked');
  assert.equal(result.phase, 'completion_readback');
  assert.equal(batchCalls, 1);
  assert.deepEqual(
    { ...fx.raw.prepare(
      'SELECT state,effect_state FROM mutation_operations WHERE operation_id=?',
    ).get(controlPlan.operation_id) },
    { state: 'VERIFYING', effect_state: 'applied' },
  );
  assert.equal(
    fx.raw.prepare(
      'SELECT active_operation_id FROM mutation_lane_state WHERE singleton_id=1',
    ).get().active_operation_id,
    controlPlan.operation_id,
  );

  fx.raw.close();
});

test('multi-item failure rolls back the whole mutation blast radius', async () => {
  const fx = fixture();
  const { intakePlan, controlPlan, state } = plans({ count: 2 });
  const revision = await projected(intakePlan, controlPlan, state);

  const transport = {
    ...fx.transport,
    async batch(statements) {
      fx.raw.exec('BEGIN IMMEDIATE');
      let contentInsertCount = 0;
      try {
        const out = [];
        for (const statement of statements) {
          if (statement.sql.startsWith('INSERT INTO queue_content ')) {
            contentInsertCount++;
            if (contentInsertCount === 2) {
              throw new Error('simulated second-item canonical write failure');
            }
          }
          out.push(await statement.run());
        }
        fx.raw.exec('COMMIT');
        return out;
      } catch (error) {
        fx.raw.exec('ROLLBACK');
        throw error;
      }
    },
  };

  const result = await runIntakeMutation({
    intakePlan,
    controlPlan,
    runtimeRevision: revision,
    transport,
    recordedAt: '2026-09-29T10:05:00.000Z',
  });

  assert.equal(result.status, 'blocked');
  assert.equal(
    fx.raw.prepare(
      "SELECT COUNT(*) AS n FROM queue_content WHERE content_id IN ('I-ADV-1','I-ADV-2')",
    ).get().n,
    0,
  );
  assert.equal(
    fx.raw.prepare('SELECT COUNT(*) AS n FROM mutation_operations').get().n,
    0,
  );
  assert.deepEqual(
    { ...fx.raw.prepare(
      'SELECT generation,active_operation_id FROM mutation_lane_state WHERE singleton_id=1',
    ).get() },
    { generation: 1, active_operation_id: null },
  );

  fx.raw.close();
});

test('realistic D1/SQLite duplicate-slot errors map to DUPLICATE_SLOT', () => {
  assert.equal(
    classifyD1TransportException(
      new Error(
        'UNIQUE constraint failed: queue_assignments.target_account, queue_assignments.resolved_at',
      ),
    ),
    'DUPLICATE_SLOT',
  );
});
