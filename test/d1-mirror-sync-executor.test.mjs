import test from 'node:test';
import assert from 'node:assert/strict';

import { compileD1MirrorSyncPlan } from '../src/d1-mirror-sync-plan.mjs';
import { executeD1MirrorSyncPlan } from '../src/d1-mirror-sync-executor.mjs';

const candidateSha = '50c19305fc37ddc933fded9d29bd47f47bffdaf5';
const at = '2026-09-15T06:35:09.000Z';

function authorityState(overrides = {}) {
  return {
    singleton_id: 1,
    owner: 'local-systemd',
    generation: 20,
    transition_state: 'stable',
    transition_id: 'transition-20',
    previous_owner: 'cloudflare',
    candidate_sha: candidateSha,
    deployment_id: 'local-systemd@20',
    transitioned_at: at,
    updated_at: at,
    ...overrides,
  };
}

function authorityEvent(overrides = {}) {
  return {
    generation: 20,
    transition_id: 'transition-20',
    previous_owner: 'cloudflare',
    next_owner: 'local-systemd',
    transition_state: 'stable',
    candidate_sha: candidateSha,
    deployment_id: 'local-systemd@20',
    event_at: at,
    detail: null,
    ...overrides,
  };
}

function localState(overrides = {}) {
  return {
    version: 1,
    posted: {
      A1: { tweetId: '111' },
      A2: { tweetId: '222' },
    },
    skipped: {
      A3: { at, reason: 'owner_skip' },
    },
    spend: 0.12,
    inflight: null,
    ...overrides,
  };
}

function plan({ currentMirrorText = null, ...overrides } = {}) {
  return compileD1MirrorSyncPlan({
    env: 'production',
    localState: localState(),
    authorityState: authorityState(),
    latestAuthorityEvent: authorityEvent(),
    currentMirrorText,
    ...overrides,
  });
}

function makeTransport({
  mirror = null,
  state = authorityState(),
  event = authorityEvent(),
  throwWriteAfterApply = false,
  throwWriteBeforeApply = false,
  throwReadAfterWrite = false,
  changeAuthorityAfterWrite = false,
  mutateBeforeCas = null,
} = {}) {
  let currentMirror = mirror;
  let currentState = state;
  let currentEvent = event;
  let writeAttempts = 0;
  let reads = 0;
  const casCalls = [];

  return {
    get mirror() { return currentMirror; },
    get writeAttempts() { return writeAttempts; },
    get casCalls() { return casCalls; },

    async readAuthority() {
      return { state: currentState, latestEvent: currentEvent };
    },

    async readMirror() {
      reads += 1;
      if (throwReadAfterWrite && writeAttempts > 0 && reads > 1) {
        throw new Error('simulated readback outage');
      }
      return currentMirror;
    },

    async compareAndSetMirror(request) {
      writeAttempts += 1;
      casCalls.push(request);

      if (mutateBeforeCas !== null) {
        currentMirror = mutateBeforeCas;
      }

      if (throwWriteBeforeApply) {
        throw new Error('simulated pre-apply write failure');
      }

      const expectedMatches = request.expected.exists
        ? currentMirror === request.expected.value
        : currentMirror === null || currentMirror === undefined;

      const authorityMatches =
        currentState.owner === request.authority.owner &&
        currentState.generation === request.authority.generation &&
        currentState.transition_id === request.authority.transitionId &&
        currentState.candidate_sha.toLowerCase() === request.authority.candidateSha &&
        currentState.deployment_id === request.authority.deploymentId;

      if (!expectedMatches || !authorityMatches) {
        return { applied: false };
      }

      currentMirror = request.nextValue;

      if (changeAuthorityAfterWrite) {
        currentState = authorityState({
          owner: 'cloudflare',
          generation: 21,
          transition_id: 'transition-21',
          previous_owner: 'local-systemd',
          deployment_id: 'cloudflare@21',
        });
        currentEvent = authorityEvent({
          generation: 21,
          transition_id: 'transition-21',
          previous_owner: 'local-systemd',
          next_owner: 'cloudflare',
          deployment_id: 'cloudflare@21',
        });
      }

      if (throwWriteAfterApply) {
        throw new Error('simulated ambiguous write response');
      }

      return { applied: true };
    },
  };
}

