function requireFunction(value, name) {
  if (typeof value !== 'function') throw new TypeError(`${name} must be a function`);
  return value;
}

export async function simulatePublicationTransaction(deps, input = {}) {
  const selectEligibility = requireFunction(deps?.selectEligibility, 'selectEligibility');
  const acquireLease = requireFunction(deps?.acquireLease, 'acquireLease');
  const verifyLease = requireFunction(deps?.verifyLease, 'verifyLease');
  const releaseLease = requireFunction(deps?.releaseLease, 'releaseLease');
  const verifyMedia = requireFunction(deps?.verifyMedia, 'verifyMedia');
  const dispatchPost = requireFunction(deps?.dispatchPost, 'dispatchPost');
  const classifyOutcome = requireFunction(deps?.classifyOutcome, 'classifyOutcome');
  const recordEvidence = requireFunction(deps?.recordEvidence, 'recordEvidence');

  const eligibility = await selectEligibility(input);
  if (!eligibility?.safeToPublish || !eligibility.post) {
    return Object.freeze({
      status: 'blocked',
      stage: 'eligibility',
      dispatched: false,
      reason: eligibility?.reason ?? 'not_eligible',
    });
  }

  const lease = await acquireLease({ post: eligibility.post, input });
  if (!lease?.acquired || !lease.handle) {
    return Object.freeze({
      status: 'blocked',
      stage: 'lease',
      dispatched: false,
      reason: lease?.reason ?? 'lease_not_acquired',
    });
  }

  const media = await verifyMedia({ post: eligibility.post, input });
  if (!media?.ok) {
    await releaseLease(lease.handle);
    return Object.freeze({
      status: 'blocked',
      stage: 'media',
      dispatched: false,
      reason: media?.reason ?? 'media_verification_failed',
    });
  }

  const current = await verifyLease(lease.handle);
  if (!current) {
    return Object.freeze({
      status: 'blocked',
      stage: 'fencing',
      dispatched: false,
      reason: 'lease_fenced',
    });
  }

  let classified;
  try {
    const response = await dispatchPost({ post: eligibility.post, media, input });
    classified = classifyOutcome({ phase: 'dispatched', response });
  } catch (error) {
    classified = classifyOutcome({ phase: 'dispatched', error });
  }

  const evidence = Object.freeze({
    postId: eligibility.post.id,
    lease: lease.handle,
    outcome: classified,
  });

  await recordEvidence(evidence);

  if (classified.classification === 'needs_reconciliation') {
    return Object.freeze({
      status: 'needs_reconciliation',
      stage: 'outcome',
      dispatched: true,
      evidence,
      leaseRetained: true,
    });
  }

  await releaseLease(lease.handle);

  return Object.freeze({
    status: classified.classification,
    stage: 'complete',
    dispatched: true,
    evidence,
    leaseRetained: false,
  });
}
