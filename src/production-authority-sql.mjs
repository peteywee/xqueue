import { sqlTextLiteral } from './d1-mirror-sync-sql.mjs';

const SHA40_RE = /^[0-9a-f]{40}$/i;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEPLOYMENT_PREFIX =
  'cloudflare-worker:xqueue-publisher-production:version:';
const LOCAL_DEPLOYMENT_RE =
  /^systemd-user:xqueue\.service:sha256:[0-9a-f]{64}$/i;

function requireText(value, name) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`${name} must be a non-empty string`);
  }
  if (value.includes('\0')) {
    throw new TypeError(`${name} must not contain NUL`);
  }
  return value.trim();
}

function requireSha(value, name = 'candidateSha') {
  if (typeof value !== 'string' || !SHA40_RE.test(value)) {
    throw new TypeError(`${name} must be a 40-hex commit SHA`);
  }
  return value.toLowerCase();
}

function requireGeneration(value, name = 'expectedGeneration') {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) {
    throw new TypeError(`${name} must be a positive integer`);
  }
  return number;
}

function requireIsoInstant(value, name) {
  const text = requireText(value, name);
  const ms = Date.parse(text);
  if (!Number.isFinite(ms) || new Date(ms).toISOString() !== text) {
    throw new TypeError(`${name} must be an exact ISO-8601 instant`);
  }
  return text;
}

export function parseProductionPublisherDeploymentId(value, name = 'deploymentId') {
  const text = requireText(value, name);
  if (!text.startsWith(DEPLOYMENT_PREFIX)) {
    throw new TypeError(
      `${name} must identify xqueue-publisher-production exact Worker version`,
    );
  }
  const versionId = text.slice(DEPLOYMENT_PREFIX.length);
  if (!UUID_RE.test(versionId)) {
    throw new TypeError(
      `${name} must identify xqueue-publisher-production exact Worker version`,
    );
  }
  return Object.freeze({ deploymentId: text, versionId: versionId.toLowerCase() });
}

export function productionPublisherDeploymentId(versionId) {
  const normalized = requireText(versionId, 'versionId').toLowerCase();
  if (!UUID_RE.test(normalized)) {
    throw new TypeError('versionId must be an exact Worker version UUID');
  }
  return DEPLOYMENT_PREFIX + normalized;
}

export function parseProductionLocalDeploymentId(
  value,
  name = 'deploymentId',
) {
  const text = requireText(value, name);
  if (!LOCAL_DEPLOYMENT_RE.test(text)) {
    throw new TypeError(
      `${name} must identify exact xqueue.service systemd deployment`,
    );
  }
  return text.toLowerCase();
}

function deploymentForOwner(owner, value, name) {
  if (owner === 'cloudflare') {
    return parseProductionPublisherDeploymentId(value, name).deploymentId;
  }
  if (owner === 'local-systemd') {
    return parseProductionLocalDeploymentId(value, name);
  }
  throw new TypeError('owner transition supports cloudflare or local-systemd only');
}

export function compileProductionAuthorityBootstrapSql({
  candidateSha,
  transitionId,
  eventAt,
} = {}) {
  const sha = sqlTextLiteral(requireSha(candidateSha));
  const transition = sqlTextLiteral(requireText(transitionId, 'transitionId'));
  const at = sqlTextLiteral(requireIsoInstant(eventAt, 'eventAt'));
  const detail = sqlTextLiteral(
    'initial production authority bootstrap; authority intentionally unowned',
  );

  return `INSERT INTO authority_events (
  generation,
  transition_id,
  previous_owner,
  next_owner,
  transition_state,
  candidate_sha,
  deployment_id,
  event_at,
  detail
)
SELECT
  1,
  ${transition},
  NULL,
  'none',
  'stable',
  ${sha},
  NULL,
  ${at},
  ${detail}
WHERE NOT EXISTS (SELECT 1 FROM authority_state)
  AND NOT EXISTS (SELECT 1 FROM authority_events)
RETURNING
  generation,
  transition_id,
  previous_owner,
  next_owner,
  transition_state,
  candidate_sha,
  deployment_id,
  event_at,
  detail;`;
}

