// cloudflare-publisher-worker-entry.test.mjs — executes the production cron entrypoint.
//
// Other suites check publisher-worker.mjs by its source text and drive runScheduledPublication
// directly. These tests run the scheduled() handler itself: the heartbeat is written before any
// authority decision, a disabled capability never reaches the publisher, and an exception that
// escapes the publisher becomes a fail-closed result instead of escaping the handler.

import test from 'node:test';
import assert from 'node:assert/strict';

import publisherWorker from '../cloudflare/src/publisher-worker.mjs';
import { schedulerLivenessConstants } from '../cloudflare/src/scheduler-liveness.mjs';

const SCHEDULED_TIME = Date.parse('2026-09-26T12:00:00.000Z');

function recordingDb() {
  const calls = [];
  return {
    calls,
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
}

async function captureConsole(run) {
  const original = { log: console.log, error: console.error };
  const lines = { log: [], error: [] };
  console.log = (line) => lines.log.push(line);
  console.error = (line) => lines.error.push(line);
  try {
    const result = await run();
    return { result, lines };
  } finally {
    console.log = original.log;
    console.error = original.error;
  }
}

test('a disabled capability records the heartbeat and never reaches the publisher', async () => {
  for (const value of [undefined, 'disabled', 'Enabled', 'true']) {
    const db = recordingDb();
    const env = { DB: db };
    if (value !== undefined) env.XQUEUE_PUBLISH_AUTHORITY = value;

    const { result, lines } = await captureConsole(() =>
      publisherWorker.scheduled({ scheduledTime: SCHEDULED_TIME }, env));

    assert.deepEqual(result, {
      status: 'idle',
      reason: 'authority_disabled',
      dispatched: false,
      automaticRetryAllowed: false,
    }, String(value));

    // Exactly one D1 statement: the heartbeat. Nothing else was read or written.
    assert.equal(db.calls.length, 1, String(value));
    assert.match(db.calls[0].sql, /INSERT INTO runtime_metadata/);
    assert.equal(db.calls[0].params[0], schedulerLivenessConstants.heartbeatKey);
    assert.equal(JSON.parse(db.calls[0].params[1]).scheduledTime, SCHEDULED_TIME);

    const logged = JSON.parse(lines.log.at(-1));
    assert.equal(logged.heartbeatRecorded, true);
    assert.equal(logged.livePublication, false);
    assert.equal(logged.schedulerAuthority, false);
    assert.equal(lines.error.length, 0);
  }
});

test('a heartbeat failure is reported and does not throw out of the handler', async () => {
  const env = {
    XQUEUE_PUBLISH_AUTHORITY: 'disabled',
    DB: {
      prepare() {
        throw new Error('D1 write unavailable');
      },
    },
  };

  const { result, lines } = await captureConsole(() =>
    publisherWorker.scheduled({ scheduledTime: SCHEDULED_TIME }, env));

  assert.equal(result.reason, 'authority_disabled');
  const failure = JSON.parse(lines.error[0]);
  assert.equal(failure.event, 'scheduler_heartbeat_failed');
  assert.equal(failure.error, 'D1 write unavailable');
  assert.equal(JSON.parse(lines.log.at(-1)).heartbeatRecorded, false);
});

test('an enabled capability without a valid scheduled time idles before any D1 read', async () => {
  const db = recordingDb();
  const { result } = await captureConsole(() =>
    publisherWorker.scheduled({}, { XQUEUE_PUBLISH_AUTHORITY: 'enabled', DB: db }));

  assert.equal(result.status, 'idle');
  assert.equal(result.reason, 'invalid_now');
  assert.equal(result.dispatched, false);
  assert.equal(db.calls.length, 1, 'only the heartbeat statement ran');
});

test('an exception escaping the publisher becomes a fail-closed result', async () => {
  // Fault injection: every access to the D1 binding throws, so the heartbeat fails and the
  // publisher rejects on its first D1 read. The handler must still resolve, not reject.
  const env = {
    XQUEUE_PUBLISH_AUTHORITY: 'enabled',
    get DB() {
      throw new Error('D1 binding exploded');
    },
  };

  const { result, lines } = await captureConsole(() =>
    publisherWorker.scheduled({ scheduledTime: SCHEDULED_TIME }, env));

  assert.deepEqual(result, {
    status: 'failed_closed',
    reason: 'scheduled_publication_unhandled_error',
    dispatched: false,
    automaticRetryAllowed: false,
  });

  const logged = JSON.parse(lines.error.at(-1));
  assert.equal(logged.event, 'scheduled');
  assert.equal(logged.heartbeatRecorded, false);
  assert.deepEqual(logged.result, result);
});