test('confirmed sync uses exact CAS precondition and verifies readback', async () => {
  const compiled = plan();
  const transport = makeTransport({ mirror: null });

  const result = await executeD1MirrorSyncPlan({
    plan: compiled,
    transport,
  });

  assert.equal(result.ok, true);
  assert.equal(result.status, 'confirmed_synced');
  assert.equal(result.writeAttempted, true);
  assert.equal(result.compareAndSetApplied, true);
  assert.equal(transport.writeAttempts, 1);
  assert.equal(transport.casCalls.length, 1);

  const call = transport.casCalls[0];
  assert.equal(call.env, 'production');
  assert.equal(call.key, 'state.snapshot_json');
  assert.deepEqual(call.expected, {
    exists: false,
    value: null,
    rawHash: null,
  });
  assert.equal(call.authority.owner, 'local-systemd');
  assert.equal(call.authority.generation, 20);
  assert.equal(call.authority.transitionId, 'transition-20');
  assert.equal(call.authority.candidateSha, candidateSha);
  assert.equal(call.authority.deploymentId, 'local-systemd@20');
  assert.equal(transport.mirror, compiled.write.value);
  assert.equal(result.hash, compiled.expectedReadback.hash);
  assert.deepEqual(result.counts, compiled.expectedReadback.counts);
  assert.equal(result.authorityDeploymentId, 'local-systemd@20');
});

test('confirmed no-op revalidates authority and mirror without writing', async () => {
  const seedPlan = plan();
  const current = seedPlan.write.value;
  const compiled = plan({ currentMirrorText: current });
  assert.equal(compiled.operation, 'no_op');

  const transport = makeTransport({ mirror: current });
  const result = await executeD1MirrorSyncPlan({ plan: compiled, transport });

  assert.equal(result.ok, true);
  assert.equal(result.status, 'confirmed_noop');
  assert.equal(result.writeAttempted, false);
  assert.equal(result.authorityDeploymentId, 'local-systemd@20');
  assert.equal(transport.writeAttempts, 0);
});

test('invalid transport is refused before any operation', async () => {
  const result = await executeD1MirrorSyncPlan({ plan: plan(), transport: {} });
  assert.deepEqual(result, {
    ok: false,
    status: 'refused',
    reason: 'invalid_injected_transport',
  });
});

test('authority change after planning refuses before mirror write', async () => {
  const transport = makeTransport({
    state: authorityState({ owner: 'cloudflare' }),
    event: authorityEvent({ next_owner: 'cloudflare' }),
  });

  const result = await executeD1MirrorSyncPlan({ plan: plan(), transport });

  assert.equal(result.ok, false);
  assert.equal(result.status, 'refused');
  assert.equal(result.reason, 'authority_owned_by_cloudflare');
  assert.equal(transport.writeAttempts, 0);
});

test('same-owner authority generation change refuses as stale plan', async () => {
  const transport = makeTransport({
    state: authorityState({
      generation: 21,
      transition_id: 'transition-21',
      previous_owner: 'local-systemd',
      deployment_id: 'local-systemd@21',
    }),
    event: authorityEvent({
      generation: 21,
      transition_id: 'transition-21',
      previous_owner: 'local-systemd',
      deployment_id: 'local-systemd@21',
    }),
  });

  const result = await executeD1MirrorSyncPlan({ plan: plan(), transport });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'authority_changed_since_plan');
  assert.equal(transport.writeAttempts, 0);
});

test('same-generation deployment identity change refuses as stale plan', async () => {
  const transport = makeTransport({
    state: authorityState({ deployment_id: 'local-systemd@replacement' }),
    event: authorityEvent({ deployment_id: 'local-systemd@replacement' }),
  });

  const result = await executeD1MirrorSyncPlan({ plan: plan(), transport });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'authority_changed_since_plan');
  assert.equal(transport.writeAttempts, 0);
});

