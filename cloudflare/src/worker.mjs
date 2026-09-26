import { publicationAuthorityEnabled } from './authority-config.mjs';
import { verifyDynamicRuntime } from './dynamic-runtime-integrity.mjs';
import { verifyQueueIntegrity } from './queue-integrity.mjs';
import { evaluateAuthorityReadiness } from './runtime-readiness.mjs';
import { runScheduledPublication } from './production-publisher.mjs';
import {
  readSchedulerLiveness,
  recordScheduledInvocation,
} from './scheduler-liveness.mjs';

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

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/health') {
      const schedulerLivenessRequired = publicationAuthorityEnabled(env);

      try {
        const storage = await storageHealth(env);
        const queueIntegrity = await verifyQueueIntegrity(env);
        const dynamicRuntimeReadiness = await verifyDynamicRuntime(env);
        const authorityReadiness = await evaluateAuthorityReadiness(env);
        const schedulerLiveness = await readSchedulerLiveness(env.DB, {
          required: authorityReadiness.authorityFlag === true,
          now: new Date(),
        });

        const authorityActive =
          authorityReadiness.ok === true &&
          authorityReadiness.authorized === true;
        const schedulerActive =
          authorityActive &&
          schedulerLiveness.ok === true;
        const healthy =
          dynamicRuntimeReadiness.ok === true &&
          schedulerLiveness.ok === true;

        const rollbackCompatibility = {
          ...queueIntegrity,
          authoritative: false,
          purpose: 'static-rollback-compatibility',
        };

        return json(
          {
            service: 'xqueue',
            status: healthy ? 'ok' : 'error',

            livePublication: authorityActive,
            schedulerAuthority: schedulerActive,
            schedulerLiveness,

            queueIntegrity: rollbackCompatibility,
            dynamicRuntimeReadiness: {
              ...dynamicRuntimeReadiness,
              authoritative: true,
              source: 'production-d1-r2',
            },
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
            schedulerAuthority: false,
            schedulerLiveness: {
              required: schedulerLivenessRequired,
              ok: false,
              state: 'unavailable',
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
    let heartbeatRecorded = false;

    try {
      await recordScheduledInvocation(env.DB, {
        scheduledTime,
        observedAt: new Date(),
      });
      heartbeatRecorded = true;
    } catch (error) {
      console.error(
        JSON.stringify({
          event: 'scheduler_heartbeat_failed',
          scheduledTime,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }

    if (!publicationAuthorityEnabled(env)) {
      const result = 'ignored because Cloudflare scheduling is not authorized';

      console.log(
        JSON.stringify({
          event: 'scheduled',
          scheduledTime,
          heartbeatRecorded,
          livePublication: false,
          schedulerAuthority: false,
          result,
        }),
      );

      return {
        status: 'idle',
        reason: 'authority_disabled',
        dispatched: false,
        automaticRetryAllowed: false,
      };
    }

    const now = new Date(scheduledTime);

    try {
      const result = await runScheduledPublication(env, { now });

      console.log(
        JSON.stringify({
          event: 'scheduled',
          scheduledTime,
          heartbeatRecorded,
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

      console.error(
        JSON.stringify({
          event: 'scheduled',
          scheduledTime,
          heartbeatRecorded,
          livePublication: true,
          schedulerAuthority: true,
          result,
        }),
      );

      return result;
    }
  },
};
