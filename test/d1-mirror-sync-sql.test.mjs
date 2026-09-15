import test from 'node:test';
import assert from 'node:assert/strict';

import {
  compileAuthorityLatestEventReadSql,
  compileAuthorityStateReadSql,
  compileMirrorCompareAndSetSql,
  compileMirrorReadSql,
  sqlTextLiteral,
} from '../src/d1-mirror-sync-sql.mjs';
import {
  compileD1MirrorSyncPlan,
  sha256Text,
} from '../src/d1-mirror-sync-plan.mjs';

const candidateSha = 'e3aaedb8222158c499bd1c58466b2a5003f5e328';
const at = '2026-09-15T07:00:00.000Z';

function authority() {
  return {
    owner: 'local-systemd',
    generation: 31,
    transitionId: "transition-'31",
    candidateSha,
    deploymentId: "local-systemd@31-'quoted",
  };
}

function authorityState() {
  return {
    singleton_id: 1,
    owner: 'local-systemd',
    generation: 31,
    transition_state: 'stable',
    transition_id: "transition-'31",
    previous_owner: 'cloudflare',
    candidate_sha: candidateSha,
    deployment_id: "local-systemd@31-'quoted",
    transitioned_at: at,
    updated_at: at,
  };
}

function authorityEvent() {
  return {
    generation: 31,
    transition_id: "transition-'31",
    previous_owner: 'cloudflare',
    next_owner: 'local-systemd',
    transition_state: 'stable',
    candidate_sha: candidateSha,
    deployment_id: "local-systemd@31-'quoted",
    event_at: at,
    detail: null,
  };
}

function state(overrides = {}) {
  return {
    version: 1,
    posted: {
      A1: { tweetId: "tweet-'1" },
    },
    skipped: {},
    spend: 0.01,
    inflight: null,
    ...overrides,
  };
}

function replacementPlan(currentMirrorText = null) {
  const compiled = compileD1MirrorSyncPlan({
    env: 'preview',
    localState: state(),
    authorityState: authorityState(),
    latestAuthorityEvent: authorityEvent(),
    currentMirrorText,
  });
  assert.equal(compiled.ok, true);
  return compiled;
}

test('SQL text literal escapes quotes and rejects NUL', () => {
  assert.equal(sqlTextLiteral("a'b"), "'a''b'");
  assert.throws(() => sqlTextLiteral('a\0b'), /NUL/);
});

test('authority read statements are SELECT-only', () => {
  const stateSql = compileAuthorityStateReadSql();
  const eventSql = compileAuthorityLatestEventReadSql();

  assert.match(stateSql, /^SELECT\b/);
  assert.match(eventSql, /^SELECT\b/);
  assert.match(stateSql, /FROM authority_state/);
  assert.match(eventSql, /FROM authority_events/);
  assert.doesNotMatch(`${stateSql}\n${eventSql}`, /\b(?:INSERT|UPDATE|DELETE|REPLACE)\b/i);
});

test('mirror read is pinned to the canonical metadata key', () => {
  const sql = compileMirrorReadSql();
  assert.match(sql, /^SELECT\b/);
  assert.match(sql, /WHERE key = 'state\.snapshot_json'/);
  assert.throws(() => compileMirrorReadSql('publication_state'), /mirror key/);
});

test('missing mirror compiles one atomic authority-bound INSERT SELECT', () => {
  const compiled = replacementPlan(null);
  const result = compileMirrorCompareAndSetSql({
    key: compiled.targetKey,
    expected: {
      exists: false,
      value: null,
      rawHash: null,
    },
    nextValue: compiled.write.value,
    authority: compiled.authority,
  });

  assert.equal(result.mode, 'insert_missing');
  assert.match(result.sql, /^INSERT INTO runtime_metadata/);
  assert.match(result.sql, /WHERE NOT EXISTS/);
  assert.match(result.sql, /FROM authority_state AS s/);
  assert.match(result.sql, /JOIN authority_events AS e/);
  assert.match(result.sql, /s\.owner = 'local-systemd'/);
  assert.match(result.sql, /s\.transition_state = 'stable'/);
  assert.match(result.sql, /s\.generation = 31/);
  assert.match(result.sql, /s\.transition_id = 'transition-''31'/);
  assert.match(result.sql, /s\.deployment_id = 'local-systemd@31-''quoted'/);
  assert.match(result.sql, /e\.generation = \(SELECT MAX\(generation\) FROM authority_events\)/);
  assert.match(result.sql, /e\.deployment_id = s\.deployment_id/);
  assert.match(result.sql, /e\.previous_owner IS s\.previous_owner/);
  assert.match(result.sql, /RETURNING key, value, updated_at/);
  assert.doesNotMatch(result.sql, /\bDELETE\b/i);
});

