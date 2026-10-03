import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';

import {
  createMutationProductionIntakeWorker,
  runProductionIntakeRequest,
  verifyProductionCheckpointEvidence,
} from '../cloudflare/src/mutation-production-intake-worker.mjs';

const RUNTIME_A = 'a'.repeat(64);
const RUNTIME_B = 'b'.repeat(64);
const RUNTIME_C = 'c'.repeat(64);
const DB_ID = 'fc85026e-bfc8-435f-8bb0-c60e139178a3';
const CONTROL_TOKEN = 'control-token-' + 'x'.repeat(32);
const CHECKPOINT_KEY = 'checkpoint-key-' + 'y'.repeat(32);

function fakeDb({ committedGeneration = 12, committedDigest = RUNTIME_B } = {}) {
  return {
    prepare(sql) {
      const state = { args: [] };
      return {
        bind(...args) {
          state.args = args;
          return this;
        },
        async all() {
          if (sql.includes('FROM queue_assignments')) return { results: [] };
          if (sql.includes('FROM queue_content c')) return { results: [] };
          return { results: [] };
        },
        async first() {
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
              source_operation_id: 'mutation-intake-' + '2'.repeat(24),
              created_at: '2026-10-03T07:00:00.000Z',
            };
          }
          return null;
        },
      };
    },
  };
}

function deps({
  mutationStatus = 'applied',
  afterGeneration = 12,
  afterDigest = RUNTIME_B,
} = {}) {
  let verifyCalls = 0;
  return {
    verifyCheckpoint: async (_env, _checkpoint, context) => {
      assert.equal(context.candidateSha, '1'.repeat(40));
      assert.equal(context.batchDigest, 'c'.repeat(64));
      return {
        bookmark: 'bookmark_12345',
        databaseId: DB_ID,
        candidateSha: '1'.repeat(40),
        batchDigest: 'c'.repeat(64),
        issuedAt: '2026-10-03T07:00:00.000Z',
        nonce: 'nonce_1234567890123456',
      };
    },
    verifyRuntime: async (_env, options) => {
      verifyCalls++;
      if (verifyCalls === 1) {
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
      assert.equal(options.expectedGeneration, undefined);
      return {
        ok: true,
        generation: afterGeneration,
        revisionDigest: afterDigest,
      };
    },
    normalizeInput: (input, options) => {
      assert.equal(options.mode, 'single');
      assert.equal(input.content_id, 'I-PRODUCTION-TEST-1');
      return {
        batch_digest: 'c'.repeat(64),
        items: [{
          content_id: 'I-PRODUCTION-TEST-1',
          content_digest: 'd'.repeat(64),
        }],
      };
    },
    assignmentHash: (rows) => {
      assert.deepEqual(rows, []);
      return 'e'.repeat(64);
    },
    plan: ({ policy, existingContent, existingDigests, runtimeState }) => {
      assert.equal(policy.version, 2);
      assert.equal(policy.timezone, 'America/Chicago');
      assert.deepEqual(policy.slots, ['14:30', '22:15']);
      assert.deepEqual(existingContent, []);
      assert.deepEqual(existingDigests, []);
      assert.equal(runtimeState.generation, 11);
      return {
        operation_id: 'intake-' + '1'.repeat(24),
        items: [{
          content_id: 'I-PRODUCTION-TEST-1',
          content_digest: 'd'.repeat(64),
        }],
      };
    },
    createTransport: () => ({
      async readHaltState() {
        return { halted: 0, generation: 3 };
      },
      async readLaneState() {
        return { generation: 7, active_operation_id: null };
      },
      async readRuntimeState() {
        return { generation: 11, revision_digest: RUNTIME_A };
      },
    }),
    createControlPlan: ({ intakePlan, haltState, laneState }) => {
      assert.equal(intakePlan.operation_id, 'intake-' + '1'.repeat(24));
      assert.equal(haltState.generation, 3);
      assert.equal(laneState.generation, 7);
      return { operation_id: 'mutation-intake-' + '2'.repeat(24) };
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
      assert.equal(args.candidate.branch, 'main');
      assert.equal(await args.transport.captureCheckpoint(), 'bookmark_12345');
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
            phase: 'production_preflight',
            preflight: { ok: false },
          };
    },
    now: () => new Date('2026-10-03T07:00:00.000Z'),
  };
}

