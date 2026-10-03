import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  MAX_PRODUCTION_INTAKE_ITEMS,
  createMutationProductionIntakeWorker,
  runProductionIntakeRequest,
} from '../cloudflare/src/mutation-production-intake-worker.mjs';

const RUNTIME_A = 'a'.repeat(64);
const RUNTIME_B = 'b'.repeat(64);
const RUNTIME_C = 'c'.repeat(64);
const DB_ID = 'fc85026e-bfc8-435f-8bb0-c60e139178a3';
const ACCOUNT_ID = 'aab09adea145e6da8fa57b0f73b073da';
const CONTROL_TOKEN = 'control-token-' + 'x'.repeat(32);
const CF_TOKEN = 'cfat_' + 'z'.repeat(40);
const OPERATION_ID = 'mutation-intake-' + '2'.repeat(24);
const INTAKE_ID = 'intake-' + '1'.repeat(24);

function env(db = fakeDb()) {
  return {
    DB: db,
    MUTATION_CONTROL_TOKEN: CONTROL_TOKEN,
    CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID,
    XQUEUE_PRODUCTION_DATABASE_ID: DB_ID,
    CLOUDFLARE_API_TOKEN: CF_TOKEN,
  };
}

function fakeDb({
  committedGeneration = 12,
  committedDigest = RUNTIME_B,
  replay = false,
} = {}) {
  return {
    prepare(sql) {
      const state = { args: [] };
      return {
        bind(...args) {
          state.args = args;
          return this;
        },
        async all() {
          if (
            replay &&
            (sql.includes('FROM queue_intake_items') ||
              sql.includes('FROM mutation_operation_items'))
          ) {
            assert.equal(state.args.length, 1, 'replay query placeholder must be bound');
          }
          if (replay && sql.includes('FROM queue_intake_items')) {
            return {
              results: [{
                operation_id: INTAKE_ID,
                ordinal: 0,
                content_id: 'I-PRODUCTION-TEST-1',
                content_digest: 'd'.repeat(64),
                pillar: 'A',
                title: 'Production test',
                source_ref: 'test',
                resolved_at: '2026-10-04T19:30:00.000Z',
                scheduled_date: '2026-10-04',
                scheduled_time: '14:30',
                timezone: 'America/Chicago',
                slot_label: 'lull',
              }],
            };
          }
          if (replay && sql.includes('FROM mutation_operation_items')) {
            return {
              results: [{
                item_key: 'I-PRODUCTION-TEST-1',
                expected_content_revision: null,
                expected_assignment_version: null,
                resulting_content_revision: 1,
                resulting_assignment_version: 1,
                readback_status: 'applied',
                readback_digest: '9'.repeat(64),
              }],
            };
          }
          if (sql.includes('FROM queue_assignments')) return { results: [] };
          if (sql.includes('FROM queue_content c')) return { results: [] };
          return { results: [] };
        },
        async first() {
          if (replay && sql.includes('FROM queue_intake_operations WHERE batch_digest')) {
            return {
              operation_id: INTAKE_ID,
              plan_digest: '1'.repeat(64),
              batch_digest: 'c'.repeat(64),
              item_count: 1,
              expected_frontier_generation: 5,
              expected_frontier_resolved_at: '2026-10-03T05:00:00.000Z',
              proposed_frontier_resolved_at: '2026-10-04T19:30:00.000Z',
              baseline_assignment_hash: 'e'.repeat(64),
              expected_runtime_generation: 11,
              expected_runtime_revision_digest: RUNTIME_A,
              resulting_runtime_generation: 12,
              resulting_runtime_revision_digest: RUNTIME_B,
              target_account: 'x-primary',
              policy_version: 2,
              status: 'complete',
              created_at: '2026-10-03T07:00:00.000Z',
              updated_at: '2026-10-03T07:00:00.000Z',
            };
          }
          if (sql.includes('FROM queue_intake_frontier')) {
            return {
              generation: 5,
              resolved_at: '2026-10-03T05:00:00.000Z',
              pending_operation_id: null,
              last_completed_operation_id: null,
            };
          }
          if (sql.includes('FROM queue_runtime_revisions') && sql.includes('source_operation_id=?')) {
            return {
              generation: committedGeneration,
              revision_digest: committedDigest,
              previous_revision_digest: RUNTIME_A,
              source_operation_id: OPERATION_ID,
              created_at: '2026-10-03T07:00:00.000Z',
            };
          }
          return null;
        },
      };
    },
  };
}

