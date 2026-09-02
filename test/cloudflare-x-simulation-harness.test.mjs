import test from 'node:test';
import assert from 'node:assert/strict';

import { evaluateEligibility } from '../cloudflare/src/eligibility.mjs';
import { probeReadOnlyIdentity } from '../probes/cloudflare-x/identity-contract.mjs';
import { classifyPublicationOutcome } from '../probes/cloudflare-x/outcome-classifier.mjs';
import { createPostViaClient } from '../probes/cloudflare-x/transport.mjs';
import { simulatePublicationTransaction } from '../probes/cloudflare-x/simulation-harness.mjs';

const NOW = new Date('2026-09-02T19:31:00.000Z');

function queue() {
  return [{
    id: 'D1',
    body: 'simulated publication',
    scheduledDate: '2026-09-02',
    scheduledTime: '14:30',
    timezone: 'America/Chicago',
    figure: 1,
  }];
}

function ledger() {
  return {
    posted: {},
    skipped: {},
    spend: 0,
    inflight: null,
  };
}

function input(overrides = {}) {
  return {
    queue: queue(),
    ledger: ledger(),
    eligibilityOptions: {
      now: NOW,
      graceMinutes: 20,
      maxPublications: 1,
    },
    ...overrides,
  };
}

function baseDeps(overrides = {}) {
  const calls = [];
  let held = false;

  const fakeClient = {
    posts: {
      async create(body) {
        calls.push(['x.create', body]);
        return { status: 201, data: { id: 'tweet-1' } };
      },
    },
  };

  const deps = {
    async verifyIdentity() {
      calls.push('identity');
      return probeReadOnlyIdentity({
        getMe: async () => ({
          data: { id: 'account-1', username: 'PatrickCra94338' },
        }),
        expected: { username: 'PatrickCra94338' },
      });
    },

    evaluateEligibility(queueValue, ledgerValue, options) {
      calls.push('eligibility');
      return evaluateEligibility(queueValue, ledgerValue, options);
    },

    async acquireLease() {
      calls.push('acquire');
      if (held) return { acquired: false, reason: 'held' };
      held = true;
      return {
        acquired: true,
        lease: {
          leaseName: 'publisher',
          ownerToken: 'winner-owner-token',
          acquisitionId: 'winner-acquisition-id',
          generation: 1,
          acquiredAtMs: NOW.getTime(),
          expiresAtMs: NOW.getTime() + 60_000,
          updatedAtMs: NOW.getTime(),
        },
      };
    },

    async verifyLease(_lease, context) {
      calls.push(`verifyLease:${context.stage}`);
      return true;
    },

    async releaseLease() {
      calls.push('release');
      held = false;
      return { released: true };
    },

    async verifyMedia() {
      calls.push('media');
      return { ok: true, mediaIds: ['sim-media-1'] };
    },

    async dispatchPost({ post, media }) {
      calls.push('dispatch');
      return createPostViaClient(fakeClient, {
        text: post.body,
        mediaIds: media.mediaIds,
      });
    },

    classifyOutcome(value) {
      calls.push('classify');
      return classifyPublicationOutcome(value);
    },

    async recordEvidence() {
      calls.push('evidence');
    },

    ...overrides,
  };

  return { deps, calls, fakeClient };
}

test('identity mismatch blocks before eligibility, lease, media, or X', async () => {
  const { deps, calls } = baseDeps({
    async verifyIdentity() {
      calls.push('identity');
      return probeReadOnlyIdentity({
        getMe: async () => ({ data: { id: 'wrong', username: 'wrong' } }),
        expected: { username: 'PatrickCra94338' },
      });
    },
  });

  const result = await simulatePublicationTransaction(deps, input());
  assert.equal(result.stage, 'identity');
  assert.equal(result.dispatched, false);
  assert.deepEqual(calls, ['identity']);
});

test('real eligibility refusal prevents lease and dispatch', async () => {
  const { deps, calls } = baseDeps();
  const result = await simulatePublicationTransaction(
    deps,
    input({
      eligibilityOptions: {
        now: new Date('2026-09-02T19:00:00.000Z'),
        graceMinutes: 20,
        maxPublications: 1,
      },
    }),
  );

  assert.equal(result.stage, 'eligibility');
  assert.equal(result.dispatched, false);
  assert.deepEqual(calls, ['identity', 'eligibility']);
});

