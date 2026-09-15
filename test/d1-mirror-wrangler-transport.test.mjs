import test from 'node:test';
import assert from 'node:assert/strict';

import {
  compileWranglerD1Invocation,
  createWranglerD1MirrorTransport,
} from '../src/d1-mirror-wrangler-transport.mjs';
import { compileD1MirrorSyncPlan } from '../src/d1-mirror-sync-plan.mjs';

const candidateSha = 'e3aaedb8222158c499bd1c58466b2a5003f5e328';
const at = '2026-09-15T07:00:00.000Z';

function authorityState(overrides = {}) {
  return {
    singleton_id: 1,
    owner: 'local-systemd',
    generation: 41,
    transition_state: 'stable',
    transition_id: 'transition-41',
    previous_owner: 'cloudflare',
    candidate_sha: candidateSha,
    deployment_id: 'local-systemd@41',
    transitioned_at: at,
    updated_at: at,
    ...overrides,
  };
}

function authorityEvent(overrides = {}) {
  return {
    generation: 41,
    transition_id: 'transition-41',
    previous_owner: 'cloudflare',
    next_owner: 'local-systemd',
    transition_state: 'stable',
    candidate_sha: candidateSha,
    deployment_id: 'local-systemd@41',
    event_at: at,
    detail: null,
    ...overrides,
  };
}

function localState() {
  return {
    version: 1,
    posted: { A1: { tweetId: 'tweet-1' } },
    skipped: {},
    spend: 0,
    inflight: null,
  };
}

function plan(currentMirrorText = null) {
  const compiled = compileD1MirrorSyncPlan({
    env: 'preview',
    localState: localState(),
    authorityState: authorityState(),
    latestAuthorityEvent: authorityEvent(),
    currentMirrorText,
  });
  assert.equal(compiled.ok, true);
  return compiled;
}

function wranglerJson(rows, { success = true } = {}) {
  return JSON.stringify([{ success, results: rows, meta: {} }]);
}

function queuedRunner(responses) {
  const calls = [];
  const queue = [...responses];
  const runProcess = async (invocation) => {
    calls.push(invocation);
    if (queue.length === 0) {
      throw new Error('unexpected fake process call');
    }
    return queue.shift();
  };
  return { calls, runProcess };
}

test('Wrangler invocation is argv-only and pins preview target', () => {
  const invocation = compileWranglerD1Invocation({
    env: 'preview',
    sql: 'SELECT 1;',
  });

  assert.equal(invocation.command, 'pnpm');
  assert.deepEqual(invocation.args, [
    'wrangler',
    'd1',
    'execute',
    'xqueue-preview',
    '--config',
    'wrangler.preview.jsonc',
    '--remote',
    '--yes',
    '--json',
    '--command',
    'SELECT 1;',
  ]);
  assert.equal('shell' in invocation, false);
});

test('production invocation is explicit and pinned to production config/database', () => {
  const invocation = compileWranglerD1Invocation({
    env: 'production',
    sql: 'SELECT 1;',
  });

  assert.equal(invocation.args[3], 'xqueue-production');
  assert.equal(invocation.args[5], 'wrangler.jsonc');
  assert.equal(invocation.args.includes('--remote'), true);
  assert.equal(invocation.args.includes('--json'), true);
});

test('missing or arbitrary environment is refused before process execution', async () => {
  let calls = 0;
  const transport = createWranglerD1MirrorTransport({
    runProcess: async () => {
      calls += 1;
      return { exitCode: 0, stdout: wranglerJson([]), stderr: '' };
    },
  });

  await assert.rejects(() => transport.readMirror({ key: 'state.snapshot_json' }), /explicit Wrangler environment/);
  await assert.rejects(() => transport.readMirror({ env: 'staging', key: 'state.snapshot_json' }), /explicit Wrangler environment/);
  assert.equal(calls, 0);
});

test('transport cannot exist without an injected process runner', () => {
  assert.throws(
    () => createWranglerD1MirrorTransport(),
    /runProcess injection is required/,
  );
});

test('readAuthority performs two read-only pinned Wrangler calls and returns exact rows', async () => {
  const state = authorityState();
  const event = authorityEvent();
  const fake = queuedRunner([
    { exitCode: 0, stdout: wranglerJson([state]), stderr: '' },
    { exitCode: 0, stdout: wranglerJson([event]), stderr: '' },
  ]);
  const transport = createWranglerD1MirrorTransport({ runProcess: fake.runProcess });

  const result = await transport.readAuthority({ env: 'preview' });

  assert.deepEqual(result, { state, latestEvent: event });
  assert.equal(fake.calls.length, 2);
  for (const call of fake.calls) {
    assert.equal(call.command, 'pnpm');
    assert.equal(call.args[3], 'xqueue-preview');
    assert.equal(call.args[5], 'wrangler.preview.jsonc');
    assert.equal(call.args.includes('--remote'), true);
    assert.equal(call.args.includes('--json'), true);
  }
  assert.match(fake.calls[0].args.at(-1), /^SELECT\b/);
  assert.match(fake.calls[1].args.at(-1), /^SELECT\b/);
});

