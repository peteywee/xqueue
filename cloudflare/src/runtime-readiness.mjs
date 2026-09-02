// runtime-readiness.mjs — read-only composition of the Cloudflare runtime lanes.
//
// This module is evidence, not publication machinery. It never writes D1/R2 and never calls X.
// It answers whether queue, mirrored ledger, media, eligibility and lease evidence are coherent.
// Publication authority is reported only when those technical gates pass AND the exact runtime
// authority flag is present; missing or malformed authority always fails closed.

import { publicationAuthorityEnabled } from './authority-config.mjs';
import { evaluateEligibility } from './eligibility.mjs';
import { verifyMediaObjects } from './media-verify.mjs';
import { inspectPublicationLease } from './publication-lease.mjs';
import { decodeBundledQueue } from './queue-integrity.mjs';
import {
  MEDIA_MANIFEST,
  MEDIA_MANIFEST_CONFIGURED,
} from '../generated/media-manifest.mjs';

const STATE_SNAPSHOT_KEY = 'state.snapshot_json';

function failure(reason, extra = {}) {
  return {
    ok: false,
    reason,
    ...extra,
  };
}

export async function readMirroredLedger(env) {
  try {
    if (!env?.DB || typeof env.DB.prepare !== 'function') {
      return failure('d1_binding_missing');
    }

    const row = await env.DB
      .prepare(
        `
        SELECT value
        FROM runtime_metadata
        WHERE key = '${STATE_SNAPSHOT_KEY}'
        LIMIT 1
        `,
      )
      .first();

    if (!row || typeof row.value !== 'string' || row.value.length === 0) {
      return failure('state_snapshot_missing');
    }

    let ledger;
    try {
      ledger = JSON.parse(row.value);
    } catch {
      return failure('state_snapshot_invalid_json');
    }

    return {
      ok: true,
      reason: null,
      ledger,
    };
  } catch {
    return failure('state_snapshot_unreachable');
  }
}

async function inspectLeaseReadOnly(env, nowMs) {
  try {
    if (!env?.DB) return failure('d1_binding_missing');
    const lease = await inspectPublicationLease(env.DB, { nowMs });
    return {
      ok: true,
      reason: null,
      lease,
    };
  } catch {
    return failure('publication_lease_schema_unavailable');
  }
}

async function inspectMediaReadOnly(env) {
  if (MEDIA_MANIFEST_CONFIGURED !== true) {
    return failure('media_manifest_not_configured', {
      configured: false,
      requiredCount: 4,
      readOnly: true,
    });
  }

  try {
    const verdict = await verifyMediaObjects(env, MEDIA_MANIFEST);
    return {
      configured: true,
      ...verdict,
    };
  } catch {
    return failure('media_verification_failed_closed', {
      configured: true,
      readOnly: true,
    });
  }
}

export async function evaluateAuthorityReadiness(env, { now = new Date() } = {}) {
  const nowMs = now instanceof Date ? now.getTime() : Number.NaN;
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
    return {
      ok: false,
      authorized: false,
      readOnly: true,
      reason: 'invalid_now',
      eligibility: null,
      media: null,
      lease: null,
      mirroredLedger: null,
    };
  }

  let queue;
  try {
    queue = decodeBundledQueue();
  } catch {
    return {
      ok: false,
      authorized: false,
      readOnly: true,
      reason: 'bundle_decode_failed',
      eligibility: null,
      media: null,
      lease: null,
      mirroredLedger: null,
    };
  }

  const mirroredLedger = await readMirroredLedger(env);
  const media = await inspectMediaReadOnly(env);
  const lease = await inspectLeaseReadOnly(env, nowMs);

  let eligibility = null;
  let eligibilityReady = false;

  if (mirroredLedger.ok) {
    eligibility = evaluateEligibility(queue, mirroredLedger.ledger, {
      now,
      graceMinutes: 20,
      maxPublications: 1,
    });

    eligibilityReady =
      eligibility.health?.ok === true &&
      eligibility.selection?.blocked !== true &&
      Array.isArray(eligibility.failures) &&
      eligibility.failures.length === 0;
  }

  const gates = {
    mirroredLedger: mirroredLedger.ok === true,
    eligibility: eligibilityReady,
    media: media.ok === true,
    leaseSchema: lease.ok === true,
  };

  const ok = Object.values(gates).every(Boolean);
  const authorityFlag = publicationAuthorityEnabled(env);
  const authorized = ok && authorityFlag;

  return {
    ok,
    authorized,
    readOnly: true,
    reason: ok
      ? (authorized ? null : 'authority_not_enabled')
      : 'authority_readiness_incomplete',
    gates,
    authorityFlag,
    mirroredLedger: {
      ok: mirroredLedger.ok,
      reason: mirroredLedger.reason,
    },
    eligibility,
    media,
    lease,
  };
}
