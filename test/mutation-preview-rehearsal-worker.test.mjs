import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  createMutationPreviewRehearsalWorker,
  runPreviewIntakeRehearsal,
} from '../cloudflare/src/mutation-preview-rehearsal-worker.mjs';

const RUNTIME_A = 'a'.repeat(64);
const RUNTIME_B = 'b'.repeat(64);

function fakeDb() {
  const prepared = [];
  return {
    prepared,
    prepare(sql) {
      const state = { sql, args: [] };
      prepared.push(state);
      return {
        bind(...args) {
          state.args = args;
          return this;
        },
        async all() {
          if (sql.includes('FROM queue_assignments') && sql.includes("WHERE status = 'active'")) {
            return { results: [] };
          }
          if (sql.includes('SELECT c.content_id,r.content_digest')) {
            return { results: [] };
          }
          return { results: [] };
        },
        async first() {
          if (sql.includes('FROM queue_intake_frontier')) {
            return {
              generation: 5,
              resolved_at: '2026-09-29T10:00:00.000Z',
              pending_operation_id: null,
              last_completed_operation_id: null,
            };
          }
          if (sql.includes('FROM queue_content c') && sql.includes('JOIN queue_assignments a')) {
            return {
              content_id: 'CQ-PREVIEW-MUT-TEST',
              intake_state: 'scheduled',
              content_digest: 'c'.repeat(64),
              assignment_id: 'CQ-PREVIEW-MUT-TEST',
              assignment_version: 1,
              resolved_at: '2026-09-30T10:00:00.000Z',
              status: 'active',
              lifecycle_state: 'scheduled',
            };
          }
          return null;
        },
      };
    },
  };
}

function dependencies({ mutationStatus = 'applied' } = {}) {
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
        snapshot: null,
      };
    },
    normalizeInput: () => ({
      format: 1,
      batch_digest: 'd'.repeat(64),
      count: 1,
      items: [{
        ordinal: 0,
        content_id: 'CQ-PREVIEW-MUT-TEST',
        content_digest: 'c'.repeat(64),
        pillar: 'A',
        title: 'Preview rehearsal',
        body: 'Preview-only mutation rehearsal fixture.',
        publication_text: 'Preview-only mutation rehearsal fixture.',
        source_ref: 'test',
      }],
    }),
    assignmentHash: (rows) => {
      assert.deepEqual(rows, []);
      return 'e'.repeat(64);
    },
    plan: ({ baselineAssignmentHash, runtimeState }) => {
      assert.equal(baselineAssignmentHash, 'e'.repeat(64));
      assert.deepEqual(runtimeState, {
        generation: 11,
        revision_digest: RUNTIME_A,
      });
      return {
        operation_id: 'intake-' + '1'.repeat(24),
        plan_digest: '1'.repeat(64),
        batch_digest: 'd'.repeat(64),
        count: 1,
        expected_frontier_generation: 5,
        expected_frontier_resolved_at: '2026-09-29T10:00:00.000Z',
        proposed_frontier_resolved_at: '2026-09-30T10:00:00.000Z',
        baseline_assignment_hash: 'e'.repeat(64),
        expected_runtime_generation: 11,
        expected_runtime_revision_digest: RUNTIME_A,
        target_account: 'x-primary',
        policy_version: 2,
        items: [{
          ordinal: 0,
          content_id: 'CQ-PREVIEW-MUT-TEST',
          content_digest: 'c'.repeat(64),
          pillar: 'A',
          title: 'Preview rehearsal',
          body: 'Preview-only mutation rehearsal fixture.',
          publication_text: 'Preview-only mutation rehearsal fixture.',
          source_ref: 'test',
          assignment_id: 'CQ-PREVIEW-MUT-TEST',
          target_account: 'x-primary',
          policy_version: 2,
          resolved_at: '2026-09-30T10:00:00.000Z',
          scheduled_date: '2026-09-30',
          scheduled_time: '05:00',
          timezone: 'America/Chicago',
          slot_label: 'lull',
        }],
      };
    },
    createTransport: () => ({
      async readHaltState() {
        return { halted: 0, generation: 1 };
      },
      async readLaneState() {
        return { generation: 1, active_operation_id: null };
      },
      async readRuntimeState() {
        return { generation: 11, revision_digest: RUNTIME_A };
      },
    }),
    createControlPlan: ({ intakePlan, runtimeState }) => {
      assert.equal(intakePlan.operation_id, 'intake-' + '1'.repeat(24));
      assert.equal(runtimeState.generation, 11);
      return {
        operation_id: 'mutation-intake-' + '2'.repeat(24),
        operation_kind: 'intake',
        operation_digest: '2'.repeat(64),
        plan_digest: '3'.repeat(64),
        expected_halt_generation: 1,
        expected_lane_generation: 1,
        expected_runtime_generation: 11,
        expected_runtime_revision_digest: RUNTIME_A,
        retry_budgets: { plan: 3, read: 3, operation: 2 },
        items: [{
          item_key: 'CQ-PREVIEW-MUT-TEST',
          expected_content_revision: null,
          expected_assignment_version: null,
          resulting_content_revision: 1,
          resulting_assignment_version: 1,
        }],
      };
    },
    projectRevision: async () => ({
      generation: 12,
      revision_digest: RUNTIME_B,
      previous_revision_digest: RUNTIME_A,
      source_operation_id: 'mutation-intake-' + '2'.repeat(24),
      active_assignment_count: 1,
      approved_unscheduled_count: 0,
      media_required_count: 0,
      media_ready_count: 0,
      created_at: '2026-09-29T10:05:00.000Z',
    }),
    runMutation: async ({ transport }) => {
      assert.equal(await transport.captureCheckpoint(), 'bookmark_12345');
      return {
        status: mutationStatus,
        phase: mutationStatus === 'applied' ? 'complete' : 'preflight',
        recovered: false,
      };
    },
    now: () => new Date('2026-09-29T10:05:00.000Z'),
  };
}

