import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { compileD1MirrorSyncPlan } from '../src/d1-mirror-sync-plan.mjs';

const candidateSha = '50c19305fc37ddc933fded9d29bd47f47bffdaf5';
const at = '2026-09-15T06:35:09.000Z';

function authorityState(overrides = {}) {
  return {
    singleton_id: 1,
    owner: 'local-systemd',
    generation: 12,
    transition_state: 'stable',
    transition_id: 'transition-12',
    previous_owner: 'cloudflare',
    candidate_sha: candidateSha,
    deployment_id: 'local-systemd@12',
    transitioned_at: at,
    updated_at: at,
    ...overrides,
  };
}

function authorityEvent(overrides = {}) {
  return {
    generation: 12,
    transition_id: 'transition-12',
    previous_owner: 'cloudflare',
    next_owner: 'local-systemd',
    transition_state: 'stable',
    candidate_sha: candidateSha,
    deployment_id: 'local-systemd@12',
    event_at: at,
    detail: null,
    ...overrides,
  };
}

function localState(overrides = {}) {
  return {
    version: 1,
    posted: {
      A1: { tweetId: '111', postedAt: '2026-09-14T12:00:00.000Z' },
      A2: { tweetId: '222', postedAt: '2026-09-14T13:00:00.000Z' },
    },
    skipped: {
      A3: {
        at: '2026-09-14T14:00:00.000Z',
        reason: 'owner_skip',
      },
    },
    spend: 0.12,
    inflight: null,
    ...overrides,
  };
}

function compile(overrides = {}) {
  return compileD1MirrorSyncPlan({
    env: 'production',
    localState: localState(),
    authorityState: authorityState(),
    latestAuthorityEvent: authorityEvent(),
    currentMirrorText: null,
    ...overrides,
  });
}

function normalizedCanonical(state) {
  const normalized = {
    ...state,
    version: 1,
    posted: state.posted ?? {},
    skipped: state.skipped ?? {},
    spend: state.spend ?? 0,
    inflight: state.inflight ?? null,
  };
  return `${JSON.stringify(normalized, null, 2)}\n`;
}

function sha256(text) {
  return createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');
}

test('environment target is explicit and bounded', () => {
  assert.equal(compile({ env: undefined }).reason, 'explicit_environment_required');
  assert.equal(compile({ env: 'staging' }).reason, 'explicit_environment_required');
  assert.equal(compile({ env: 'preview' }).ok, true);
});

test('malformed local state refuses before any plan exists', () => {
  const result = compile({ localState: { posted: [] } });
  assert.deepEqual(result, { ok: false, reason: 'local_state_invalid' });
});