test('existing mirror compiles exact-value UPDATE CAS plus authority predicate', () => {
  const old = JSON.stringify(state({ posted: {} }));
  const compiled = replacementPlan(old);
  const result = compileMirrorCompareAndSetSql({
    key: compiled.targetKey,
    expected: {
      exists: true,
      value: old,
      rawHash: sha256Text(old),
    },
    nextValue: compiled.write.value,
    authority: compiled.authority,
  });

  assert.equal(result.mode, 'update_existing');
  assert.match(result.sql, /^UPDATE runtime_metadata/);
  assert.match(result.sql, /AND value = /);
  assert.match(result.sql, /AND EXISTS \(/);
  assert.match(result.sql, /s\.generation = 31/);
  assert.match(result.sql, /lower\(s\.candidate_sha\) = 'e3aaedb8222158c499bd1c58466b2a5003f5e328'/);
  assert.match(result.sql, /RETURNING key, value, updated_at/);
});

test('old mirror raw hash must match exact old value', () => {
  const old = JSON.stringify(state({ posted: {} }));
  const compiled = replacementPlan(old);

  assert.throws(
    () => compileMirrorCompareAndSetSql({
      key: compiled.targetKey,
      expected: {
        exists: true,
        value: old,
        rawHash: 'a'.repeat(64),
      },
      nextValue: compiled.write.value,
      authority: compiled.authority,
    }),
    /rawHash does not match/,
  );
});

test('missing mirror precondition cannot smuggle old evidence', () => {
  const compiled = replacementPlan(null);

  assert.throws(
    () => compileMirrorCompareAndSetSql({
      key: compiled.targetKey,
      expected: {
        exists: false,
        value: 'old',
        rawHash: sha256Text('old'),
      },
      nextValue: compiled.write.value,
      authority: compiled.authority,
    }),
    /missing mirror precondition/,
  );
});

test('arbitrary target key is rejected before SQL generation', () => {
  const compiled = replacementPlan(null);
  assert.throws(
    () => compileMirrorCompareAndSetSql({
      key: 'publication_ledger',
      expected: { exists: false, value: null, rawHash: null },
      nextValue: compiled.write.value,
      authority: compiled.authority,
    }),
    /mirror key/,
  );
});

test('non-local or incomplete authority cannot compile write SQL', () => {
  const compiled = replacementPlan(null);

  assert.throws(
    () => compileMirrorCompareAndSetSql({
      key: compiled.targetKey,
      expected: { exists: false, value: null, rawHash: null },
      nextValue: compiled.write.value,
      authority: { ...compiled.authority, owner: 'cloudflare' },
    }),
    /local-systemd/,
  );

  assert.throws(
    () => compileMirrorCompareAndSetSql({
      key: compiled.targetKey,
      expected: { exists: false, value: null, rawHash: null },
      nextValue: compiled.write.value,
      authority: { ...compiled.authority, deploymentId: '' },
    }),
    /deploymentId/,
  );
});

test('next value must remain a valid XQueue state snapshot', () => {
  const compiled = replacementPlan(null);
  assert.throws(
    () => compileMirrorCompareAndSetSql({
      key: compiled.targetKey,
      expected: { exists: false, value: null, rawHash: null },
      nextValue: '{"not":"xqueue-state"}',
      authority: compiled.authority,
    }),
    /valid normalized XQueue state snapshot/,
  );
});
