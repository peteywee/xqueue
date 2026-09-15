const OWNERS = new Set(['local-systemd', 'cloudflare', 'none']);
const TRANSITION_STATES = new Set(['stable', 'transitioning']);
const SHA_RE = /^[0-9a-f]{40}$/i;

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function isIsoInstant(value) {
  if (!isNonEmptyString(value)) return false;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return false;
  return new Date(ms).toISOString() === value;
}

function validOwner(value, { nullable = false } = {}) {
  if (nullable && value === null) return true;
  return OWNERS.has(value);
}

function sameNullable(left, right) {
  return (left ?? null) === (right ?? null);
}

export const AUTHORITY_OWNERS = Object.freeze([
  'local-systemd',
  'cloudflare',
  'none',
]);

export const AUTHORITY_TRANSITION_STATES = Object.freeze([
  'stable',
  'transitioning',
]);

export function validateAuthorityStateRecord(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    return { ok: false, reason: 'authority_state_missing_or_invalid' };
  }

  if (record.singleton_id !== 1) {
    return { ok: false, reason: 'authority_state_invalid_singleton' };
  }

  if (!validOwner(record.owner)) {
    return { ok: false, reason: 'authority_state_invalid_owner' };
  }

  if (!Number.isSafeInteger(record.generation) || record.generation < 1) {
    return { ok: false, reason: 'authority_state_invalid_generation' };
  }

  if (!TRANSITION_STATES.has(record.transition_state)) {
    return { ok: false, reason: 'authority_state_invalid_transition_state' };
  }

  if (!isNonEmptyString(record.transition_id)) {
    return { ok: false, reason: 'authority_state_invalid_transition_id' };
  }

  if (!validOwner(record.previous_owner ?? null, { nullable: true })) {
    return { ok: false, reason: 'authority_state_invalid_previous_owner' };
  }

  if (!isNonEmptyString(record.candidate_sha) || !SHA_RE.test(record.candidate_sha)) {
    return { ok: false, reason: 'authority_state_invalid_candidate_sha' };
  }

  if (record.deployment_id !== null && record.deployment_id !== undefined && !isNonEmptyString(record.deployment_id)) {
    return { ok: false, reason: 'authority_state_invalid_deployment_id' };
  }

  if (!isIsoInstant(record.transitioned_at)) {
    return { ok: false, reason: 'authority_state_invalid_transitioned_at' };
  }

  if (!isIsoInstant(record.updated_at)) {
    return { ok: false, reason: 'authority_state_invalid_updated_at' };
  }

  if (Date.parse(record.updated_at) < Date.parse(record.transitioned_at)) {
    return { ok: false, reason: 'authority_state_update_precedes_transition' };
  }

  return { ok: true, reason: null };
}

export function validateAuthorityEventRecord(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    return { ok: false, reason: 'authority_event_missing_or_invalid' };
  }

  if (!Number.isSafeInteger(record.generation) || record.generation < 1) {
    return { ok: false, reason: 'authority_event_invalid_generation' };
  }

  if (!isNonEmptyString(record.transition_id)) {
    return { ok: false, reason: 'authority_event_invalid_transition_id' };
  }

  if (!validOwner(record.previous_owner ?? null, { nullable: true })) {
    return { ok: false, reason: 'authority_event_invalid_previous_owner' };
  }

  if (!validOwner(record.next_owner)) {
    return { ok: false, reason: 'authority_event_invalid_next_owner' };
  }

  if (!TRANSITION_STATES.has(record.transition_state)) {
    return { ok: false, reason: 'authority_event_invalid_transition_state' };
  }

  if (!isNonEmptyString(record.candidate_sha) || !SHA_RE.test(record.candidate_sha)) {
    return { ok: false, reason: 'authority_event_invalid_candidate_sha' };
  }

  if (record.deployment_id !== null && record.deployment_id !== undefined && !isNonEmptyString(record.deployment_id)) {
    return { ok: false, reason: 'authority_event_invalid_deployment_id' };
  }

  if (!isIsoInstant(record.event_at)) {
    return { ok: false, reason: 'authority_event_invalid_event_at' };
  }

  return { ok: true, reason: null };
}

export function evaluateMirrorSyncAuthority({ state, latestEvent } = {}) {
  const stateValidation = validateAuthorityStateRecord(state);
  if (!stateValidation.ok) {
    return { allowed: false, reason: stateValidation.reason };
  }

  const eventValidation = validateAuthorityEventRecord(latestEvent);
  if (!eventValidation.ok) {
    return { allowed: false, reason: eventValidation.reason };
  }

  if (state.generation !== latestEvent.generation) {
    return { allowed: false, reason: 'authority_generation_mismatch' };
  }

  if (state.transition_id !== latestEvent.transition_id) {
    return { allowed: false, reason: 'authority_transition_id_mismatch' };
  }

  if (state.owner !== latestEvent.next_owner) {
    return { allowed: false, reason: 'authority_owner_projection_mismatch' };
  }

  if (!sameNullable(state.previous_owner, latestEvent.previous_owner)) {
    return { allowed: false, reason: 'authority_previous_owner_mismatch' };
  }

  if (state.transition_state !== latestEvent.transition_state) {
    return { allowed: false, reason: 'authority_transition_state_mismatch' };
  }

  if (state.candidate_sha.toLowerCase() !== latestEvent.candidate_sha.toLowerCase()) {
    return { allowed: false, reason: 'authority_candidate_mismatch' };
  }

  if (!sameNullable(state.deployment_id, latestEvent.deployment_id)) {
    return { allowed: false, reason: 'authority_deployment_mismatch' };
  }

  if (state.transitioned_at !== latestEvent.event_at) {
    return { allowed: false, reason: 'authority_transition_time_mismatch' };
  }

  if (state.transition_state !== 'stable') {
    return { allowed: false, reason: 'authority_transition_unresolved' };
  }

  if (state.owner !== 'local-systemd') {
    return {
      allowed: false,
      reason: state.owner === 'cloudflare'
        ? 'authority_owned_by_cloudflare'
        : 'authority_unowned',
    };
  }

  return {
    allowed: true,
    reason: null,
    owner: state.owner,
    generation: state.generation,
    transitionId: state.transition_id,
    candidateSha: state.candidate_sha.toLowerCase(),
  };
}
