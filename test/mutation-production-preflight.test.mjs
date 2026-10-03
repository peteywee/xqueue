import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { createIntakeMutationControlPlan } from '../src/mutation-intake-adapter.mjs';
import { projectIntakeRuntimeRevision } from '../src/mutation-intake-d1.mjs';
import { createD1MutationTransport } from '../src/mutation-control-transport.mjs';
import {
  evaluateProductionMutationPreflight,
  runProductionIntakeMutation,
} from '../src/mutation-production-preflight.mjs';

const HEAD = 'f'.repeat(40);
const DEPLOYMENT =
  'cloudflare-worker:xqueue-publisher-production:version:' +
  '11111111-1111-4111-8111-111111111111';

function auth(overrides = {}) {
  return {
    ok: true,
    environment: 'production',
    tokenType: 'account',
    status: 'active',
    d1Readable: true,
    ...overrides,
  };
}

function candidate(overrides = {}) {
  return {
    branch: 'main',
    clean: true,
    headSha: HEAD,
    originMainSha: HEAD,
    ...overrides,
  };
}

function safety(overrides = {}) {
  return {
    authority: {
      owner: 'cloudflare',
      generation: 9,
      transition_state: 'stable',
      candidate_sha: 'a'.repeat(40),
      deployment_id: DEPLOYMENT,
    },
    unresolvedAttemptCount: 0,
    activeLeaseCount: 0,
    publicationLeaseGeneration: 5,
    publicationEventCursor: 0,
    runtimeSnapshotObserved: true,
    inflight: null,
    ...overrides,
  };
}

test('production mutation preflight accepts exact clean main and clean publication state', () => {
  const result = evaluateProductionMutationPreflight({
    environment: 'production',
    auth: auth(),
    candidate: candidate(),
    safety: safety(),
  });

  assert.equal(result.ok, true);
  assert.equal(result.authority, 'bound');
  assert.deepEqual(result.blockers, []);
  assert.equal(result.observed.unresolvedAttemptCount, 0);
  assert.equal(result.observed.activeLeaseCount, 0);
});

