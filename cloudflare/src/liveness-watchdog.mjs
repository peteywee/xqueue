// liveness-watchdog.mjs — provider-neutral scheduler liveness monitor.
//
// This Worker has no X transport, no R2 binding, and no publication imports. It reads
// the production scheduler heartbeat from D1, persists only watchdog state metadata,
// and emits provider-neutral alert/recovery signals to logs. Notification delivery is
// intentionally owner-reserved and is not selected here.

import {
  DEFAULT_LIVENESS_STALE_AFTER_MS,
  inspectSchedulerLiveness,
} from './scheduler-liveness.mjs';

export const WATCHDOG_STATE_KEY = 'scheduler.watchdog_state_json';
export const ALERT_AFTER_MS = DEFAULT_LIVENESS_STALE_AFTER_MS;
export const RENOTIFY_AFTER_MS = 12 * 60 * 60 * 1000;

function validMs(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function iso(ms) {
  return new Date(ms).toISOString();
}

function defaultState() {
  return {
    version: 1,
    condition: 'unknown',
    conditionStartedAtMs: null,
    conditionStartedAt: null,
    lastSignal: null,
    lastSignalAtMs: null,
    lastSignalAt: null,
    recoveredAtMs: null,
    recoveredAt: null,
  };
}

function normalizeState(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.version !== 1) {
    return defaultState();
  }

  return {
    ...defaultState(),
    ...value,
  };
}

async function readWatchdogState(env) {
  try {
    const db = env?.DB;
    if (!db || typeof db.prepare !== 'function') return defaultState();

    const statement = db.prepare(
      `
      SELECT value
      FROM runtime_metadata
      WHERE key = ?
      LIMIT 1
      `,
    );
    const bound = typeof statement.bind === 'function'
      ? statement.bind(WATCHDOG_STATE_KEY)
      : statement;
    const row = typeof bound.first === 'function' ? await bound.first() : null;
    if (typeof row?.value !== 'string') return defaultState();

    return normalizeState(JSON.parse(row.value));
  } catch {
    return defaultState();
  }
}

async function writeWatchdogState(env, state, nowMs) {
  try {
    const db = env?.DB;
    if (!db || typeof db.prepare !== 'function') {
      return { ok: false, reason: 'd1_binding_missing' };
    }

    const statement = db.prepare(
      `
      INSERT INTO runtime_metadata (key, value, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET
        value = excluded.value,
        updated_at = excluded.updated_at
      `,
    );
    const bound = typeof statement.bind === 'function'
      ? statement.bind(WATCHDOG_STATE_KEY, JSON.stringify(state), iso(nowMs))
      : statement;

    if (typeof bound.run !== 'function') {
      return { ok: false, reason: 'd1_write_unavailable' };
    }

    await bound.run();
    return { ok: true, reason: null };
  } catch {
    return { ok: false, reason: 'watchdog_state_write_failed' };
  }
}

export function evaluateWatchdogDecision(
  liveness,
  priorState,
  {
    now = new Date(),
    alertAfterMs = ALERT_AFTER_MS,
    renotifyAfterMs = RENOTIFY_AFTER_MS,
  } = {},
) {
  const nowMs = now instanceof Date ? now.getTime() : Number.NaN;
  if (!validMs(nowMs) || !validMs(alertAfterMs) || !validMs(renotifyAfterMs)) {
    throw new TypeError('invalid watchdog timing options');
  }

  const prior = normalizeState(priorState);

  if (liveness?.ok === true) {
    const recovered = prior.condition === 'unhealthy';
    return {
      signal: recovered ? 'recovery_due' : null,
      state: {
        ...defaultState(),
        condition: 'healthy',
        conditionStartedAtMs: null,
        conditionStartedAt: null,
        lastSignal: recovered ? 'recovery_due' : prior.lastSignal,
        lastSignalAtMs: recovered ? nowMs : prior.lastSignalAtMs,
        lastSignalAt: recovered ? iso(nowMs) : prior.lastSignalAt,
        recoveredAtMs: recovered ? nowMs : prior.recoveredAtMs,
        recoveredAt: recovered ? iso(nowMs) : prior.recoveredAt,
      },
    };
  }

  const inheritedStart =
    prior.condition === 'unhealthy' && validMs(prior.conditionStartedAtMs)
      ? prior.conditionStartedAtMs
      : null;

  const observedStart = validMs(liveness?.lastObservedAtMs)
    ? liveness.lastObservedAtMs
    : nowMs;

  const conditionStartedAtMs = inheritedStart ?? observedStart;
  const conditionAgeMs = Math.max(0, nowMs - conditionStartedAtMs);

  const lastSignalAtMs = validMs(prior.lastSignalAtMs)
    ? prior.lastSignalAtMs
    : null;

  const alertDue =
    conditionAgeMs >= alertAfterMs &&
    (
      lastSignalAtMs === null ||
      nowMs - lastSignalAtMs >= renotifyAfterMs
    );

  return {
    signal: alertDue ? 'alert_due' : null,
    state: {
      ...defaultState(),
      condition: 'unhealthy',
      conditionStartedAtMs,
      conditionStartedAt: iso(conditionStartedAtMs),
      lastSignal: alertDue ? 'alert_due' : prior.lastSignal,
      lastSignalAtMs: alertDue ? nowMs : prior.lastSignalAtMs,
      lastSignalAt: alertDue ? iso(nowMs) : prior.lastSignalAt,
      recoveredAtMs: prior.recoveredAtMs,
      recoveredAt: prior.recoveredAt,
    },
  };
}

export async function runWatchdog(env, { now = new Date() } = {}) {
  const nowMs = now instanceof Date ? now.getTime() : Number.NaN;
  if (!validMs(nowMs)) {
    return {
      ok: false,
      signal: null,
      reason: 'invalid_now',
      liveness: null,
    };
  }

  const liveness = await inspectSchedulerLiveness(env, {
    now,
    staleAfterMs: ALERT_AFTER_MS,
  });
  const priorState = await readWatchdogState(env);
  const decision = evaluateWatchdogDecision(liveness, priorState, { now });
  const persisted = await writeWatchdogState(env, decision.state, nowMs);

  return {
    ok: persisted.ok,
    signal: decision.signal,
    reason: persisted.reason,
    liveness,
    state: decision.state,
    notificationProviderConfigured: false,
  };
}

export default {
  async fetch() {
    return new Response(
      JSON.stringify({
        service: 'xqueue-liveness-watchdog',
        publicationCapability: false,
      }),
      {
        status: 200,
        headers: { 'content-type': 'application/json; charset=utf-8' },
      },
    );
  },

  async scheduled(controller, env) {
    const scheduledTimeMs = Number(controller?.scheduledTime);
    const now = validMs(scheduledTimeMs)
      ? new Date(scheduledTimeMs)
      : new Date();

    const result = await runWatchdog(env, { now });

    console.log(JSON.stringify({
      event: 'scheduler_liveness_watchdog',
      scheduledTime: controller?.scheduledTime ?? null,
      publicationCapability: false,
      result,
    }));

    return result;
  },
};
