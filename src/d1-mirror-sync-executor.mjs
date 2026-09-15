import { evaluateMirrorSyncAuthority } from './authority-ownership.mjs';
import {
  inspectD1MirrorText,
  sha256Text,
} from './d1-mirror-sync-plan.mjs';

const ENVIRONMENTS = new Set(['production', 'preview']);
const TARGET_KEY = 'state.snapshot_json';
const SHA40_RE = /^[0-9a-f]{40}$/i;
const SHA64_RE = /^[0-9a-f]{64}$/i;

function fail(status, reason, extra = {}) {
  return {
    ok: false,
    status,
    reason,
    ...extra,
  };
}

function validCounts(value) {
  return value &&
    Number.isSafeInteger(value.posted) && value.posted >= 0 &&
    Number.isSafeInteger(value.skipped) && value.skipped >= 0 &&
    Number.isSafeInteger(value.inflight) && value.inflight >= 0;
}

function sameCounts(left, right) {
  return validCounts(left) &&
    validCounts(right) &&
    left.posted === right.posted &&
    left.skipped === right.skipped &&
    left.inflight === right.inflight;
}

function validatePlan(plan) {
  if (!plan || typeof plan !== 'object' || plan.ok !== true) {
    return 'invalid_plan';
  }

  if (!ENVIRONMENTS.has(plan.env)) return 'invalid_plan_environment';
  if (plan.targetKey !== TARGET_KEY) return 'invalid_plan_target';
  if (!['no_op', 'replace_mirror'].includes(plan.operation)) {
    return 'invalid_plan_operation';
  }

  if (
    plan.authority?.owner !== 'local-systemd' ||
    !Number.isSafeInteger(plan.authority?.generation) ||
    plan.authority.generation < 1 ||
    typeof plan.authority?.transitionId !== 'string' ||
    plan.authority.transitionId.length === 0 ||
    typeof plan.authority?.candidateSha !== 'string' ||
    !SHA40_RE.test(plan.authority.candidateSha)
  ) {
    return 'invalid_plan_authority';
  }

  if (
    typeof plan.local?.hash !== 'string' ||
    !SHA64_RE.test(plan.local.hash) ||
    !validCounts(plan.local.counts)
  ) {
    return 'invalid_plan_local_evidence';
  }

  if (
    typeof plan.expectedReadback?.hash !== 'string' ||
    !SHA64_RE.test(plan.expectedReadback.hash) ||
    !validCounts(plan.expectedReadback.counts) ||
    plan.expectedReadback.hash !== plan.local.hash ||
    !sameCounts(plan.expectedReadback.counts, plan.local.counts)
  ) {
    return 'invalid_plan_readback_evidence';
  }

  if (typeof plan.before?.exists !== 'boolean') {
    return 'invalid_plan_before_evidence';
  }

  if (plan.before.exists) {
    if (typeof plan.before.rawHash !== 'string' || !SHA64_RE.test(plan.before.rawHash)) {
      return 'invalid_plan_before_evidence';
    }
  } else if (plan.before.rawHash !== null) {
    return 'invalid_plan_before_evidence';
  }

  if (plan.operation === 'no_op') {
    if (plan.write !== null) return 'invalid_noop_write';
  } else {
    if (
      !plan.write ||
      plan.write.key !== TARGET_KEY ||
      typeof plan.write.value !== 'string'
    ) {
      return 'invalid_plan_write';
    }

    const writeEvidence = inspectD1MirrorText(plan.write.value);
    if (
      writeEvidence.valid !== true ||
      writeEvidence.hash !== plan.local.hash ||
      !sameCounts(writeEvidence.counts, plan.local.counts)
    ) {
      return 'invalid_plan_write_evidence';
    }
  }

  return null;
}

function validateTransport(transport, operation) {
  if (!transport || typeof transport !== 'object') return false;
  if (typeof transport.readAuthority !== 'function') return false;
  if (typeof transport.readMirror !== 'function') return false;
  if (operation === 'replace_mirror' && typeof transport.compareAndSetMirror !== 'function') {
    return false;
  }
  return true;
}

function authorityMatchesPlan(authority, plan) {
  return authority.allowed === true &&
    authority.owner === plan.authority.owner &&
    authority.generation === plan.authority.generation &&
    authority.transitionId === plan.authority.transitionId &&
    authority.candidateSha === plan.authority.candidateSha.toLowerCase();
}

