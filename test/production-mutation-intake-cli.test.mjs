import test from 'node:test';
import assert from 'node:assert/strict';

import { candidateDigest } from '../src/authoring/contracts.mjs';
import { authorizeProductionIntakeInput } from '../cloudflare/src/mutation-production-intake-worker.mjs';

import {
  PRODUCTION_INTAKE_CONFIRM,
  REQUIRED_MUTATION_MIGRATIONS,
  MUTEX_COMPATIBLE_PUBLISHER_COMMIT,
  SAFETY_SQL,
  assertMutationSchema,
  assertObservedIdentity,
  checkPublisherMutexCompatibility,
  mutationWorkerOwnerPublicKey,
  planIntakeIdentity,
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

  // Evidence may be embedded in the item; the shared authorization step (run
  // offline before anything launches) requires it from exactly one source.
  assert.equal(
    parseArgs([
      '--environment', 'production',
      '--file', 'item.json',
      '--automated',
      '--apply',
      '--confirm', PRODUCTION_INTAKE_CONFIRM,
    ]).ownerApprovalFile,
    null,
  );

  const signed = parseArgs([
    '--environment', 'production',
    '--file', 'item.json',
    '--automated',
    '--approval-file', 'approval.json',
    '--approved-candidate-file', 'candidate.json',
    '--apply',
    '--confirm', PRODUCTION_INTAKE_CONFIRM,
  ]);
  assert.equal(signed.ownerApprovalFile, 'approval.json');
  assert.equal(signed.approvedCandidateFile, 'candidate.json');

  // The Worker verifies the signature over the full approved candidate, so a
  // signed approval without that candidate can never authorize intake.
  assert.throws(
    () => parseArgs([
      '--environment', 'production',
      '--file', 'item.json',
      '--automated',
      '--approval-file', 'approval.json',
    ]),
    /must be supplied together/,
  );
  assert.throws(
    () => parseArgs([
      '--environment', 'production',
      '--file', 'item.json',
      '--approved-candidate-file', 'candidate.json',
    ]),
    /valid only with --automated/,
  );

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
    publisherMutex: { ok: true, reason: 'publisher_mutex_compatible' },
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
  // Absent publisher compatibility evidence is a blocker, never a pass.
  assert.ok(ids.includes('publisher_mutex_compatibility_unknown'));
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

test('operator lease read uses the same held-lease exclusion as the mutation Worker', async () => {
  const { readFileSync } = await import('node:fs');
  const transport = readFileSync(new URL('../src/mutation-control-transport.mjs', import.meta.url), 'utf8');
  assert.match(transport, /FROM publication_leases ' \+\s*'WHERE owner_token IS NOT NULL'/);
  assert.match(SAFETY_SQL, /FROM publication_leases WHERE owner_token IS NOT NULL;/);
  // An expired-but-held lease still blocks; no TTL or clock predicate may relax it.
  assert.doesNotMatch(SAFETY_SQL, /expires_at_ms|strftime|julianday/);
});

test('publisher mutex compatibility is proven by commit ancestry and fails closed', () => {
  const sha = 'd'.repeat(40);
  const calls = [];
  const spawnWith = (status) => (command, argv) => {
    calls.push([command, ...argv]);
    return { status };
  };

  assert.equal(checkPublisherMutexCompatibility(sha, spawnWith(0)).ok, true);
  assert.deepEqual(calls[0], [
    'git', 'merge-base', '--is-ancestor', MUTEX_COMPATIBLE_PUBLISHER_COMMIT, sha,
  ]);
  assert.equal(
    checkPublisherMutexCompatibility(sha, spawnWith(1)).reason,
    'publisher_predates_mutation_mutex',
  );
  assert.equal(
    checkPublisherMutexCompatibility(sha, spawnWith(128)).reason,
    'publisher_candidate_unverifiable',
  );
  assert.equal(
    checkPublisherMutexCompatibility('not-a-sha', spawnWith(0)).reason,
    'publisher_candidate_invalid',
  );
});

test('apply refuses before launching the Worker when the publisher predates the mutex', async () => {
  const run = (command, argv) => {
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
  let checkedSha = null;
  const previousExitCode = process.exitCode;
  let blockedExitCode;
  let result;
  try {
    result = await main(
    [
      '--environment', 'production',
      '--file', 'item.json',
      '--apply',
      '--confirm', PRODUCTION_INTAKE_CONFIRM,
    ],
    {
      run,
      readJson: () => ({ content_id: 'I-1', pillar: 'A', body: 'approved' }),
      checkPublisher: (sha) => {
        checkedSha = sha;
        return { ok: false, reason: 'publisher_predates_mutation_mutex', candidateSha: sha };
      },
      invokeWorker: async () => {
        invoked = true;
        throw new Error('must not invoke');
      },
    },
    );
    blockedExitCode = process.exitCode;
  } finally {
    process.exitCode = previousExitCode;
  }

  assert.equal(blockedExitCode, 1);
  assert.equal(checkedSha, safety().authority.candidate_sha);
  assert.equal(result.status, 'blocked');
  assert.equal(invoked, false);
  assert.ok(
    result.readiness.blockers.some((item) => item.id === 'publisher_predates_mutation_mutex'),
  );
  assert.equal(result.publisherMutex.reason, 'publisher_predates_mutation_mutex');
});

function readyRun() {
  return (command, argv) => {
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
}

async function withExitCode(fn) {
  const previous = process.exitCode;
  try {
    const value = await fn();
    return { value, exitCode: process.exitCode };
  } finally {
    process.exitCode = previous;
  }
}

test('invalid intake input blocks apply offline before the Worker is launched', async () => {
  let invoked = false;
  const { value: result, exitCode } = await withExitCode(() => main(
    [
      '--environment', 'production',
      '--file', 'item.json',
      '--apply',
      '--confirm', PRODUCTION_INTAKE_CONFIRM,
    ],
    {
      run: readyRun(),
      readJson: () => ({ content_id: 'I-1', pillar: 'A' }),
      checkPublisher: () => ({ ok: true, reason: 'publisher_mutex_compatible' }),
      invokeWorker: async () => {
        invoked = true;
        throw new Error('must not invoke');
      },
    },
  ));

  assert.equal(invoked, false);
  assert.equal(exitCode, 1);
  assert.equal(result.status, 'blocked');
  assert.equal(result.planned.ok, false);
  assert.ok(result.readiness.blockers.some((item) => item.id === 'INVALID_INTAKE'));
});

test('automated intake whose fields differ from the signed candidate is blocked offline', async () => {
  const approvedCandidate = {
    candidate_id: 'I-2',
    artifact_kind: 'post',
    title: 'Signed title',
    body: 'signed body',
    pillar: 'A',
    figure: null,
    source_refs: ['source:test'],
  };
  const files = new Map([
    ['item.json', {
      content_id: 'I-2',
      pillar: 'A',
      title: 'Signed title',
      body: 'edited after signing',
      source_ref: 'source:test',
    }],
    ['approval.json', { owner_proof: { payload_digest: 'sha256:' + '3'.repeat(64) } }],
    ['candidate.json', approvedCandidate],
  ]);
  let invoked = false;
  const { value: result } = await withExitCode(() => main(
    [
      '--environment', 'production',
      '--file', 'item.json',
      '--automated',
      '--approval-file', 'approval.json',
      '--approved-candidate-file', 'candidate.json',
    ],
    {
      run: readyRun(),
      readJson: (path) => files.get(path),
      ownerPublicKeyPem: 'test-owner-public-key',
      verifyOwnerApproval: () => true,
      checkPublisher: () => ({ ok: true, reason: 'publisher_mutex_compatible' }),
      invokeWorker: async () => {
        invoked = true;
        throw new Error('must not invoke');
      },
    },
  ));

  assert.equal(invoked, false);
  assert.equal(result.status, 'blocked');
  assert.ok(result.readiness.blockers.some((item) => item.id === 'INVALID_OWNER_APPROVAL'));
});

test('a Worker identity that contradicts the offline plan requires readback, not success', async () => {
  await assert.rejects(
    main(
      [
        '--environment', 'production',
        '--file', 'item.json',
        '--apply',
        '--confirm', PRODUCTION_INTAKE_CONFIRM,
      ],
      {
        run: readyRun(),
        readJson: () => ({ content_id: 'I-1', pillar: 'A', body: 'approved' }),
        checkPublisher: () => ({ ok: true, reason: 'publisher_mutex_compatible' }),
        invokeWorker: async () => ({
          status: 'ok',
          planned: {
            operationId: 'mutation-intake-' + 'f'.repeat(24),
            contentIds: ['I-1'],
            contentDigests: ['0'.repeat(64)],
          },
          mutation: { status: 'applied' },
        }),
      },
    ),
    (error) => {
      assert.match(error.message, /contradicts the offline plan/);
      assert.equal(error.response.requiresReadback, true);
      return true;
    },
  );

  const planned = planIntakeIdentity({
    mode: 'single',
    input: { content_id: 'I-1', pillar: 'A', body: 'approved' },
  });
  assert.throws(() => assertObservedIdentity(planned, undefined), /contradicts/);
  assert.equal(
    assertObservedIdentity(planned, {
      operationId: planned.operationId,
      contentIds: planned.contentIds,
      contentDigests: planned.contentDigests,
    }),
    true,
  );
});

test('offline authorization uses the committed Worker owner public key', () => {
  assert.match(mutationWorkerOwnerPublicKey(), /^-----BEGIN PUBLIC KEY-----\n/);
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
      checkPublisher: () => ({ ok: true, reason: 'publisher_mutex_compatible' }),
      invokeWorker: async () => {
        invoked = true;
        throw new Error('must not invoke');
      },
    },
  );

  assert.equal(result.status, 'ready');
  assert.equal(result.mode, 'observe');
  assert.equal(invoked, false);
  // Observe mode reports the identity the Worker itself will derive.
  const expected = authorizeProductionIntakeInput({
    mode: 'single',
    sourceMode: 'owner-manual',
    input: { content_id: 'I-1', pillar: 'A', body: 'approved' },
  });
  assert.equal(result.planned.ok, true);
  assert.equal(result.planned.operationId, expected.operationId);
  assert.equal(result.planned.batchDigest, expected.normalized.batch_digest);
  assert.deepEqual(result.planned.contentIds, ['I-1']);
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

  const approvedCandidate = {
    candidate_id: 'I-1',
    artifact_kind: 'post',
    status: 'awaiting_owner',
    title: 'Approved operator intake',
    body: 'approved',
    pillar: 'A',
    figure: null,
    knowledge_unit_refs: ['knowledge:test'],
    source_refs: ['source:test'],
    created_at: '2026-10-03T06:58:00.000Z',
    generator: null,
    validation: { result: 'pass', findings: [] },
  };
  approvedCandidate.content_digest = candidateDigest(approvedCandidate);
  const approval = {
    approval_id: 'approval:test',
    candidate_id: approvedCandidate.candidate_id,
    candidate_digest: approvedCandidate.content_digest,
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
    ['item.json', {
      content_id: approvedCandidate.candidate_id,
      pillar: approvedCandidate.pillar,
      title: approvedCandidate.title,
      body: approvedCandidate.body,
      source_ref: approvedCandidate.source_refs[0],
    }],
    ['approval.json', approval],
    ['candidate.json', approvedCandidate],
  ]);
  const verified = [];
  const verifyOwnerApproval = (candidate, provided, publicKeyPem) => {
    verified.push({ candidate, provided, publicKeyPem });
    return true;
  };
  const ownerPublicKeyPem = 'test-owner-public-key';
  let call;

  const result = await main(
    [
      '--environment', 'production',
      '--file', 'item.json',
      '--automated',
      '--approval-file', 'approval.json',
      '--approved-candidate-file', 'candidate.json',
      '--apply',
      '--confirm', PRODUCTION_INTAKE_CONFIRM,
    ],
    {
      run,
      readJson: (path) => files.get(path),
      ownerPublicKeyPem,
      verifyOwnerApproval,
      checkPublisher: () => ({ ok: true, reason: 'publisher_mutex_compatible' }),
      invokeWorker: async (args) => {
        call = args;
        const planned = planIntakeIdentity(args.payload, {
          ownerPublicKeyPem,
          verifyOwnerApproval: () => true,
        });
        return {
          status: 'ok',
          planned: {
            operationId: planned.operationId,
            contentIds: planned.contentIds,
            contentDigests: planned.contentDigests,
          },
          mutation: { status: 'applied' },
        };
      },
    },
  );

  // Offline authorization verified the signed approval against the full candidate.
  assert.equal(verified.length, 1);
  assert.equal(verified[0].candidate, approvedCandidate);
  assert.equal(verified[0].provided, approval);
  assert.equal(verified[0].publicKeyPem, ownerPublicKeyPem);
  assert.equal(result.planned.sourceMode, 'automated');
  assert.match(result.planned.operationId, /^mutation-intake-[0-9a-f]{24}$/);
  assert.equal(result.identityBinding.planned, result.identityBinding.observed);

  assert.equal(call.payload.sourceMode, 'automated');
  assert.deepEqual(call.payload.ownerApproval, approval);
  assert.deepEqual(call.payload.approvedCandidate, approvedCandidate);
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
      checkPublisher: () => ({ ok: true, reason: 'publisher_mutex_compatible' }),
      invokeWorker: async (args) => {
        call = args;
        const planned = planIntakeIdentity(args.payload);
        return {
          status: 'ok',
          planned: {
            operationId: planned.operationId,
            contentIds: planned.contentIds,
            contentDigests: planned.contentDigests,
          },
          mutation: { status: 'applied' },
        };
      },
    },
  );

  assert.equal(result.status, 'complete');
  assert.equal(call.candidate.branch, 'main');
  assert.equal(call.candidate.headSha, 'a'.repeat(40));
  assert.equal(call.payload.mode, 'single');
  assert.equal(call.payload.sourceMode, 'owner-manual');
});
