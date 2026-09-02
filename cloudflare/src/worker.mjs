import { verifyQueueIntegrity } from './queue-integrity.mjs';

function json(value, init = {}) {
  const headers = new Headers(init.headers);

  headers.set(
    'content-type',
    'application/json; charset=utf-8'
  );

  return new Response(
    JSON.stringify(value, null, 2),
    {
      ...init,
      headers
    }
  );
}

async function storageHealth(env) {
  const d1 = await env.DB
    .prepare(
      `
      SELECT COUNT(*) AS count
      FROM sqlite_master
      WHERE type = 'table'
      `
    )
    .first();

  const r2 = await env.MEDIA.list({
    limit: 1
  });

  return {
    d1: {
      reachable: true,
      tables: Number(d1?.count ?? 0)
    },

    r2: {
      reachable: true,
      sampleObjectCount: r2.objects.length
    }
  };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/health') {
      try {
        const storage =
          await storageHealth(env);

        const queueIntegrity =
          await verifyQueueIntegrity(env);

        // Fail closed: an unverifiable queue is an unhealthy runtime.
        const healthy = queueIntegrity.ok === true;

        return json(
          {
            service: 'xqueue',
            status: healthy ? 'ok' : 'error',

            livePublication: false,
            schedulerAuthority: false,

            queueIntegrity,

            storage
          },
          healthy
            ? {}
            : {
                status: 503
              }
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
                : String(error)
          },
          {
            status: 503
          }
        );
      }
    }

    return json(
      {
        error: 'not_found'
      },
      {
        status: 404
      }
    );
  },

  async scheduled(controller, env, ctx) {
    console.log(
      JSON.stringify({
        event: 'scheduled',
        scheduledTime:
          controller.scheduledTime,

        livePublication: false,
        schedulerAuthority: false,

        result:
          'ignored because Cloudflare scheduling is not authorized'
      })
    );
  }
};
