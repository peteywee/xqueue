import test from 'node:test';
import assert from 'node:assert/strict';

import {
  evaluateMirrorSyncAuthority,
  validateAuthorityEventRecord,
  validateAuthorityStateRecord,
} from '../src/authority-ownership.mjs';

const candidateSha = '50c19305fc37ddc933fded9d29bd47f47bffdaf5';
const transitionedAt = '2026-09-15T06:35:09.000Z';

function state(overrides = {}) {
  return {
    singleton_id: 1,
    owner: 'local-systemd',
    generation: 7,
    transition_state: 'stable',
    transition_id: 'authority-transition-7',
    previous_owner: 'cloudflare',
    candidate_sha: candidateSha,
    deployment_id: 'local-systemd@candidate-7',
    transitioned_at: transitionedAt,
    updated_at: transitionedAt,
    ...overrides,
  };
}

function event(overrides = {}) {
  return {
    generation: 7,
    transition_id: 'authority-transition-7',
    previous_owner: 'cloudflare',
    next_owner: 'local-systemd',
    transition_state: 'stable',
    candidate_sha: candidateSha,
    deployment_id: 'local-systemd@candidate-7',
    event_at: transitionedAt,
    detail: null,
    ...overrides,
  };
}

test('stable local-systemd ownership authorizes mirror sync', () => {
  assert.deepEqual(evaluateMirrorSyncAuthority({ state: state(), latestEvent: event() }), {
    allowed: true,
    reason: null,
    owner: 'local-systemd',
    generation: 7,
    transitionId: 'authority-transition-7',
    candidateSha,
  });
});

test('cloudflare ownership refuses mirror sync', () => {
  const result = evaluateMirrorSyncAuthority({
    state: state({ owner: 'cloudflare' }),
    latestEvent: event({ next_owner: 'cloudflare' }),
  });
  assert.equal(result.allowed, false);
  assert.equal(result.reason, 'authority_owned_by_cloudflare');
});

test('none ownership refuses mirror sync', () => {
  const result = evaluateMirrorSyncAuthority({
    state: state({ owner: 'none' }),
    latestEvent: event({ next_owner: 'none' }),
  });
  assert.equal(result.allowed, false);
  assert.equal(result.reason, 'authority_unowned');
});

test('transitioning ownership refuses mirror sync', () => {
  const result = evaluateMirrorSyncAuthority({
    state: state({ transition_state: 'transitioning' }),
    latestEvent: event({ transition_state: 'transitioning' }),
  });
  assert.equal(result.allowed, false);
  assert.equal(result.reason, 'authority_transition_unresolved');
});

test('unknown owner fails structural validation', () => {
  assert.deepEqual(validateAuthorityStateRecord(state({ owner: 'worker-maybe' })), {
    ok: false,
    reason: 'authority_state_invalid_owner',
  });
});

test('invalid generation fails structural validation', () => {
  assert.deepEqual(validateAuthorityStateRecord(state({ generation: 0 })), {
    ok: false,
    reason: 'authority_state_invalid_generation',
  });
});

test('missing transition id fails structural validation', () => {
  assert.deepEqual(validateAuthorityEventRecord(event({ transition_id: '' })), {
    ok: false,
    reason: 'authority_event_invalid_transition_id',
  });
});

test('invalid candidate sha fails structural validation', () => {
  assert.deepEqual(validateAuthorityStateRecord(state({ candidate_sha: 'main' })), {
    ok: false,
    reason: 'authority_state_invalid_candidate_sha',
  });
});

test('stale authority projection generation refuses mirror sync', () => {
  const result = evaluateMirrorSyncAuthority({
    state: state({ generation: 6 }),
    latestEvent: event({ generation: 7 }),
  });
  assert.equal(result.allowed, false);
  assert.equal(result.reason, 'authority_generation_mismatch');
});

test('conflicting transition identity refuses mirror sync', () => {
  const result = evaluateMirrorSyncAuthority({
    state: state(),
    latestEvent: event({ transition_id: 'authority-transition-other' }),
  });
  assert.equal(result.allowed, false);
  assert.equal(result.reason, 'authority_transition_id_mismatch');
});

test('conflicting owner projection refuses mirror sync', () => {
  const result = evaluateMirrorSyncAuthority({
    state: state(),
    latestEvent: event({ next_owner: 'cloudflare' }),
  });
  assert.equal(result.allowed, false);
  assert.equal(result.reason, 'authority_owner_projection_mismatch');
});

test('conflicting candidate evidence refuses mirror sync', () => {
  const result = evaluateMirrorSyncAuthority({
    state: state(),
    latestEvent: event({ candidate_sha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }),
  });
  assert.equal(result.allowed, false);
  assert.equal(result.reason, 'authority_candidate_mismatch');
});

test('conflicting deployment evidence refuses mirror sync', () => {
  const result = evaluateMirrorSyncAuthority({
    state: state(),
    latestEvent: event({ deployment_id: 'different-deployment' }),
  });
  assert.equal(result.allowed, false);
  assert.equal(result.reason, 'authority_deployment_mismatch');
});

test('conflicting transition time refuses mirror sync', () => {
  const result = evaluateMirrorSyncAuthority({
    state: state(),
    latestEvent: event({ event_at: '2026-09-15T06:36:09.000Z' }),
  });
  assert.equal(result.allowed, false);
  assert.equal(result.reason, 'authority_transition_time_mismatch');
});

test('updated_at cannot precede transition time', () => {
  assert.deepEqual(
    validateAuthorityStateRecord(state({ updated_at: '2026-09-15T06:34:09.000Z' })),
    { ok: false, reason: 'authority_state_update_precedes_transition' },
  );
});
