import test from 'node:test';
import assert from 'node:assert/strict';

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
  productionPublisherInternals,
} from '../cloudflare/src/production-publisher.mjs';
import {
  classifyPublicationOutcome,
} from '../probes/cloudflare-x/outcome-classifier.mjs';

function queue() {
  return [{
    id: 'C99',
    pillar: 'C',
    title: 'Production candidate',
    body: 'production candidate post',
    figure: null,
    scheduledDate: '2026-09-02',
    scheduledTime: '10:50',
    timezone: 'America/Chicago',
    slot: 'morning',
  }];
}

function ledger() {
  return {
    version: 1,
    posted: {},
    skipped: {},
    spend: 0,
    inflight: null,
  };
}

function changeProofDb() {
  return {
    prepare(sql) {
      return {
        sql,
        bind(...args) {
          this.args = args;
          return this;
        },
      };
    },
    async batch(statements) {
      return statements.map((statement, index) =>
        index % 2 === 1
          ? { results: [{ direct_changes: 1 }] }
          : { meta: { statement: statement.sql } },
      );
    },
  };
}

test('authority flag is exact and fail-closed', () => {
  assert.equal(publicationAuthorityEnabled({}), false);
  assert.equal(publicationAuthorityEnabled({ XQUEUE_PUBLISH_AUTHORITY: 'ENABLED' }), false);
  assert.equal(publicationAuthorityEnabled({ XQUEUE_PUBLISH_AUTHORITY: 'true' }), false);
  assert.equal(publicationAuthorityEnabled({ XQUEUE_PUBLISH_AUTHORITY: 'enabled' }), true);

  const hostile = new Proxy({}, {
    get() {
      throw new Error('hostile binding');
    },
  });
  assert.equal(publicationAuthorityEnabled(hostile), false);
});

test('publisher does nothing before the authority flag is enabled', async () => {
  let calls = 0;
  const result = await runScheduledPublication(
    {},
    {
      now: new Date('2026-09-02T16:00:00.000Z'),
      dependencies: {
        async verifyQueueIntegrity() {
          calls += 1;
          return { ok: true };
        },
      },
    },
  );

  assert.equal(result.status, 'idle');
  assert.equal(result.reason, 'authority_disabled');
  assert.equal(result.dispatched, false);
  assert.equal(calls, 0);
});

test('enabled publisher runs one real-shaped transaction with one selected post', async () => {
  const q = queue();
  const state = ledger();
  const source = { raw: JSON.stringify(state), ledger: state };

  let fenceCalls = 0;
  let outcomeCalls = 0;
  let createCalls = 0;
  let identityCalls = 0;

  const fakeClient = {
    users: {
      async getMe() {
        identityCalls += 1;
        return { data: { id: '123', username: 'PatrickCra94338' } };
      },
    },
    posts: {
      async create(body) {
        createCalls += 1;
        assert.equal(body.text, 'production candidate post');
        return { data: { id: '999999' } };
      },
    },
  };

  const lease = {
    leaseName: 'publisher',
    ownerToken: 'owner-token',
    acquisitionId: 'acquisition-id',
    generation: 1,
    acquiredAtMs: 1,
    expiresAtMs: Number.MAX_SAFE_INTEGER,
  };

  const result = await runScheduledPublication(
    {
      XQUEUE_PUBLISH_AUTHORITY: 'enabled',
      DB: {},
    },
    {
      now: new Date('2026-09-02T16:00:00.000Z'),
      dependencies: {
        async verifyQueueIntegrity() {
          return { ok: true };
        },
        decodeBundledQueue() {
          return q;
        },
        async readPublicationSnapshot() {
          return source;
        },
        async prepareSelectedMedia() {
          return { ok: true, required: false, bytes: null, mediaObject: null };
        },
        makeClient() {
          return fakeClient;
        },
        async acquirePublicationLease() {
          return { acquired: true, lease };
        },
        async verifyPublicationLease() {
          return true;
        },
        async releasePublicationLease() {
          return { released: true };
        },
        async beginPublishingFence(db, snapshot, input) {
          fenceCalls += 1;
          assert.equal(snapshot, source);
          assert.equal(input.post.id, 'C99');
          return {
            raw: 'publishing',
            ledger: {
              ...state,
              inflight: {
                attemptId: 'attempt-1',
                postId: 'C99',
                title: 'Production candidate',
                contentHash: 'hash',
                cost: 0.015,
                status: 'publishing',
              },
            },
          };
        },
        async persistPublicationOutcome(db, snapshot, input) {
          outcomeCalls += 1;
          assert.equal(snapshot.raw, 'publishing');
          assert.equal(input.post.id, 'C99');
          assert.equal(input.outcome.classification, 'confirmed_posted');
          assert.equal(input.outcome.postId, '999999');
        },
      },
    },
  );

  assert.equal(result.status, 'confirmed_posted');
  assert.equal(result.selectedPostId, 'C99');
  assert.equal(result.evidence.outcome.postId, '999999');
  assert.equal(identityCalls, 1);
  assert.equal(createCalls, 1);
  assert.equal(fenceCalls, 1);
  assert.equal(outcomeCalls, 1);
  assert.equal(result.automaticRetryAllowed, false);
});

