import { verifyDynamicRuntime } from './dynamic-runtime-integrity.mjs';

function json(value, init = {}) {
  const headers = new Headers(init.headers);
  headers.set('content-type', 'application/json; charset=utf-8');
  return new Response(JSON.stringify(value, null, 2), { ...init, headers });
}

export async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)]
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('');
}

export async function observeMediaBodies(
  env,
  mediaVerdict,
  { hashBytes = sha256Hex } = {},
) {
  const objects = Array.isArray(mediaVerdict?.objects) ? mediaVerdict.objects : [];
  const observed = [];

  for (const object of objects) {
    const key = object?.r2Key;
    const expectedSize = Number(object?.expected?.byteSize);
    const expectedSha256 = String(object?.expected?.sha256 ?? '').toLowerCase();

    if (!key || !Number.isFinite(expectedSize) || !/^[0-9a-f]{64}$/.test(expectedSha256)) {
      return {
        ok: false,
        reason: 'media_evidence_malformed',
        bodyObservedCount: observed.length,
        objects: observed,
      };
    }

    let body;
    try {
      body = await env.MEDIA.get(key);
    } catch {
      return {
        ok: false,
        reason: 'r2_unreachable',
        bodyObservedCount: observed.length,
        objects: observed,
      };
    }

    if (!body || typeof body.arrayBuffer !== 'function') {
      return {
        ok: false,
        reason: 'media_missing',
        bodyObservedCount: observed.length,
        objects: observed,
      };
    }

    const bytes = await body.arrayBuffer();
    const byteSize = bytes.byteLength;
    const sha256 = await hashBytes(bytes);
    const item = {
      r2Key: key,
      byteSize,
      sha256,
      sizeMatch: byteSize === expectedSize,
      hashMatch: sha256 === expectedSha256,
    };
    observed.push(item);

    if (!item.sizeMatch || !item.hashMatch) {
      return {
        ok: false,
        reason: item.sizeMatch ? 'hash_mismatch' : 'size_mismatch',
        bodyObservedCount: observed.length,
        objects: observed,
      };
    }
  }

  return {
    ok: objects.length > 0 && observed.length === objects.length,
    reason: objects.length > 0 ? null : 'empty_required_set',
    bodyObservedCount: observed.length,
    objects: observed,
  };
}

export function createPreviewProofWorker({
  verifyRuntime = verifyDynamicRuntime,
  hashBytes = sha256Hex,
} = {}) {
  return {
    async fetch(request, env) {
      const url = new URL(request.url);
      if (url.pathname !== '/proof') {
        return json({ error: 'not_found' }, { status: 404 });
      }

      try {
        const runtime = await verifyRuntime(env, {
          verifyMedia: true,
          includeSnapshot: false,
        });

        if (!runtime.ok) {
          return json({
            service: 'xqueue-preview-proof',
            role: 'read-only-proof',
            status: 'error',
            publicationCapable: false,
            schedulerAuthority: false,
            dynamicRuntime: runtime,
            mediaBodyProof: null,
          }, { status: 503 });
        }

        const mediaBodyProof = await observeMediaBodies(env, runtime.media, { hashBytes });
        const ok = mediaBodyProof.ok === true;

        return json({
          service: 'xqueue-preview-proof',
          role: 'read-only-proof',
          status: ok ? 'ok' : 'error',
          publicationCapable: false,
          schedulerAuthority: false,
          dynamicRuntime: {
            ok: runtime.ok,
            reason: runtime.reason,
            generation: runtime.generation,
            revisionDigest: runtime.revisionDigest,
            activeAssignmentCount: runtime.activeAssignmentCount,
            approvedUnscheduledCount: runtime.approvedUnscheduledCount,
            deferredCount: runtime.deferredCount,
            mediaRequiredCount: runtime.mediaRequiredCount,
            mediaReadyCount: runtime.mediaReadyCount,
            media: {
              ok: runtime.media?.ok === true,
              requiredCount: runtime.media?.requiredCount ?? null,
              verifiedCount: runtime.media?.verifiedCount ?? null,
              failures: runtime.media?.failures ?? [],
            },
          },
          mediaBodyProof,
        }, ok ? {} : { status: 503 });
      } catch (error) {
        return json({
          service: 'xqueue-preview-proof',
          role: 'read-only-proof',
          status: 'error',
          publicationCapable: false,
          schedulerAuthority: false,
          error: error instanceof Error ? error.message : String(error),
        }, { status: 503 });
      }
  },
  };
}

export default createPreviewProofWorker();
