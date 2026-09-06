const HEARTBEAT_KEY = 'scheduler.last_invocation';
const EXPECTED_INTERVAL_MINUTES = 15;
const STALE_AFTER_MINUTES = 45;

const UPSERT_HEARTBEAT_SQL = `
INSERT INTO runtime_metadata (key, value, updated_at)
VALUES (?1, ?2, ?3)
ON CONFLICT(key) DO UPDATE SET
  value = excluded.value,
  updated_at = excluded.updated_at
`;

const READ_HEARTBEAT_SQL = `
SELECT value, updated_at
FROM runtime_metadata
WHERE key = ?1
LIMIT 1
`;

function asDate(value, label) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new Error(`${label} must be a valid date`);
  }
  return date;
}

export function evaluateSchedulerLivenessRecord(
  row,
  {
    now = new Date(),
    required = true,
    expectedIntervalMinutes = EXPECTED_INTERVAL_MINUTES,
    staleAfterMinutes = STALE_AFTER_MINUTES,
  } = {},
) {
  const nowDate = asDate(now, 'now');

  if (!required) {
    return Object.freeze({
      required: false,
      ok: true,
      state: 'not_required',
      lastInvocationAt: null,
      expectedNextAt: null,
      staleAfterAt: null,
      ageMinutes: null,
    });
  }

  if (!row || typeof row.value !== 'string') {
    return Object.freeze({
      required: true,
      ok: false,
      state: 'missing',
      lastInvocationAt: null,
      expectedNextAt: null,
      staleAfterAt: null,
      ageMinutes: null,
    });
  }

  let parsed;
  try {
    parsed = JSON.parse(row.value);
  } catch {
    return Object.freeze({
      required: true,
      ok: false,
      state: 'invalid',
      lastInvocationAt: null,
      expectedNextAt: null,
      staleAfterAt: null,
      ageMinutes: null,
    });
  }

  const observedAt = parsed?.observedAt ?? row.updated_at;
  const observedMs = Date.parse(observedAt);
  if (!Number.isFinite(observedMs)) {
    return Object.freeze({
      required: true,
      ok: false,
      state: 'invalid',
      lastInvocationAt: null,
      expectedNextAt: null,
      staleAfterAt: null,
      ageMinutes: null,
    });
  }

  const ageMs = nowDate.getTime() - observedMs;
  if (ageMs < -60_000) {
    return Object.freeze({
      required: true,
      ok: false,
      state: 'clock_skew',
      lastInvocationAt: new Date(observedMs).toISOString(),
      expectedNextAt: null,
      staleAfterAt: null,
      ageMinutes: ageMs / 60_000,
    });
  }

  const expectedNextMs = observedMs + expectedIntervalMinutes * 60_000;
  const staleAfterMs = observedMs + staleAfterMinutes * 60_000;
  const ok = nowDate.getTime() <= staleAfterMs;

  return Object.freeze({
    required: true,
    ok,
    state: ok ? 'fresh' : 'stale',
    lastInvocationAt: new Date(observedMs).toISOString(),
    expectedNextAt: new Date(expectedNextMs).toISOString(),
    staleAfterAt: new Date(staleAfterMs).toISOString(),
    ageMinutes: +(ageMs / 60_000).toFixed(3),
    scheduledTime: parsed?.scheduledTime ?? null,
    thresholdMinutes: staleAfterMinutes,
  });
}

export async function recordScheduledInvocation(
  db,
  {
    scheduledTime = null,
    observedAt = new Date(),
  } = {},
) {
  if (!db || typeof db.prepare !== 'function') {
    throw new Error('D1 binding DB is unavailable');
  }

  const observedDate = asDate(observedAt, 'observedAt');
  const observedIso = observedDate.toISOString();
  const value = JSON.stringify({
    scheduledTime: Number.isFinite(Number(scheduledTime)) ? Number(scheduledTime) : null,
    observedAt: observedIso,
  });

  await db
    .prepare(UPSERT_HEARTBEAT_SQL)
    .bind(HEARTBEAT_KEY, value, observedIso)
    .run();

  return Object.freeze({
    key: HEARTBEAT_KEY,
    observedAt: observedIso,
    scheduledTime: Number.isFinite(Number(scheduledTime)) ? Number(scheduledTime) : null,
  });
}

export async function readSchedulerLiveness(
  db,
  options = {},
) {
  if (!db || typeof db.prepare !== 'function') {
    throw new Error('D1 binding DB is unavailable');
  }

  const row = await db
    .prepare(READ_HEARTBEAT_SQL)
    .bind(HEARTBEAT_KEY)
    .first();

  return evaluateSchedulerLivenessRecord(row, options);
}

export const schedulerLivenessConstants = Object.freeze({
  heartbeatKey: HEARTBEAT_KEY,
  expectedIntervalMinutes: EXPECTED_INTERVAL_MINUTES,
  staleAfterMinutes: STALE_AFTER_MINUTES,
});
