import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve, relative } from 'node:path';
import { intakeCompletionEvidence } from '../src/mutation-intake-d1.mjs';
import { verifyPreviewIntakeEvidence } from '../src/mutation-preview-evidence.mjs';

import {
  createMutationPreviewRehearsalWorker,
  runPreviewIntakeRehearsal,
} from '../cloudflare/src/mutation-preview-rehearsal-worker.mjs';

const RUNTIME_A = 'a'.repeat(64);
const RUNTIME_B = 'b'.repeat(64);

function fakeDb(createdOverrides = {}) {
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
              content_revision: 1,
              intake_state: 'scheduled',
              content_digest: 'c'.repeat(64),
              assignment_id: 'CQ-PREVIEW-MUT-TEST',
              assignment_version: 1,
              resolved_at: '2026-09-30T10:00:00.000Z',
              status: 'active',
              lifecycle_state: 'scheduled',
              ...createdOverrides,
            };
          }
          return null;
        },
      };
    },
  };
}

function dependencies({ mutationStatus = 'applied', changeMutation = () => {} } = {}) {
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
    runMutation: async ({ transport, controlPlan }) => {
      assert.equal(await transport.captureCheckpoint(), 'bookmark_12345');
      const result = {
        status: mutationStatus,
        phase: mutationStatus === 'applied' ? 'complete' : 'preflight',
        recovered: false,
        operation_id: controlPlan.operation_id,
        ...intakeCompletionEvidence(controlPlan, {
          operation_id: controlPlan.operation_id,
          runtime_generation: 12,
          runtime_revision_digest: RUNTIME_B,
          items: [{
            item_key: 'CQ-PREVIEW-MUT-TEST',
            readback_status: 'applied',
            resulting_content_revision: 1,
            resulting_assignment_version: 1,
          }],
        }),
      };
      changeMutation(result);
      return result;
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
  assert.equal(result.mutation.observed.operation_id, result.mutation.operationId);
  assert.equal(result.mutation.observed.runtime_revision_digest, RUNTIME_B);
  assert.equal(result.canonicalReadback.contentRevision, 1);
  assert.equal(result.canonicalReadback.contentDigest, 'c'.repeat(64));
  assert.equal(result.planned.assignmentId, 'CQ-PREVIEW-MUT-TEST');
  assert.equal(result.planned.contentDigest, 'c'.repeat(64));
  assert.deepEqual(verifyPreviewIntakeEvidence(result).observed, result.mutation.observed);
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
  assert.equal(config.d1_databases[0].database_id, 'f5f9bea9-e88c-41ab-9407-70356079a638');
  assert.equal(config.d1_databases[0].binding, 'DB');
  assert.equal(config.d1_databases[0].migrations_dir, 'cloudflare/migrations');
  assert.equal(config.r2_buckets, undefined);
  assert.equal(config.queues, undefined);
  assert.equal(config.triggers, undefined);
  assert.equal(config.vars, undefined);
});

const payload = {
  bookmark: 'bookmark_12345',
  policy: { version: 2 },
  fixture: { content_id: 'CQ-PREVIEW-MUT-TEST' },
};

test('HTTP evidence retains exact runner completion and canonical content proof', async () => {
  const worker = createMutationPreviewRehearsalWorker(dependencies());
  const response = await worker.fetch(new Request('https://example.test/mutation-intake-proof', {
    method: 'POST', body: JSON.stringify(payload),
  }), { DB: fakeDb() });
  assert.equal(response.status, 200);
  const evidence = await response.json();
  assert.equal(evidence.status, 'ok');
  assert.equal(verifyPreviewIntakeEvidence(evidence).evidence_digest, evidence.mutation.evidence_digest);
});

for (const [name, changeMutation] of [
  ['missing readback', (m) => { delete m.observed; }],
  ['missing digest', (m) => { delete m.evidence_digest; }],
  ['wrong operation', (m) => { m.operation_id = 'mutation-intake-' + '9'.repeat(24); }],
  ['wrong digest', (m) => { m.evidence_digest = '9'.repeat(64); }],
]) {
  test(`wrapper refuses successful runner status with ${name}`, async () => {
    await assert.rejects(runPreviewIntakeRehearsal(
      { DB: fakeDb() }, payload, dependencies({ changeMutation }),
    ));
  });
}

for (const override of [{ content_revision: 2 }, { assignment_id: 'unrelated' }, { content_digest: '0'.repeat(64) }]) {
  test(`wrapper refuses contradictory canonical readback ${JSON.stringify(override)}`, async () => {
    await assert.rejects(runPreviewIntakeRehearsal(
      { DB: fakeDb(override) }, payload, dependencies(),
    ), /canonical readback is incomplete/);
  });
}

test('already-applied exact completion evidence remains acceptable without retry semantics', async () => {
  const evidence = await runPreviewIntakeRehearsal(
    { DB: fakeDb() }, payload, dependencies({ mutationStatus: 'already_applied' }),
  );
  assert.equal(evidence.mutation.status, 'already_applied');
  verifyPreviewIntakeEvidence(evidence);
});