function existingOperation(state = 'COMPLETE') {
  return {
    operation_id: OPERATION_ID,
    operation_kind: 'intake',
    operation_digest: '8'.repeat(64),
    plan_digest: '7'.repeat(64),
    state,
    outcome: state === 'COMPLETE' ? 'AUTO_RESOLVE' : null,
    expected_halt_generation: 3,
    lane_generation: 8,
    expected_runtime_generation: 11,
    expected_runtime_revision_digest: RUNTIME_A,
    checkpoint_bookmark: 'bookmark_12345',
    checkpoint_verified_at: '2026-10-03T07:00:00.000Z',
    max_plan_retries: 3,
    max_read_retries: 3,
    max_operation_retries: 2,
    effect_state: 'applied',
    resulting_runtime_generation: 12,
    resulting_runtime_revision_digest: RUNTIME_B,
  };
}

function deps({
  mutationStatus = 'applied',
  afterGeneration = 12,
  afterDigest = RUNTIME_B,
  replayOperation = null,
  normalizeCount = 1,
  postDispatchVerifyError = null,
  resumeMutationStatus = 'already_applied',
  resumeMutationError = null,
  controlPlanError = null,
} = {}) {
  let verifyCalls = 0;
  const events = [];
  const transport = {
    async readOperation() {
      events.push('read-operation');
      return replayOperation;
    },
    async readHaltState() {
      events.push('read-halt');
      return { halted: 0, generation: 3 };
    },
    async readLaneState() {
      events.push('read-lane');
      return { generation: 7, active_operation_id: null };
    },
    async readRuntimeState() {
      events.push('read-runtime');
      return { generation: 11, revision_digest: RUNTIME_A };
    },
    async captureCheckpoint() {
      events.push('capture-checkpoint');
      return 'bookmark_12345';
    },
    async readPublicationSafety() {
      events.push('read-publication-safety');
      return {
        authority: {
          owner: 'cloudflare',
          generation: 9,
          transition_state: 'stable',
          candidate_sha: 'a'.repeat(40),
          deployment_id:
            'cloudflare-worker:xqueue-publisher-production:version:' +
            '11111111-1111-4111-8111-111111111111',
        },
        unresolvedAttemptCount: 0,
        activeLeaseCount: 0,
        publicationLeaseGeneration: 5,
        publicationEventCursor: 17,
        runtimeSnapshotObserved: true,
        inflight: null,
      };
    },
  };

  return {
    events,
    verifyAuth: async ({ token, accountId }) => {
      assert.equal(token, CF_TOKEN);
      assert.equal(accountId, ACCOUNT_ID);
      return { ok: true, tokenType: 'account', status: 'active' };
    },
    verifyRuntime: async (_env, options) => {
      verifyCalls++;
      if (!replayOperation && verifyCalls === 1) {
        assert.equal(options.includeSnapshot, true);
        return {
          ok: true,
          generation: 11,
          revisionDigest: RUNTIME_A,
          snapshot: {
            assignments: [],
            deferred: [],
            approvedUnscheduled: [],
            media: [],
          },
        };
      }
      assert.equal(options.includeSnapshot, false);
      if (postDispatchVerifyError) throw postDispatchVerifyError;
      return {
        ok: true,
        generation: afterGeneration,
        revisionDigest: afterDigest,
      };
    },
    normalizeInput: (input, options) => {
      assert.equal(input.content_id, 'I-PRODUCTION-TEST-1');
      const items = Array.from({ length: normalizeCount }, (_, index) => ({
        content_id: index === 0
          ? 'I-PRODUCTION-TEST-1'
          : 'I-PRODUCTION-TEST-' + (index + 1),
        content_digest: index === 0
          ? 'd'.repeat(64)
          : String(index + 1).padStart(64, 'e').slice(-64),
      }));
      return {
        format: 1,
        batch_digest: 'c'.repeat(64),
        count: normalizeCount,
        items,
      };
    },
    deriveOperationId: () => OPERATION_ID,
    assignmentHash: (rows) => {
      assert.deepEqual(rows, []);
      return 'e'.repeat(64);
    },
    plan: ({ policy, existingContent, existingDigests, runtimeState, normalized }) => {
      assert.equal(policy.version, 2);
      assert.equal(policy.timezone, 'America/Chicago');
      assert.deepEqual(policy.slots, ['14:30', '22:15']);
      assert.deepEqual(existingContent, []);
      assert.deepEqual(existingDigests, []);
      assert.equal(runtimeState.generation, 11);
      return {
        operation_id: INTAKE_ID,
        plan_digest: '1'.repeat(64),
        batch_digest: normalized.batch_digest,
        count: normalized.count,
        expected_frontier_generation: 5,
        expected_frontier_resolved_at: '2026-10-03T05:00:00.000Z',
        proposed_frontier_resolved_at: '2026-10-04T19:30:00.000Z',
        baseline_assignment_hash: 'e'.repeat(64),
        expected_runtime_generation: 11,
        expected_runtime_revision_digest: RUNTIME_A,
        target_account: 'x-primary',
        policy_version: 2,
        items: normalized.items.map((item, ordinal) => ({
          ordinal,
          ...item,
          assignment_id: item.content_id,
          assignment_version: 1,
          content_revision: 1,
          target_account: 'x-primary',
          policy_version: 2,
          resolved_at: '2026-10-04T19:30:00.000Z',
          scheduled_date: '2026-10-04',
          scheduled_time: '14:30',
          timezone: 'America/Chicago',
          slot_label: 'lull',
        })),
      };
    },
    createTransport: ({ accountId, databaseId, apiToken }) => {
      assert.equal(accountId, ACCOUNT_ID);
      assert.equal(databaseId, DB_ID);
      assert.equal(apiToken, CF_TOKEN);
      return transport;
    },
    createControlPlan: ({ intakePlan, haltState, laneState }) => {
      if (controlPlanError) throw controlPlanError;
      assert.equal(intakePlan.operation_id, INTAKE_ID);
      assert.equal(haltState.generation, 3);
      assert.equal(laneState.generation, 7);
      return {
        operation_id: OPERATION_ID,
        operation_kind: 'intake',
        operation_digest: '8'.repeat(64),
        plan_digest: '7'.repeat(64),
        expected_halt_generation: 3,
        expected_lane_generation: 7,
        expected_runtime_generation: 11,
        expected_runtime_revision_digest: RUNTIME_A,
        retry_budgets: { plan: 3, read: 3, operation: 2 },
        items: intakePlan.items.map((item) => ({
          item_key: item.content_id,
          expected_content_revision: null,
          expected_assignment_version: null,
          resulting_content_revision: 1,
          resulting_assignment_version: 1,
        })),
      };
    },
    projectRevision: async ({ controlPlan }) => ({
      generation: 12,
      revision_digest: RUNTIME_B,
      previous_revision_digest: RUNTIME_A,
      source_operation_id: controlPlan.operation_id,
    }),
    runMutation: async (args) => {
      assert.equal(args.environment, 'production');
      assert.equal(args.auth.ok, true);
      assert.equal(args.auth.environment, 'production');
      assert.equal(args.candidate.branch, 'main');
      assert.equal(await args.transport.captureCheckpoint(), 'bookmark_12345');
      if (mutationStatus === 'pre-dispatch-unavailable') {
        return {
          status: 'blocked',
          phase: 'production_preflight',
          fault_class: 'PRE_DISPATCH_STATE_UNAVAILABLE',
          retryable: true,
          preflight: { ok: false, authority: 'unknown' },
        };
      }
      const blockedPhase =
        mutationStatus === 'post-dispatch-blocked'
          ? 'apply'
          : mutationStatus === 'complete-readback-blocked'
            ? 'complete_readback'
            : mutationStatus === 'existing-operation-blocked'
              ? 'existing_operation'
              : 'production_preflight';
      return mutationStatus === 'applied'
        ? {
            status: 'applied',
            phase: 'complete',
            recovered: false,
            operation_id: args.controlPlan.operation_id,
            evidence_digest: 'f'.repeat(64),
            observed: {
              operation_id: args.controlPlan.operation_id,
              runtime_generation: 12,
              runtime_revision_digest: RUNTIME_B,
              items: [{
                item_key: 'I-PRODUCTION-TEST-1',
                resulting_content_revision: 1,
                resulting_assignment_version: 1,
              }],
            },
            production_preflight: { ok: true, authority: 'bound' },
          }
        : {
            status: 'blocked',
            phase: blockedPhase,
            decision: { outcome: 'SYSTEM_HALT' },
            preflight: { ok: false },
          };
    },
    resumeMutation: async ({ controlPlan }) => {
      if (resumeMutationError) throw resumeMutationError;
      if (resumeMutationStatus !== 'already_applied') {
        return {
          status: resumeMutationStatus,
          phase: 'initial_readback',
          recovered: false,
          decision: { outcome: 'AUTO_RETRY' },
        };
      }
      return {
        status: 'already_applied',
        phase: 'complete_readback',
        recovered: true,
        operation_id: controlPlan.operation_id,
        evidence_digest: 'f'.repeat(64),
        observed: {
          operation_id: controlPlan.operation_id,
          runtime_generation: 12,
          runtime_revision_digest: RUNTIME_B,
          items: [{
            item_key: 'I-PRODUCTION-TEST-1',
            readback_status: 'applied',
            resulting_content_revision: 1,
            resulting_assignment_version: 1,
          }],
        },
      };
    },
    now: () => new Date('2026-10-03T07:00:00.000Z'),
  };
}

