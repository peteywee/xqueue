import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
  ALERT_AFTER_MS,
  RENOTIFY_AFTER_MS,
  evaluateWatchdogDecision,
  runWatchdog,
} from '../cloudflare/src/liveness-watchdog.mjs';
import {
  SCHEDULER_OBSERVATION_KEY,
  buildSchedulerObservation,
  evaluateSchedulerLiveness,
  readSchedulerObservation,
  recordSchedulerObservation,
} from '../cloudflare/src/scheduler-liveness.mjs';
import worker, {
  schedulerAuthorityFrom,
} from '../cloudflare/src/worker.mjs';

function metadataDb(initial = {}) {
  const rows = new Map(Object.entries(initial));

  return {
    rows,
    prepare(sql) {
      let args = [];
      return {
        bind(...values) {
          args = values;
          return this;
        },
        async first() {
          if (/SELECT\s+value\s+FROM\s+runtime_metadata/i.test(sql)) {
            const value = rows.get(args[0]);
            return value === undefined ? null : { value };
          }
          throw new Error(`unexpected first SQL: ${sql}`);
        },
        async run() {
          if (/INSERT\s+INTO\s+runtime_metadata/i.test(sql)) {
            rows.set(args[0], args[1]);
            return { success: true };
          }
          throw new Error(`unexpected run SQL: ${sql}`);
        },
      };
    },
  };
}

function observationAt(observedAtMs, extra = {}) {
  return {
    ok: true,
    reason: null,
    observation: buildSchedulerObservation({
      scheduledTimeMs: observedAtMs,
      observedAtMs,
      phase: 'completed',
      authorityEnabled: true,
      result: {
        status: 'idle',
        reason: 'nothing_due',
        dispatched: false,
      },
      ...extra,
    }),
  };
}

test('fresh scheduler observation is liveness evidence', () => {
  const observedAtMs = Date.parse('2026-09-04T19:30:00.000Z');
  const result = evaluateSchedulerLiveness(
    observationAt(observedAtMs),
    { now: new Date('2026-09-04T20:00:00.000Z') },
  );

  assert.equal(result.ok, true);
  assert.equal(result.status, 'fresh');
  assert.equal(result.reason, null);
});

test('stale scheduler observation fails liveness without redefining authority', () => {
  const observedAtMs = Date.parse('2026-09-04T12:00:00.000Z');
  const result = evaluateSchedulerLiveness(
    observationAt(observedAtMs),
    { now: new Date('2026-09-04T16:00:00.000Z') },
  );

  assert.equal(result.ok, false);
  assert.equal(result.status, 'stale');
  assert.equal(result.reason, 'scheduler_heartbeat_stale');
  assert.equal(schedulerAuthorityFrom(true, result), false);
});

test('authority without heartbeat is never scheduler authority', () => {
  const missing = evaluateSchedulerLiveness(
    { ok: false, reason: 'scheduler_observation_missing' },
    { now: new Date('2026-09-04T16:00:00.000Z') },
  );

  assert.equal(missing.status, 'unknown');
  assert.equal(schedulerAuthorityFrom(true, missing), false);
  assert.equal(schedulerAuthorityFrom(false, { ok: true }), false);
  assert.equal(schedulerAuthorityFrom(true, { ok: true }), true);
});

test('scheduler heartbeat round-trips through runtime_metadata', async () => {
  const db = metadataDb();
  const env = { DB: db };

  const written = await recordSchedulerObservation(env, {
    scheduledTimeMs: 1_788_551_100_000,
    observedAtMs: 1_788_551_108_000,
    phase: 'completed',
    authorityEnabled: true,
    result: {
      status: 'posted',
      reason: null,
      dispatched: true,
      selectedPostId: 'A16',
    },
  });

  assert.equal(written.ok, true);
  assert.equal(db.rows.has(SCHEDULER_OBSERVATION_KEY), true);

  const read = await readSchedulerObservation(env);
  assert.equal(read.ok, true);
  assert.equal(read.observation.phase, 'completed');
  assert.equal(read.observation.result.selectedPostId, 'A16');
});

