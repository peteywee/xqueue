import { publicationAuthorityEnabled } from './authority-config.mjs';
import { verifyQueueIntegrity } from './queue-integrity.mjs';
import { evaluateAuthorityReadiness } from './runtime-readiness.mjs';
import {
  inspectSchedulerLiveness,
  recordSchedulerObservation,
} from './scheduler-liveness.mjs';
import { runScheduledPublication } from './production-publisher.mjs';

function json(value, init = {}) {
  const headers = new Headers(init.headers);

  headers.set(
    'content-type',
    'application/json; charset=utf-8',
  );

  return new Response(
    JSON.stringify(value, null, 2),
    {
      ...init,
      headers,
    },
  );
}

async function storageHealth(env) {
  const d1 = await env.DB
    .prepare(
      `
      SELECT COUNT(*) AS count
      FROM sqlite_master
      WHERE type = 'table'
      `,
    )
    .first();

  const r2 = await env.MEDIA.list({
    limit: 1,
  });

  return {
    d1: {
      reachable: true,
      tables: Number(d1?.count ?? 0),
    },

    r2: {
      reachable: true,
      sampleObjectCount: r2.objects.length,
    },
  };
}

function scheduledMs(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0
    ? number
    : null;
}

export function schedulerAuthorityFrom(publicationAuthority, schedulerLiveness) {
  return publicationAuthority === true && schedulerLiveness?.ok === true;
}

async function recordObservation(env, {
  scheduledTimeMs,
  phase,
  authorityEnabled,
  result = null,
}) {
  if (scheduledTimeMs === null) {
    return { ok: false, reason: 'scheduled_time_invalid' };
  }

  const verdict = await recordSchedulerObservation(env, {
    scheduledTimeMs,
    observedAtMs: Date.now(),
    phase,
    authorityEnabled,
    result,
  });

  if (!verdict.ok) {
    console.error(JSON.stringify({
      event: 'scheduler_observation_write_failed',
      phase,
      reason: verdict.reason,
    }));
  }

  return verdict;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/health') {
      try {
        const storage = await storageHealth(env);
        const queueIntegrity = await verifyQueueIntegrity(env);
        const authorityReadiness = await evaluateAuthorityReadiness(env);
        const schedulerLiveness = await inspectSchedulerLiveness(env);

        const healthy = queueIntegrity.ok === true;
        const publicationAuthority =
          authorityReadiness.ok === true &&
          authorityReadiness.authorized === true;
        const schedulerAuthority = schedulerAuthorityFrom(
          publicationAuthority,
          schedulerLiveness,
        );

        return json(
          {
            service: 'xqueue',
            status: healthy ? 'ok' : 'error',

            // Backward-compatible capability signal. This says the publication path
            // is authorized/readiness-gated; it does NOT claim scheduler liveness.
            livePublication: publicationAuthority,
            publicationAuthority,

            // Scheduler authority now requires independent durable liveness evidence.
            schedulerAuthority,
            schedulerLiveness,

            queueIntegrity,
            authorityReadiness,

            storage,
          },
          healthy
            ? {}
            : { status: 503 },
        );
      } catch (error) {
        return json(
          {
            service: 'xqueue',
            status: 'error',

            livePublication: false,
            publicationAuthority: false,
            schedulerAuthority: false,
            schedulerLiveness: {
              ok: false,
              status: 'unknown',
              reason: 'health_evaluation_failed',
            },

            error:
              error instanceof Error
                ? error.message
                : String(error),
          },
          { status: 503 },
        );
      }
    }

    return json(
      { error: 'not_found' },
      { status: 404 },
    );
  },

  async scheduled(controller, env) {
    const scheduledTime = controller?.scheduledTime;
    const scheduledTimeMs = scheduledMs(scheduledTime);
    const authorityEnabled = publicationAuthorityEnabled(env);

    // Heartbeat evidence is best-effort and cannot authorize publication. Failure to
    // record it is surfaced to the watchdog/health path but does not create a second
    // publication decision system.
    await recordObservation(env, {
      scheduledTimeMs,
      phase: 'started',
      authorityEnabled,
    });

    if (!authorityEnabled) {
      const result = {
        status: 'idle',
        reason: 'authority_disabled',
        dispatched: false,
        automaticRetryAllowed: false,
      };
      const logResult =
        'ignored because Cloudflare scheduling is not authorized';

      await recordObservation(env, {
        scheduledTimeMs,
        phase: 'completed',
        authorityEnabled,
        result,
      });

      console.log(
        JSON.stringify({
          event: 'scheduled',
          scheduledTime,
          livePublication: false,
          schedulerAuthority: false,
          result: logResult,
        }),
      );

      return result;
    }

    const now = new Date(scheduledTime);

    try {
      const result = await runScheduledPublication(env, { now });

      await recordObservation(env, {
        scheduledTimeMs,
        phase: 'completed',
        authorityEnabled,
        result,
      });

      console.log(
        JSON.stringify({
          event: 'scheduled',
          scheduledTime,
          livePublication: true,
          schedulerAuthority: true,
          result,
        }),
      );

      return result;
    } catch {
      const result = {
        status: 'failed_closed',
        reason: 'scheduled_publication_unhandled_error',
        dispatched: false,
        automaticRetryAllowed: false,
      };

      await recordObservation(env, {
        scheduledTimeMs,
        phase: 'completed',
        authorityEnabled,
        result,
      });

      console.error(
        JSON.stringify({
          event: 'scheduled',
          scheduledTime,
          livePublication: true,
          schedulerAuthority: true,
          result,
        }),
      );

      return result;
    }
  },
};