export function compileProductionNoneToCloudflareSql({
  candidateSha,
  deploymentId,
  transitionId,
  eventAt,
} = {}) {
  const sha = sqlTextLiteral(requireSha(candidateSha));
  const deploymentText =
    parseProductionPublisherDeploymentId(deploymentId).deploymentId;
  const deployment = sqlTextLiteral(deploymentText);
  const transition = sqlTextLiteral(requireText(transitionId, 'transitionId'));
  const at = sqlTextLiteral(requireIsoInstant(eventAt, 'eventAt'));
  const detail = sqlTextLiteral(
    'production authority transfer: none -> cloudflare',
  );

  return `INSERT INTO authority_events (
  generation,
  transition_id,
  previous_owner,
  next_owner,
  transition_state,
  candidate_sha,
  deployment_id,
  event_at,
  detail
)
SELECT
  2,
  ${transition},
  'none',
  'cloudflare',
  'stable',
  ${sha},
  ${deployment},
  ${at},
  ${detail}
WHERE EXISTS (
  SELECT 1
  FROM authority_state s
  JOIN authority_events e
    ON e.generation = s.generation
   AND e.transition_id = s.transition_id
  WHERE s.singleton_id = 1
    AND s.owner = 'none'
    AND s.generation = 1
    AND s.transition_state = 'stable'
    AND s.previous_owner IS NULL
    AND lower(s.candidate_sha) = ${sha}
    AND s.deployment_id IS NULL
    AND e.previous_owner IS NULL
    AND e.next_owner = 'none'
    AND e.transition_state = 'stable'
    AND lower(e.candidate_sha) = lower(s.candidate_sha)
    AND e.deployment_id IS NULL
    AND e.event_at = s.transitioned_at
)
  AND NOT EXISTS (SELECT 1 FROM authority_events WHERE generation >= 2)
RETURNING
  generation,
  transition_id,
  previous_owner,
  next_owner,
  transition_state,
  candidate_sha,
  deployment_id,
  event_at,
  detail;`;
}

export function compileProductionCloudflareRebindSql({
  candidateSha,
  deploymentId,
  previousCandidateSha,
  previousDeploymentId,
  expectedGeneration,
  transitionId,
  eventAt,
} = {}) {
  const sha = sqlTextLiteral(requireSha(candidateSha));
  const previousSha = sqlTextLiteral(
    requireSha(previousCandidateSha, 'previousCandidateSha'),
  );
  const deploymentText =
    parseProductionPublisherDeploymentId(deploymentId).deploymentId;
  const previousDeploymentText =
    parseProductionPublisherDeploymentId(
      previousDeploymentId,
      'previousDeploymentId',
    ).deploymentId;
  if (deploymentText === previousDeploymentText) {
    throw new TypeError('deploymentId must differ from previousDeploymentId');
  }

  const generation = requireGeneration(expectedGeneration);
  if (generation < 2) {
    throw new TypeError('expectedGeneration must be >= 2 for Cloudflare rebind');
  }
  const nextGeneration = generation + 1;

  const deployment = sqlTextLiteral(deploymentText);
  const previousDeployment = sqlTextLiteral(previousDeploymentText);
  const transition = sqlTextLiteral(requireText(transitionId, 'transitionId'));
  const at = sqlTextLiteral(requireIsoInstant(eventAt, 'eventAt'));
  const detail = sqlTextLiteral(
    'production authority deployment rebind: cloudflare -> cloudflare',
  );

  return `INSERT INTO authority_events (
  generation,
  transition_id,
  previous_owner,
  next_owner,
  transition_state,
  candidate_sha,
  deployment_id,
  event_at,
  detail
)
SELECT
  ${nextGeneration},
  ${transition},
  'cloudflare',
  'cloudflare',
  'stable',
  ${sha},
  ${deployment},
  ${at},
  ${detail}
WHERE EXISTS (
  SELECT 1
  FROM authority_state s
  JOIN authority_events e
    ON e.generation = s.generation
   AND e.transition_id = s.transition_id
  WHERE s.singleton_id = 1
    AND s.owner = 'cloudflare'
    AND s.generation = ${generation}
    AND s.transition_state = 'stable'
    AND lower(s.candidate_sha) = ${previousSha}
    AND s.deployment_id = ${previousDeployment}
    AND e.generation = s.generation
    AND e.next_owner = 'cloudflare'
    AND e.transition_state = 'stable'
    AND lower(e.candidate_sha) = lower(s.candidate_sha)
    AND e.deployment_id = s.deployment_id
    AND e.event_at = s.transitioned_at
)
  AND NOT EXISTS (
    SELECT 1 FROM authority_events WHERE generation >= ${nextGeneration}
  )
RETURNING
  generation,
  transition_id,
  previous_owner,
  next_owner,
  transition_state,
  candidate_sha,
  deployment_id,
  event_at,
  detail;`;
}


