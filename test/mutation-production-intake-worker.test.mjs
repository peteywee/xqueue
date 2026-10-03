import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  createMutationProductionIntakeWorker,
  runProductionIntakeRequest,
} from '../cloudflare/src/mutation-production-intake-worker.mjs';

const RUNTIME_A = 'a'.repeat(64);
const RUNTIME_B = 'b'.repeat(64);

function fakeDb() {
  return {
    prepare(sql) {
      return {
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
          return null;
        },
      };
    },
  };
}

function deps({ mutationStatus = 'applied' } = {}) {
  let verifyCalls = 0;
  return {
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
      assert.equal(options.expectedGeneration, 12);
      assert.equal(options.expectedRevisionDigest, RUNTIME_B);
      return {
        ok: true,
        generation: 12,
        revisionDigest: RUNTIME_B,
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
    plan: ({ existingContent, existingDigests, runtimeState }) => {
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

function payload() {
  return {
    environment: 'production',
    bookmark: 'bookmark_12345',
    mode: 'single',
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
    policy: { version: 2 },
    input: {
      content_id: 'I-PRODUCTION-TEST-1',
      pillar: 'A',
      body: 'Approved production intake test.',
    },
  };
}

test('production worker drives the guarded production wrapper and proves no publication authority', async () => {
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
  assert.equal(result.before.generation, 11);
  assert.equal(result.after.generation, 12);
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
  const bad = payload();
  bad.environment = 'preview';
  await assert.rejects(
    () => runProductionIntakeRequest({ DB: fakeDb() }, bad, deps()),
    /environment=production/,
  );
});

test('production mutation worker config has D1 only and no publication bindings or triggers', () => {
  const config = readFileSync('wrangler.mutation-production-intake.jsonc', 'utf8');
  assert.match(config, /"name": "xqueue-mutation-production-intake"/);
  assert.match(config, /"database_name": "xqueue-production"/);
  assert.match(config, /"binding": "DB"/);
  assert.doesNotMatch(config, /r2_buckets/);
  assert.doesNotMatch(config, /queues/);
  assert.doesNotMatch(config, /triggers/);
  assert.doesNotMatch(config, /MEDIA/);
  assert.doesNotMatch(config, /X_BEARER|X_API|TWITTER|scheduler/i);
});

test('production worker surface exposes only health and guarded production intake', async () => {
  const worker = createMutationProductionIntakeWorker(deps());
  const health = await worker.fetch(new Request('https://example.test/health'), { DB: fakeDb() });
  assert.equal(health.status, 200);
  const healthBody = await health.json();
  assert.equal(healthBody.publicationCapable, false);
  assert.equal(healthBody.schedulerAuthority, false);

  const missing = await worker.fetch(new Request('https://example.test/publish'), { DB: fakeDb() });
  assert.equal(missing.status, 404);
});
