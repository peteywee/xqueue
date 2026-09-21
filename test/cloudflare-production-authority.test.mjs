import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import {
  publicationAuthorityEnabled,
} from '../cloudflare/src/authority-config.mjs';
import {
  beginPublishingFence,
  persistPublicationOutcome,
} from '../cloudflare/src/publication-ledger.mjs';
import {
  verifyPublicationLease,
} from '../cloudflare/src/publication-lease-verify.mjs';
import {
  runScheduledPublication,
} from '../cloudflare/src/production-publisher.mjs';
import {
  classifyPublicationOutcome,
} from '../probes/cloudflare-x/outcome-classifier.mjs';

function ledger() {
  return {
    version: 1,
    spend: 0,
    posted: {},
    skipped: {},
    inflight: null,
  };
}

function sha256(text) {
  return createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');
}

function fenceEvidence() {
  return {
    attemptId: 'attempt-123',
    stateGeneration: 2,
    leaseName: 'publisher',
    leaseGeneration: 1,
    leaseOwnerToken: 'owner-token',
    leaseAcquisitionId: 'acquisition-id',
    leaseAcquiredAtMs: 1000,
    leaseExpiresAtMs: 9999999999999,
    assignmentId: 'C99',
    assignmentVersion: 1,
    policyVersion: 2,
    contentDigest: 'a'.repeat(64),
  };
}

function assignmentHandle(contentId = 'C99') {
  return {
    assignment_id: contentId,
    assignment_version: 1,
    content_id: contentId,
    policy_version: 2,
    content_digest: 'a'.repeat(64),
    resolved_at: '2026-09-02T16:00:00.000Z',
  };
}

function queue() {
  return [{
    id: 'C99',
    pillar: 'C',
    title: 'Production candidate',
    body: 'One exactly selected production-shaped post.',
    figure: null,
    date: '2026-09-02',
    time: '11:00',
    timezone: 'America/Chicago',
  }];
}

function eligible() {
  return {
    health: {
      ok: true,
      postedCount: 0,
      skippedCount: 0,
      unresolvedCount: 1,
      due: ['C99'],
      overdue: [],
      next: 'C99',
      inflight: null,
      graceMinutes: 20,
    },
    selection: {
      blocked: false,
      blockReason: null,
      selected: ['C99'],
    },
    safeToPublish: true,
    failures: [],
  };
}

function prepared(sql, params = [], onFirst = null) {
  return {
    sql,
    params,
    bind(...next) {
      return prepared(sql, next, onFirst);
    },
    async first() {
      if (typeof onFirst !== 'function') {
        throw new Error('unexpected first() call in proof DB');
      }
      return onFirst({ sql, params });
    },
  };
}

function changeProofDb({
  stateStatus = 'scheduled',
  stateAttemptId = null,
  stateGeneration = 1,
} = {}) {
  const operations = [];

  return {
    operations,
    prepare(sql) {
      return prepared(sql, [], ({ sql: cursorSql }) => {
        if (/FROM publication_state/.test(cursorSql)) {
          return {
            status: stateStatus,
            attempt_id: stateAttemptId,
            generation: stateGeneration,
            scheduled_at: '2026-09-02T16:00:00.000Z',
          };
        }
        throw new Error('unexpected first() query in proof DB');
      });
    },
    async batch(statements) {
      operations.push(...statements);
      return [
        { success: true, results: [] },
        { success: true, results: [{ direct_changes: 1 }] },
        { success: true, results: [] },
        { success: true, results: [{ direct_changes: 1 }] },
        { success: true, results: [] },
        { success: true, results: [{ direct_changes: 1 }] },
        { success: true, results: [] },
        { success: true, results: [{ direct_changes: 1 }] },
      ];
    },
  };
}

function publishingSnapshot(state) {
  const fence = state.inflight?.publicationFence ?? fenceEvidence();
  if (state.inflight && !state.inflight.publicationFence) {
    state.inflight.publicationFence = fence;
  }
  return {
    raw: JSON.stringify(state),
    ledger: state,
    publicationFence: fence,
    publicationStateGeneration: 2,
  };
}

function mockXClient() {
  return {
    users: {
      async getMe() {
        return { data: { id: 'test-user-id', username: 'PatrickCra94338' } };
      },
    },
    posts: {
      async create() {
        return { data: { id: '999999' } };
      },
    },
  };
}

