import test from 'node:test';
import assert from 'node:assert/strict';

import { runD1MirrorSync } from '../scripts/d1-mirror-sync.mjs';

const candidateSha = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const otherSha = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const eventAt = '2026-09-15T18:00:00.000Z';
const deploymentId = 'local-systemd:xqueue.service:preview';

function localState() {
  return {
    version: 1,
    posted: { A1: { tweetId: 'tweet-1' } },
    skipped: {},
    spend: 0,
    inflight: null,
  };
}

function canonicalState() {
  return `${JSON.stringify(localState(), null, 2)}\n`;
}

function authority(owner = 'none', overrides = {}) {
  const local = owner === 'local-systemd';
  const state = {
    singleton_id: 1,
    owner,
    generation: local ? 2 : 1,
    transition_state: 'stable',
    transition_id: local ? 'none-to-local-2' : 'preview-bootstrap-none-1',
    previous_owner: local ? 'none' : null,
    candidate_sha: candidateSha,
    deployment_id: local ? deploymentId : null,
    transitioned_at: eventAt,
    updated_at: eventAt,
    ...overrides.state,
  };
  const event = {
    generation: state.generation,
    transition_id: state.transition_id,
    previous_owner: state.previous_owner,
    next_owner: state.owner,
    transition_state: state.transition_state,
    candidate_sha: state.candidate_sha,
    deployment_id: state.deployment_id,
    event_at: state.transitioned_at,
    detail: null,
    ...overrides.event,
  };
  return { state, latestEvent: event };
}

function gitRunner({ head = candidateSha, status = '' } = {}) {
  const calls = [];
  const runProcess = async (invocation) => {
    calls.push(invocation);
    assert.equal(invocation.command, 'git');
    const command = invocation.args.join(' ');
    if (command === 'rev-parse HEAD') {
      return { exitCode: 0, stdout: `${head}\n`, stderr: '' };
    }
    if (command === 'status --porcelain --untracked-files=all') {
      return { exitCode: 0, stdout: status, stderr: '' };
    }
    throw new Error(`unexpected git invocation: ${command}`);
  };
  return { runProcess, calls };
}

function transportFor(snapshot, { mirror = canonicalState() } = {}) {
  const calls = [];
  const transport = {
    async readAuthority({ env }) {
      calls.push({ op: 'readAuthority', env });
      return snapshot;
    },
    async readMirror({ env, key }) {
      calls.push({ op: 'readMirror', env, key });
      return mirror;
    },
    async compareAndSetMirror() {
      calls.push({ op: 'compareAndSetMirror' });
      throw new Error('unexpected write');
    },
  };
  return { transport, calls };
}

test('explicit environment is required and extra arguments are refused', async () => {
  let processCalls = 0;
  const runProcess = async () => {
    processCalls += 1;
    throw new Error('should not run');
  };

  await assert.rejects(
    () => runD1MirrorSync({ argv: [], runProcess }),
    /explicit environment required/,
  );
  await assert.rejects(
    () => runD1MirrorSync({ argv: ['--env', 'preview', '--force'], runProcess }),
    /explicit environment required/,
  );
  assert.equal(processCalls, 0);
});

