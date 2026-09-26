import test from 'node:test';
import assert from 'node:assert/strict';

import {
  compileProductionAuthorityBootstrapSql,
  compileProductionNoneToCloudflareSql,
} from '../src/production-authority-sql.mjs';

const sha = 'fc9f105e24b8da64fc01dd8515b2dc646e9de1d2';
const at = '2026-09-26T03:00:00.000Z';

test('production bootstrap seeds exactly owner none generation 1', () => {
  const sql = compileProductionAuthorityBootstrapSql({
    candidateSha: sha,
    transitionId: 'production-bootstrap-none-test',
    eventAt: at,
  });

  assert.match(sql, /next_owner,[\s\S]*'none'/);
  assert.match(sql, /owner =?\s*'none'|\n  'none',/);
  assert.match(sql, /generation[\s\S]*1/);
  assert.doesNotMatch(sql, /cloudflare/);
  assert.doesNotMatch(sql, /runtime_metadata|publication_state|publication_events/);
});

test('production transfer is single none to cloudflare generation 2 CAS', () => {
  const deploymentId =
    'cloudflare-worker:xqueue-publisher-production:version:' +
    'ddd904f7-9271-4c6b-9b91-e3da898bc349';

  const sql = compileProductionNoneToCloudflareSql({
    candidateSha: sha,
    deploymentId,
    transitionId: 'production-none-to-cloudflare-test',
    eventAt: at,
  });

  assert.match(sql, /previous_owner[\s\S]*'none'/);
  assert.match(sql, /next_owner[\s\S]*'cloudflare'/);
  assert.match(sql, /owner = 'cloudflare'/);
  assert.match(sql, /generation = 2/);
  assert.match(sql, /NOT EXISTS \(SELECT 1 FROM authority_events WHERE generation >= 2\)/);
  assert.match(sql, /xqueue-publisher-production/);
  assert.doesNotMatch(sql, /runtime_metadata|publication_state|publication_events/);
});

test('production transfer rejects non-publisher deployment identities', () => {
  assert.throws(
    () => compileProductionNoneToCloudflareSql({
      candidateSha: sha,
      deploymentId: 'cloudflare:wrong-worker',
      transitionId: 'bad',
      eventAt: at,
    }),
    /exact Worker version/,
  );
});
