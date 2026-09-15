import {
  evaluateMirrorSyncAuthority,
  validateAuthorityEventRecord,
  validateAuthorityStateRecord,
} from '../../src/authority-ownership.mjs';

const READ_STATE_SQL = `
SELECT
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
LIMIT 1
`;

const READ_LATEST_EVENT_SQL = `
SELECT
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
LIMIT 1
`;

function firstRow(result) {
  return result?.results?.[0] ?? null;
}

function decodeState(row) {
  if (!row) return null;

  return {
    singleton_id: Number(row.singleton_id),
    owner: row.owner === null ? null : String(row.owner),
    generation: Number(row.generation),
    transition_state:
      row.transition_state === null ? null : String(row.transition_state),
    transition_id:
      row.transition_id === null ? null : String(row.transition_id),
    previous_owner:
      row.previous_owner === null ? null : String(row.previous_owner),
    candidate_sha:
      row.candidate_sha === null ? null : String(row.candidate_sha),
    deployment_id:
      row.deployment_id === null ? null : String(row.deployment_id),
    transitioned_at:
      row.transitioned_at === null ? null : String(row.transitioned_at),
    updated_at:
      row.updated_at === null ? null : String(row.updated_at),
  };
}

function decodeEvent(row) {
  if (!row) return null;

  return {
    generation: Number(row.generation),
    transition_id:
      row.transition_id === null ? null : String(row.transition_id),
    previous_owner:
      row.previous_owner === null ? null : String(row.previous_owner),
    next_owner:
      row.next_owner === null ? null : String(row.next_owner),
    transition_state:
      row.transition_state === null ? null : String(row.transition_state),
    candidate_sha:
      row.candidate_sha === null ? null : String(row.candidate_sha),
    deployment_id:
      row.deployment_id === null ? null : String(row.deployment_id),
    event_at: row.event_at === null ? null : String(row.event_at),
    detail: row.detail === null ? null : String(row.detail),
  };
}

function failure(reason, extra = {}) {
  return {
    ok: false,
    readOnly: true,
    reason,
    ...extra,
  };
}

export async function inspectAuthorityOwnership(db) {
  if (!db || typeof db.prepare !== 'function' || typeof db.batch !== 'function') {
    return failure('d1_binding_missing');
  }

  let results;
  try {
    results = await db.batch([
      db.prepare(READ_STATE_SQL),
      db.prepare(READ_LATEST_EVENT_SQL),
    ]);
  } catch {
    return failure('authority_schema_unreachable');
  }

  const state = decodeState(firstRow(results?.[0]));
  const latestEvent = decodeEvent(firstRow(results?.[1]));

  if (!state) {
    return failure('authority_state_missing', { state: null, latestEvent });
  }

  if (!latestEvent) {
    return failure('authority_event_missing', { state, latestEvent: null });
  }

  const stateValidation = validateAuthorityStateRecord(state);
  if (!stateValidation.ok) {
    return failure(stateValidation.reason, { state, latestEvent });
  }

  const eventValidation = validateAuthorityEventRecord(latestEvent);
  if (!eventValidation.ok) {
    return failure(eventValidation.reason, { state, latestEvent });
  }

  const mirrorSync = evaluateMirrorSyncAuthority({ state, latestEvent });

  const projectionCoherent =
    mirrorSync.allowed === true ||
    [
      'authority_owned_by_cloudflare',
      'authority_unowned',
      'authority_transition_unresolved',
    ].includes(mirrorSync.reason);

  if (!projectionCoherent) {
    return failure(mirrorSync.reason, { state, latestEvent, mirrorSync });
  }

  return {
    ok: true,
    readOnly: true,
    reason: null,
    state,
    latestEvent,
    mirrorSync,
  };
}