function payload(overrides = {}) {
  return {
    environment: 'production',
    mode: 'single',
    sourceMode: 'owner-manual',
    candidate: {
      branch: 'main',
      clean: true,
      headSha: '1'.repeat(40),
      originMainSha: '1'.repeat(40),
    },
    input: {
      content_id: 'I-PRODUCTION-TEST-1',
      pillar: 'A',
      body: 'Approved production intake test.',
    },
    ...overrides,
  };
}

test('production worker uses trusted auth and trusted checkpoint transport with canonical policy', async () => {
  const d = deps();
  const result = await runProductionIntakeRequest(env(), payload(), d);

  assert.equal(result.ok, true);
  assert.equal(result.replay, false);
  assert.equal(result.publicationCapable, false);
  assert.equal(result.schedulerAuthority, false);
  assert.equal(result.recoveryCheckpointCaptured, true);
  assert.equal(result.planned.operationId, OPERATION_ID);
  assert.equal(result.productionPreflight.ok, true);
  assert.equal(result.committedRuntimeRevision.generation, 12);
  assert.equal(result.before.generation, 11);
  assert.equal(result.after.generation, 12);
  assert.ok(d.events.indexOf('capture-checkpoint') > d.events.indexOf('read-runtime'));
});

test('request replay is recovered before duplicate-content planning', async () => {
  const d = deps({ replayOperation: existingOperation() });
  let planned = false;
  d.plan = () => {
    planned = true;
    throw new Error('plan must not run during exact replay');
  };

  const result = await runProductionIntakeRequest(
    env(fakeDb({ replay: true })),
    payload(),
    d,
  );

  assert.equal(result.ok, true);
  assert.equal(result.replay, true);
  assert.equal(result.mutation.status, 'already_applied');
  assert.equal(planned, false);
});

