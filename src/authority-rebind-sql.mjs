import { sqlTextLiteral } from './d1-mirror-sync-sql.mjs';

const SHA40_RE = /^[0-9a-f]{40}$/i;

function requireText(value, name) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`${name} must be a non-empty string`);
  }
  if (value.includes('\0')) throw new TypeError(`${name} must not contain NUL`);
  return value.trim();
}

function requireSha(value, name) {
  if (typeof value !== 'string' || !SHA40_RE.test(value)) {
    throw new TypeError(`${name} must be a 40-hex commit SHA`);
  }
  return value.toLowerCase();
}

function requireGeneration(value) {
  if (!Number.isSafeInteger(value) || value < 2) {
    throw new TypeError('expectedGeneration must be an integer >= 2');
  }
  return value;
}

function requireIsoInstant(value, name) {
  const text = requireText(value, name);
  const ms = Date.parse(text);
  if (!Number.isFinite(ms) || new Date(ms).toISOString() !== text) {
    throw new TypeError(`${name} must be an exact ISO-8601 instant`);
  }
  return text;
}

export function compilePreviewLocalSystemdRebindSql({
  expectedGeneration,
  expectedCandidateSha,
  candidateSha,
  deploymentId,
  transitionId,
  eventAt,
} = {}) {
  const currentGeneration = requireGeneration(expectedGeneration);
  const nextGeneration = currentGeneration + 1;
  const previousSha = sqlTextLiteral(requireSha(expectedCandidateSha, 'expectedCandidateSha'));
  const nextSha = sqlTextLiteral(requireSha(candidateSha, 'candidateSha'));
  const deployment = sqlTextLiteral(requireText(deploymentId, 'deploymentId'));
  const transition = sqlTextLiteral(requireText(transitionId, 'transitionId'));
  const at = sqlTextLiteral(requireIsoInstant(eventAt, 'eventAt'));
  const detail = sqlTextLiteral('preview authority rebind: local-systemd -> local-systemd');

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
  'local-systemd',
  'local-systemd',
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
    AND s.owner = 'local-systemd'
    AND s.generation = ${currentGeneration}
    AND s.transition_state = 'stable'
    AND lower(s.candidate_sha) = ${previousSha}
    AND s.deployment_id = ${deployment}
    AND e.next_owner = 'local-systemd'
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
  detail;

UPDATE authority_state
SET
  owner = 'local-systemd',
  generation = ${nextGeneration},
  transition_state = 'stable',
  transition_id = ${transition},
  previous_owner = 'local-systemd',
  candidate_sha = ${nextSha},
  deployment_id = ${deployment},
  transitioned_at = ${at},
  updated_at = ${at}
WHERE changes() = 1
  AND singleton_id = 1
  AND owner = 'local-systemd'
  AND generation = ${currentGeneration}
  AND transition_state = 'stable'
  AND lower(candidate_sha) = ${previousSha}
  AND deployment_id = ${deployment}
  AND EXISTS (
    SELECT 1
    FROM authority_events
    WHERE generation = ${nextGeneration}
      AND transition_id = ${transition}
      AND previous_owner = 'local-systemd'
      AND next_owner = 'local-systemd'
      AND transition_state = 'stable'
      AND lower(candidate_sha) = ${nextSha}
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
