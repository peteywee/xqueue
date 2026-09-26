import { sqlTextLiteral } from './d1-mirror-sync-sql.mjs';

const SHA40_RE = /^[0-9a-f]{40}$/i;
const DEPLOYMENT_RE =
  /^cloudflare-worker:xqueue-publisher-production:version:[0-9a-f-]{36}$/i;

function requireText(value, name) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`${name} must be a non-empty string`);
  }
  if (value.includes('\0')) {
    throw new TypeError(`${name} must not contain NUL`);
  }
  return value.trim();
}

function requireSha(value) {
  if (typeof value !== 'string' || !SHA40_RE.test(value)) {
    throw new TypeError('candidateSha must be a 40-hex commit SHA');
  }
  return value.toLowerCase();
}

function requireIsoInstant(value, name) {
  const text = requireText(value, name);
  const ms = Date.parse(text);
  if (!Number.isFinite(ms) || new Date(ms).toISOString() !== text) {
    throw new TypeError(`${name} must be an exact ISO-8601 instant`);
  }
  return text;
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
  detail;

INSERT INTO authority_state (
  singleton_id,
  owner,
  generation,
  transition_state,
  transition_id,
  previous_owner,
  candidate_sha,
  deployment_id,
  transitioned_at,
  updated_at
)
SELECT
  1,
  'none',
  1,
  'stable',
  ${transition},
  NULL,
  ${sha},
  NULL,
  ${at},
  ${at}
WHERE changes() = 1
  AND NOT EXISTS (SELECT 1 FROM authority_state)
  AND EXISTS (
    SELECT 1
    FROM authority_events
    WHERE generation = 1
      AND transition_id = ${transition}
      AND previous_owner IS NULL
      AND next_owner = 'none'
      AND transition_state = 'stable'
      AND lower(candidate_sha) = ${sha}
      AND deployment_id IS NULL
      AND event_at = ${at}
  )
RETURNING
  singleton_id,
  owner,
  generation,
  transition_state,
  transition_id,
  previous_owner,
  candidate_sha,
  deployment_id,
  transitioned_at,
  updated_at;`;
}

export function compileProductionNoneToCloudflareSql({
  candidateSha,
  deploymentId,
  transitionId,
  eventAt,
} = {}) {
  const sha = sqlTextLiteral(requireSha(candidateSha));
  const deploymentText = requireText(deploymentId, 'deploymentId');
  if (!DEPLOYMENT_RE.test(deploymentText)) {
    throw new TypeError(
      'deploymentId must identify xqueue-publisher-production exact Worker version',
    );
  }
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
  detail;

UPDATE authority_state
SET
  owner = 'cloudflare',
  generation = 2,
  transition_state = 'stable',
  transition_id = ${transition},
  previous_owner = 'none',
  candidate_sha = ${sha},
  deployment_id = ${deployment},
  transitioned_at = ${at},
  updated_at = ${at}
WHERE changes() = 1
  AND singleton_id = 1
  AND owner = 'none'
  AND generation = 1
  AND transition_state = 'stable'
  AND previous_owner IS NULL
  AND deployment_id IS NULL
  AND EXISTS (
    SELECT 1
    FROM authority_events
    WHERE generation = 2
      AND transition_id = ${transition}
      AND previous_owner = 'none'
      AND next_owner = 'cloudflare'
      AND transition_state = 'stable'
      AND lower(candidate_sha) = ${sha}
      AND deployment_id = ${deployment}
      AND event_at = ${at}
  )
RETURNING
  singleton_id,
  owner,
  generation,
  transition_state,
  transition_id,
  previous_owner,
  candidate_sha,
  deployment_id,
  transitioned_at,
  updated_at;`;
}
