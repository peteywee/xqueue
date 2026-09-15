import {
  inspectD1MirrorText,
  sha256Text,
} from './d1-mirror-sync-plan.mjs';

const TARGET_KEY = 'state.snapshot_json';
const SHA40_RE = /^[0-9a-f]{40}$/i;
const SHA64_RE = /^[0-9a-f]{64}$/i;

function assertSqlText(value, name, { allowEmpty = false } = {}) {
  if (typeof value !== 'string') {
    throw new TypeError(`${name} must be a string`);
  }
  if (!allowEmpty && value.length === 0) {
    throw new TypeError(`${name} must be non-empty`);
  }
  if (value.includes('\0')) {
    throw new TypeError(`${name} must not contain NUL`);
  }
  return value;
}

export function sqlTextLiteral(value) {
  const text = assertSqlText(value, 'SQL text', { allowEmpty: true });
  return `'${text.replaceAll("'", "''")}'`;
}

function validateAuthority(authority) {
  if (!authority || typeof authority !== 'object') {
    throw new TypeError('authority is required');
  }
  if (authority.owner !== 'local-systemd') {
    throw new TypeError('authority owner must be local-systemd');
  }
  if (!Number.isSafeInteger(authority.generation) || authority.generation < 1) {
    throw new TypeError('authority generation must be a positive safe integer');
  }
  assertSqlText(authority.transitionId, 'authority transitionId');
  if (typeof authority.candidateSha !== 'string' || !SHA40_RE.test(authority.candidateSha)) {
    throw new TypeError('authority candidateSha must be a 40-hex commit SHA');
  }
  assertSqlText(authority.deploymentId, 'authority deploymentId');
  return authority;
}

function validateTargetKey(key) {
  if (key !== TARGET_KEY) {
    throw new TypeError(`mirror key must be ${TARGET_KEY}`);
  }
  return key;
}

function authorityPredicate(authority) {
  const a = validateAuthority(authority);
  const transitionId = sqlTextLiteral(a.transitionId);
  const candidateSha = sqlTextLiteral(a.candidateSha.toLowerCase());
  const deploymentId = sqlTextLiteral(a.deploymentId);

  return `EXISTS (
    SELECT 1
    FROM authority_state AS s
    JOIN authority_events AS e
      ON e.generation = s.generation
     AND e.transition_id = s.transition_id
    WHERE s.singleton_id = 1
      AND s.owner = 'local-systemd'
      AND s.transition_state = 'stable'
      AND s.generation = ${a.generation}
      AND s.transition_id = ${transitionId}
      AND lower(s.candidate_sha) = ${candidateSha}
      AND s.deployment_id = ${deploymentId}
      AND e.generation = (SELECT MAX(generation) FROM authority_events)
      AND e.next_owner = s.owner
      AND e.transition_state = s.transition_state
      AND lower(e.candidate_sha) = lower(s.candidate_sha)
      AND e.deployment_id = s.deployment_id
      AND e.previous_owner IS s.previous_owner
      AND e.event_at = s.transitioned_at
  )`;
}

export function compileAuthorityStateReadSql() {
  return `SELECT
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
FROM authority_state
WHERE singleton_id = 1
LIMIT 1;`;
}

export function compileAuthorityLatestEventReadSql() {
  return `SELECT
  generation,
  transition_id,
  previous_owner,
  next_owner,
  transition_state,
  candidate_sha,
  deployment_id,
  event_at,
  detail
FROM authority_events
ORDER BY generation DESC
LIMIT 1;`;
}

export function compileMirrorReadSql(key = TARGET_KEY) {
  validateTargetKey(key);
  return `SELECT value, updated_at
FROM runtime_metadata
WHERE key = ${sqlTextLiteral(key)}
LIMIT 1;`;
}

export function compileMirrorCompareAndSetSql({
  key,
  expected,
  nextValue,
  authority,
} = {}) {
  validateTargetKey(key);
  validateAuthority(authority);
  assertSqlText(nextValue, 'nextValue');

  const nextEvidence = inspectD1MirrorText(nextValue);
  if (!nextEvidence.valid || nextEvidence.canonicalText !== nextValue) {
    throw new TypeError('nextValue must be a valid normalized XQueue state snapshot');
  }

  if (!expected || typeof expected !== 'object' || typeof expected.exists !== 'boolean') {
    throw new TypeError('expected mirror precondition is required');
  }

  const keyLiteral = sqlTextLiteral(key);
  const nextLiteral = sqlTextLiteral(nextValue);
  const authoritySql = authorityPredicate(authority);
  const timestampSql = `strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`;

  if (expected.exists) {
    assertSqlText(expected.value, 'expected.value', { allowEmpty: true });
    if (typeof expected.rawHash !== 'string' || !SHA64_RE.test(expected.rawHash)) {
      throw new TypeError('expected.rawHash must be a 64-hex SHA-256 digest');
    }
    if (sha256Text(expected.value) !== expected.rawHash.toLowerCase()) {
      throw new TypeError('expected.rawHash does not match expected.value');
    }

    return {
      mode: 'update_existing',
      sql: `UPDATE runtime_metadata
SET value = ${nextLiteral},
    updated_at = ${timestampSql}
WHERE key = ${keyLiteral}
  AND value = ${sqlTextLiteral(expected.value)}
  AND ${authoritySql}
RETURNING key, value, updated_at;`,
    };
  }

  if (expected.value !== null || expected.rawHash !== null) {
    throw new TypeError('missing mirror precondition must use null value/rawHash');
  }

  return {
    mode: 'insert_missing',
    sql: `INSERT INTO runtime_metadata (key, value, updated_at)
SELECT ${keyLiteral}, ${nextLiteral}, ${timestampSql}
WHERE NOT EXISTS (
  SELECT 1 FROM runtime_metadata WHERE key = ${keyLiteral}
)
  AND ${authoritySql}
ON CONFLICT(key) DO NOTHING
RETURNING key, value, updated_at;`,
  };
}