async function readAndVerifyAuthority(transport, plan, phase) {
  let snapshot;
  try {
    snapshot = await transport.readAuthority({ env: plan.env });
  } catch {
    return fail('refused', `authority_read_failed_${phase}`);
  }

  const authority = evaluateMirrorSyncAuthority({
    state: snapshot?.state,
    latestEvent: snapshot?.latestEvent,
  });

  if (!authority.allowed) {
    return fail('refused', authority.reason, { phase, authority });
  }

  if (!authorityMatchesPlan(authority, plan)) {
    return fail('refused', 'authority_changed_since_plan', {
      phase,
      authority,
    });
  }

  return { ok: true, authority };
}

function rawMirrorEvidence(value) {
  const inspected = inspectD1MirrorText(value);
  return {
    value,
    inspected,
  };
}

function matchesPlannedBefore(current, planned) {
  if (current.inspected.exists !== planned.exists) return false;
  if (!planned.exists) return true;
  return current.inspected.rawHash === planned.rawHash;
}

function readbackMatchesPlan(readback, plan) {
  return readback.inspected.valid === true &&
    readback.inspected.hash === plan.expectedReadback.hash &&
    sameCounts(readback.inspected.counts, plan.expectedReadback.counts);
}

export async function executeD1MirrorSyncPlan({ plan, transport } = {}) {
  const planError = validatePlan(plan);
  if (planError) return fail('refused', planError);

  if (!validateTransport(transport, plan.operation)) {
    return fail('refused', 'invalid_injected_transport');
  }

  const beforeAuthority = await readAndVerifyAuthority(
    transport,
    plan,
    'before',
  );
  if (!beforeAuthority.ok) return beforeAuthority;

  let currentValue;
  try {
    currentValue = await transport.readMirror({
      env: plan.env,
      key: plan.targetKey,
    });
  } catch {
    return fail('refused', 'mirror_read_failed_before');
  }

  const current = rawMirrorEvidence(currentValue);

  if (plan.operation === 'no_op') {
    if (!readbackMatchesPlan(current, plan)) {
      return fail('refused', 'noop_plan_stale');
    }

    const afterAuthority = await readAndVerifyAuthority(
      transport,
      plan,
      'after',
    );
    if (!afterAuthority.ok) return afterAuthority;

    return {
      ok: true,
      status: 'confirmed_noop',
      reason: null,
      env: plan.env,
      key: plan.targetKey,
      authorityGeneration: plan.authority.generation,
      hash: plan.expectedReadback.hash,
      counts: plan.expectedReadback.counts,
      writeAttempted: false,
    };
  }

  if (!matchesPlannedBefore(current, plan.before)) {
    return fail('refused', 'mirror_changed_since_plan', {
      plannedBeforeRawHash: plan.before.rawHash,
      currentBeforeRawHash: current.inspected.rawHash,
      plannedBeforeExists: plan.before.exists,
      currentBeforeExists: current.inspected.exists,
    });
  }

  let writeResult = null;
  let writeReportedError = false;

  try {
    writeResult = await transport.compareAndSetMirror({
      env: plan.env,
      key: plan.targetKey,
      expected: {
        exists: current.inspected.exists,
        value: currentValue ?? null,
        rawHash: current.inspected.rawHash,
      },
      nextValue: plan.write.value,
      authority: { ...plan.authority },
    });
  } catch {
    writeReportedError = true;
  }

  let readbackValue;
  try {
    readbackValue = await transport.readMirror({
      env: plan.env,
      key: plan.targetKey,
    });
  } catch {
    return fail('indeterminate', 'readback_unavailable_after_write', {
      writeReportedError,
      writeResult,
    });
  }

  const readback = rawMirrorEvidence(readbackValue);

  if (!readbackMatchesPlan(readback, plan)) {
    return fail('indeterminate', 'readback_mismatch_after_write', {
      writeReportedError,
      writeResult,
      expectedHash: plan.expectedReadback.hash,
      actualHash: readback.inspected.hash,
      readbackValid: readback.inspected.valid,
    });
  }

  const afterAuthority = await readAndVerifyAuthority(
    transport,
    plan,
    'after',
  );
  if (!afterAuthority.ok) {
    return fail('indeterminate', 'authority_changed_during_sync', {
      authorityFailure: afterAuthority,
      writeReportedError,
      writeResult,
      readbackHash: readback.inspected.hash,
    });
  }

  return {
    ok: true,
    status: writeReportedError
      ? 'confirmed_synced_after_ambiguous_write'
      : 'confirmed_synced',
    reason: null,
    env: plan.env,
    key: plan.targetKey,
    authorityGeneration: plan.authority.generation,
    hash: readback.inspected.hash,
    counts: readback.inspected.counts,
    writeAttempted: true,
    writeReportedError,
    compareAndSetApplied:
      typeof writeResult?.applied === 'boolean' ? writeResult.applied : null,
  };
}

export function mirrorRawSha256(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') return null;
  return sha256Text(value);
}