test('authority-disabled scheduled invocation still records liveness but cannot publish', async () => {
  const db = metadataDb();
  const result = await worker.scheduled(
    { scheduledTime: Date.parse('2026-09-04T20:15:00.000Z') },
    { DB: db },
  );

  assert.equal(result.status, 'idle');
  assert.equal(result.reason, 'authority_disabled');
  assert.equal(result.dispatched, false);

  const read = await readSchedulerObservation({ DB: db });
  assert.equal(read.ok, true);
  assert.equal(read.observation.phase, 'completed');
  assert.equal(read.observation.authorityEnabled, false);
  assert.equal(read.observation.result.dispatched, false);
});

test('watchdog stays silent while heartbeat is fresh', () => {
  const now = new Date('2026-09-04T20:00:00.000Z');
  const liveness = evaluateSchedulerLiveness(
    observationAt(Date.parse('2026-09-04T19:45:00.000Z')),
    { now },
  );

  const decision = evaluateWatchdogDecision(liveness, null, { now });
  assert.equal(decision.signal, null);
  assert.equal(decision.state.condition, 'healthy');
});

test('watchdog emits one alert after threshold and dedupes until renotify interval', () => {
  const now = new Date('2026-09-04T20:00:00.000Z');
  const staleObservedAt = now.getTime() - ALERT_AFTER_MS - 1;
  const liveness = evaluateSchedulerLiveness(
    observationAt(staleObservedAt),
    { now },
  );

  const first = evaluateWatchdogDecision(liveness, null, { now });
  assert.equal(first.signal, 'alert_due');
  assert.equal(first.state.condition, 'unhealthy');

  const tooSoon = evaluateWatchdogDecision(
    liveness,
    first.state,
    { now: new Date(now.getTime() + RENOTIFY_AFTER_MS - 1) },
  );
  assert.equal(tooSoon.signal, null);

  const repeated = evaluateWatchdogDecision(
    liveness,
    first.state,
    { now: new Date(now.getTime() + RENOTIFY_AFTER_MS) },
  );
  assert.equal(repeated.signal, 'alert_due');
});

test('watchdog emits exactly one recovery signal when fresh heartbeat returns', () => {
  const unhealthy = {
    version: 1,
    condition: 'unhealthy',
    conditionStartedAtMs: Date.parse('2026-09-04T12:00:00.000Z'),
    conditionStartedAt: '2026-09-04T12:00:00.000Z',
    lastSignal: 'alert_due',
    lastSignalAtMs: Date.parse('2026-09-04T15:00:00.000Z'),
    lastSignalAt: '2026-09-04T15:00:00.000Z',
    recoveredAtMs: null,
    recoveredAt: null,
  };
  const now = new Date('2026-09-04T20:00:00.000Z');
  const fresh = evaluateSchedulerLiveness(
    observationAt(Date.parse('2026-09-04T19:45:00.000Z')),
    { now },
  );

  const recovery = evaluateWatchdogDecision(fresh, unhealthy, { now });
  assert.equal(recovery.signal, 'recovery_due');
  assert.equal(recovery.state.condition, 'healthy');

  const stable = evaluateWatchdogDecision(
    fresh,
    recovery.state,
    { now: new Date('2026-09-04T20:15:00.000Z') },
  );
  assert.equal(stable.signal, null);
});

test('runWatchdog persists state but has no notification provider by design', async () => {
  const observedAtMs = Date.parse('2026-09-04T12:00:00.000Z');
  const observation = observationAt(observedAtMs).observation;
  const db = metadataDb({
    [SCHEDULER_OBSERVATION_KEY]: JSON.stringify(observation),
  });

  const result = await runWatchdog(
    { DB: db },
    { now: new Date('2026-09-04T16:00:00.000Z') },
  );

  assert.equal(result.ok, true);
  assert.equal(result.signal, 'alert_due');
  assert.equal(result.notificationProviderConfigured, false);
  assert.equal(db.rows.has('scheduler.watchdog_state_json'), true);
});

test('watchdog module is structurally disconnected from publication capability', () => {
  const source = fs.readFileSync(
    new URL('../cloudflare/src/liveness-watchdog.mjs', import.meta.url),
    'utf8',
  );

  assert.equal(source.includes("from './production-publisher.mjs'"), false);
  assert.equal(source.includes('@xdevplatform'), false);
  assert.equal(source.includes('createPostViaClient'), false);
  assert.equal(source.includes('uploadMediaBytesViaClient'), false);
  assert.equal(source.includes('env.MEDIA'), false);
});