function payload(overrides = {}) {
  return {
    environment: 'production',
    checkpoint: { placeholder: true },
    mode: 'single',
    sourceMode: 'owner-manual',
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

test('production worker drives guarded production mutation with canonical bundled policy', async () => {
  const result = await runProductionIntakeRequest(
    { DB: fakeDb() },
    payload(),
    deps(),
  );

  assert.equal(result.ok, true);
  assert.equal(result.publicationCapable, false);
  assert.equal(result.schedulerAuthority, false);
  assert.equal(result.recoveryCheckpointCaptured, true);
  assert.equal(result.planned.operationId, 'mutation-intake-' + '2'.repeat(24));
  assert.deepEqual(result.planned.contentIds, ['I-PRODUCTION-TEST-1']);
  assert.equal(result.productionPreflight.ok, true);
  assert.equal(result.committedRuntimeRevision.generation, 12);
  assert.equal(result.before.generation, 11);
  assert.equal(result.after.generation, 12);
});

test('post-commit verification accepts a later healthy runtime head when the committed source revision is exact', async () => {
  const result = await runProductionIntakeRequest(
    { DB: fakeDb() },
    payload(),
    deps({ afterGeneration: 13, afterDigest: RUNTIME_C }),
  );
  assert.equal(result.ok, true);
  assert.equal(result.committedRuntimeRevision.generation, 12);
  assert.equal(result.after.generation, 13);
});

test('blocked production preflight never claims successful production mutation evidence', async () => {
  const result = await runProductionIntakeRequest(
    { DB: fakeDb() },
    payload(),
    deps({ mutationStatus: 'blocked' }),
  );

  assert.equal(result.ok, false);
  assert.equal(result.mutation.status, 'blocked');
  assert.equal(result.publicationCapable, false);
  assert.equal(result.schedulerAuthority, false);
});

test('production worker refuses non-production request evidence', async () => {
  await assert.rejects(
    () => runProductionIntakeRequest(
      { DB: fakeDb() },
      payload({ environment: 'preview' }),
      deps(),
    ),
    /environment=production/,
  );
});

test('explicit unsupported source mode fails closed instead of becoming owner-manual', async () => {
  await assert.rejects(
    () => runProductionIntakeRequest(
      { DB: fakeDb() },
      payload({ sourceMode: 'automted' }),
      deps(),
    ),
    /sourceMode must be owner-manual or automated/,
  );
});

function signedCheckpoint({
  candidateSha = '1'.repeat(40),
  batchDigest = 'c'.repeat(64),
  bookmark = 'bookmark_12345',
  issuedAt = '2026-10-03T07:00:00.000Z',
  nonce = 'nonce_1234567890123456',
} = {}) {
  const fields = [
    'xqueue-production-checkpoint-v1',
    DB_ID,
    candidateSha,
    batchDigest,
    bookmark,
    issuedAt,
    nonce,
  ];
  return {
    databaseId: DB_ID,
    candidateSha,
    batchDigest,
    bookmark,
    issuedAt,
    nonce,
    signature: createHmac('sha256', CHECKPOINT_KEY)
      .update(fields.join('\n'))
      .digest('hex'),
  };
}

test('checkpoint evidence is HMAC-bound to production database, candidate, batch, and freshness window', async () => {
  const verified = await verifyProductionCheckpointEvidence(
    {
      XQUEUE_PRODUCTION_DATABASE_ID: DB_ID,
      MUTATION_CHECKPOINT_HMAC_KEY: CHECKPOINT_KEY,
    },
    signedCheckpoint(),
    {
      candidateSha: '1'.repeat(40),
      batchDigest: 'c'.repeat(64),
      now: new Date('2026-10-03T07:02:00.000Z'),
    },
  );
  assert.equal(verified.bookmark, 'bookmark_12345');

  await assert.rejects(
    () => verifyProductionCheckpointEvidence(
      {
        XQUEUE_PRODUCTION_DATABASE_ID: DB_ID,
        MUTATION_CHECKPOINT_HMAC_KEY: CHECKPOINT_KEY,
      },
      signedCheckpoint({ batchDigest: 'd'.repeat(64) }),
      {
        candidateSha: '1'.repeat(40),
        batchDigest: 'c'.repeat(64),
        now: new Date('2026-10-03T07:02:00.000Z'),
      },
    ),
    /batch binding mismatch/,
  );

  await assert.rejects(
    () => verifyProductionCheckpointEvidence(
      {
        XQUEUE_PRODUCTION_DATABASE_ID: DB_ID,
        MUTATION_CHECKPOINT_HMAC_KEY: CHECKPOINT_KEY,
      },
      signedCheckpoint({ issuedAt: '2026-10-03T06:50:00.000Z' }),
      {
        candidateSha: '1'.repeat(40),
        batchDigest: 'c'.repeat(64),
        now: new Date('2026-10-03T07:02:00.000Z'),
      },
    ),
    /stale/,
  );
});

test('production mutation endpoint requires an independent bearer service identity', async () => {
  const worker = createMutationProductionIntakeWorker(deps());
  const env = {
    DB: fakeDb(),
    MUTATION_CONTROL_TOKEN: CONTROL_TOKEN,
  };

  const unauthenticated = await worker.fetch(
    new Request('https://example.test/production-intake', {
      method: 'POST',
      body: JSON.stringify(payload()),
      headers: { 'content-type': 'application/json' },
    }),
    env,
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
    env,
  );
  assert.equal(authenticatedResponse.status, 200);
});

test('production mutation worker config has D1 only and no publication bindings or triggers', () => {
  const config = readFileSync('wrangler.mutation-production-intake.jsonc', 'utf8');
  assert.match(config, /"name": "xqueue-mutation-production-intake"/);
  assert.match(config, /"database_name": "xqueue-production"/);
  assert.match(config, /"binding": "DB"/);
  assert.match(config, /"XQUEUE_PRODUCTION_DATABASE_ID"/);
  assert.doesNotMatch(config, /r2_buckets/);
  assert.doesNotMatch(config, /queues/);
  assert.doesNotMatch(config, /triggers/);
  assert.doesNotMatch(config, /MEDIA/);
  assert.doesNotMatch(config, /X_BEARER|X_API|TWITTER|scheduler/i);
  assert.doesNotMatch(config, /control-token-|checkpoint-key-/);
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
