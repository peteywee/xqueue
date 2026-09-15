import { createHash } from 'node:crypto';

import { evaluateMirrorSyncAuthority } from './authority-ownership.mjs';
import { normalizeState } from './state-store.mjs';

const TARGET_KEY = 'state.snapshot_json';
const ENVIRONMENTS = new Set(['production', 'preview']);

export function sha256Text(text) {
  return createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');
}

function canonicalState(state) {
  return `${JSON.stringify(state, null, 2)}\n`;
}

function counts(state) {
  return {
    posted: Object.keys(state.posted).length,
    skipped: Object.keys(state.skipped).length,
    inflight: state.inflight === null ? 0 : 1,
  };
}

function invalid(reason, extra = {}) {
  return { ok: false, reason, ...extra };
}

export function inspectD1MirrorText(text) {
  if (text === null || text === undefined) {
    return {
      exists: false,
      rawHash: null,
      valid: false,
      reason: 'mirror_missing',
      normalized: null,
      canonicalText: null,
      hash: null,
      counts: null,
    };
  }

  if (typeof text !== 'string' || text.length === 0) {
    return {
      exists: true,
      rawHash: typeof text === 'string' ? sha256Text(text) : null,
      valid: false,
      reason: 'mirror_invalid_text',
      normalized: null,
      canonicalText: null,
      hash: null,
      counts: null,
    };
  }

  const rawHash = sha256Text(text);

  try {
    const parsed = JSON.parse(text);
    const normalized = normalizeState(parsed);
    const canonicalText = canonicalState(normalized);
    return {
      exists: true,
      rawHash,
      valid: true,
      reason: null,
      normalized,
      canonicalText,
      hash: sha256Text(canonicalText),
      counts: counts(normalized),
    };
  } catch {
    return {
      exists: true,
      rawHash,
      valid: false,
      reason: 'mirror_invalid_state',
      normalized: null,
      canonicalText: null,
      hash: null,
      counts: null,
    };
  }
}

export function compileD1MirrorSyncPlan({
  env,
  localState,
  authorityState,
  latestAuthorityEvent,
  currentMirrorText = null,
} = {}) {
  if (!ENVIRONMENTS.has(env)) return invalid('explicit_environment_required');

  let normalizedLocal;
  try {
    normalizedLocal = normalizeState(localState);
  } catch {
    return invalid('local_state_invalid');
  }

  if (normalizedLocal.inflight !== null) {
    return invalid(
      normalizedLocal.inflight.status === 'needs_reconciliation'
        ? 'local_state_needs_reconciliation'
        : 'local_state_inflight',
      {
        postId: normalizedLocal.inflight.postId,
        status: normalizedLocal.inflight.status,
      },
    );
  }

  const authority = evaluateMirrorSyncAuthority({
    state: authorityState,
    latestEvent: latestAuthorityEvent,
  });
  if (!authority.allowed) return invalid(authority.reason, { authority });

  const canonicalText = canonicalState(normalizedLocal);
  const localHash = sha256Text(canonicalText);
  const before = inspectD1MirrorText(currentMirrorText);
  const afterCounts = counts(normalizedLocal);

  // A no-op requires exact canonical bytes, not merely semantically equivalent JSON.
  // This keeps the mirror converged to one deterministic representation and makes
  // exact readback evidence meaningful.
  const noOp = before.valid === true && currentMirrorText === canonicalText;

  return {
    ok: true,
    reason: null,
    operation: noOp ? 'no_op' : 'replace_mirror',
    env,
    targetKey: TARGET_KEY,
    authority: {
      owner: authority.owner,
      generation: authority.generation,
      transitionId: authority.transitionId,
      candidateSha: authority.candidateSha,
      deploymentId: authority.deploymentId,
    },
    local: {
      hash: localHash,
      counts: afterCounts,
    },
    before: {
      exists: before.exists,
      rawHash: before.rawHash,
      valid: before.valid,
      reason: before.reason,
      hash: before.hash,
      counts: before.counts,
    },
    expectedReadback: {
      hash: localHash,
      counts: afterCounts,
    },
    write: noOp
      ? null
      : {
          key: TARGET_KEY,
          value: canonicalText,
        },
  };
}