test('authority flag is exact and fail-closed', () => {
  assert.equal(publicationAuthorityEnabled({}), false);
  assert.equal(publicationAuthorityEnabled({ XQUEUE_PUBLISH_AUTHORITY: 'ENABLED' }), false);
  assert.equal(publicationAuthorityEnabled({ XQUEUE_PUBLISH_AUTHORITY: 'true' }), false);
  assert.equal(publicationAuthorityEnabled({ XQUEUE_PUBLISH_AUTHORITY: 'enabled' }), true);
  assert.equal(publicationAuthorityEnabled({ XQUEUE_PUBLISH_AUTHORITY: 'TRUE' }), false);
});

test('publisher does nothing before the authority flag is enabled', async () => {
  let touched = false;
  const result = await runScheduledPublication({}, {
    dependencies: {
      async verifyQueueIntegrity() {
        touched = true;
        return { ok: true };
      },
    },
  });

  assert.equal(result.status, 'idle');
  assert.equal(result.reason, 'authority_disabled');
  assert.equal(touched, false);
});

test('enabled publisher runs one real-shaped transaction with one selected post', async () => {
  let evidenceRecorded = null;
  let releaseCalls = 0;
  const source = ledger();

  const result = await runScheduledPublication(
    {
      XQUEUE_PUBLISH_AUTHORITY: 'enabled',
      DB: {},
      MEDIA: {},
    },
    {
      now: new Date('2026-09-02T16:00:00.000Z'),
      dependencies: {
        async verifyQueueIntegrity() { return { ok: true }; },
        async readPublicationSnapshot() {
          return { raw: JSON.stringify(source), ledger: source };
        },
        async readGlobalPublicationHalt() {
          return {
            ok: true,
            halted: false,
            generation: 1,
            reason: 'initial_unhalted',
            actorClass: 'migration',
            updatedAt: '2026-09-02T15:00:00.000Z',
          };
        },
        evaluateEligibility() { return eligible(); },
        decodeBundledQueue() { return queue(); },
        async readCurrentAssignmentHandle() { return assignmentHandle('C99'); },
        async prepareSelectedMedia() {
          return { ok: true, required: false, bytes: null, mediaObject: null };
        },
        makeClient() { return mockXClient(); },
        async acquirePublicationLease() {
          return {
            acquired: true,
            lease: {
              leaseName: 'publisher',
              ownerToken: 'owner-token',
              acquisitionId: 'acquisition-id',
              generation: 1,
              acquiredAtMs: Date.now(),
              expiresAtMs: Date.now() + 60_000,
            },
          };
        },
        async verifyPublicationLease() { return true; },
        async releasePublicationLease() {
          releaseCalls += 1;
          return { released: true };
        },
        async beginPublishingFence(db, snapshot, input) {
          assert.equal(input.lease.leaseName, 'publisher');
          assert.equal(input.lease.acquisitionId, 'acquisition-id');
          assert.equal(input.assignment.assignment_id, 'C99');
          assert.equal(input.assignment.assignment_version, 1);
          const next = structuredClone(source);
          next.inflight = {
            attemptId: 'attempt-123',
            postId: 'C99',
            title: 'Production candidate',
            contentHash: 'a'.repeat(64),
            cost: 0.015,
            status: 'publishing',
          };
          return {
            raw: JSON.stringify(next),
            ledger: next,
            publicationStateGeneration: 2,
          };
        },
        async persistPublicationOutcome(db, snapshot, input) {
          evidenceRecorded = { db, snapshot, input };
        },
        async simulatePublicationTransaction(deps) {
          const identity = await deps.verifyIdentity();
          assert.equal(identity.username, 'PatrickCra94338');
          const lease = (await deps.acquireLease()).lease;
          assert.equal(await deps.verifyLease(lease), true);
          const media = await deps.verifyMedia({ post: queue()[0] });
          assert.equal(media.ok, true);
          const response = await deps.dispatchPost({ post: queue()[0], media });
          const outcome = deps.classifyOutcome({ phase: 'dispatched', response });
          await deps.recordEvidence({ outcome });
          await deps.releaseLease(lease);
          return {
            status: 'confirmed_posted',
            stage: 'complete',
            dispatched: true,
            automaticRetryAllowed: false,
          };
        },
      },
    },
  );

  assert.equal(result.status, 'confirmed_posted');
  assert.equal(result.selectedPostId, 'C99');
  assert.equal(evidenceRecorded.input.post.id, 'C99');
  assert.equal(evidenceRecorded.input.outcome.classification, 'confirmed_posted');
  assert.equal(releaseCalls, 1);
});