test('preview rehearsal drives planner -> control plan -> mutation -> exact runtime proof', async () => {
  const result = await runPreviewIntakeRehearsal(
    { DB: fakeDb() },
    {
      bookmark: 'bookmark_12345',
      policy: {
        version: 2,
        timezone: 'America/Chicago',
        slots: ['05:00'],
        daysOfWeek: [1, 2, 3, 4, 5],
      },
      fixture: {
        content_id: 'CQ-PREVIEW-MUT-TEST',
        pillar: 'A',
        title: 'Preview rehearsal',
        body: 'Preview-only mutation rehearsal fixture.',
      },
    },
    dependencies(),
  );

  assert.equal(result.ok, true);
  assert.equal(result.publicationCapable, false);
  assert.equal(result.schedulerAuthority, false);
  assert.equal(result.mutation.status, 'applied');
  assert.equal(result.before.generation, 11);
  assert.equal(result.after.generation, 12);
  assert.equal(result.recoveryCheckpointCaptured, true);
});

test('blocked mutation does not claim a successful rehearsal', async () => {
  const result = await runPreviewIntakeRehearsal(
    { DB: fakeDb() },
    {
      bookmark: 'bookmark_12345',
      policy: {
        version: 2,
        timezone: 'America/Chicago',
        slots: ['05:00'],
        daysOfWeek: [1, 2, 3, 4, 5],
      },
      fixture: {
        content_id: 'CQ-PREVIEW-MUT-TEST',
        pillar: 'A',
        title: 'Preview rehearsal',
        body: 'Preview-only mutation rehearsal fixture.',
      },
    },
    dependencies({ mutationStatus: 'blocked' }),
  );

  assert.equal(result.ok, false);
  assert.equal(result.mutation.status, 'blocked');
});

test('worker health surface is no-X and does not execute a mutation', async () => {
  const worker = createMutationPreviewRehearsalWorker({
    runMutation: async () => {
      throw new Error('must not execute');
    },
  });
  const response = await worker.fetch(
    new Request('https://example.test/health'),
    { DB: fakeDb() },
  );
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.status, 'ok');
  assert.equal(body.publicationCapable, false);
  assert.equal(body.schedulerAuthority, false);
});

test('preview rehearsal Wrangler config has D1 only and no publication bindings', () => {
  const config = JSON.parse(
    readFileSync('wrangler.mutation-preview-proof.jsonc', 'utf8'),
  );

  assert.equal(config.name, 'xqueue-mutation-preview-rehearsal');
  assert.equal(config.d1_databases?.length, 1);
  assert.equal(config.d1_databases[0].database_name, 'xqueue-preview');
  assert.equal(config.r2_buckets, undefined);
  assert.equal(config.queues, undefined);
  assert.equal(config.triggers, undefined);
  assert.equal(config.vars, undefined);
});
