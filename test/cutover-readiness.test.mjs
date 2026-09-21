import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import {
  CANONICAL_QUEUE_JSON,
  DECLARED_QUEUE_SHA256,
} from '../cloudflare/generated/queue-bundle.mjs';
import { decodeBundledQueue } from '../cloudflare/src/queue-integrity.mjs';
import { evaluateCutoverReadiness } from '../src/cutover-readiness.mjs';

function sha256(value) {
  return createHash('sha256').update(Buffer.from(value, 'utf8')).digest('hex');
}

function healthyInertHealth() {
  return {
    service: 'xqueue',
    status: 'ok',
    livePublication: false,
    schedulerAuthority: false,
    queueIntegrity: { ok: true },
    dynamicRuntimeReadiness: { ok: true },
    authorityReadiness: {
      ok: true,
      authorityFlag: false,
      authorized: false,
    },
    storage: {
      d1: { reachable: true },
      r2: { reachable: true },
    },
  };
}

function readyD1(queue, sha) {
  return {
    queueSha256: sha,
    queueCount: queue.length,
    migrationNames: [
      '0006_continuous_queue_shadow.sql',
      '0007_continuous_queue_intake.sql',
      '0008_dynamic_runtime_integrity.sql',
      '0009_deferred_lifecycle.sql',
      '0010_publication_fence_identity.sql',
      '0011_global_publication_halt.sql',
      '0012_reconciliation_determinations.sql',
    ],
    unresolvedAttemptCount: 0,
    activeLeaseCount: 0,
    haltState: { halted: 0, generation: 1 },
  };
}

test('current production bundle remains explicitly blocked until #52 scheduledAt activation', () => {
  const queue = decodeBundledQueue();
  assert.equal(queue.length, 180);
  assert.equal(queue.some((row) => row.scheduledAt != null), false);

  const result = evaluateCutoverReadiness({
    queue,
    canonicalQueueText: CANONICAL_QUEUE_JSON,
    declaredQueueSha256: DECLARED_QUEUE_SHA256,
    health: healthyInertHealth(),
    d1: readyD1(queue, DECLARED_QUEUE_SHA256),
    controlPlane: { schedules: [], deployments: [], observationErrors: [] },
    authorityBoundaryIntact: true,
    credentialBoundaryIntact: true,
  });

  assert.equal(result.ready, false);
  assert.equal(result.checks.scheduleActivation, false);
  assert.deepEqual(
    result.blockers.map((row) => row.id),
    ['schedule_activation'],
  );
});

test('a fully observed, technically-ready, safely-inert pre-cutover candidate passes', () => {
  const queue = [
    { id: 'A1', scheduledAt: '2026-09-22T19:30:00.000Z' },
    { id: 'A2', scheduledAt: '2026-09-23T03:15:00.000Z' },
  ];
  const canonicalQueueText = JSON.stringify(queue, null, 2) + '\n';
  const sha = sha256(canonicalQueueText);

  const result = evaluateCutoverReadiness({
    queue,
    canonicalQueueText,
    declaredQueueSha256: sha,
    health: healthyInertHealth(),
    d1: readyD1(queue, sha),
    controlPlane: {
      schedules: [],
      deployments: [{ id: 'status-deployment' }],
      observationErrors: [],
    },
    authorityBoundaryIntact: true,
    credentialBoundaryIntact: true,
  });

  assert.equal(result.ready, true);
  assert.deepEqual(result.blockers, []);
  assert.equal(Object.values(result.checks).every(Boolean), true);
});

test('unresolved attempts, active lease, unreadable halt and control plane fail closed', () => {
  const queue = [{ id: 'A1', scheduledAt: '2026-09-22T19:30:00.000Z' }];
  const canonicalQueueText = JSON.stringify(queue, null, 2) + '\n';
  const sha = sha256(canonicalQueueText);

  const result = evaluateCutoverReadiness({
    queue,
    canonicalQueueText,
    declaredQueueSha256: sha,
    health: healthyInertHealth(),
    d1: {
      ...readyD1(queue, sha),
      unresolvedAttemptCount: 1,
      activeLeaseCount: 1,
      haltState: null,
    },
    controlPlane: {
      schedules: null,
      deployments: null,
      observationErrors: ['HTTP 403'],
    },
    authorityBoundaryIntact: true,
    credentialBoundaryIntact: true,
  });

  const ids = result.blockers.map((row) => row.id);
  assert.ok(ids.includes('unresolved_publication_attempt'));
  assert.ok(ids.includes('active_publication_lease'));
  assert.ok(ids.includes('halt_state_unreadable'));
  assert.ok(ids.includes('cloudflare_control_plane_unobservable'));
});

test('pre-cutover report refuses an accidentally active Cloudflare publisher', () => {
  const queue = [{ id: 'A1', scheduledAt: '2026-09-22T19:30:00.000Z' }];
  const canonicalQueueText = JSON.stringify(queue, null, 2) + '\n';
  const sha = sha256(canonicalQueueText);

  const result = evaluateCutoverReadiness({
    queue,
    canonicalQueueText,
    declaredQueueSha256: sha,
    health: {
      ...healthyInertHealth(),
      livePublication: true,
      schedulerAuthority: true,
      authorityReadiness: {
        ok: true,
        authorityFlag: true,
        authorized: true,
      },
    },
    d1: readyD1(queue, sha),
    controlPlane: { schedules: [], deployments: [], observationErrors: [] },
    authorityBoundaryIntact: true,
    credentialBoundaryIntact: true,
  });

  assert.equal(result.checks.cloudflareAuthoritySafelyInert, false);
  assert.ok(result.blockers.some((row) => row.id === 'cloudflare_authority_not_inert'));
});