test('artifact validator rejects missing and contradictory completion evidence', async (t) => {
  const good = await runPreviewIntakeRehearsal({ DB: fakeDb() }, payload, dependencies());
  const cases = [
    ['missing evidence digest', (e) => { delete e.mutation.evidence_digest; }],
    ['missing observed', (e) => { delete e.mutation.observed; }],
    ['wrong operation', (e) => { e.mutation.observed.operation_id = 'other'; }],
    ['stale runtime', (e) => { e.mutation.observed.runtime_generation = 11; }],
    ['wrong runtime digest', (e) => { e.mutation.observed.runtime_revision_digest = RUNTIME_A; }],
    ['missing item', (e) => { e.mutation.observed.items = []; }],
    ['extra item', (e) => { e.mutation.observed.items.push({ ...e.mutation.observed.items[0] }); }],
    ['wrong item', (e) => { e.mutation.observed.items[0].item_key = 'unrelated'; }],
    ['unapplied item', (e) => { e.mutation.observed.items[0].readback_status = 'pending'; }],
    ['wrong content version', (e) => { e.mutation.observed.items[0].resulting_content_revision = 2; }],
    ['wrong assignment version', (e) => { e.mutation.observed.items[0].resulting_assignment_version = 2; }],
    ['tampered digest', (e) => { e.mutation.evidence_digest = '0'.repeat(64); }],
    ['missing canonical revision', (e) => { delete e.canonicalReadback.contentRevision; }],
    ['missing canonical digest', (e) => { delete e.canonicalReadback.contentDigest; }],
    ['malformed canonical digest', (e) => { e.canonicalReadback.contentDigest = 'unknown'; }],
    ['wrong canonical item', (e) => { e.canonicalReadback.contentId = 'unrelated'; }],
    ['wrong canonical assignment', (e) => { e.canonicalReadback.assignmentId = 'unrelated'; }],
    ['wrong canonical digest', (e) => { e.canonicalReadback.contentDigest = '0'.repeat(64); }],
    ['wrong planned assignment', (e) => { e.planned.assignmentId = 'unrelated'; }],
    ['wrong planned digest', (e) => { e.planned.contentDigest = '0'.repeat(64); }],
    ['wrong planned operation', (e) => { e.planned.operationId = 'mutation-intake-' + '9'.repeat(24); }],
    ['wrong canonical version', (e) => { e.canonicalReadback.contentRevision = 2; }],
    ['missing checkpoint', (e) => { e.recoveryCheckpointCaptured = false; }],
    ['publication capable', (e) => { e.publicationCapable = true; }],
    ['scheduler capable', (e) => { e.schedulerAuthority = true; }],
    ['blocked mutation', (e) => { e.mutation.status = 'blocked'; }],
  ];
  for (const [name, change] of cases) {
    await t.test(name, () => {
      const bad = structuredClone(good);
      change(bad);
      assert.throws(() => verifyPreviewIntakeEvidence(bad));
    });
  }
});

test('trusted workflow validates saved evidence with the same completion verifier', () => {
  const workflow = readFileSync('.github/workflows/preview-mutation-intake-rehearsal.yml', 'utf8');
  assert.match(workflow, /import\('\.\/src\/mutation-preview-evidence\.mjs'\)/);
  assert.match(workflow, /verifyPreviewIntakeEvidence\(evidence\)/);
  assert.match(workflow, /branches: \[main\]/);
  assert.doesNotMatch(workflow, /pull_request/);
  assert.match(workflow, /group: xqueue-preview-schema-mutation/);
  assert.match(workflow, /XQUEUE_PREVIEW_DATABASE_ID: f5f9bea9-e88c-41ab-9407-70356079a638/);
  assert.ok(workflow.includes(
    "'This content exists only to prove the no-X preview D1 mutation path. Run ' +",
  ));
  assert.ok(workflow.includes("suffix + '.',"));
  const requestStartMarker = 'HTTP_STATUS="$(curl -sS';
  const requestEndMarker = 'http://127.0.0.1:8788/mutation-intake-proof || true)"';
  const requestStart = workflow.indexOf(requestStartMarker);
  const requestEnd = workflow.indexOf(requestEndMarker, requestStart);
  assert.notEqual(requestStart, -1);
  assert.notEqual(requestEnd, -1);
  const requestBlock = workflow.slice(requestStart, requestEnd + requestEndMarker.length);
  assert.ok(requestBlock.startsWith(requestStartMarker));
  assert.doesNotMatch(requestBlock, /curl -fsS/);
  const outputPos = requestBlock.indexOf('--output /tmp/xqueue-mutation-preview-evidence.json');
  const statusPos = requestBlock.indexOf("--write-out '%{http_code}'");
  const endpointPos = requestBlock.indexOf('http://127.0.0.1:8788/mutation-intake-proof');
  assert.ok(outputPos > 0);
  assert.ok(statusPos > outputPos);
  assert.ok(endpointPos > statusPos);
  assert.ok(requestBlock.endsWith(requestEndMarker));
  assert.ok(workflow.includes('cat /tmp/xqueue-mutation-preview-evidence.json >&2'));
});

test('rehearsal triggers cover every local module in its dependency graph and the lockfile', () => {
  const workflow = readFileSync('.github/workflows/preview-mutation-intake-rehearsal.yml', 'utf8');
  const pathBlock = workflow.split('    paths:\n')[1].split('  workflow_dispatch:')[0];
  const paths = [...pathBlock.matchAll(/      - '([^']+)'/g)].map((m) => m[1]);
  const covered = (path) => paths.some((p) => p === path ||
    (p.endsWith('/*.mjs') && dirname(path) === p.slice(0, -6) && path.endsWith('.mjs')));
  const visited = new Set();
  function visit(file) {
    const path = relative(process.cwd(), file);
    if (visited.has(path)) return;
    visited.add(path);
    assert.ok(covered(path), `remote rehearsal trigger missing dependency: ${path}`);
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g)) {
      if (match[1].startsWith('.')) visit(resolve(dirname(file), match[1]));
    }
  }
  visit(resolve('cloudflare/src/mutation-preview-rehearsal-worker.mjs'));
  assert.ok(visited.has('src/autonomy/decision-model.mjs'));
  assert.ok(visited.has('cloudflare/src/media-verify.mjs'));
  assert.ok(paths.includes('pnpm-lock.yaml'));
});