test('publishing fence mirrors local inflight semantics and advances state generation before dispatch', async () => {
  const state = ledger();
  const result = await beginPublishingFence(
    changeProofDb(),
    { raw: JSON.stringify(state), ledger: state },
    {
      post: { id: 'C99', title: 'Production candidate' },
      text: 'hello',
      cost: 0.015,
      now: new Date('2026-09-02T16:00:00.000Z'),
      attemptId: 'attempt-123',
      lease: {
        leaseName: 'publisher',
        ownerToken: 'owner-token',
        acquisitionId: 'acquisition-id',
        generation: 1,
        acquiredAtMs: 1000,
        expiresAtMs: 9999999999999,
      },
      assignment: {
        ...assignmentHandle('C99'),
        content_digest: sha256('hello'),
      },
    },
  );

  assert.equal(result.ledger.inflight.status, 'publishing');
  assert.equal(result.ledger.inflight.postId, 'C99');
  assert.equal(result.ledger.inflight.attemptId, 'attempt-123');
  assert.equal(result.ledger.inflight.cost, 0.015);
  assert.equal(result.publicationStateGeneration, 2);
});

test('confirmed post commits tweet id, clears inflight and advances generation', async () => {
  const state = ledger();
  state.inflight = {
    attemptId: 'attempt-123',
    postId: 'C99',
    title: 'Production candidate',
    contentHash: 'a'.repeat(64),
    cost: 0.015,
    startedAt: '2026-09-02T16:00:00.000Z',
    publishStartedAt: '2026-09-02T16:00:00.000Z',
    status: 'publishing',
  };

  const result = await persistPublicationOutcome(
    changeProofDb(),
    publishingSnapshot(state),
    {
      post: { id: 'C99' },
      outcome: {
        classification: 'confirmed_posted',
        reason: 'explicit_success',
        postId: '999999',
      },
      now: new Date('2026-09-02T16:01:00.000Z'),
    },
  );

  assert.equal(result.ledger.inflight, null);
  assert.equal(result.ledger.posted.C99.tweetId, '999999');
  assert.equal(result.ledger.posted.C99.attemptId, 'attempt-123');
  assert.equal(result.ledger.spend, 0.015);
  assert.equal(result.publicationStateGeneration, 3);
  assert.equal(result.reconciliationRequired, false);
});

test('confirmed-not-posted outcome stays distinct and advances generation', async () => {
  const state = ledger();
  state.inflight = {
    attemptId: 'attempt-123',
    postId: 'C99',
    title: 'Production candidate',
    contentHash: 'a'.repeat(64),
    cost: 0.015,
    status: 'publishing',
  };

  const result = await persistPublicationOutcome(
    changeProofDb(),
    publishingSnapshot(state),
    {
      post: { id: 'C99' },
      outcome: {
        classification: 'confirmed_not_posted',
        reason: 'explicit_http_refusal_429',
        automaticRetryAllowed: false,
      },
      now: new Date('2026-09-02T16:01:00.000Z'),
    },
  );

  assert.equal(result.ledger.inflight, null);
  assert.equal(result.publicationStateGeneration, 3);
  assert.equal(result.reconciliationRequired, false);
});

test('ambiguous outcome remains a durable reconciliation block and advances generation', async () => {
  const state = ledger();
  state.inflight = {
    attemptId: 'attempt-123',
    postId: 'C99',
    title: 'Production candidate',
    contentHash: 'a'.repeat(64),
    cost: 0.015,
    status: 'publishing',
  };

  const result = await persistPublicationOutcome(
    changeProofDb(),
    publishingSnapshot(state),
    {
      post: { id: 'C99' },
      outcome: {
        classification: 'needs_reconciliation',
        reason: 'ambiguous_timeout',
        automaticRetryAllowed: false,
      },
      now: new Date('2026-09-02T16:01:00.000Z'),
    },
  );

  assert.equal(result.ledger.inflight.status, 'needs_reconciliation');
  assert.equal(result.ledger.inflight.lastError, 'ambiguous_timeout');
  assert.equal(result.publicationStateGeneration, 3);
  assert.equal(result.reconciliationRequired, true);
});

