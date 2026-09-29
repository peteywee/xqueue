import { parseProductionPublisherDeploymentId } from './production-authority-sql.mjs';
import { runIntakeMutation } from './mutation-intake-runner.mjs';

const SHA40_RE = /^[0-9a-f]{40}$/i;

function blocker(id, detail) {
  return Object.freeze({ id, detail });
}

function positiveInteger(value) {
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= 1 ? n : null;
}

function nonNegativeInteger(value) {
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
}

function authFacts(auth) {
  return {
    ok: auth?.ok === true,
    environment: auth?.environment ?? null,
    tokenType: auth?.tokenType ?? auth?.token_type ?? null,
    tokenStatus: auth?.status ?? auth?.token_status ?? null,
    d1Readable: auth?.d1Readable ?? auth?.d1?.readable ?? false,
  };
}

function candidateFacts(candidate) {
  return {
    branch: candidate?.branch ?? null,
    clean: candidate?.clean === true,
    headSha: String(candidate?.headSha ?? candidate?.head_sha ?? '').toLowerCase(),
    originMainSha: String(
      candidate?.originMainSha ?? candidate?.origin_main_sha ?? '',
    ).toLowerCase(),
  };
}

function authorityFacts(row) {
  if (!row || typeof row !== 'object') {
    return {
      owner: null,
      generation: null,
      transitionState: null,
      candidateSha: null,
      deploymentId: null,
      deploymentValid: false,
    };
  }

  const deploymentId = row.deployment_id ?? row.deploymentId ?? null;
  let deploymentValid = false;
  try {
    parseProductionPublisherDeploymentId(deploymentId);
    deploymentValid = true;
  } catch {
    deploymentValid = false;
  }

  return {
    owner: row.owner ?? null,
    generation: positiveInteger(row.generation),
    transitionState: row.transition_state ?? row.transitionState ?? null,
    candidateSha: String(
      row.candidate_sha ?? row.candidateSha ?? '',
    ).toLowerCase(),
    deploymentId,
    deploymentValid,
  };
}

export function evaluateProductionMutationPreflight({
  environment,
  auth,
  candidate,
  safety,
} = {}) {
  const blockers = [];
  const authState = authFacts(auth);
  const candidateState = candidateFacts(candidate);
  const authority = authorityFacts(safety?.authority);

  if (environment !== 'production') {
    blockers.push(blocker(
      'environment_not_production',
      'Production mutation requires explicit environment=production.',
    ));
  }

  if (
    !authState.ok ||
    authState.environment !== 'production' ||
    !['account', 'user'].includes(authState.tokenType) ||
    authState.tokenStatus !== 'active'
  ) {
    blockers.push(blocker(
      'cloudflare_auth_not_verified',
      'Typed active Cloudflare production authentication is not proven.',
    ));
  }

  if (authState.d1Readable !== true) {
    blockers.push(blocker(
      'production_d1_not_readable',
      'Production D1 read capability is not proven.',
    ));
  }

  if (candidateState.branch !== 'main') {
    blockers.push(blocker(
      'candidate_not_main',
      'Production mutation checkout must be on main.',
    ));
  }

  if (candidateState.clean !== true) {
    blockers.push(blocker(
      'candidate_dirty',
      'Production mutation checkout contains tracked changes.',
    ));
  }

  if (
    !SHA40_RE.test(candidateState.headSha) ||
    !SHA40_RE.test(candidateState.originMainSha) ||
    candidateState.headSha !== candidateState.originMainSha
  ) {
    blockers.push(blocker(
      'candidate_not_exact_main',
      'HEAD must exactly match the fetched origin/main commit.',
    ));
  }

  if (
    authority.owner !== 'cloudflare' ||
    authority.transitionState !== 'stable' ||
    authority.generation === null ||
    !SHA40_RE.test(authority.candidateSha)
  ) {
    blockers.push(blocker(
      'publication_authority_not_stable',
      'Canonical publication authority is not a readable stable Cloudflare binding.',
    ));
  }

  if (!authority.deploymentValid) {
    blockers.push(blocker(
      'publication_deployment_invalid',
      'Canonical publication authority is not bound to an exact production publisher Worker version.',
    ));
  }

  const unresolvedAttemptCount = nonNegativeInteger(
    safety?.unresolvedAttemptCount,
  );
  const activeLeaseCount = nonNegativeInteger(safety?.activeLeaseCount);

  if (unresolvedAttemptCount === null || activeLeaseCount === null) {
    blockers.push(blocker(
      'publication_safety_unreadable',
      'Publication attempt/lease safety counts are missing or invalid.',
    ));
  } else {
    if (unresolvedAttemptCount !== 0) {
      blockers.push(blocker(
        'unresolved_publication_attempt',
        'Prepared, publishing, or reconciliation-required publication state exists.',
      ));
    }
    if (activeLeaseCount !== 0) {
      blockers.push(blocker(
        'active_publication_lease',
        'An unexpired publication lease is active.',
      ));
    }
  }

  if (safety?.inflight !== null) {
    blockers.push(blocker(
      'publication_inflight',
      'The canonical runtime snapshot still contains inflight publication state.',
    ));
  }

  return Object.freeze({
    ok: blockers.length === 0,
    authority: blockers.some((item) =>
      item.id === 'publication_authority_not_stable' ||
      item.id === 'publication_deployment_invalid'
    ) ? 'unknown' : 'bound',
    blockers: Object.freeze(blockers),
    observed: Object.freeze({
      environment: environment ?? null,
      auth: Object.freeze(authState),
      candidate: Object.freeze(candidateState),
      publicationAuthority: Object.freeze(authority),
      unresolvedAttemptCount,
      activeLeaseCount,
      inflight: safety?.inflight ?? null,
    }),
  });
}

export async function runProductionIntakeMutation({
  environment,
  auth,
  candidate,
  transport,
  ...mutationArgs
}) {
  if (!transport || typeof transport.readPublicationSafety !== 'function') {
    throw new Error('production mutation transport requires readPublicationSafety()');
  }

  let safety;
  try {
    safety = await transport.readPublicationSafety();
  } catch {
    const preflight = Object.freeze({
      ok: false,
      authority: 'unknown',
      blockers: Object.freeze([
        blocker(
          'publication_safety_unreadable',
          'Canonical publication safety facts could not be read.',
        ),
      ]),
      observed: null,
    });
    return Object.freeze({
      status: 'blocked',
      phase: 'production_preflight',
      preflight,
    });
  }

  const preflight = evaluateProductionMutationPreflight({
    environment,
    auth,
    candidate,
    safety,
  });

  if (!preflight.ok) {
    return Object.freeze({
      status: 'blocked',
      phase: 'production_preflight',
      preflight,
    });
  }

  const result = await runIntakeMutation({
    ...mutationArgs,
    transport,
    authority: preflight.authority,
  });

  return Object.freeze({
    ...result,
    production_preflight: preflight,
  });
}
