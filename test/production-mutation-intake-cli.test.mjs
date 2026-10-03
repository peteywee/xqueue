import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PRODUCTION_INTAKE_CONFIRM,
  REQUIRED_MUTATION_MIGRATIONS,
  assertMutationSchema,
  evaluateOperatorReadiness,
  main,
  parseArgs,
  parseSafetyPayload,
} from '../scripts/production-mutation-intake.mjs';

function auth(overrides = {}) {
  return {
    ok: true,
    environment: 'production',
    token_type: 'account',
    token_status: 'active',
    d1: { readable: true },
    ...overrides,
  };
}

function candidate(overrides = {}) {
  return {
    branch: 'main',
    clean: true,
    headSha: 'a'.repeat(40),
    originMainSha: 'a'.repeat(40),
    ...overrides,
  };
}

function safety(overrides = {}) {
  return {
    authority: {
      owner: 'cloudflare',
      generation: 9,
      transition_state: 'stable',
      candidate_sha: 'b'.repeat(40),
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
    mutationHalt: { halted: 0, generation: 4 },
    mutationLane: { generation: 8, active_operation_id: null },
    runtimeState: { generation: 12, revision_digest: 'c'.repeat(64) },
    ...overrides,
  };
}

test('production operator CLI requires explicit environment and apply confirmation', () => {
  assert.throws(
    () => parseArgs(['--file', 'item.json']),
    /explicit --environment production/,
  );
  assert.throws(
    () => parseArgs([
      '--environment', 'production',
      '--file', 'item.json',
      '--apply',
    ]),
    new RegExp(PRODUCTION_INTAKE_CONFIRM),
  );

  const parsed = parseArgs([
    '--environment', 'production',
    '--file', 'item.json',
    '--mode', 'batch',
    '--automated',
    '--apply',
    '--confirm', PRODUCTION_INTAKE_CONFIRM,
  ]);
  assert.equal(parsed.environment, 'production');
  assert.equal(parsed.mode, 'batch');
  assert.equal(parsed.sourceMode, 'automated');
  assert.equal(parsed.ownerApprovalFile, null);
  assert.equal(parsed.apply, true);

  assert.throws(
    () => parseArgs([
      '--environment', 'production',
      '--file', 'item.json',
      '--automated',
      '--apply',
      '--confirm', PRODUCTION_INTAKE_CONFIRM,
    ]),
    /requires --approval-file/,
  );

  const signed = parseArgs([
    '--environment', 'production',
    '--file', 'item.json',
    '--automated',
    '--approval-file', 'approval.json',
    '--apply',
    '--confirm', PRODUCTION_INTAKE_CONFIRM,
  ]);
  assert.equal(signed.ownerApprovalFile, 'approval.json');

  assert.throws(
    () => parseArgs([
      '--environment', 'production',
      '--file', 'item.json',
      '--approval-digest', 'legacy',
    ]),
    /unknown argument: --approval-digest/,
  );
});

test('schema readiness requires all production mutation migrations and never auto-applies them', () => {
  assert.deepEqual(REQUIRED_MUTATION_MIGRATIONS, [
    '0015_mutation_control_plane.sql',
    '0016_mutation_completion_item_guard.sql',
    '0017_publication_mutation_mutex.sql',
  ]);
  assert.equal(assertMutationSchema(REQUIRED_MUTATION_MIGRATIONS), true);
  assert.throws(
    () => assertMutationSchema(['0015_mutation_control_plane.sql']),
    /never auto-applies production migrations/,
  );
});

test('operator readiness consumes the existing production preflight and mutation lane facts', () => {
  const ready = evaluateOperatorReadiness({
    auth: auth(),
    candidate: candidate(),
    migrations: REQUIRED_MUTATION_MIGRATIONS,
    safety: safety(),
  });
  assert.equal(ready.ok, true);

  const blocked = evaluateOperatorReadiness({
    auth: auth(),
    candidate: candidate({ clean: false }),
    migrations: ['0015_mutation_control_plane.sql'],
    safety: safety({
      mutationHalt: { halted: 1, generation: 4 },
      mutationLane: { generation: 8, active_operation_id: 'mutation-intake-x' },
    }),
  });
  assert.equal(blocked.ok, false);
  const ids = blocked.blockers.map((item) => item.id);
  assert.ok(ids.includes('candidate_dirty'));
  assert.ok(ids.includes('production_mutation_schema_not_active'));
  assert.ok(ids.includes('mutation_lane_halted'));
  assert.ok(ids.includes('mutation_lane_contended'));
});

test('safety parser keeps publication and mutation-lane facts distinct', () => {
  const parsed = parseSafetyPayload([
    { results: [{ owner: 'cloudflare', generation: 9 }] },
    { results: [{ unresolved: 0 }] },
    { results: [{ active_leases: 0 }] },
    { results: [{ inflight: null }] },
    { results: [{ publication_lease_generation: 5 }] },
    { results: [{ publication_event_cursor: 17 }] },
    { results: [{ halted: 0, generation: 4 }] },
    { results: [{ generation: 8, active_operation_id: null }] },
    { results: [{ generation: 12, revision_digest: 'c'.repeat(64) }] },
  ]);
  assert.equal(parsed.unresolvedAttemptCount, 0);
  assert.equal(parsed.activeLeaseCount, 0);
  assert.equal(parsed.publicationLeaseGeneration, 5);
  assert.equal(parsed.publicationEventCursor, 17);
  assert.equal(parsed.mutationHalt.generation, 4);
  assert.equal(parsed.mutationLane.generation, 8);
  assert.equal(parsed.runtimeState.generation, 12);
});

test('observe mode never invokes the mutation Worker', async () => {
  const commands = [];
  const run = (command, argv) => {
    commands.push([command, ...argv]);
    const key = [command, ...argv].join(' ');
    if (key === 'git branch --show-current') return 'main\n';
    if (key === 'git status --porcelain --untracked-files=all') return '';
    if (key === 'git fetch origin main') return '';
    if (key === 'git rev-parse HEAD') return 'a'.repeat(40) + '\n';
    if (key === 'git rev-parse origin/main') return 'a'.repeat(40) + '\n';
    if (key === 'pnpm cf:auth:preflight --environment production') {
      return JSON.stringify(auth());
    }
    if (key.includes('SELECT name FROM d1_migrations')) {
      return JSON.stringify([{ results: REQUIRED_MUTATION_MIGRATIONS.map((name) => ({ name })) }]);
    }
    if (key.includes('SELECT owner,generation,transition_state')) {
      return JSON.stringify([
        { results: [safety().authority] },
        { results: [{ unresolved: 0 }] },
        { results: [{ active_leases: 0 }] },
        { results: [{ inflight: null }] },
        { results: [{ publication_lease_generation: 5 }] },
        { results: [{ publication_event_cursor: 17 }] },
        { results: [safety().mutationHalt] },
        { results: [safety().mutationLane] },
        { results: [safety().runtimeState] },
      ]);
    }
    throw new Error('unexpected command: ' + key);
  };

  let invoked = false;
  const result = await main(
    ['--environment', 'production', '--file', 'item.json'],
    {
      run,
      readJson: () => ({ content_id: 'I-1', pillar: 'A', body: 'approved' }),
      invokeWorker: async () => {
        invoked = true;
        throw new Error('must not invoke');
      },
    },
  );

  assert.equal(result.status, 'ready');
  assert.equal(result.mode, 'observe');
  assert.equal(invoked, false);
  assert.ok(commands.some((row) => row.join(' ') === 'git fetch origin main'));
});

test('automated single-item apply passes signed approval evidence, never a digest override', async () => {
  const run = (command, argv) => {
    const key = [command, ...argv].join(' ');
    if (key === 'git branch --show-current') return 'main\n';
    if (key === 'git status --porcelain --untracked-files=all') return '';
    if (key === 'git fetch origin main') return '';
    if (key === 'git rev-parse HEAD') return 'a'.repeat(40) + '\n';
    if (key === 'git rev-parse origin/main') return 'a'.repeat(40) + '\n';
    if (key === 'pnpm cf:auth:preflight --environment production') return JSON.stringify(auth());
    if (key.includes('SELECT name FROM d1_migrations')) {
      return JSON.stringify([{ results: REQUIRED_MUTATION_MIGRATIONS.map((name) => ({ name })) }]);
    }
    if (key.includes('SELECT owner,generation,transition_state')) {
      return JSON.stringify([
        { results: [safety().authority] },
        { results: [{ unresolved: 0 }] },
        { results: [{ active_leases: 0 }] },
        { results: [{ inflight: null }] },
        { results: [{ publication_lease_generation: 5 }] },
        { results: [{ publication_event_cursor: 17 }] },
        { results: [safety().mutationHalt] },
        { results: [safety().mutationLane] },
        { results: [safety().runtimeState] },
      ]);
    }
    throw new Error('unexpected command: ' + key);
  };

  const approval = {
    approval_id: 'approval:test',
    candidate_id: 'I-1',
    candidate_digest: 'sha256:' + '1'.repeat(64),
    decision: 'approve',
    decided_by: 'Patrick Craven',
    decided_at: '2026-10-03T06:59:00.000Z',
    owner_proof: {
      type: 'ed25519-detached',
      public_key_fingerprint: 'sha256:' + '2'.repeat(64),
      payload_digest: 'sha256:' + '3'.repeat(64),
      signature_base64: 'signed-proof',
    },
  };
  const files = new Map([
    ['item.json', { content_id: 'I-1', pillar: 'A', body: 'approved' }],
    ['approval.json', approval],
  ]);
  let call;

  await main(
    [
      '--environment', 'production',
      '--file', 'item.json',
      '--automated',
      '--approval-file', 'approval.json',
      '--apply',
      '--confirm', PRODUCTION_INTAKE_CONFIRM,
    ],
    {
      run,
      readJson: (path) => files.get(path),
      invokeWorker: async (args) => {
        call = args;
        return { status: 'ok', mutation: { status: 'applied' } };
      },
    },
  );

  assert.equal(call.payload.sourceMode, 'automated');
  assert.deepEqual(call.payload.ownerApproval, approval);
  assert.equal('ownerApprovalDigest' in call.payload, false);
});

test('apply mode invokes the ephemeral Worker only after readiness and exact confirmation', async () => {
  const run = (command, argv) => {
    const key = [command, ...argv].join(' ');
    if (key === 'git branch --show-current') return 'main\n';
    if (key === 'git status --porcelain --untracked-files=all') return '';
    if (key === 'git fetch origin main') return '';
    if (key === 'git rev-parse HEAD') return 'a'.repeat(40) + '\n';
    if (key === 'git rev-parse origin/main') return 'a'.repeat(40) + '\n';
    if (key === 'pnpm cf:auth:preflight --environment production') return JSON.stringify(auth());
    if (key.includes('SELECT name FROM d1_migrations')) {
      return JSON.stringify([{ results: REQUIRED_MUTATION_MIGRATIONS.map((name) => ({ name })) }]);
    }
    if (key.includes('SELECT owner,generation,transition_state')) {
      return JSON.stringify([
        { results: [safety().authority] },
        { results: [{ unresolved: 0 }] },
        { results: [{ active_leases: 0 }] },
        { results: [{ inflight: null }] },
        { results: [{ publication_lease_generation: 5 }] },
        { results: [{ publication_event_cursor: 17 }] },
        { results: [safety().mutationHalt] },
        { results: [safety().mutationLane] },
        { results: [safety().runtimeState] },
      ]);
    }
    throw new Error('unexpected command: ' + key);
  };

  let call;
  const result = await main(
    [
      '--environment', 'production',
      '--file', 'item.json',
      '--apply',
      '--confirm', PRODUCTION_INTAKE_CONFIRM,
    ],
    {
      run,
      readJson: () => ({ content_id: 'I-1', pillar: 'A', body: 'approved' }),
      invokeWorker: async (args) => {
        call = args;
        return { status: 'ok', mutation: { status: 'applied' } };
      },
    },
  );

  assert.equal(result.status, 'complete');
  assert.equal(call.candidate.branch, 'main');
  assert.equal(call.candidate.headSha, 'a'.repeat(40));
  assert.equal(call.payload.mode, 'single');
  assert.equal(call.payload.sourceMode, 'owner-manual');
});