test('exact lease verifier rejects stale, expired and mismatched handles', async () => {
  const lease = {
    ownerToken: 'owner-token',
    acquisitionId: 'acquisition-id',
    generation: 7,
    acquiredAtMs: 1000,
    expiresAtMs: 5000,
  };

  const row = {
    lease_name: 'publisher',
    owner_token: lease.ownerToken,
    acquisition_id: lease.acquisitionId,
    generation: lease.generation,
    acquired_at_ms: lease.acquiredAtMs,
    expires_at_ms: lease.expiresAtMs,
    updated_at_ms: 1000,
  };

  const db = {
    prepare() {
      return {
        async first() { return row; },
      };
    },
  };

  assert.equal(await verifyPublicationLease(db, lease, { nowMs: 4999 }), true);
  assert.equal(await verifyPublicationLease(db, lease, { nowMs: 5000 }), false);
  assert.equal(
    await verifyPublicationLease(
      db,
      { ...lease, generation: 8 },
      { nowMs: 4999 },
    ),
    false,
  );
});

test('classifier reads XDK-style HTTP errors and includes 413 refusal', () => {
  const classification = classifyPublicationOutcome({
    phase: 'dispatched',
    error: { response: { status: 413 } },
  });

  assert.equal(classification.classification, 'confirmed_not_posted');
  assert.equal(classification.reason, 'explicit_http_refusal_413');
  assert.equal(classification.automaticRetryAllowed, false);
});

test('Worker-compatible render preserves the pillar B legal disclaimer', async () => {
  const source = ledger();
  let renderedText = null;

  await runScheduledPublication(
    {
      XQUEUE_PUBLISH_AUTHORITY: 'enabled',
      DB: {},
      MEDIA: {},
    },
    {
      now: new Date('2026-09-02T16:00:00.000Z'),
      dependencies: {
        async verifyQueueIntegrity() { return { ok: true }; },
        async readPublicationSnapshot() {
          return { raw: JSON.stringify(source), ledger: source };
        },
        async readGlobalPublicationHalt() {
          return {
            ok: true,
            halted: false,
            generation: 1,
            reason: 'initial_unhalted',
            actorClass: 'migration',
            updatedAt: '2026-09-02T15:00:00.000Z',
          };
        },
        evaluateEligibility() {
          return {
            ...eligible(),
            selection: { blocked: false, blockReason: null, selected: ['B99'] },
          };
        },
        decodeBundledQueue() {
          return [{ ...queue()[0], id: 'B99', pillar: 'B' }];
        },
        async readCurrentAssignmentHandle() { return assignmentHandle('B99'); },
        async prepareSelectedMedia() {
          return { ok: true, required: false, bytes: null, mediaObject: null };
        },
        makeClient() { return mockXClient(); },
        async acquirePublicationLease() {
          return {
            acquired: true,
            lease: {
              leaseName: 'publisher',
              ownerToken: 'owner-token',
              acquisitionId: 'acquisition-id',
              generation: 1,
              acquiredAtMs: Date.now(),
              expiresAtMs: Date.now() + 60_000,
            },
          };
        },
        async verifyPublicationLease() { return true; },
        async releasePublicationLease() { return { released: true }; },
        async beginPublishingFence(db, snapshot, input) {
          assert.equal(input.lease.leaseName, 'publisher');
          assert.equal(input.assignment.assignment_id, 'B99');
          renderedText = input.text;
          const next = structuredClone(source);
          next.inflight = {
            attemptId: 'attempt-123',
            postId: input.post.id,
            title: input.post.title,
            contentHash: 'a'.repeat(64),
            cost: input.cost,
            status: 'publishing',
          };
          return {
            raw: JSON.stringify(next),
            ledger: next,
            publicationStateGeneration: 2,
          };
        },
        async persistPublicationOutcome() {},
        async simulatePublicationTransaction(deps) {
          await deps.verifyIdentity();
          const lease = (await deps.acquireLease()).lease;
          await deps.verifyLease(lease);
          const selected = { ...queue()[0], id: 'B99', pillar: 'B' };
          const media = await deps.verifyMedia({ post: selected });
          const response = await deps.dispatchPost({ post: selected, media });
          const outcome = deps.classifyOutcome({ phase: 'dispatched', response });
          await deps.recordEvidence({ outcome });
          await deps.releaseLease(lease);
          return {
            status: 'confirmed_posted',
            stage: 'complete',
            dispatched: true,
            automaticRetryAllowed: false,
          };
        },
      },
    },
  );

  assert.match(renderedText, /General information, not legal advice\./);
});