test('mirror change after planning refuses before CAS write', async () => {
  const old = JSON.stringify(localState({ posted: {} }));
  const compiled = plan({ currentMirrorText: old });
  const changed = JSON.stringify(localState({ posted: { X: { tweetId: '999' } } }));
  const transport = makeTransport({ mirror: changed });

  const result = await executeD1MirrorSyncPlan({ plan: compiled, transport });

  assert.equal(result.ok, false);
  assert.equal(result.status, 'refused');
  assert.equal(result.reason, 'mirror_changed_since_plan');
  assert.equal(transport.writeAttempts, 0);
});

test('race between pre-read and CAS becomes indeterminate when readback mismatches', async () => {
  const old = JSON.stringify(localState({ posted: {} }));
  const compiled = plan({ currentMirrorText: old });
  const raced = JSON.stringify(localState({ posted: { Z: { tweetId: '777' } } }));
  const transport = makeTransport({ mirror: old, mutateBeforeCas: raced });

  const result = await executeD1MirrorSyncPlan({ plan: compiled, transport });

  assert.equal(result.ok, false);
  assert.equal(result.status, 'indeterminate');
  assert.equal(result.reason, 'readback_mismatch_after_write');
  assert.equal(result.writeResult.applied, false);
  assert.equal(transport.mirror, raced);
});

test('write error after apply is reconciled to confirmed success by exact readback', async () => {
  const compiled = plan();
  const transport = makeTransport({ mirror: null, throwWriteAfterApply: true });

  const result = await executeD1MirrorSyncPlan({ plan: compiled, transport });

  assert.equal(result.ok, true);
  assert.equal(result.status, 'confirmed_synced_after_ambiguous_write');
  assert.equal(result.writeReportedError, true);
  assert.equal(result.hash, compiled.expectedReadback.hash);
  assert.equal(transport.mirror, compiled.write.value);
});

test('write error before apply remains indeterminate after mismatching readback', async () => {
  const compiled = plan();
  const transport = makeTransport({ mirror: null, throwWriteBeforeApply: true });

  const result = await executeD1MirrorSyncPlan({ plan: compiled, transport });

  assert.equal(result.ok, false);
  assert.equal(result.status, 'indeterminate');
  assert.equal(result.reason, 'readback_mismatch_after_write');
  assert.equal(result.writeReportedError, true);
  assert.equal(transport.mirror, null);
});

test('readback outage after a write is never reported as success', async () => {
  const compiled = plan();
  const transport = makeTransport({ mirror: null, throwReadAfterWrite: true });

  const result = await executeD1MirrorSyncPlan({ plan: compiled, transport });

  assert.equal(result.ok, false);
  assert.equal(result.status, 'indeterminate');
  assert.equal(result.reason, 'readback_unavailable_after_write');
});

test('authority transition after matching write/readback makes outcome indeterminate', async () => {
  const compiled = plan();
  const transport = makeTransport({ mirror: null, changeAuthorityAfterWrite: true });

  const result = await executeD1MirrorSyncPlan({ plan: compiled, transport });

  assert.equal(result.ok, false);
  assert.equal(result.status, 'indeterminate');
  assert.equal(result.reason, 'authority_changed_during_sync');
  assert.equal(result.readbackHash, compiled.expectedReadback.hash);
});

test('tampered target key is refused', async () => {
  const compiled = { ...plan(), targetKey: 'publication_state' };
  const transport = makeTransport();

  const result = await executeD1MirrorSyncPlan({ plan: compiled, transport });

  assert.deepEqual(result, {
    ok: false,
    status: 'refused',
    reason: 'invalid_plan_target',
  });
  assert.equal(transport.writeAttempts, 0);
});

test('tampered deployment identity is refused before transport use', async () => {
  const base = plan();
  const compiled = {
    ...base,
    authority: { ...base.authority, deploymentId: '' },
  };
  const transport = makeTransport();

  const result = await executeD1MirrorSyncPlan({ plan: compiled, transport });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'invalid_plan_authority');
  assert.equal(transport.writeAttempts, 0);
});

test('tampered write value is refused before injected transport is used', async () => {
  const base = plan();
  const compiled = {
    ...base,
    write: {
      ...base.write,
      value: JSON.stringify(localState({ posted: {} })),
    },
  };
  const transport = makeTransport();

  const result = await executeD1MirrorSyncPlan({ plan: compiled, transport });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'invalid_plan_write_evidence');
  assert.equal(transport.writeAttempts, 0);
});