test('selection must resolve to exactly one queue post', async () => {
  const { deps, calls } = baseDeps({
    evaluateEligibility() {
      calls.push('eligibility');
      return {
        safeToPublish: true,
        selection: { blocked: false, selected: ['missing'] },
        failures: [],
      };
    },
  });

  const result = await simulatePublicationTransaction(deps, input());
  assert.equal(result.stage, 'eligibility');
  assert.equal(result.reason, 'selected_post_not_unique');
  assert.equal(calls.includes('acquire'), false);
});

test('lease loser cannot verify media or dispatch', async () => {
  const { deps, calls } = baseDeps({
    async acquireLease() {
      calls.push('acquire');
      return { acquired: false, reason: 'held' };
    },
  });

  const result = await simulatePublicationTransaction(deps, input());
  assert.equal(result.stage, 'lease');
  assert.equal(result.dispatched, false);
  assert.equal(calls.includes('media'), false);
  assert.equal(calls.includes('dispatch'), false);
});

test('media mismatch releases owned lease and prevents dispatch', async () => {
  const { deps, calls } = baseDeps({
    async verifyMedia() {
      calls.push('media');
      return { ok: false, reason: 'hash_mismatch' };
    },
  });

  const result = await simulatePublicationTransaction(deps, input());
  assert.equal(result.stage, 'media');
  assert.equal(result.dispatched, false);
  assert.equal(result.reason, 'hash_mismatch');
  assert.equal(calls.includes('release'), true);
  assert.equal(calls.includes('dispatch'), false);
});

test('media verifier exception fails closed and still attempts owned cleanup', async () => {
  const { deps, calls } = baseDeps({
    async verifyMedia() {
      calls.push('media');
      throw new Error('R2 exploded');
    },
  });

  const result = await simulatePublicationTransaction(deps, input());
  assert.equal(result.stage, 'media');
  assert.equal(result.reason, 'media_verification_error');
  assert.equal(calls.includes('release'), true);
  assert.equal(calls.includes('dispatch'), false);
});

test('media failure plus failed lease cleanup is surfaced explicitly', async () => {
  const { deps } = baseDeps({
    async verifyMedia() {
      return { ok: false, reason: 'missing' };
    },
    async releaseLease() {
      return { released: false };
    },
  });

  const result = await simulatePublicationTransaction(deps, input());
  assert.equal(result.status, 'lease_cleanup_required');
  assert.equal(result.stage, 'media');
  assert.equal(result.dispatched, false);
  assert.equal(result.leaseRetained, true);
});

test('stale lease before dispatch cannot reach X and is never released by stale owner', async () => {
  const { deps, calls } = baseDeps({
    async verifyLease(_lease, context) {
      calls.push(`verifyLease:${context.stage}`);
      return false;
    },
  });

  const result = await simulatePublicationTransaction(deps, input());
  assert.equal(result.stage, 'fencing');
  assert.equal(result.reason, 'lease_fenced_before_dispatch');
  assert.equal(result.dispatched, false);
  assert.equal(calls.includes('dispatch'), false);
  assert.equal(calls.includes('release'), false);
});

test('confirmed success uses real transport + classifier, records evidence, then releases', async () => {
  const { deps, calls } = baseDeps();
  const result = await simulatePublicationTransaction(deps, input());

  assert.equal(result.status, 'confirmed_posted');
  assert.equal(result.dispatched, true);
  assert.equal(result.leaseRetained, false);
  assert.equal(result.evidence.outcome.postId, 'tweet-1');
  assert.equal(result.automaticRetryAllowed, false);

  const xCall = calls.find((entry) => Array.isArray(entry) && entry[0] === 'x.create');
  assert.deepEqual(xCall[1], {
    text: 'simulated publication',
    media: { mediaIds: ['sim-media-1'] },
  });

  assert.deepEqual(
    calls.filter((entry) => typeof entry === 'string'),
    [
      'identity',
      'eligibility',
      'acquire',
      'media',
      'verifyLease:pre_dispatch',
      'dispatch',
      'classify',
      'verifyLease:post_dispatch',
      'evidence',
      'release',
    ],
  );
});

test('lease takeover during X request converts even explicit success to reconciliation', async () => {
  let checks = 0;
  let recorded;
  const { deps, calls } = baseDeps({
    async verifyLease(_lease, context) {
      calls.push(`verifyLease:${context.stage}`);
      checks += 1;
      return checks === 1;
    },
    async recordEvidence(value) {
      calls.push('evidence');
      recorded = value;
    },
  });

  const result = await simulatePublicationTransaction(deps, input());

  assert.equal(result.status, 'needs_reconciliation');
  assert.equal(result.reason, 'lease_fenced_after_dispatch');
  assert.equal(result.dispatched, true);
  assert.equal(result.leaseRetained, true);
  assert.equal(result.automaticRetryAllowed, false);
  assert.equal(recorded.outcome.observedClassification, 'confirmed_posted');
  assert.equal(recorded.outcome.observedPostId, 'tweet-1');
  assert.equal(calls.includes('release'), false);
});