test('request replay still requires exact-main production preflight', async () => {
  const d = deps({ replayOperation: existingOperation() });
  await assert.rejects(
    () => runProductionIntakeRequest(
      env(fakeDb({ replay: true })),
      payload({
        candidate: {
          branch: 'main',
          clean: false,
          headSha: '1'.repeat(40),
          originMainSha: '1'.repeat(40),
        },
      }),
      d,
    ),
    (error) =>
      error?.faultClass === 'PRE_DISPATCH_STATE_CONFLICT' &&
      error?.httpStatus === 409 &&
      /candidate_dirty/.test(error.message),
  );
});

test('applied replay resume failures are non-retryable post-dispatch ambiguity', async () => {
  const d = deps({
    replayOperation: existingOperation(),
    resumeMutationError: new Error('network timeout during applied replay readback'),
  });
  await assert.rejects(
    () => runProductionIntakeRequest(
      env(fakeDb({ replay: true })),
      payload(),
      d,
    ),
    (error) =>
      error?.faultClass === 'POST_DISPATCH_READBACK_AMBIGUOUS' &&
      error?.httpStatus === 409 &&
      error?.retryable === false &&
      error?.requiresReadback === true,
  );
});

test('pre-dispatch runtime planning races return stable replan-required conflict', async () => {
  const d = deps({
    controlPlanError: new Error('intake runtime snapshot does not match its plan fence'),
  });
  await assert.rejects(
    () => runProductionIntakeRequest(env(), payload(), d),
    (error) =>
      error?.faultClass === 'PRE_DISPATCH_REPLAN_REQUIRED' &&
      error?.httpStatus === 409 &&
      error?.retryable === true,
  );
});