test('prepared inflight publication refuses mirror sync', () => {
  const result = compile({
    localState: localState({ inflight: { postId: 'A4', status: 'prepared' } }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'local_state_inflight');
  assert.equal(result.postId, 'A4');
  assert.equal(result.status, 'prepared');
});

test('publishing inflight publication refuses mirror sync', () => {
  const result = compile({
    localState: localState({ inflight: { postId: 'A4', status: 'publishing' } }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'local_state_inflight');
});

test('needs_reconciliation gets a distinct refusal', () => {
  const result = compile({
    localState: localState({ inflight: { postId: 'A4', status: 'needs_reconciliation' } }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'local_state_needs_reconciliation');
});

test('Cloudflare authority refuses even with a valid local ledger', () => {
  const result = compile({
    authorityState: authorityState({ owner: 'cloudflare' }),
    latestAuthorityEvent: authorityEvent({ next_owner: 'cloudflare' }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'authority_owned_by_cloudflare');
});

test('none authority refuses mirror sync', () => {
  const result = compile({
    authorityState: authorityState({ owner: 'none' }),
    latestAuthorityEvent: authorityEvent({ next_owner: 'none' }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'authority_unowned');
});

test('transitioning authority refuses mirror sync', () => {
  const result = compile({
    authorityState: authorityState({ transition_state: 'transitioning' }),
    latestAuthorityEvent: authorityEvent({ transition_state: 'transitioning' }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'authority_transition_unresolved');
});

test('local authority without deployment identity cannot produce a plan', () => {
  const result = compile({
    authorityState: authorityState({ deployment_id: null }),
    latestAuthorityEvent: authorityEvent({ deployment_id: null }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'authority_local_deployment_missing');
});

test('missing mirror compiles a bounded replacement plan', () => {
  const state = localState();
  const expectedText = normalizedCanonical(state);
  const expectedHash = sha256(expectedText);
  const result = compile({ currentMirrorText: null });

  assert.equal(result.ok, true);
  assert.equal(result.operation, 'replace_mirror');
  assert.equal(result.env, 'production');
  assert.equal(result.targetKey, 'state.snapshot_json');
  assert.deepEqual(result.local.counts, { posted: 2, skipped: 1, inflight: 0 });
  assert.equal(result.local.hash, expectedHash);
  assert.equal(result.before.exists, false);
  assert.equal(result.before.valid, false);
  assert.equal(result.before.reason, 'mirror_missing');
  assert.equal(result.write.key, 'state.snapshot_json');
  assert.equal(result.write.value, expectedText);
  assert.deepEqual(result.expectedReadback, {
    hash: expectedHash,
    counts: { posted: 2, skipped: 1, inflight: 0 },
  });
  assert.equal(result.authority.owner, 'local-systemd');
  assert.equal(result.authority.generation, 12);
  assert.equal(result.authority.deploymentId, 'local-systemd@12');
});

test('semantically equal but non-canonical mirror compiles a canonical replacement', () => {
  const state = localState();
  const compactMirror = JSON.stringify(state);
  const canonicalMirror = normalizedCanonical(state);
  const result = compile({ currentMirrorText: compactMirror });

  assert.equal(result.ok, true);
  assert.equal(result.operation, 'replace_mirror');
  assert.equal(result.before.valid, true);
  assert.equal(result.before.hash, result.local.hash);
  assert.notEqual(result.before.rawHash, result.local.hash);
  assert.equal(result.write.value, canonicalMirror);
  assert.deepEqual(result.before.counts, result.local.counts);
});

test('exact canonical mirror is an idempotent no-op', () => {
  const state = localState();
  const canonicalMirror = normalizedCanonical(state);
  const result = compile({ currentMirrorText: canonicalMirror });

  assert.equal(result.ok, true);
  assert.equal(result.operation, 'no_op');
  assert.equal(result.write, null);
  assert.equal(result.before.valid, true);
  assert.equal(result.before.rawHash, result.local.hash);
  assert.equal(result.before.hash, result.local.hash);
});

test('malformed current mirror is replaced rather than treated as authoritative', () => {
  const result = compile({ currentMirrorText: '{broken-json' });
  assert.equal(result.ok, true);
  assert.equal(result.operation, 'replace_mirror');
  assert.equal(result.before.exists, true);
  assert.equal(result.before.valid, false);
  assert.equal(result.before.reason, 'mirror_invalid_state');
  assert.equal(typeof result.write?.value, 'string');
});

test('different valid mirror compiles replacement with before/after evidence', () => {
  const oldMirror = localState({
    posted: { A1: { tweetId: '111' } },
    skipped: {},
    spend: 0.03,
  });
  const result = compile({ currentMirrorText: JSON.stringify(oldMirror) });

  assert.equal(result.ok, true);
  assert.equal(result.operation, 'replace_mirror');
  assert.deepEqual(result.before.counts, { posted: 1, skipped: 0, inflight: 0 });
  assert.deepEqual(result.expectedReadback.counts, { posted: 2, skipped: 1, inflight: 0 });
  assert.notEqual(result.before.hash, result.local.hash);
});

test('stale authority generation prevents a plan even when mirror is identical', () => {
  const state = localState();
  const result = compile({
    currentMirrorText: JSON.stringify(state),
    authorityState: authorityState({ generation: 11 }),
    latestAuthorityEvent: authorityEvent({ generation: 12 }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'authority_generation_mismatch');
});

test('plan output contains data only and has no database transport dependency', () => {
  const result = compile();
  assert.equal(result.ok, true);
  assert.equal('db' in result, false);
  assert.equal('execute' in result, false);
  assert.equal('command' in result, false);
  assert.equal(typeof result.write.value, 'string');
});
