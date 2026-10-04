import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { createIntakeMutationControlPlan } from '../src/mutation-intake-adapter.mjs';
import { projectIntakeRuntimeRevision } from '../src/mutation-intake-d1.mjs';
import { runIntakeMutation } from '../src/mutation-intake-runner.mjs';
import { createD1MutationTransport } from '../src/mutation-control-transport.mjs';

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

function fixture({ bookmarkResponse = null } = {}) {
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
      if (bookmarkResponse) return bookmarkResponse();
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

function plans() {
  const body = 'Approved orchestrated intake body.';
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
      content_id: 'I-RUNNER-1',
      content_digest: contentDigest,
      pillar: 'A',
      title: 'Runner test',
      body,
      publication_text: body,
      source_ref: 'runner-test',
      assignment_id: 'I-RUNNER-1',
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

async function runtimeRevision(intakePlan, controlPlan, state) {
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

test('final completion readback failure stays post-dispatch and blocked', async () => {
  const fx = fixture();
  const { intakePlan, controlPlan, state } = plans();
  const revision = await runtimeRevision(intakePlan, controlPlan, state);

  let batchCalls = 0;
  let failReads = false;
  const transport = {
    ...fx.transport,
    prepare(sql) {
      if (failReads) throw new Error('network timeout during final completion readback');
      return fx.transport.prepare(sql);
    },
    async batch(statements) {
      const result = await fx.transport.batch(statements);
      batchCalls++;
      if (batchCalls === 2) failReads = true;
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
  assert.equal(result.phase, 'finalize_readback');
  assert.equal(result.error_class, 'D1_READ_UNAVAILABLE');
  assert.equal(result.readback, 'unavailable');
  assert.equal(result.recovered, false);
  assert.equal(batchCalls, 2);
  assert.equal(
    fx.raw.prepare('SELECT state FROM mutation_operations WHERE operation_id=?').get(controlPlan.operation_id).state,
    'COMPLETE',
  );

  fx.raw.close();
});

test('contradictory completion readback uses dedicated contradictory fault class', async () => {
  const fx = fixture();
  const { intakePlan, controlPlan, state } = plans();
  const revision = await runtimeRevision(intakePlan, controlPlan, state);

  let batchCalls = 0;
  const transport = {
    ...fx.transport,
    async batch(statements) {
      const result = await fx.transport.batch(statements);
      batchCalls++;
      if (batchCalls === 1) {
        fx.raw.prepare(
          "UPDATE queue_content SET intake_state='approved_unscheduled' WHERE content_id=?",
        ).run('I-RUNNER-1');
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
  assert.equal(result.error_class, 'D1_READ_CONTRADICTORY');
  assert.equal(result.readback, 'contradictory');
  assert.equal(result.decision.outcome, 'SYSTEM_HALT');

  fx.raw.close();
});

test('runner performs checkpoint -> atomic apply -> exact readback -> finalize', async () => {
  const fx = fixture();
  const { intakePlan, controlPlan, state } = plans();
  const revision = await runtimeRevision(intakePlan, controlPlan, state);

  const result = await runIntakeMutation({
    intakePlan,
    controlPlan,
    runtimeRevision: revision,
    transport: fx.transport,
    recordedAt: '2026-09-29T10:05:00.000Z',
  });

  assert.equal(result.status, 'applied');
  assert.equal(result.phase, 'complete');
  assert.equal(result.recovered, false);
  assert.equal(fx.checkpointCalls(), 1);

  assert.deepEqual(
    { ...fx.raw.prepare(
      'SELECT state,outcome,effect_state FROM mutation_operations WHERE operation_id=?',
    ).get(controlPlan.operation_id) },
    { state: 'COMPLETE', outcome: 'AUTO_RESOLVE', effect_state: 'applied' },
  );
  assert.deepEqual(
    { ...fx.raw.prepare(
      'SELECT generation,active_operation_id FROM mutation_lane_state WHERE singleton_id=1',
    ).get() },
    { generation: 2, active_operation_id: null },
  );

  fx.raw.close();
});

test('runner refuses stale runtime at preflight before checkpoint or mutation', async () => {
  const fx = fixture();
  const { intakePlan, controlPlan, state } = plans();
  const revision = await runtimeRevision(intakePlan, controlPlan, state);

  fx.raw.prepare(
    'INSERT INTO queue_runtime_revisions ' +
      '(generation,revision_digest,active_assignment_count,approved_unscheduled_count,media_required_count,media_ready_count,' +
      'previous_revision_digest,source_operation_id,created_at) VALUES (12,?,0,0,0,0,?,NULL,?)',
  ).run('e'.repeat(64), 'a'.repeat(64), '2026-09-29T10:04:30.000Z');

  const result = await runIntakeMutation({
    intakePlan,
    controlPlan,
    runtimeRevision: revision,
    transport: fx.transport,
    recordedAt: '2026-09-29T10:05:00.000Z',
  });

  assert.equal(result.status, 'blocked');
  assert.equal(result.phase, 'preflight');
  assert.equal(result.decision.outcome, 'AUTO_RETRY');
  assert.equal(fx.checkpointCalls(), 0);
  assert.equal(
    fx.raw.prepare('SELECT COUNT(*) AS n FROM mutation_operations').get().n,
    0,
  );

  fx.raw.close();
});

test('checkpoint outages are retryable unavailable reads; unusable bookmarks still halt', async () => {
  const cases = [
    {
      name: 'network failure',
      response: () => { throw new Error('network down'); },
      errorClass: 'D1_READ_UNAVAILABLE',
      outcome: 'AUTO_RETRY',
    },
    {
      name: 'HTTP 503 with non-JSON body',
      response: () => ({
        ok: false,
        status: 503,
        json: async () => { throw new SyntaxError('Unexpected token <'); },
      }),
      errorClass: 'D1_READ_UNAVAILABLE',
      outcome: 'AUTO_RETRY',
    },
    {
      name: 'HTTP 429',
      response: () => ({ ok: false, status: 429, json: async () => ({ success: false }) }),
      errorClass: 'D1_READ_UNAVAILABLE',
      outcome: 'AUTO_RETRY',
    },
    {
      name: 'HTTP 403',
      response: () => ({ ok: false, status: 403, json: async () => ({ success: false }) }),
      errorClass: 'CHECKPOINT_CORRUPT',
      outcome: 'SYSTEM_HALT',
    },
    {
      name: 'unusable bookmark',
      response: () => ({
        ok: true,
        status: 200,
        json: async () => ({ success: true, result: { bookmark: 'bad' } }),
      }),
      errorClass: 'CHECKPOINT_CORRUPT',
      outcome: 'SYSTEM_HALT',
    },
  ];

  for (const c of cases) {
    const fx = fixture({ bookmarkResponse: c.response });
    const { intakePlan, controlPlan, state } = plans();
    const revision = await runtimeRevision(intakePlan, controlPlan, state);

    const result = await runIntakeMutation({
      intakePlan,
      controlPlan,
      runtimeRevision: revision,
      transport: fx.transport,
      recordedAt: '2026-09-29T10:05:00.000Z',
    });

    assert.equal(result.status, 'blocked', c.name);
    assert.equal(result.phase, 'checkpoint', c.name);
    assert.equal(result.error_class, c.errorClass, c.name);
    assert.equal(result.decision.outcome, c.outcome, c.name);
    assert.equal(fx.checkpointCalls(), 1, c.name);
    assert.equal(
      fx.raw.prepare('SELECT COUNT(*) AS n FROM mutation_operations').get().n,
      0,
      c.name,
    );
    assert.equal(
      fx.raw.prepare(
        'SELECT active_operation_id FROM mutation_lane_state WHERE singleton_id=1',
      ).get().active_operation_id,
      null,
      c.name,
    );

    fx.raw.close();
  }
});

test('lost apply response after commit recovers by readback and never replays apply', async () => {
  const fx = fixture();
  const { intakePlan, controlPlan, state } = plans();
  const revision = await runtimeRevision(intakePlan, controlPlan, state);

  let batchCalls = 0;
  const transport = {
    ...fx.transport,
    async batch(statements) {
      batchCalls++;
      if (batchCalls === 1) {
        await fx.transport.batch(statements);
        throw new Error('network timeout after commit');
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
  assert.equal(result.recovered, true);
  assert.equal(batchCalls, 2);
  assert.equal(
    fx.raw.prepare(
      'SELECT state FROM mutation_operations WHERE operation_id=?',
    ).get(controlPlan.operation_id).state,
    'COMPLETE',
  );
  assert.equal(
    fx.raw.prepare(
      'SELECT COUNT(*) AS n FROM queue_runtime_revisions WHERE source_operation_id=?',
    ).get(controlPlan.operation_id).n,
    1,
  );

  fx.raw.close();
});

test('lost apply response without commit fails closed and does not blind retry', async () => {
  const fx = fixture();
  const { intakePlan, controlPlan, state } = plans();
  const revision = await runtimeRevision(intakePlan, controlPlan, state);

  let batchCalls = 0;
  const transport = {
    ...fx.transport,
    async batch() {
      batchCalls++;
      throw new Error('network timeout before commit');
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
  assert.equal(result.phase, 'apply');
  assert.equal(result.error_class, 'D1_BATCH_AMBIGUOUS');
  assert.equal(result.decision.outcome, 'SYSTEM_HALT');
  assert.equal(batchCalls, 1);
  assert.equal(
    fx.raw.prepare('SELECT COUNT(*) AS n FROM mutation_operations').get().n,
    0,
  );

  fx.raw.close();
});