export function compileProductionOwnerTransitionSql({
  previousOwner,
  nextOwner,
  previousCandidateSha,
  candidateSha,
  previousDeploymentId,
  deploymentId,
  expectedGeneration,
  transitionId,
  eventAt,
} = {}) {
  if (
    !['cloudflare', 'local-systemd'].includes(previousOwner) ||
    !['cloudflare', 'local-systemd'].includes(nextOwner) ||
    previousOwner === nextOwner
  ) {
    throw new TypeError(
      'owner transition must change between cloudflare and local-systemd',
    );
  }

  const generation = requireGeneration(expectedGeneration);
  const nextGeneration = generation + 1;
  const previousSha = sqlTextLiteral(
    requireSha(previousCandidateSha, 'previousCandidateSha'),
  );
  const nextSha = sqlTextLiteral(requireSha(candidateSha));
  const previousDeploymentText = deploymentForOwner(
    previousOwner,
    previousDeploymentId,
    'previousDeploymentId',
  );
  const deploymentText = deploymentForOwner(
    nextOwner,
    deploymentId,
    'deploymentId',
  );
  const previousDeployment = sqlTextLiteral(previousDeploymentText);
  const deployment = sqlTextLiteral(deploymentText);
  const transition = sqlTextLiteral(requireText(transitionId, 'transitionId'));
  const at = sqlTextLiteral(requireIsoInstant(eventAt, 'eventAt'));
  const detail = sqlTextLiteral(
    `production authority transition: ${previousOwner} -> ${nextOwner}`,
  );

  return `INSERT INTO authority_events (
  generation,
  transition_id,
  previous_owner,
  next_owner,
  transition_state,
  candidate_sha,
  deployment_id,
  event_at,
  detail
)
SELECT
  ${nextGeneration},
  ${transition},
  ${sqlTextLiteral(previousOwner)},
  ${sqlTextLiteral(nextOwner)},
  'stable',
  ${nextSha},
  ${deployment},
  ${at},
  ${detail}
WHERE EXISTS (
  SELECT 1
  FROM authority_state s
  JOIN authority_events e
    ON e.generation = s.generation
   AND e.transition_id = s.transition_id
  WHERE s.singleton_id = 1
    AND s.owner = ${sqlTextLiteral(previousOwner)}
    AND s.generation = ${generation}
    AND s.transition_state = 'stable'
    AND lower(s.candidate_sha) = ${previousSha}
    AND s.deployment_id = ${previousDeployment}
    AND e.generation = s.generation
    AND e.next_owner = s.owner
    AND e.transition_state = 'stable'
    AND lower(e.candidate_sha) = lower(s.candidate_sha)
    AND e.deployment_id = s.deployment_id
    AND e.event_at = s.transitioned_at
)
  AND NOT EXISTS (
    SELECT 1 FROM authority_events WHERE generation >= ${nextGeneration}
  )
RETURNING
  generation,
  transition_id,
  previous_owner,
  next_owner,
  transition_state,
  candidate_sha,
  deployment_id,
  event_at,
  detail;`;
}
