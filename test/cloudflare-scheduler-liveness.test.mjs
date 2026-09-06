import test from 'node:test';
import assert from 'node:assert/strict';

import {
  evaluateSchedulerLivenessRecord,
  recordScheduledInvocation,
  schedulerLivenessConstants,
} from '../cloudflare/src/scheduler-liveness.mjs';

function heartbeatRow(observedAt, scheduledTime = 1000) {
  return {
    value: JSON.stringify({ observedAt, scheduledTime }),
    updated_at: observedAt,
  };
}

test('scheduler liveness is not required when publication authority is disabled', () => {
  const result = evaluateSchedulerLivenessRecord(null, {
    required: false,
    now: new Date('2026-09-06T12:00:00.000Z'),
  });

  assert.equal(result.ok, true);
  assert.equal(result.state, 'not_required');
});

test('missing heartbeat fails when scheduler authority is expected', () => {
  const result = evaluateSchedulerLivenessRecord(null, {
    required: true,
    now: new Date('2026-09-06T12:00:00.000Z'),
  });

  assert.equal(result.ok, false);
  assert.equal(result.state, 'missing');
});

test('heartbeat stays healthy through the bounded three-cycle window', () => {
  const result = evaluateSchedulerLivenessRecord(
    heartbeatRow('2026-09-06T11:30:00.000Z'),
    {
      required: true,
      now: new Date('2026-09-06T12:00:00.000Z'),
    },
  );

  assert.equal(schedulerLivenessConstants.expectedIntervalMinutes, 15);
  assert.equal(schedulerLivenessConstants.staleAfterMinutes, 45);
  assert.equal(result.ok, true);
  assert.equal(result.state, 'fresh');
  assert.equal(result.expectedNextAt, '2026-09-06T11:45:00.000Z');
  assert.equal(result.staleAfterAt, '2026-09-06T12:15:00.000Z');
});

test('heartbeat becomes stale after three missed 15-minute cycles', () => {
  const result = evaluateSchedulerLivenessRecord(
    heartbeatRow('2026-09-06T11:00:00.000Z'),
    {
      required: true,
      now: new Date('2026-09-06T12:00:00.000Z'),
    },
  );

  assert.equal(result.ok, false);
  assert.equal(result.state, 'stale');
  assert.equal(result.ageMinutes, 60);
});

test('malformed heartbeat fails closed', () => {
  const result = evaluateSchedulerLivenessRecord(
    { value: '{not-json', updated_at: '2026-09-06T11:59:00.000Z' },
    {
      required: true,
      now: new Date('2026-09-06T12:00:00.000Z'),
    },
  );

  assert.equal(result.ok, false);
  assert.equal(result.state, 'invalid');
});

test('scheduled invocation persists one durable heartbeat record', async () => {
  const calls = [];
  const db = {
    prepare(sql) {
      return {
        bind(...params) {
          return {
            async run() {
              calls.push({ sql, params });
              return { success: true };
            },
          };
        },
      };
    },
  };

  const result = await recordScheduledInvocation(db, {
    scheduledTime: 1788700000000,
    observedAt: new Date('2026-09-06T12:00:00.000Z'),
  });

  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /ON CONFLICT\(key\) DO UPDATE/);
  assert.equal(calls[0].params[0], 'scheduler.last_invocation');
  assert.equal(result.observedAt, '2026-09-06T12:00:00.000Z');
});
