import { sqlTextLiteral } from './d1-mirror-sync-sql.mjs';

const SHA40_RE = /^[0-9a-f]{40}$/i;

function requireText(value, name) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${name} must be a non-empty string`);
  }
  if (value.includes('\0')) {
    throw new TypeError(`${name} must not contain NUL`);
  }
  return value;
}

function requireIsoInstant(value, name) {
  requireText(value, name);
  const ms = Date.parse(value);
  if (!Number.isFinite(ms) || new Date(ms).toISOString() !== value) {
    throw new TypeError(`${name} must be an exact ISO-8601 instant`);
  }
  return value;
}

export function compileInitialPreviewAuthorityBootstrapSql({
  candidateSha,
  transitionId,
  eventAt,
} = {}) {
  if (typeof candidateSha !== 'string' || !SHA40_RE.test(candidateSha)) {
    throw new TypeError('candidateSha must be a 40-hex commit SHA');
  }
  requireText(transitionId, 'transitionId');
  requireIsoInstant(eventAt, 'eventAt');

  const sha = sqlTextLiteral(candidateSha.toLowerCase());
  const transition = sqlTextLiteral(transitionId);
  const at = sqlTextLiteral(eventAt);
  const detail = sqlTextLiteral(
    'initial preview authority bootstrap; authority intentionally unowned',
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
