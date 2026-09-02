import { verifyQueueIntegrity } from './queue-integrity.mjs';
import { evaluateAuthorityReadiness } from './runtime-readiness.mjs';
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

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/health') {
      try {
        const storage = await storageHealth(env);
        const queueIntegrity = await verifyQueueIntegrity(env);
        const authorityReadiness = await evaluateAuthorityReadiness(env);

        const healthy = queueIntegrity.ok === true;
        const authorityActive =
          authorityReadiness.ok === true &&
          authorityReadiness.authorized === true;

        return json(
          {
            service: 'xqueue',
            status: healthy ? 'ok' : 'error',

            livePublication: authorityActive,
            schedulerAuthority: authorityActive,

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
            schedulerAuthority: false,

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
    const now = new Date(scheduledTime);

    try {
      const result = await runScheduledPublication(env, { now });

      console.log(
        JSON.stringify({
          event: 'scheduled',
          scheduledTime,
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
          result,
        }),
      );

      return result;
    }
  },
};
