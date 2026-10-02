import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createMutationProductionIntakeWorker,
  runProductionIntakeRequest,
} from '../cloudflare/src/mutation-production-intake-worker.mjs';

const DIGEST = 'd'.repeat(64);
const NEXT_DIGEST = 'e'.repeat(64);
const PLAN_DIGEST = 'a'.repeat(64);
const BATCH_DIGEST = 'b'.repeat(64);
const BASELINE_DIGEST = 'c'.repeat(64);
const CONTROL_DIGEST = 'f'.repeat(64);

function dbFixture() {
  return {
    prepare(sql) {
      let args = [];
      return {
        bind(...values) {
          args = values;
          return this;
        },
        async first() {
          if (sql.includes('FROM queue_intake_frontier')) {
            return {
              generation: 5,
              resolved_at: '2026-10-02T19:00:00.000Z',
              pending_operation_id: null,
              last_completed_operation_id: null,
            };
          }
          if (sql.includes('FROM queue_content c') && sql.includes('a.lifecycle_state')) {
            assert.deepEqual(args, ['PROD-1']);
            return {
              content_id: 'PROD-1',
              content_revision: 1,
              intake_state: 'scheduled',
              content_digest: DIGEST,
              assignment_id: 'PROD-1',
              assignment_version: 1,
              resolved_at: '2026-10-03T15:00:00.000Z',
              status: 'active',
              lifecycle_state: 'scheduled',
            };
          }
          return null;
        },
        async all() {
          if (sql.includes('FROM queue_assignments') && sql.includes("status = 'active'")) {
            return { results: [] };
          }
          if (sql.includes('WHERE c.content_id=? OR r.content_digest=?')) {
            return { results: [] };
          }
          return { results: [] };
        },
      };
    },
  };
}

function runtimeBefore() {
  return {
    ok: true,
    generation: 11,
    revisionDigest: '1'.repeat(64),
    snapshot: {
      assignments: [],
      deferred: [],
      approvedUnscheduled: [],
      media: [],
    },
  };
}

function dependencies(calls) {
  return {
    verifyRuntime: async (_env, options) => {
      calls.runtime.push(options);
      return options.includeSnapshot === true
        ? runtimeBefore()
        : {
            ok: true,
            generation: 12,
            revisionDigest: NEXT_DIGEST,
          };
    },
    normalizeInput: () => ({
      batch_digest: BATCH_DIGEST,
      items: [{
        content_id: 'PROD-1',
        content_digest: DIGEST,
        body: 'Approved production intake body.',
      }],
    }),
    assignmentHash: () => BASELINE_DIGEST,
    plan: (args) => {
      calls.plan = args;
      return {
        operation_id: 'intake-' + PLAN_DIGEST.slice(0, 24),
        plan_digest: PLAN_DIGEST,
        batch_digest: BATCH_DIGEST,
        count: 1,
        expected_frontier_generation: 5,
        expected_frontier_resolved_at: '2026-10-02T19:00:00.000Z',
        proposed_frontier_resolved_at: '2026-10-03T15:00:00.000Z',
        baseline_assignment_hash: BASELINE_DIGEST,
        expected_runtime_generation: 11,
        expected_runtime_revision_digest: '1'.repeat(64),
        target_account: 'x-primary',
        policy_version: 2,
        items: [{
          content_id: 'PROD-1',
          assignment_id: 'PROD-1',
          content_digest: DIGEST,
        }],
      };
    },
    createTransport: ({ db }) => {
      assert.ok(db);
      return {
        readHaltState: async () => ({ halted: 0, generation: 7 }),
        readLaneState: async () => ({ generation: 9, active_operation_id: null }),
        readRuntimeState: async () => ({
          generation: 11,
          revision_digest: '1'.repeat(64),
        }),
      };
    },
    createControlPlan: (args) => {
      calls.control = args;
      return {
        operation_id: 'mutation-intake-' + CONTROL_DIGEST.slice(0, 24),
        operation_kind: 'intake',
        operation_digest: CONTROL_DIGEST,
        plan_digest: '2'.repeat(64),
        expected_halt_generation: 7,
        expected_lane_generation: 9,
        expected_runtime_generation: 11,
        expected_runtime_revision_digest: '1'.repeat(64),
        retry_budgets: { plan: 3, read: 3, operation: 2 },
        items: [{
          item_key: 'PROD-1',
          expected_content_revision: null,
          expected_assignment_version: null,
          resulting_content_revision: 1,
          resulting_assignment_version: 1,
        }],
      };
    },
    projectRevision: async () => ({
      generation: 12,
      revision_digest: NEXT_DIGEST,
      active_assignment_count: 1,
      approved_unscheduled_count: 0,
      media_required_count: 0,
      media_ready_count: 0,
      previous_revision_digest: '1'.repeat(64),
      source_operation_id: 'intake-' + PLAN_DIGEST.slice(0, 24),
    }),
    runMutation: async (args) => {
      calls.mutation = args;
      return {
        status: 'applied',
        phase: 'complete',
        recovered: false,
        operation_id: 'mutation-intake-' + CONTROL_DIGEST.slice(0, 24),
        evidence_digest: '3'.repeat(64),
        production_preflight: { ok: true, authority: 'bound' },
      };
    },
    now: () => new Date('2026-10-02T19:00:00.000Z'),
  };
}