test('readMirror returns exact stored value and null for missing row', async () => {
  const fake = queuedRunner([
    { exitCode: 0, stdout: wranglerJson([{ value: '{"x":1}', updated_at: at }]), stderr: '' },
    { exitCode: 0, stdout: wranglerJson([]), stderr: '' },
  ]);
  const transport = createWranglerD1MirrorTransport({ runProcess: fake.runProcess });

  assert.equal(
    await transport.readMirror({ env: 'preview', key: 'state.snapshot_json' }),
    '{"x":1}',
  );
  assert.equal(
    await transport.readMirror({ env: 'preview', key: 'state.snapshot_json' }),
    null,
  );
});

test('compareAndSetMirror compiles atomic SQL and reports applied only from RETURNING row', async () => {
  const compiled = plan(null);
  const returned = {
    key: compiled.targetKey,
    value: compiled.write.value,
    updated_at: at,
  };
  const fake = queuedRunner([
    { exitCode: 0, stdout: wranglerJson([returned]), stderr: '' },
    { exitCode: 0, stdout: wranglerJson([]), stderr: '' },
  ]);
  const transport = createWranglerD1MirrorTransport({ runProcess: fake.runProcess });

  const request = {
    env: compiled.env,
    key: compiled.targetKey,
    expected: { exists: false, value: null, rawHash: null },
    nextValue: compiled.write.value,
    authority: compiled.authority,
  };

  const applied = await transport.compareAndSetMirror(request);
  const lostRace = await transport.compareAndSetMirror(request);

  assert.equal(applied.applied, true);
  assert.equal(applied.mode, 'insert_missing');
  assert.deepEqual(applied.row, returned);
  assert.equal(lostRace.applied, false);
  assert.equal(lostRace.row, null);
  assert.match(fake.calls[0].args.at(-1), /^INSERT INTO runtime_metadata/);
  assert.match(fake.calls[0].args.at(-1), /RETURNING key, value, updated_at/);
});

test('nonzero Wrangler exit is surfaced and never interpreted as a D1 result', async () => {
  const fake = queuedRunner([
    { exitCode: 1, stdout: '', stderr: 'authentication failed' },
  ]);
  const transport = createWranglerD1MirrorTransport({ runProcess: fake.runProcess });

  await assert.rejects(
    () => transport.readMirror({ env: 'preview', key: 'state.snapshot_json' }),
    /Wrangler D1 command failed: authentication failed/,
  );
});

test('malformed, failed, or ambiguous Wrangler JSON fails closed', async () => {
  const malformed = queuedRunner([
    { exitCode: 0, stdout: 'not-json', stderr: '' },
  ]);
  await assert.rejects(
    () => createWranglerD1MirrorTransport({ runProcess: malformed.runProcess })
      .readMirror({ env: 'preview', key: 'state.snapshot_json' }),
    /not valid JSON/,
  );

  const failed = queuedRunner([
    { exitCode: 0, stdout: wranglerJson([], { success: false }), stderr: '' },
  ]);
  await assert.rejects(
    () => createWranglerD1MirrorTransport({ runProcess: failed.runProcess })
      .readMirror({ env: 'preview', key: 'state.snapshot_json' }),
    /did not report success/,
  );

  const multipleStatements = queuedRunner([
    {
      exitCode: 0,
      stdout: JSON.stringify([
        { success: true, results: [] },
        { success: true, results: [] },
      ]),
      stderr: '',
    },
  ]);
  await assert.rejects(
    () => createWranglerD1MirrorTransport({ runProcess: multipleStatements.runProcess })
      .readMirror({ env: 'preview', key: 'state.snapshot_json' }),
    /unexpected statement count/,
  );
});

test('row multiplicity fails closed for singleton reads and compare-and-set', async () => {
  const duplicateRows = [{ value: 'a' }, { value: 'b' }];
  const readFake = queuedRunner([
    { exitCode: 0, stdout: wranglerJson(duplicateRows), stderr: '' },
  ]);
  await assert.rejects(
    () => createWranglerD1MirrorTransport({ runProcess: readFake.runProcess })
      .readMirror({ env: 'preview', key: 'state.snapshot_json' }),
    /unexpected row count/,
  );

  const compiled = plan(null);
  const casFake = queuedRunner([
    {
      exitCode: 0,
      stdout: wranglerJson([
        { key: compiled.targetKey, value: compiled.write.value, updated_at: at },
        { key: compiled.targetKey, value: compiled.write.value, updated_at: at },
      ]),
      stderr: '',
    },
  ]);
  const transport = createWranglerD1MirrorTransport({ runProcess: casFake.runProcess });
  await assert.rejects(
    () => transport.compareAndSetMirror({
      env: compiled.env,
      key: compiled.targetKey,
      expected: { exists: false, value: null, rawHash: null },
      nextValue: compiled.write.value,
      authority: compiled.authority,
    }),
    /compare-and-set returned an unexpected row count/,
  );
});
