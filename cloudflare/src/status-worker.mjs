import { verifyDynamicRuntime } from './dynamic-runtime-integrity.mjs';
import { readGlobalPublicationHalt } from './publication-halt.mjs';
import { verifyQueueIntegrity } from './queue-integrity.mjs';
import { readSchedulerLiveness } from './scheduler-liveness.mjs';

function json(value, init = {}) {
  const headers = new Headers(init.headers);
  headers.set('content-type', 'application/json; charset=utf-8');

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

  const r2 = await env.MEDIA.list({ limit: 1 });

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

    if (url.pathname !== '/health') {
      return json({ error: 'not_found' }, { status: 404 });
    }

    try {
      const [
        storage,
        queueIntegrity,
        dynamicRuntimeReadiness,
        publicationHalt,
        schedulerLiveness,
      ] = await Promise.all([
        storageHealth(env),
        verifyQueueIntegrity(env),
        verifyDynamicRuntime(env),
        readGlobalPublicationHalt(env.DB),
        readSchedulerLiveness(env.DB, {
          required: false,
          now: new Date(),
        }),
      ]);

      const healthy =
        dynamicRuntimeReadiness.ok === true &&
        publicationHalt.ok === true;

      const rollbackCompatibility = {
        ...queueIntegrity,
        authoritative: false,
        purpose: 'static-rollback-compatibility',
      };

      return json(
        {
          service: 'xqueue',
          role: 'status-only',
          status: healthy ? 'ok' : 'error',
          publicationCapable: false,
          livePublication: false,
          schedulerAuthority: false,
          publicationHalt,
          schedulerLiveness,
          queueIntegrity: rollbackCompatibility,
          dynamicRuntimeReadiness: {
            ...dynamicRuntimeReadiness,
            authoritative: true,
            source: 'production-d1-r2',
          },
          storage,
        },
        healthy ? {} : { status: 503 },
      );
    } catch (error) {
      return json(
        {
          service: 'xqueue',
          role: 'status-only',
          status: 'error',
          publicationCapable: false,
          livePublication: false,
          schedulerAuthority: false,
          error: error instanceof Error ? error.message : String(error),
        },
        { status: 503 },
      );
    }
  },
};
