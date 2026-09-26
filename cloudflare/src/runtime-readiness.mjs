// runtime-readiness.mjs — read-only composition of canonical D1/R2 runtime lanes.
//
// This module never writes D1/R2 and never calls X. After the #46 cutover,
// production queue/content/assignment/media readiness is derived from the
// verified durable runtime snapshot. Generated static artifacts are rollback
// compatibility evidence only and are not publication-authority inputs.

import { publicationAuthorityEnabled } from './authority-config.mjs';
import {
  publicationQueueFromSnapshot,
  verifyDynamicRuntime,
} from './dynamic-runtime-integrity.mjs';
import { evaluateEligibility } from './eligibility.mjs';
import { inspectPublicationLease } from './publication-lease.mjs';

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

export async function evaluateAuthorityReadiness(
  env,
  {
    now = new Date(),
    dependencies = {},
  } = {},
) {
  const nowMs = now instanceof Date ? now.getTime() : Number.NaN;
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
    return {
      ok: false,
      authorized: false,
      readOnly: true,
      reason: 'invalid_now',
      gates: null,
      authorityFlag: publicationAuthorityEnabled(env),
      eligibility: null,
      media: null,
      lease: null,
      mirroredLedger: null,
      dynamicRuntime: null,
    };
  }

  const verifyRuntime =
    dependencies.verifyDynamicRuntime ?? verifyDynamicRuntime;
  const buildQueue =
    dependencies.publicationQueueFromSnapshot ?? publicationQueueFromSnapshot;

  const [mirroredLedger, lease, dynamicRuntime] = await Promise.all([
    readMirroredLedger(env),
    inspectLeaseReadOnly(env, nowMs),
    verifyRuntime(env),
  ]);

  let queue = null;
  let eligibility = null;
  let eligibilityReady = false;

  if (dynamicRuntime?.ok === true && dynamicRuntime?.snapshot) {
    try {
      queue = buildQueue(dynamicRuntime.snapshot);
    } catch {
      queue = null;
    }
  }

  if (queue && mirroredLedger.ok) {
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

  const mediaReady =
    dynamicRuntime?.ok === true &&
    dynamicRuntime?.media?.ok === true;

  const gates = {
    dynamicRuntime: dynamicRuntime?.ok === true,
    mirroredLedger: mirroredLedger.ok === true,
    eligibility: eligibilityReady,
    media: mediaReady,
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
    dynamicRuntime: {
      ok: dynamicRuntime?.ok === true,
      reason: dynamicRuntime?.reason ?? null,
      generation: dynamicRuntime?.generation ?? null,
      revisionDigest: dynamicRuntime?.revisionDigest ?? null,
    },
    eligibility,
    media: dynamicRuntime?.media ?? null,
    lease,
  };
}
