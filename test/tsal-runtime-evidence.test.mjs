import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildRuntimeEvidence,
  evaluateRuntimeHealth,
  observeRuntime,
} from '../scripts/tsal-runtime-evidence.mjs';

function healthyPayload(overrides = {}) {
  return {
    service: 'xqueue',
    status: 'ok',
    livePublication: true,
    schedulerAuthority: true,
    schedulerLiveness: {
      required: true,
      ok: true,
      state: 'fresh',
      lastInvocationAt: '2026-09-06T02:45:00.000Z',
    },
    queueIntegrity: { ok: true },
    authorityReadiness: {
      ok: true,
      authorized: true,
      authorityFlag: true,
    },
    storage: {
      d1: { reachable: true, tables: 8 },
      r2: { reachable: true, sampleObjectCount: 1 },
    },
    ...overrides,
  };
}

test('runtime health proves technical safety without conflating deployment authority', () => {
  const health = healthyPayload({
    livePublication: false,
    schedulerAuthority: false,
    schedulerLiveness: {
      required: false,
      ok: true,
      state: 'not_required',
    },
    authorityReadiness: {
      ok: true,
      authorized: false,
      authorityFlag: false,
    },
  });

  const result = evaluateRuntimeHealth(health);

  assert.equal(result.safe, true);
  assert.deepEqual(result.failing, []);
  assert.equal(result.authority.authorized, false);
  assert.equal(result.authority.schedulerAuthority, false);
});

test('healthy runtime creates current passing runtime evidence', () => {
  const evidence = buildRuntimeEvidence({
    health: healthyPayload(),
    producedAt: '2026-09-06T03:00:00.000Z',
    validForMinutes: 90,
    runId: '12345',
    actor: 'peteywee',
    observerCommit: 'abc123',
    source: 'https://example.test/health',
  });

  assert.equal(evidence.result, 'pass');
  assert.equal(evidence.evidence_class, 'runtime');
  assert.equal(evidence.evidence_type, 'runtime_observation');
  assert.equal(evidence.claim_id, 'xqueue-publisher.runtime.safe');
  assert.equal(evidence.valid_until, '2026-09-06T04:30:00.000Z');
  assert.equal(evidence.candidate, null);
  assert.equal(evidence.details.observer_commit, 'abc123');
  assert.equal(evidence.details.evaluation.checks.scheduler_liveness, true);
});

test('stale scheduler heartbeat makes runtime evidence fail', () => {
  const evidence = buildRuntimeEvidence({
    health: healthyPayload({
      status: 'error',
      schedulerAuthority: false,
      schedulerLiveness: {
        required: true,
        ok: false,
        state: 'stale',
        lastInvocationAt: '2026-09-06T01:00:00.000Z',
      },
    }),
    producedAt: '2026-09-06T03:00:00.000Z',
  });

  assert.equal(evidence.result, 'fail');
  assert.ok(evidence.details.evaluation.failing.includes('scheduler_liveness'));
});

test('explicitly unhealthy runtime creates failing evidence', () => {
  const health = healthyPayload({
    authorityReadiness: {
      ok: false,
      authorized: false,
      authorityFlag: true,
    },
  });

  const evidence = buildRuntimeEvidence({
    health,
    producedAt: '2026-09-06T03:00:00.000Z',
  });

  assert.equal(evidence.result, 'fail');
  assert.deepEqual(evidence.details.evaluation.failing, ['authority_readiness']);
});

test('unavailable observation stays unknown instead of fabricating a failure or pass', () => {
  const evidence = buildRuntimeEvidence({
    health: null,
    observationError: 'network unavailable',
    producedAt: '2026-09-06T03:00:00.000Z',
  });

  assert.equal(evidence.result, 'unknown');
  assert.equal(evidence.details.observation_error, 'network unavailable');
  assert.equal(evidence.details.evaluation, null);
});

test('HTTP error with structured unhealthy body remains an observed runtime failure', async () => {
  const fetchImpl = async () => new Response(
    JSON.stringify(healthyPayload({ status: 'error' })),
    {
      status: 503,
      headers: { 'content-type': 'application/json' },
    },
  );

  const observation = await observeRuntime({
    url: 'https://example.test/health',
    fetchImpl,
  });

  assert.equal(observation.health.status, 'error');
  assert.equal(observation.observationError, 'HTTP 503 reported by production health');

  const evidence = buildRuntimeEvidence({
    ...observation,
    producedAt: '2026-09-06T03:00:00.000Z',
  });

  assert.equal(evidence.result, 'fail');
  assert.ok(evidence.details.evaluation.failing.includes('service_status'));
});

test('transport failure produces unknown observation', async () => {
  const observation = await observeRuntime({
    url: 'https://example.test/health',
    fetchImpl: async () => {
      throw new Error('socket closed');
    },
  });

  assert.equal(observation.health, null);
  assert.equal(observation.observationError, 'socket closed');
});
