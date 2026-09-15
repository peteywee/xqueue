import test from 'node:test';
import assert from 'node:assert/strict';

import { inspectAuthorityOwnership } from '../cloudflare/src/authority-ownership-read.mjs';

const candidateSha = '50c19305fc37ddc933fded9d29bd47f47bffdaf5';
const at = '2026-09-15T06:35:09.000Z';

function stateRow(overrides = {}) {
  return {
    singleton_id: 1,
    owner: 'local-systemd',
    generation: 11,
    transition_state: 'stable',
    transition_id: 'transition-11',
    previous_owner: 'cloudflare',
    candidate_sha: candidateSha,
    deployment_id: 'local-systemd@11',
    transitioned_at: at,
    updated_at: at,
    ...overrides,
  };
}

function eventRow(overrides = {}) {
  return {
    generation: 11,
    transition_id: 'transition-11',
    previous_owner: 'cloudflare',
    next_owner: 'local-systemd',
    transition_state: 'stable',
    candidate_sha: candidateSha,
    deployment_id: 'local-systemd@11',
    event_at: at,
    detail: null,
    ...overrides,
  };
}

function mockDb({ state = stateRow(), event = eventRow(), throwBatch = false } = {}) {
  const prepared = [];

  return {
    prepared,
    prepare(sql) {
      const statement = { sql };
      prepared.push(statement);
      return statement;
    },
    async batch(statements) {
      if (throwBatch) throw new Error('simulated D1 failure');
      assert.equal(statements.length, 2);
      assert.match(statements[0].sql, /FROM authority_state/);
      assert.match(statements[1].sql, /FROM authority_events/);
      return [
        { results: state ? [state] : [] },
        { results: event ? [event] : [] },
      ];
    },
  };
}

test('read-only inspector authorizes mirror sync only for coherent local ownership', async () => {
  const db = mockDb();
  const result = await inspectAuthorityOwnership(db);

  assert.equal(result.ok, true);
  assert.equal(result.readOnly, true);
  assert.equal(result.state.owner, 'local-systemd');
  assert.equal(result.mirrorSync.allowed, true);
  assert.equal(result.mirrorSync.generation, 11);
  assert.equal(db.prepared.length, 2);
  assert.ok(db.prepared.every(({ sql }) => /^\s*SELECT\b/i.test(sql)));
});

test('coherent Cloudflare ownership is readable but refuses mirror sync', async () => {
  const result = await inspectAuthorityOwnership(mockDb({
    state: stateRow({ owner: 'cloudflare' }),
    event: eventRow({ next_owner: 'cloudflare' }),
  }));

  assert.equal(result.ok, true);
  assert.equal(result.mirrorSync.allowed, false);
  assert.equal(result.mirrorSync.reason, 'authority_owned_by_cloudflare');
});

test('coherent none ownership is readable but refuses mirror sync', async () => {
  const result = await inspectAuthorityOwnership(mockDb({
    state: stateRow({ owner: 'none' }),
    event: eventRow({ next_owner: 'none' }),
  }));

  assert.equal(result.ok, true);
  assert.equal(result.mirrorSync.allowed, false);
  assert.equal(result.mirrorSync.reason, 'authority_unowned');
});

test('transitioning ownership is readable but refuses mirror sync', async () => {
  const result = await inspectAuthorityOwnership(mockDb({
    state: stateRow({ transition_state: 'transitioning' }),
    event: eventRow({ transition_state: 'transitioning' }),
  }));

  assert.equal(result.ok, true);
  assert.equal(result.mirrorSync.allowed, false);
  assert.equal(result.mirrorSync.reason, 'authority_transition_unresolved');
});

test('missing authority state fails closed', async () => {
  const result = await inspectAuthorityOwnership(mockDb({ state: null }));
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'authority_state_missing');
});

test('missing authority event fails closed', async () => {
  const result = await inspectAuthorityOwnership(mockDb({ event: null }));
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'authority_event_missing');
});

test('stale generation mismatch fails closed', async () => {
  const result = await inspectAuthorityOwnership(mockDb({
    state: stateRow({ generation: 10 }),
    event: eventRow({ generation: 11 }),
  }));

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'authority_generation_mismatch');
});

test('conflicting owner projection fails closed', async () => {
  const result = await inspectAuthorityOwnership(mockDb({
    state: stateRow({ owner: 'local-systemd' }),
    event: eventRow({ next_owner: 'cloudflare' }),
  }));

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'authority_owner_projection_mismatch');
});

test('schema/read failure fails closed without claiming ownership', async () => {
  const result = await inspectAuthorityOwnership(mockDb({ throwBatch: true }));
  assert.deepEqual(result, {
    ok: false,
    readOnly: true,
    reason: 'authority_schema_unreachable',
  });
});

test('missing D1 binding fails closed', async () => {
  const result = await inspectAuthorityOwnership(null);
  assert.deepEqual(result, {
    ok: false,
    readOnly: true,
    reason: 'd1_binding_missing',
  });
});