test('production mutation preflight exposes every independent blocking fact', () => {
  const result = evaluateProductionMutationPreflight({
    environment: 'preview',
    auth: auth({ ok: false, status: 'inactive', d1Readable: false }),
    candidate: candidate({
      branch: 'feature/test',
      clean: false,
      originMainSha: 'e'.repeat(40),
    }),
    safety: safety({
      authority: {
        owner: 'none',
        generation: 1,
        transition_state: 'changing',
        candidate_sha: 'bad',
        deployment_id: 'wrong',
      },
      unresolvedAttemptCount: 2,
      activeLeaseCount: 1,
      runtimeSnapshotObserved: false,
      inflight: '{"attempt":"A-1"}',
    }),
  });

  assert.equal(result.ok, false);
  const ids = result.blockers.map((item) => item.id);
  for (const expected of [
    'environment_not_production',
    'cloudflare_auth_not_verified',
    'production_d1_not_readable',
    'candidate_not_main',
    'candidate_dirty',
    'candidate_not_exact_main',
    'publication_authority_not_stable',
    'publication_deployment_invalid',
    'unresolved_publication_attempt',
    'active_publication_lease',
    'runtime_snapshot_unreadable',
  ]) {
    assert.ok(ids.includes(expected), expected);
  }
  assert.equal(result.authority, 'unknown');
});

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
  constructor(db, { beforeBatch = null } = {}) {
    this.db = db;
    this.beforeBatch = beforeBatch;
  }

  prepare(sql) {
    return new D1Statement(this.db, sql);
  }

  async batch(statements) {
    if (this.beforeBatch) {
      const hook = this.beforeBatch;
      this.beforeBatch = null;
      hook(this.db);
    }
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

function mutationFixture(options = {}) {
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

  raw.prepare(
    'INSERT INTO authority_state ' +
      '(singleton_id,owner,generation,transition_state,transition_id,previous_owner,candidate_sha,deployment_id,transitioned_at,updated_at) ' +
      "VALUES (1,'cloudflare',9,'stable','test-transition','none',?,?,?,?)",
  ).run('a'.repeat(40), DEPLOYMENT, '2026-09-29T10:00:00.000Z', '2026-09-29T10:00:00.000Z');

  raw.prepare(
    "INSERT INTO runtime_metadata (key,value,updated_at) VALUES ('state.snapshot_json',?,?)",
  ).run(JSON.stringify({ inflight: null }), '2026-09-29T10:00:00.000Z');

  raw.prepare(
    'INSERT INTO publication_leases ' +
      '(lease_name,owner_token,acquisition_id,generation,acquired_at_ms,expires_at_ms,updated_at_ms) ' +
      "VALUES ('publisher',NULL,NULL,5,0,0,0)",
  ).run();

  let checkpointCalls = 0;
  const base = createD1MutationTransport({
    db: new SqliteD1(raw, options),
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
    base,
    checkpointCalls: () => checkpointCalls,
  };
}

function mutationPlans() {
  const body = 'Approved production-preflight intake body.';
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
      content_id: 'I-PROD-PREFLIGHT-1',
      content_digest: contentDigest,
      pillar: 'A',
      title: 'Production preflight test',
      body,
      publication_text: body,
      source_ref: 'production-preflight-test',
      assignment_id: 'I-PROD-PREFLIGHT-1',
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

test('production wrapper runs guarded intake only after clean production preflight', async () => {
  const fx = mutationFixture();
  const { intakePlan, controlPlan, state } = mutationPlans();
  const runtimeRevision = await projected(intakePlan, controlPlan, state);
  const transport = {
    ...fx.base,
    async readPublicationSafety() {
      return safety();
    },
  };

  const result = await runProductionIntakeMutation({
    environment: 'production',
    auth: auth(),
    candidate: candidate(),
    transport,
    intakePlan,
    controlPlan,
    runtimeRevision,
    recordedAt: '2026-09-29T10:05:00.000Z',
  });

  assert.equal(result.status, 'applied');
  assert.equal(result.production_preflight.ok, true);
  assert.equal(fx.checkpointCalls(), 1);

  fx.raw.close();
});

test('production wrapper blocks dirty publication state before checkpoint or mutation', async () => {
  const fx = mutationFixture();
  const { intakePlan, controlPlan, state } = mutationPlans();
  const runtimeRevision = await projected(intakePlan, controlPlan, state);
  const transport = {
    ...fx.base,
    async readPublicationSafety() {
      return safety({ unresolvedAttemptCount: 1 });
    },
  };

  const result = await runProductionIntakeMutation({
    environment: 'production',
    auth: auth(),
    candidate: candidate(),
    transport,
    intakePlan,
    controlPlan,
    runtimeRevision,
    recordedAt: '2026-09-29T10:05:00.000Z',
  });

  assert.equal(result.status, 'blocked');
  assert.equal(result.phase, 'production_preflight');
  assert.ok(
    result.preflight.blockers.some(
      (item) => item.id === 'unresolved_publication_attempt',
    ),
  );
  assert.equal(fx.checkpointCalls(), 0);
  assert.equal(
    fx.raw.prepare('SELECT COUNT(*) AS n FROM mutation_operations').get().n,
    0,
  );

  fx.raw.close();
});


test('production publication safety is reasserted atomically at mutation-lane claim', async () => {
  const fx = mutationFixture({
    beforeBatch(raw) {
      raw.prepare(
        "INSERT INTO publication_state (post_id,status,scheduled_at,updated_at) VALUES (?,'publishing',?,?)",
      ).run(
        'TOCTOU-PUBLISH',
        '2026-09-30T10:00:00.000Z',
        '2026-09-29T10:05:00.000Z',
      );
    },
  });
  const { intakePlan, controlPlan, state } = mutationPlans();
  const runtimeRevision = await projected(intakePlan, controlPlan, state);
  const transport = {
    ...fx.base,
    async readPublicationSafety() {
      return safety();
    },
  };

  const result = await runProductionIntakeMutation({
    environment: 'production',
    auth: auth(),
    candidate: candidate(),
    transport,
    intakePlan,
    controlPlan,
    runtimeRevision,
    recordedAt: '2026-09-29T10:05:00.000Z',
  });

  assert.equal(result.status, 'blocked');
  assert.equal(fx.checkpointCalls(), 1);
  assert.equal(
    fx.raw.prepare('SELECT COUNT(*) AS n FROM mutation_operations').get().n,
    0,
  );
  assert.equal(
    fx.raw.prepare('SELECT active_operation_id FROM mutation_lane_state WHERE singleton_id=1').get().active_operation_id,
    null,
  );

  fx.raw.close();
});


test('completed publication lease cycle after safety read invalidates the recovery bookmark fence', async () => {
  const fx = mutationFixture({
    beforeBatch(raw) {
      raw.prepare(
        "UPDATE publication_leases SET generation=generation+1,updated_at_ms=updated_at_ms+1 WHERE lease_name='publisher'",
      ).run();
    },
  });
  const { intakePlan, controlPlan, state } = mutationPlans();
  const runtimeRevision = await projected(intakePlan, controlPlan, state);

  const result = await runProductionIntakeMutation({
    environment: 'production',
    auth: auth(),
    candidate: candidate(),
    transport: fx.base,
    intakePlan,
    controlPlan,
    runtimeRevision,
    recordedAt: '2026-09-29T10:05:00.000Z',
  });

  assert.equal(result.status, 'blocked');
  assert.equal(fx.checkpointCalls(), 1);
  assert.equal(
    fx.raw.prepare('SELECT COUNT(*) AS n FROM mutation_operations').get().n,
    0,
  );
  assert.equal(
    fx.raw.prepare('SELECT active_operation_id FROM mutation_lane_state WHERE singleton_id=1').get().active_operation_id,
    null,
  );

  fx.raw.close();
});
