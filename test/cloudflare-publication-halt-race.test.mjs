import test from 'node:test';
import assert from 'node:assert/strict';

import {
  runScheduledPublication,
} from '../cloudflare/src/production-publisher.mjs';

function ledger() {
  return {
    version: 1,
    spend: 0,
    posted: {},
    skipped: {},
    inflight: null,
  };
}

function queue() {
  return [{
    id: 'A1',
    pillar: 'A',
    title: 'A1',
    body: 'Approved publication body.',
    figure: null,
    date: '2026-09-21',
    time: '14:30',
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
      due: ['A1'],
      overdue: [],
      next: 'A1',
      inflight: null,
      graceMinutes: 20,
    },
    selection: {
      blocked: false,
      blockReason: null,
      selected: ['A1'],
    },
    safeToPublish: true,
    failures: [],
  };
}

function openHalt() {
  return {
    ok: true,
    halted: false,
    generation: 1,
    reason: 'initial_unhalted',
    actorClass: 'migration',
    updatedAt: '2026-09-21T18:00:00.000Z',
  };
}

function closedHalt() {
  return {
    ok: true,
    halted: true,
    generation: 2,
    reason: 'safety stop',
    actorClass: 'automation',
    updatedAt: '2026-09-21T18:01:00.000Z',
  };
}

function baseDependencies(overrides = {}) {
  const source = ledger();
  let postCreates = 0;
  let acquired = 0;
  let beginFenceCalls = 0;
  let recordedOutcome = null;

  const dependencies = {
    async verifyQueueIntegrity() {
      return { ok: true };
    },
    async readPublicationSnapshot() {
      return { raw: JSON.stringify(source), ledger: source };
    },
    evaluateEligibility() {
      return eligible();
    },
    decodeBundledQueue() {
      return queue();
    },
    async readCurrentAssignmentHandle() {
      return {
        assignment_id: 'A1',
        assignment_version: 1,
        content_id: 'A1',
        policy_version: 2,
        content_digest: 'a'.repeat(64),
        resolved_at: '2026-09-21T19:30:00.000Z',
      };
    },
    async prepareSelectedMedia() {
      return {
        ok: true,
        required: false,
        bytes: null,
        mediaObject: null,
      };
    },
    makeClient() {
      return {
        users: {
          async getMe() {
            return {
              data: {
                id: 'test-user-id',
                username: 'PatrickCra94338',
              },
            };
          },
        },
        posts: {
          async create() {
            postCreates += 1;
            return { data: { id: 'tweet-1' } };
          },
        },
      };
    },
    async acquirePublicationLease() {
      acquired += 1;
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
    async verifyPublicationLease() {
      return true;
    },
    async releasePublicationLease() {
      return { released: true };
    },
    async beginPublishingFence() {
      beginFenceCalls += 1;
      const next = structuredClone(source);
      next.inflight = {
        attemptId: 'attempt-halt-race',
        postId: 'A1',
        title: 'A1',
        contentHash: 'a'.repeat(64),
        cost: 0.01,
        startedAt: '2026-09-21T19:29:00.000Z',
        status: 'publishing',
        publishStartedAt: '2026-09-21T19:29:00.000Z',
      };
      return {
        raw: JSON.stringify(next),
        ledger: next,
        publicationStateGeneration: 2,
      };
    },
    async persistPublicationOutcome(db, snapshot, input) {
      recordedOutcome = input.outcome;
    },
    ...overrides,
  };

  return {
    dependencies,
    counters: {
      get postCreates() { return postCreates; },
      get acquired() { return acquired; },
      get beginFenceCalls() { return beginFenceCalls; },
      get recordedOutcome() { return recordedOutcome; },
    },
  };
}

function env() {
  return {
    XQUEUE_PUBLISH_AUTHORITY: 'enabled',
    DB: {},
    MEDIA: {},
  };
}

test('halt present at transaction start fails closed before queue or X access', async () => {
  let queueTouched = false;

  const result = await runScheduledPublication(env(), {
    now: new Date('2026-09-21T19:30:00.000Z'),
    dependencies: {
      async readGlobalPublicationHalt() {
        return closedHalt();
      },
      async verifyQueueIntegrity() {
        queueTouched = true;
        return { ok: true };
      },
    },
  });

  assert.equal(result.status, 'idle');
  assert.equal(result.reason, 'publication_halted');
  assert.equal(result.dispatched, false);
  assert.equal(queueTouched, false);
});

test('unreadable halt store fails closed before transaction work begins', async () => {
  let queueTouched = false;

  const result = await runScheduledPublication(env(), {
    now: new Date('2026-09-21T19:30:00.000Z'),
    dependencies: {
      async readGlobalPublicationHalt() {
        throw new Error('D1 unavailable');
      },
      async verifyQueueIntegrity() {
        queueTouched = true;
        return { ok: true };
      },
    },
  });

  assert.equal(result.status, 'idle');
  assert.equal(result.reason, 'halt_store_unavailable');
  assert.equal(result.dispatched, false);
  assert.equal(queueTouched, false);
});

test('halt set after scheduler entry but before lease acquisition blocks lease acquisition', async () => {
  let haltReads = 0;
  const proof = baseDependencies({
    async readGlobalPublicationHalt() {
      haltReads += 1;
      return haltReads === 1 ? openHalt() : closedHalt();
    },
  });

  const result = await runScheduledPublication(env(), {
    now: new Date('2026-09-21T19:30:00.000Z'),
    dependencies: proof.dependencies,
  });

  assert.equal(result.status, 'blocked');
  assert.equal(result.stage, 'lease');
  assert.equal(result.reason, 'publication_halted');
  assert.equal(proof.counters.acquired, 0);
  assert.equal(proof.counters.beginFenceCalls, 0);
  assert.equal(proof.counters.postCreates, 0);
});

test('halt set after lease acquisition is rechecked before post creation', async () => {
  let haltReads = 0;
  const proof = baseDependencies({
    async readGlobalPublicationHalt() {
      haltReads += 1;
      if (haltReads <= 2) return openHalt();
      return closedHalt();
    },
  });

  const result = await runScheduledPublication(env(), {
    now: new Date('2026-09-21T19:30:00.000Z'),
    dependencies: proof.dependencies,
  });

  assert.equal(proof.counters.acquired, 1);
  assert.equal(proof.counters.beginFenceCalls, 1);
  assert.equal(proof.counters.postCreates, 0);
  assert.equal(proof.counters.recordedOutcome.classification, 'confirmed_not_posted');
  assert.equal(proof.counters.recordedOutcome.reason, 'pre_dispatch_failure');
  assert.equal(result.dispatched, true);
  assert.equal(result.status, 'confirmed_not_posted');
});