test('production target is recognized but remains activation-gated with zero process calls', async () => {
  let processCalls = 0;
  let stateReads = 0;
  let transportCreates = 0;
  const result = await runD1MirrorSync({
    argv: ['--env', 'production'],
    runProcess: async () => {
      processCalls += 1;
      throw new Error('should not run');
    },
    readLocalState: () => {
      stateReads += 1;
      return localState();
    },
    transportFactory: () => {
      transportCreates += 1;
      throw new Error('should not create transport');
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'production_sync_not_activated');
  assert.equal(result.writeAttempted, false);
  assert.equal(processCalls, 0);
  assert.equal(stateReads, 0);
  assert.equal(transportCreates, 0);
});

test('current preview owner=none refuses before mirror read or write', async () => {
  const git = gitRunner();
  const fake = transportFor(authority('none'));

  const result = await runD1MirrorSync({
    argv: ['--env', 'preview'],
    runProcess: git.runProcess,
    readLocalState: localState,
    transportFactory: () => fake.transport,
    envVars: {},
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'authority_unowned');
  assert.equal(result.writeAttempted, false);
  assert.deepEqual(fake.calls.map((call) => call.op), ['readAuthority']);
});

test('missing or invalid local state refuses before D1 access', async () => {
  const git = gitRunner();
  let transportCreates = 0;
  const result = await runD1MirrorSync({
    argv: ['--env=preview'],
    runProcess: git.runProcess,
    readLocalState: () => {
      throw new Error('state.json is missing');
    },
    transportFactory: () => {
      transportCreates += 1;
      throw new Error('should not create transport');
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'local_state_invalid');
  assert.match(result.detail, /state\.json is missing/);
  assert.equal(transportCreates, 0);
});

test('dirty worktree refuses before local state or D1 access', async () => {
  const git = gitRunner({ status: '?? local-note.txt\n' });
  let stateReads = 0;
  const result = await runD1MirrorSync({
    argv: ['--', '--env', 'preview'],
    runProcess: git.runProcess,
    readLocalState: () => {
      stateReads += 1;
      return localState();
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'worktree_not_clean');
  assert.equal(stateReads, 0);
});

test('local authority must be bound to current exact HEAD before mirror access', async () => {
  const git = gitRunner();
  const fake = transportFor(authority('local-systemd', {
    state: { candidate_sha: otherSha },
    event: { candidate_sha: otherSha },
  }));

  const result = await runD1MirrorSync({
    argv: ['--env', 'preview'],
    runProcess: git.runProcess,
    readLocalState: localState,
    transportFactory: () => fake.transport,
    envVars: { XQUEUE_DEPLOYMENT_ID: deploymentId },
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'authority_candidate_not_current_head');
  assert.deepEqual(fake.calls.map((call) => call.op), ['readAuthority']);
});

test('local authority requires an exact runtime deployment identity match', async () => {
  const git = gitRunner();

  const missing = transportFor(authority('local-systemd'));
  const missingResult = await runD1MirrorSync({
    argv: ['--env', 'preview'],
    runProcess: git.runProcess,
    readLocalState: localState,
    transportFactory: () => missing.transport,
    envVars: {},
  });
  assert.equal(missingResult.reason, 'local_deployment_identity_missing');
  assert.deepEqual(missing.calls.map((call) => call.op), ['readAuthority']);

  const mismatch = transportFor(authority('local-systemd'));
  const mismatchResult = await runD1MirrorSync({
    argv: ['--env', 'preview'],
    runProcess: git.runProcess,
    readLocalState: localState,
    transportFactory: () => mismatch.transport,
    envVars: { XQUEUE_DEPLOYMENT_ID: 'wrong-deployment' },
  });
  assert.equal(mismatchResult.reason, 'local_deployment_identity_mismatch');
  assert.deepEqual(mismatch.calls.map((call) => call.op), ['readAuthority']);
});

test('matching local authority can complete an idempotent no-op with no write', async () => {
  const git = gitRunner();
  const fake = transportFor(authority('local-systemd'));

  const result = await runD1MirrorSync({
    argv: ['--env', 'preview'],
    runProcess: git.runProcess,
    readLocalState: localState,
    transportFactory: () => fake.transport,
    envVars: { XQUEUE_DEPLOYMENT_ID: deploymentId },
  });

  assert.equal(result.ok, true);
  assert.equal(result.status, 'confirmed_noop');
  assert.equal(result.planOperation, 'no_op');
  assert.equal(result.writeAttempted, false);
  assert.equal(result.candidateSha, candidateSha);
  assert.equal(
    fake.calls.some((call) => call.op === 'compareAndSetMirror'),
    false,
  );
});
