function requireFunction(value, name) {
  if (typeof value !== 'function') {
    throw new TypeError(`${name} must be a function`);
  }
  return value;
}

function blocked(stage, reason, extra = {}) {
  return Object.freeze({
    status: 'blocked',
    stage,
    dispatched: false,
    reason,
    ...extra,
  });
}

function reconciliationOutcome(reason, observed = null) {
  return Object.freeze({
    classification: 'needs_reconciliation',
    reason,
    automaticRetryAllowed: false,
    reconciliationRequired: true,
    observedClassification: observed?.classification ?? null,
    observedPostId: observed?.postId ?? null,
  });
}

function leaseEvidence(lease) {
  return Object.freeze({
    generation: Number.isSafeInteger(lease?.generation) ? lease.generation : null,
    acquiredAtMs: Number.isSafeInteger(lease?.acquiredAtMs) ? lease.acquiredAtMs : null,
    expiresAtMs: Number.isSafeInteger(lease?.expiresAtMs) ? lease.expiresAtMs : null,
  });
}

function selectedPost(queue, eligibility) {
  if (!eligibility?.safeToPublish) {
    return {
      ok: false,
      reason:
        eligibility?.selection?.blockReason ??
        eligibility?.failures?.[0] ??
        'not_eligible',
    };
  }

  const selected = eligibility?.selection?.selected;
  if (!Array.isArray(selected) || selected.length !== 1) {
    return { ok: false, reason: 'selection_not_exactly_one' };
  }

  if (!Array.isArray(queue)) {
    return { ok: false, reason: 'queue_unavailable' };
  }

  const matches = queue.filter((post) => post?.id === selected[0]);
  if (matches.length !== 1) {
    return { ok: false, reason: 'selected_post_not_unique' };
  }

  return { ok: true, post: matches[0] };
}

async function leaseIsCurrent(verifyLease, lease, context) {
  try {
    const result = await verifyLease(lease, context);
    if (result === true) return true;
    if (result && typeof result === 'object') {
      return result.valid === true || result.current === true;
    }
    return false;
  } catch {
    return false;
  }
}

async function releaseOwnedLease(releaseLease, lease, context) {
  try {
    const result = await releaseLease(lease, context);
    if (result === true) return true;
    if (result && typeof result === 'object') return result.released === true;
    return false;
  } catch {
    return false;
  }
}

async function persistEvidence(recordEvidence, evidence) {
  try {
    await recordEvidence(evidence);
    return true;
  } catch {
    return false;
  }
}

function dispatchPhase(error) {
  return ['pre_dispatch', 'not_dispatched', 'dispatched'].includes(error?.phase)
    ? error.phase
    : 'dispatched';
}

export async function simulatePublicationTransaction(deps, input = {}) {
  const verifyIdentity = requireFunction(deps?.verifyIdentity, 'verifyIdentity');
  const evaluateEligibility = requireFunction(deps?.evaluateEligibility, 'evaluateEligibility');
  const acquireLease = requireFunction(deps?.acquireLease, 'acquireLease');
  const verifyLease = requireFunction(deps?.verifyLease, 'verifyLease');
  const releaseLease = requireFunction(deps?.releaseLease, 'releaseLease');
  const verifyMedia = requireFunction(deps?.verifyMedia, 'verifyMedia');
  const dispatchPost = requireFunction(deps?.dispatchPost, 'dispatchPost');
  const classifyOutcome = requireFunction(deps?.classifyOutcome, 'classifyOutcome');
  const recordEvidence = requireFunction(deps?.recordEvidence, 'recordEvidence');

  try {
    const identity = await verifyIdentity(input);
    if (identity === false || identity?.ok === false || identity == null) {
      return blocked('identity', identity?.reason ?? 'identity_not_verified');
    }
  } catch {
    return blocked('identity', 'identity_verification_failed');
  }

  const eligibility = await evaluateEligibility(
    input.queue,
    input.ledger,
    input.eligibilityOptions ?? {},
  );

  const selection = selectedPost(input.queue, eligibility);
  if (!selection.ok) {
    return blocked('eligibility', selection.reason, { eligibility });
  }

  const post = selection.post;
  const acquired = await acquireLease({ post, input });
  const lease = acquired?.lease ?? acquired?.handle ?? null;

  if (!acquired?.acquired || !lease) {
    return blocked('lease', acquired?.reason ?? 'lease_not_acquired');
  }

  let media;
  try {
    media = await verifyMedia({ post, input });
  } catch {
    media = { ok: false, reason: 'media_verification_error' };
  }

  if (!media?.ok) {
    const released = await releaseOwnedLease(releaseLease, lease, {
      stage: 'media',
      post,
      input,
    });

    if (!released) {
      return Object.freeze({
        status: 'lease_cleanup_required',
        stage: 'media',
        dispatched: false,
        reason: media?.reason ?? 'media_verification_failed',
        leaseRetained: true,
      });
    }

    return blocked('media', media?.reason ?? 'media_verification_failed');
  }

  const preDispatchLeaseCurrent = await leaseIsCurrent(verifyLease, lease, {
    stage: 'pre_dispatch',
    post,
    input,
  });

  if (!preDispatchLeaseCurrent) {
    return blocked('fencing', 'lease_fenced_before_dispatch', {
      leaseRetained: true,
    });
  }

  let classified;
  try {
    const response = await dispatchPost({ post, media, input });
    classified = classifyOutcome({ phase: 'dispatched', response });
  } catch (error) {
    classified = classifyOutcome({
      phase: dispatchPhase(error),
      error,
    });
  }

  if (!classified || typeof classified.classification !== 'string') {
    classified = reconciliationOutcome('classifier_invalid_result');
  }

  // A lease can expire or be taken over while the external request is in flight.
  // Never let an X result complete a transaction under a stale generation.
  const postDispatchLeaseCurrent = await leaseIsCurrent(verifyLease, lease, {
    stage: 'post_dispatch',
    post,
    input,
  });

  if (!postDispatchLeaseCurrent) {
    classified = reconciliationOutcome('lease_fenced_after_dispatch', classified);
  }

  const evidence = Object.freeze({
    postId: post.id,
    lease: leaseEvidence(lease),
    outcome: classified,
  });

  const evidenceRecorded = await persistEvidence(recordEvidence, evidence);
  if (!evidenceRecorded) {
    return Object.freeze({
      status: 'needs_reconciliation',
      stage: 'evidence',
      dispatched: true,
      reason: 'evidence_record_failed',
      evidence,
      leaseRetained: true,
      automaticRetryAllowed: false,
    });
  }

  if (classified.classification === 'needs_reconciliation') {
    return Object.freeze({
      status: 'needs_reconciliation',
      stage: 'outcome',
      dispatched: true,
      reason: classified.reason,
      evidence,
      leaseRetained: true,
      automaticRetryAllowed: false,
    });
  }

  const released = await releaseOwnedLease(releaseLease, lease, {
    stage: 'complete',
    post,
    input,
  });

  if (!released) {
    return Object.freeze({
      status: 'lease_cleanup_required',
      stage: 'release',
      dispatched: true,
      reason: 'lease_release_failed',
      observedOutcome: classified.classification,
      evidence,
      leaseRetained: true,
      automaticRetryAllowed: false,
    });
  }

  return Object.freeze({
    status: classified.classification,
    stage: 'complete',
    dispatched: true,
    evidence,
    leaseRetained: false,
    automaticRetryAllowed: false,
  });
}