test('post-commit verification accepts a later healthy runtime head', async () => {
  const result = await runProductionIntakeRequest(
    env(),
    payload(),
    deps({ afterGeneration: 13, afterDigest: RUNTIME_C }),
  );
  assert.equal(result.ok, true);
  assert.equal(result.committedRuntimeRevision.generation, 12);
  assert.equal(result.after.generation, 13);
});

test('production batch limit rejects excessive blast radius before mutation', async () => {
  const d = deps({ normalizeCount: MAX_PRODUCTION_INTAKE_ITEMS + 1 });
  await assert.rejects(
    () => runProductionIntakeRequest(
      env(),
      payload({ mode: 'batch' }),
      d,
    ),
    (error) =>
      error?.faultClass === 'PRODUCTION_BATCH_LIMIT_EXCEEDED' &&
      error?.httpStatus === 413,
  );
  assert.deepEqual(d.events, []);
});

test('blocked production preflight never claims successful production mutation evidence', async () => {
  const result = await runProductionIntakeRequest(
    env(),
    payload(),
    deps({ mutationStatus: 'blocked' }),
  );
  assert.equal(result.ok, false);
  assert.equal(result.mutation.status, 'blocked');
});

test('explicit unsupported source mode fails closed', async () => {
  await assert.rejects(
    () => runProductionIntakeRequest(
      env(),
      payload({ sourceMode: 'automted' }),
      deps(),
    ),
    (error) =>
      error?.faultClass === 'INVALID_INTAKE' &&
      /sourceMode must be owner-manual or automated/.test(error.message),
  );
});

test('production endpoint requires independent bearer service identity', async () => {
  const worker = createMutationProductionIntakeWorker(deps());
  const runtimeEnv = env();

  const unauthenticated = await worker.fetch(
    new Request('https://example.test/production-intake', {
      method: 'POST',
      body: JSON.stringify(payload()),
      headers: { 'content-type': 'application/json' },
    }),
    runtimeEnv,
  );
  assert.equal(unauthenticated.status, 401);

  const authenticatedResponse = await worker.fetch(
    new Request('https://example.test/production-intake', {
      method: 'POST',
      body: JSON.stringify(payload()),
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer ' + CONTROL_TOKEN,
      },
    }),
    runtimeEnv,
  );
  assert.equal(authenticatedResponse.status, 200);
});

test('worker returns stable non-retryable 400 for missing or array candidate evidence', async () => {
  for (const candidate of [null, []]) {
    const worker = createMutationProductionIntakeWorker(deps());
    const response = await worker.fetch(
      new Request('https://example.test/production-intake', {
        method: 'POST',
        body: JSON.stringify(payload({ candidate })),
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer ' + CONTROL_TOKEN,
        },
      }),
      env(),
    );
    assert.equal(response.status, 400);
    const body = await response.json();
    assert.equal(body.faultClass, 'INVALID_CANDIDATE');
    assert.equal(body.retryable, false);
    assert.equal(body.requiresReadback, false);
  }
});

test('worker returns stable non-retryable 400 for malformed JSON', async () => {
  const worker = createMutationProductionIntakeWorker(deps());
  const response = await worker.fetch(
    new Request('https://example.test/production-intake', {
      method: 'POST',
      body: '{',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer ' + CONTROL_TOKEN,
      },
    }),
    env(),
  );
  assert.equal(response.status, 400);
  const body = await response.json();
  assert.equal(body.faultClass, 'INVALID_JSON');
  assert.equal(body.retryable, false);
  assert.equal(body.requiresReadback, false);
});

test('transient pre-dispatch safety read failure is retryable 503', async () => {
  const worker = createMutationProductionIntakeWorker(
    deps({ mutationStatus: 'pre-dispatch-unavailable' }),
  );
  const response = await worker.fetch(
    new Request('https://example.test/production-intake', {
      method: 'POST',
      body: JSON.stringify(payload()),
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer ' + CONTROL_TOKEN,
      },
    }),
    env(),
  );
  assert.equal(response.status, 503);
  const body = await response.json();
  assert.equal(body.faultClass, 'PRE_DISPATCH_STATE_UNAVAILABLE');
  assert.equal(body.retryable, true);
  assert.equal(body.requiresReadback, false);
});

