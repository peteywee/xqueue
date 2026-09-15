import test from 'node:test';
import assert from 'node:assert/strict';

import { compileInitialPreviewAuthorityBootstrapSql } from '../src/authority-bootstrap-sql.mjs';

const candidateSha = 'e70352a3ca2cb50c854c473dd5c30106f3ffba6b';
const eventAt = '2026-09-15T10:00:00.000Z';
const transitionId = 'preview-bootstrap-none-1';

function compile(overrides = {}) {
  return compileInitialPreviewAuthorityBootstrapSql({
    candidateSha,
    eventAt,
    transitionId,
    ...overrides,
  });
}

test('bootstrap SQL creates event then state and grants no publication owner', () => {
  const sql = compile();

  assert.match(sql, /^INSERT INTO authority_events/);
  assert.match(sql, /INSERT INTO authority_state/);
  assert.match(sql, /next_owner,\n  transition_state/);
  assert.match(sql, /'none',\n  'stable'/);
  assert.match(sql, /owner,\n  generation/);
  assert.equal((sql.match(/'local-systemd'/g) ?? []).length, 0);
  assert.equal((sql.match(/'cloudflare'/g) ?? []).length, 0);
  assert.doesNotMatch(sql, /runtime_metadata|publication_state|publication_events/);
});

test('bootstrap SQL requires both authority tables to be empty', () => {
  const sql = compile();

  assert.match(sql, /NOT EXISTS \(SELECT 1 FROM authority_state\)/);
  assert.match(sql, /NOT EXISTS \(SELECT 1 FROM authority_events\)/);
  assert.match(sql, /WHERE changes\(\) = 1/);
  assert.match(sql, /WHERE generation = 1/);
  assert.match(sql, /next_owner = 'none'/);
  assert.match(sql, /deployment_id IS NULL/);
});

test('bootstrap SQL is deterministic for the same evidence', () => {
  assert.equal(compile(), compile());
});

test('bootstrap SQL escapes transition text and rejects NUL', () => {
  const sql = compile({ transitionId: "bootstrap-'quoted'" });
  assert.match(sql, /bootstrap-''quoted''/);

  assert.throws(
    () => compile({ transitionId: 'bad\0transition' }),
    /must not contain NUL/,
  );
});

test('bootstrap SQL rejects malformed candidate and timestamp evidence', () => {
  assert.throws(
    () => compile({ candidateSha: 'not-a-sha' }),
    /40-hex commit SHA/,
  );
  assert.throws(
    () => compile({ eventAt: '2026-09-15 10:00:00' }),
    /exact ISO-8601 instant/,
  );
  assert.throws(
    () => compile({ transitionId: '' }),
    /non-empty string/,
  );
});
