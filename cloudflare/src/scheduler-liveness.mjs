// scheduler-liveness.mjs — durable scheduler observation + read-only liveness projection.
//
// This module contains no X transport and no R2 access. Heartbeat persistence is
// deliberately best-effort from the publication Worker: inability to record liveness
// evidence must never manufacture authority or silently change publication policy.

export const SCHEDULER_OBSERVATION_KEY = 'scheduler.last_observation_json';
export const DEFAULT_LIVENESS_STALE_AFTER_MS = 3 * 60 * 60 * 1000;

function failure(reason, extra = {}) {
  return {
    ok: false,
    reason,
    ...extra,
  };
}

function iso(ms) {
  return new Date(ms).toISOString();
}

function validMs(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function sanitizeResult(result) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    return null;
  }

  return {
    status: typeof result.status === 'string' ? result.status : null,
    reason: typeof result.reason === 'string' ? result.reason : null,
    dispatched: result.dispatched === true,
    selectedPostId:
      typeof result.selectedPostId === 'string'
        ? result.selectedPostId
        : null,
  };
}

export function buildSchedulerObservation({
  scheduledTimeMs,
  observedAtMs,
  phase,
  authorityEnabled,
  result = null,
}) {
  if (!validMs(scheduledTimeMs)) {
    throw new TypeError('scheduledTimeMs must be a non-negative safe integer');
  }
  if (!validMs(observedAtMs)) {
    throw new TypeError('observedAtMs must be a non-negative safe integer');
  }
  if (phase !== 'started' && phase !== 'completed') {
    throw new TypeError('phase must be started or completed');
  }

  return {
    version: 1,
    scheduledTimeMs,
    scheduledTime: iso(scheduledTimeMs),
    observedAtMs,
    observedAt: iso(observedAtMs),
    phase,
    authorityEnabled: authorityEnabled === true,
    result: sanitizeResult(result),
  };
}

export async function recordSchedulerObservation(env, input) {
  let observation;
  try {
    observation = buildSchedulerObservation(input);
  } catch {
    return failure('scheduler_observation_invalid');
  }

  try {
    const db = env?.DB;
    if (!db || typeof db.prepare !== 'function') {
      return failure('d1_binding_missing');
    }

    const text = JSON.stringify(observation);
    const statement = db.prepare(
      `
      INSERT INTO runtime_metadata (key, value, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET
        value = excluded.value,
        updated_at = excluded.updated_at
      `,
    );

    const bound =
      typeof statement.bind === 'function'
        ? statement.bind(
            SCHEDULER_OBSERVATION_KEY,
            text,
            observation.observedAt,
          )
        : statement;

    if (typeof bound.run !== 'function') {
      return failure('d1_write_unavailable');
    }

    await bound.run();

    return {
      ok: true,
      reason: null,
      observation,
    };
  } catch {
    return failure('scheduler_observation_write_failed');
  }
}

function parseObservation(raw) {
  if (typeof raw !== 'string' || raw.length === 0) {
    return failure('scheduler_observation_missing');
  }

  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    return failure('scheduler_observation_invalid_json');
  }

  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    value.version !== 1 ||
    !validMs(value.scheduledTimeMs) ||
    !validMs(value.observedAtMs) ||
    (value.phase !== 'started' && value.phase !== 'completed')
  ) {
    return failure('scheduler_observation_invalid_shape');
  }

  return {
    ok: true,
    reason: null,
    observation: value,
  };
}

export async function readSchedulerObservation(env) {
  try {
    const db = env?.DB;
    if (!db || typeof db.prepare !== 'function') {
      return failure('d1_binding_missing');
    }

    const statement = db.prepare(
      `
      SELECT value
      FROM runtime_metadata
      WHERE key = ?
      LIMIT 1
      `,
    );

    const bound =
      typeof statement.bind === 'function'
        ? statement.bind(SCHEDULER_OBSERVATION_KEY)
        : statement;

    if (typeof bound.first !== 'function') {
      return failure('d1_read_unavailable');
    }

    const row = await bound.first();
    return parseObservation(row?.value);
  } catch {
    return failure('scheduler_observation_unreachable');
  }
}

export function evaluateSchedulerLiveness(
  observationResult,
  {
    now = new Date(),
    staleAfterMs = DEFAULT_LIVENESS_STALE_AFTER_MS,
  } = {},
) {
  const nowMs = now instanceof Date ? now.getTime() : Number.NaN;
  if (!validMs(nowMs) || !validMs(staleAfterMs) || staleAfterMs === 0) {
    return failure('invalid_liveness_options', {
      status: 'unknown',
      readOnly: true,
    });
  }

  if (!observationResult?.ok || !observationResult.observation) {
    return failure(observationResult?.reason ?? 'scheduler_observation_unknown', {
      status: 'unknown',
      readOnly: true,
      ageMs: null,
      lastObservedAt: null,
      lastObservedAtMs: null,
      staleAfterMs,
    });
  }

  const observation = observationResult.observation;
  const ageMs = nowMs - observation.observedAtMs;

  if (!Number.isSafeInteger(ageMs) || ageMs < 0) {
    return failure('scheduler_observation_from_future', {
      status: 'unknown',
      readOnly: true,
      ageMs,
      lastObservedAt: observation.observedAt,
      lastObservedAtMs: observation.observedAtMs,
      staleAfterMs,
      observation,
    });
  }

  const fresh = ageMs <= staleAfterMs;

  return {
    ok: fresh,
    reason: fresh ? null : 'scheduler_heartbeat_stale',
    status: fresh ? 'fresh' : 'stale',
    readOnly: true,
    ageMs,
    staleAfterMs,
    lastObservedAt: observation.observedAt,
    lastObservedAtMs: observation.observedAtMs,
    observation,
  };
}

export async function inspectSchedulerLiveness(env, options = {}) {
  const observation = await readSchedulerObservation(env);
  return evaluateSchedulerLiveness(observation, options);
}