test('complete_readback and existing_operation are conservatively post-dispatch', async () => {
  for (const mutationStatus of ['complete-readback-blocked', 'existing-operation-blocked']) {
    const worker = createMutationProductionIntakeWorker(deps({ mutationStatus }));
    const response = await worker.fetch(
      new Request('https://example.test/production-intake', {
        method: 'POST',
        body: JSON.stringify(payload()),
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer ' + CONTROL_TOKEN,
        },
      }),
      env(),
    );
    assert.equal(response.status, 409);
    const body = await response.json();
    assert.equal(body.faultClass, 'POST_DISPATCH_RECONCILIATION_REQUIRED');
    assert.equal(body.retryable, false);
    assert.equal(body.requiresReadback, true);
  }
});

test('post-dispatch blocked result is 409 and explicitly requires readback', async () => {
  const worker = createMutationProductionIntakeWorker(
    deps({ mutationStatus: 'post-dispatch-blocked' }),
  );
  const response = await worker.fetch(
    new Request('https://example.test/production-intake', {
      method: 'POST',
      body: JSON.stringify(payload()),
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer ' + CONTROL_TOKEN,
      },
    }),
    env(),
  );
  assert.equal(response.status, 409);
  const body = await response.json();
  assert.equal(body.faultClass, 'POST_DISPATCH_RECONCILIATION_REQUIRED');
  assert.equal(body.retryable, false);
  assert.equal(body.requiresReadback, true);
});

test('post-commit readback ambiguity is a stable non-retryable 409', async () => {
  const worker = createMutationProductionIntakeWorker(deps());
  const response = await worker.fetch(
    new Request('https://example.test/production-intake', {
      method: 'POST',
      body: JSON.stringify(payload()),
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer ' + CONTROL_TOKEN,
      },
    }),
    env(fakeDb({ committedDigest: RUNTIME_C })),
  );
  assert.equal(response.status, 409);
  const body = await response.json();
  assert.equal(body.faultClass, 'POST_DISPATCH_READBACK_AMBIGUOUS');
  assert.equal(body.retryable, false);
  assert.equal(body.requiresReadback, true);
});

test('thrown post-dispatch runtime readback is non-retryable ambiguity and requires readback', async () => {
  const worker = createMutationProductionIntakeWorker(
    deps({ postDispatchVerifyError: new Error('network timeout during runtime readback') }),
  );
  const response = await worker.fetch(
    new Request('https://example.test/production-intake', {
      method: 'POST',
      body: JSON.stringify(payload()),
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer ' + CONTROL_TOKEN,
      },
    }),
    env(),
  );
  assert.equal(response.status, 409);
  const body = await response.json();
  assert.equal(body.faultClass, 'POST_DISPATCH_READBACK_AMBIGUOUS');
  assert.equal(body.retryable, false);
  assert.equal(body.requiresReadback, true);
  assert.match(body.error, /runtime head readback failed/i);
});

test('production mutation worker config contains D1 only and no embedded secrets/publication bindings', () => {
  const config = readFileSync('wrangler.mutation-production-intake.jsonc', 'utf8');
  assert.match(config, /"name": "xqueue-mutation-production-intake"/);
  assert.match(config, /"database_name": "xqueue-production"/);
  assert.match(config, /"binding": "DB"/);
  assert.match(config, /"CLOUDFLARE_ACCOUNT_ID"/);
  assert.match(config, /"XQUEUE_PRODUCTION_DATABASE_ID"/);
  assert.doesNotMatch(config, /CLOUDFLARE_API_TOKEN/);
  assert.doesNotMatch(config, /MUTATION_CONTROL_TOKEN/);
  assert.doesNotMatch(config, /MUTATION_CHECKPOINT_HMAC_KEY/);
  assert.doesNotMatch(config, /r2_buckets|queues|triggers|MEDIA|X_BEARER|X_API|TWITTER|scheduler/i);
});

test('production worker health is non-mutating and unknown routes stay closed', async () => {
  const worker = createMutationProductionIntakeWorker(deps());
  const health = await worker.fetch(
    new Request('https://example.test/health'),
    { DB: fakeDb() },
  );
  assert.equal(health.status, 200);
  const healthBody = await health.json();
  assert.equal(healthBody.publicationCapable, false);
  assert.equal(healthBody.schedulerAuthority, false);

  const missing = await worker.fetch(
    new Request('https://example.test/publish'),
    { DB: fakeDb() },
  );
  assert.equal(missing.status, 404);
});