test('publishing fence mirrors local inflight semantics before dispatch', async () => {
  const state = ledger();
  const source = { raw: JSON.stringify(state), ledger: state };

  const fenced = await beginPublishingFence(
    changeProofDb(),
    source,
    {
      post: { id: 'C99', title: 'Production candidate' },
      text: 'production candidate post',
      cost: 0.015,
      now: new Date('2026-09-02T16:00:00.000Z'),
      attemptId: 'attempt-123',
    },
  );

  assert.equal(fenced.ledger.inflight.postId, 'C99');
  assert.equal(fenced.ledger.inflight.status, 'publishing');
  assert.equal(fenced.ledger.inflight.attemptId, 'attempt-123');
  assert.equal(fenced.ledger.inflight.cost, 0.015);
  assert.equal(typeof fenced.ledger.inflight.contentHash, 'string');
  assert.equal(fenced.ledger.inflight.contentHash.length, 64);
});

test('confirmed post commits tweet id and clears inflight', async () => {
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
    { raw: JSON.stringify(state), ledger: state },
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
  assert.equal(result.reconciliationRequired, false);
});

test('any non-posted outcome becomes a durable reconciliation block', async () => {
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
    { raw: JSON.stringify(state), ledger: state },
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

  assert.equal(result.ledger.inflight.status, 'needs_reconciliation');
  assert.equal(result.ledger.inflight.lastError, 'explicit_http_refusal_429');
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
        async first() {
          return row;
        },
      };
    },
  };

  assert.equal(await verifyPublicationLease(db, lease, { nowMs: 4999 }), true);
  assert.equal(await verifyPublicationLease(db, lease, { nowMs: 5000 }), false);
  assert.equal(
    await verifyPublicationLease(
      db,
      { ...lease, generation: 6 },
      { nowMs: 2000 },
    ),
    false,
  );
});

test('classifier reads XDK-style HTTP errors and includes 413 refusal', () => {
  const forbidden = classifyPublicationOutcome({
    phase: 'dispatched',
    error: { response: { status: 403 } },
  });
  assert.equal(forbidden.classification, 'confirmed_not_posted');
  assert.equal(forbidden.reason, 'explicit_http_refusal_403');

  const tooLarge = classifyPublicationOutcome({
    phase: 'dispatched',
    error: { statusCode: 413 },
  });
  assert.equal(tooLarge.classification, 'confirmed_not_posted');
  assert.equal(tooLarge.reason, 'explicit_http_refusal_413');
});

test('Worker-compatible render preserves the pillar B legal disclaimer', () => {
  const text = productionPublisherInternals.renderPost({
    pillar: 'B',
    body: 'Body',
  });

  assert.equal(
    text,
    'Body\n\nGeneral information, not legal advice. Wage and hour rules vary by\n' +
      'state — talk to an employment attorney about your situation.',
  );
});
