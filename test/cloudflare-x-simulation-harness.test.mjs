import test from 'node:test';
import assert from 'node:assert/strict';

import { simulatePublicationTransaction } from '../probes/cloudflare-x/simulation-harness.mjs';

function baseDeps(overrides = {}) {
  const calls = [];
  const deps = {
    async selectEligibility() {
      calls.push('eligibility');
      return { safeToPublish: true, post: { id: 'A2', body: 'hello' } };
    },
    async acquireLease() {
      calls.push('acquire');
      return { acquired: true, handle: { generation: 1, ownerToken: 'owner' } };
    },
    async verifyLease() {
      calls.push('verifyLease');
      return true;
    },
    async releaseLease() {
      calls.push('release');
      return true;
    },
    async verifyMedia() {
      calls.push('media');
      return { ok: true, mediaIds: [] };
    },
    async dispatchPost() {
      calls.push('dispatch');
      return { status: 201, data: { id: 'tweet-1' } };
    },
    classifyOutcome({ response, error }) {
      calls.push('classify');
      if (error) return { classification: 'needs_reconciliation', reason: 'timeout', automaticRetryAllowed: false };
      return { classification: 'confirmed_posted', postId: response.data.id, automaticRetryAllowed: false };
    },
    async recordEvidence() {
      calls.push('evidence');
    },
    ...overrides,
  };
  return { deps, calls };
}

test('eligibility refusal prevents lease and dispatch', async () => {
  const { deps, calls } = baseDeps({
    async selectEligibility() {
      calls.push('eligibility');
      return { safeToPublish: false, reason: 'not_due' };
    },
  });
  const result = await simulatePublicationTransaction(deps);
  assert.equal(result.stage, 'eligibility');
  assert.equal(result.dispatched, false);
  assert.deepEqual(calls, ['eligibility']);
});

test('lease loser cannot verify media or dispatch', async () => {
  const { deps, calls } = baseDeps({
    async acquireLease() {
      calls.push('acquire');
      return { acquired: false, reason: 'held' };
    },
  });
  const result = await simulatePublicationTransaction(deps);
  assert.equal(result.stage, 'lease');
  assert.equal(result.dispatched, false);
  assert.deepEqual(calls, ['eligibility', 'acquire']);
});

test('media mismatch releases owned lease and prevents dispatch', async () => {
  const { deps, calls } = baseDeps({
    async verifyMedia() {
      calls.push('media');
      return { ok: false, reason: 'hash_mismatch' };
    },
  });
  const result = await simulatePublicationTransaction(deps);
  assert.equal(result.stage, 'media');
  assert.equal(result.dispatched, false);
  assert.deepEqual(calls, ['eligibility', 'acquire', 'media', 'release']);
});

test('stale/fenced lease cannot dispatch and cannot release the new owner', async () => {
  const { deps, calls } = baseDeps({
    async verifyLease() {
      calls.push('verifyLease');
      return false;
    },
  });
  const result = await simulatePublicationTransaction(deps);
  assert.equal(result.stage, 'fencing');
  assert.equal(result.dispatched, false);
  assert.equal(calls.includes('dispatch'), false);
  assert.equal(calls.includes('release'), false);
});

test('confirmed success records evidence then releases lease', async () => {
  const { deps, calls } = baseDeps();
  const result = await simulatePublicationTransaction(deps);
  assert.equal(result.status, 'confirmed_posted');
  assert.equal(result.dispatched, true);
  assert.equal(result.leaseRetained, false);
  assert.equal(result.evidence.outcome.postId, 'tweet-1');
  assert.deepEqual(calls, ['eligibility', 'acquire', 'media', 'verifyLease', 'dispatch', 'classify', 'evidence', 'release']);
});

test('ambiguous dispatch records reconciliation evidence and retains lease', async () => {
  const { deps, calls } = baseDeps({
    async dispatchPost() {
      calls.push('dispatch');
      const error = new Error('timeout');
      error.code = 'ETIMEDOUT';
      throw error;
    },
  });
  const result = await simulatePublicationTransaction(deps);
  assert.equal(result.status, 'needs_reconciliation');
  assert.equal(result.dispatched, true);
  assert.equal(result.leaseRetained, true);
  assert.equal(calls.includes('release'), false);
  assert.equal(result.evidence.outcome.automaticRetryAllowed, false);
});

test('two concurrent simulations with one lease winner dispatch exactly once', async () => {
  let held = false;
  let dispatches = 0;
  const common = baseDeps().deps;
  common.acquireLease = async () => {
    if (held) return { acquired: false, reason: 'held' };
    held = true;
    return { acquired: true, handle: { generation: 1, ownerToken: 'winner' } };
  };
  common.dispatchPost = async () => {
    dispatches += 1;
    return { status: 201, data: { id: 'tweet-1' } };
  };

  const [a, b] = await Promise.all([
    simulatePublicationTransaction(common),
    simulatePublicationTransaction(common),
  ]);

  assert.equal(dispatches, 1);
  assert.equal([a.status, b.status].includes('confirmed_posted'), true);
  assert.equal([a.stage, b.stage].includes('lease'), true);
});