function payload(overrides = {}) {
  return {
    environment: 'production',
    auth: {
      ok: true,
      environment: 'production',
      tokenType: 'account',
      status: 'active',
      d1Readable: true,
    },
    candidate: {
      branch: 'main',
      clean: true,
      headSha: '4'.repeat(40),
      originMainSha: '4'.repeat(40),
    },
    policy: { version: 2 },
    input: { content_id: 'PROD-1', body: 'Approved production intake body.' },
    bookmark: 'bookmark_production_12345',
    mode: 'single',
    ...overrides,
  };
}

test('production intake core builds one plan and delegates through the production wrapper inputs', async () => {
  const calls = { runtime: [] };
  const result = await runProductionIntakeRequest(
    { DB: dbFixture() },
    payload(),
    dependencies(calls),
  );

  assert.equal(result.ok, true);
  assert.equal(result.publicationCapable, false);
  assert.equal(result.schedulerAuthority, false);
  assert.equal(result.recoveryCheckpointCaptured, true);
  assert.equal(result.planned.contentId, 'PROD-1');
  assert.equal(result.planned.assignmentId, 'PROD-1');
  assert.equal(result.planned.contentDigest, DIGEST);
  assert.equal(result.canonicalReadback.contentId, 'PROD-1');
  assert.equal(result.canonicalReadback.assignmentVersion, 1);
  assert.equal(result.canonicalReadback.contentDigest, DIGEST);
  assert.equal(result.productionPreflight.ok, true);

  assert.equal(calls.mutation.environment, 'production');
  assert.equal(calls.mutation.auth.environment, 'production');
  assert.equal(calls.mutation.candidate.branch, 'main');
  assert.equal(calls.mutation.transport.readPublicationSafety, undefined);
  assert.equal(calls.runtime.length, 2);
});

test('initial production intake core rejects batch mode before any mutation handoff', async () => {
  const calls = { runtime: [] };
  let delegated = 0;
  const deps = dependencies(calls);
  deps.runMutation = async () => {
    delegated++;
    throw new Error('must not run');
  };

  await assert.rejects(
    () => runProductionIntakeRequest(
      { DB: dbFixture() },
      payload({ mode: 'batch' }),
      deps,
    ),
    /limited to mode=single/,
  );
  assert.equal(delegated, 0);
});

test('production mutation HTTP surface is fail-closed while activation is disabled', async () => {
  let delegated = 0;
  const worker = createMutationProductionIntakeWorker({
    runMutation: async () => {
      delegated++;
      throw new Error('must not run');
    },
  });

  const response = await worker.fetch(
    new Request('https://mutation.invalid/mutation-intake', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload()),
    }),
    {
      DB: dbFixture(),
      XQUEUE_MUTATION_ACTIVATION: 'disabled',
    },
  );

  assert.equal(response.status, 503);
  const body = await response.json();
  assert.equal(body.status, 'blocked');
  assert.match(body.reason, /activation is disabled/);
  assert.equal(body.publicationCapable, false);
  assert.equal(body.schedulerAuthority, false);
  assert.equal(delegated, 0);
});