test('ambiguous timeout records reconciliation evidence and retains lease', async () => {
  const { deps, calls } = baseDeps({
    async dispatchPost() {
      calls.push('dispatch');
      const error = new Error('timeout');
      error.code = 'ETIMEDOUT';
      throw error;
    },
  });

  const result = await simulatePublicationTransaction(deps, input());
  assert.equal(result.status, 'needs_reconciliation');
  assert.equal(result.reason, 'transport_etimedout');
  assert.equal(result.dispatched, true);
  assert.equal(result.leaseRetained, true);
  assert.equal(result.automaticRetryAllowed, false);
  assert.equal(calls.includes('release'), false);
});

test('known not-dispatched transport failure can complete as confirmed not posted', async () => {
  const { deps } = baseDeps({
    async dispatchPost() {
      const error = new Error('DNS failed before request');
      error.code = 'ENOTFOUND';
      error.phase = 'not_dispatched';
      throw error;
    },
  });

  const result = await simulatePublicationTransaction(deps, input());
  assert.equal(result.status, 'confirmed_not_posted');
  assert.equal(result.stage, 'complete');
  assert.equal(result.leaseRetained, false);
});

test('evidence persistence failure after dispatch is reconciliation-required and retains lease', async () => {
  const { deps, calls } = baseDeps({
    async recordEvidence() {
      calls.push('evidence');
      throw new Error('evidence store unavailable');
    },
  });

  const result = await simulatePublicationTransaction(deps, input());
  assert.equal(result.status, 'needs_reconciliation');
  assert.equal(result.stage, 'evidence');
  assert.equal(result.reason, 'evidence_record_failed');
  assert.equal(result.leaseRetained, true);
  assert.equal(result.automaticRetryAllowed, false);
  assert.equal(calls.includes('release'), false);
});

test('release failure is explicit and does not erase the observed X outcome', async () => {
  const { deps } = baseDeps({
    async releaseLease() {
      return { released: false };
    },
  });

  const result = await simulatePublicationTransaction(deps, input());
  assert.equal(result.status, 'lease_cleanup_required');
  assert.equal(result.stage, 'release');
  assert.equal(result.observedOutcome, 'confirmed_posted');
  assert.equal(result.leaseRetained, true);
  assert.equal(result.automaticRetryAllowed, false);
});

test('evidence redacts lease capability tokens', async () => {
  let evidence;
  const { deps } = baseDeps({
    async recordEvidence(value) {
      evidence = value;
    },
  });

  await simulatePublicationTransaction(deps, input());
  const encoded = JSON.stringify(evidence);
  assert.equal(encoded.includes('winner-owner-token'), false);
  assert.equal(encoded.includes('winner-acquisition-id'), false);
  assert.equal(evidence.lease.generation, 1);
});

test('invalid classifier output fails closed to reconciliation', async () => {
  const { deps } = baseDeps({
    classifyOutcome() {
      return null;
    },
  });

  const result = await simulatePublicationTransaction(deps, input());
  assert.equal(result.status, 'needs_reconciliation');
  assert.equal(result.reason, 'classifier_invalid_result');
  assert.equal(result.automaticRetryAllowed, false);
});

test('two concurrent simulations with one lease winner dispatch exactly once', async () => {
  let held = false;
  let dispatches = 0;
  const { deps } = baseDeps();

  deps.acquireLease = async () => {
    if (held) return { acquired: false, reason: 'held' };
    held = true;
    return {
      acquired: true,
      lease: {
        ownerToken: 'winner-owner-token',
        acquisitionId: 'winner-acquisition-id',
        generation: 1,
        acquiredAtMs: NOW.getTime(),
        expiresAtMs: NOW.getTime() + 60_000,
      },
    };
  };

  deps.dispatchPost = async ({ post, media }) => {
    dispatches += 1;
    return {
      status: 201,
      data: { id: `${post.id}-${media.mediaIds.length}` },
    };
  };

  const [a, b] = await Promise.all([
    simulatePublicationTransaction(deps, input()),
    simulatePublicationTransaction(deps, input()),
  ]);

  assert.equal(dispatches, 1);
  assert.equal([a.status, b.status].includes('confirmed_posted'), true);
  assert.equal([a.stage, b.stage].includes('lease'), true);
});
