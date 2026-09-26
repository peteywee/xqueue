import test from 'node:test';
import assert from 'node:assert/strict';

import {
  compileProductionAuthorityBootstrapSql,
  compileProductionCloudflareRebindSql,
  compileProductionNoneToCloudflareSql,
  parseProductionPublisherDeploymentId,
  productionPublisherDeploymentId,
} from '../src/production-authority-sql.mjs';

const sha = 'fc9f105e24b8da64fc01dd8515b2dc646e9de1d2';
const previousSha = '83c7ffffea11950960cee66b413006db827fec2d';
const at = '2026-09-26T03:00:00.000Z';
const deploymentId =
  'cloudflare-worker:xqueue-publisher-production:version:' +
  'ddd904f7-9271-4c6b-9b91-e3da898bc349';
const previousDeploymentId =
  'cloudflare-worker:xqueue-publisher-production:version:' +
  '8646c543-65f0-4353-a29b-5c457e914010';

test('production deployment identity requires an exact UUID-shaped Worker version', () => {
  assert.deepEqual(
    parseProductionPublisherDeploymentId(deploymentId),
    {
      deploymentId,
      versionId: 'ddd904f7-9271-4c6b-9b91-e3da898bc349',
    },
  );

  assert.equal(
    productionPublisherDeploymentId('DDD904F7-9271-4C6B-9B91-E3DA898BC349'),
    deploymentId,
  );

  for (const bad of [
    'cloudflare:wrong-worker',
    'cloudflare-worker:xqueue-publisher-production:version:------------------------------------',
    'cloudflare-worker:xqueue-publisher-production:version:ddd904f792714c6b9b91e3da898bc349',
    'cloudflare-worker:xqueue-publisher-production:version:ddd904f7-9271-4c6b-9b91-e3da898bc34z',
  ]) {
    assert.throws(
      () => parseProductionPublisherDeploymentId(bad),
      /exact Worker version/,
    );
  }
});

test('production bootstrap is one append-only statement; trigger owns projection', () => {
  const sql = compileProductionAuthorityBootstrapSql({
    candidateSha: sha,
    transitionId: 'production-bootstrap-none-test',
    eventAt: at,
  });

  assert.match(sql, /^INSERT INTO authority_events/);
  assert.match(sql, /next_owner,[\s\S]*'none'/);
  assert.match(sql, /NOT EXISTS \(SELECT 1 FROM authority_state\)/);
  assert.doesNotMatch(sql, /UPDATE authority_state/);
  assert.equal(sql.match(/INSERT INTO authority_events/g)?.length, 1);
});

test('production transfer is one none -> cloudflare generation 2 CAS at same candidate', () => {
  const sql = compileProductionNoneToCloudflareSql({
    candidateSha: sha,
    deploymentId,
    transitionId: 'production-none-to-cloudflare-test',
    eventAt: at,
  });

  assert.match(sql, /^INSERT INTO authority_events/);
  assert.match(sql, /previous_owner[\s\S]*'none'/);
  assert.match(sql, /next_owner[\s\S]*'cloudflare'/);
  assert.match(sql, /SELECT\s+2,/);
  assert.match(sql, /lower\(s\.candidate_sha\) = 'fc9f105e24b8da64fc01dd8515b2dc646e9de1d2'/);
  assert.match(sql, /NOT EXISTS \(SELECT 1 FROM authority_events WHERE generation >= 2\)/);
  assert.doesNotMatch(sql, /UPDATE authority_state/);
});

test('production transfer rejects malformed publisher deployment identities', () => {
  assert.throws(
    () => compileProductionNoneToCloudflareSql({
      candidateSha: sha,
      deploymentId:
        'cloudflare-worker:xqueue-publisher-production:version:' +
        '------------------------------------',
      transitionId: 'bad',
      eventAt: at,
    }),
    /exact Worker version/,
  );
});

test('production Cloudflare rebind is generic N -> N+1 with exact prior CAS', () => {
  const sql = compileProductionCloudflareRebindSql({
    candidateSha: sha,
    deploymentId,
    previousCandidateSha: previousSha,
    previousDeploymentId,
    expectedGeneration: 7,
    transitionId: 'production-cloudflare-rebind-test',
    eventAt: at,
  });

  assert.match(sql, /^INSERT INTO authority_events/);
  assert.match(sql, /SELECT\s+8,/);
  assert.match(sql, /s\.generation = 7/);
  assert.match(
    sql,
    /lower\(s\.candidate_sha\) = '83c7ffffea11950960cee66b413006db827fec2d'/,
  );
  assert.ok(sql.includes(previousDeploymentId));
  assert.ok(sql.includes(deploymentId));
  assert.match(sql, /generation >= 8/);
  assert.doesNotMatch(sql, /UPDATE authority_state/);
});

test('production rebind refuses same version and malformed prior version', () => {
  assert.throws(
    () => compileProductionCloudflareRebindSql({
      candidateSha: sha,
      deploymentId,
      previousCandidateSha: previousSha,
      previousDeploymentId: deploymentId,
      expectedGeneration: 3,
      transitionId: 'same-version',
      eventAt: at,
    }),
    /must differ/,
  );

  assert.throws(
    () => compileProductionCloudflareRebindSql({
      candidateSha: sha,
      deploymentId,
      previousCandidateSha: previousSha,
      previousDeploymentId:
        'cloudflare-worker:xqueue-publisher-production:version:' +
        '------------------------------------',
      expectedGeneration: 3,
      transitionId: 'bad-prior',
      eventAt: at,
    }),
    /exact Worker version/,
  );
});

test('production rebind validates prior candidate and generation inputs', () => {
  assert.throws(
    () => compileProductionCloudflareRebindSql({
      candidateSha: sha,
      deploymentId,
      previousCandidateSha: 'not-a-sha',
      previousDeploymentId,
      expectedGeneration: 3,
      transitionId: 'bad-sha',
      eventAt: at,
    }),
    /previousCandidateSha/,
  );

  assert.throws(
    () => compileProductionCloudflareRebindSql({
      candidateSha: sha,
      deploymentId,
      previousCandidateSha: previousSha,
      previousDeploymentId,
      expectedGeneration: 1,
      transitionId: 'bad-generation',
      eventAt: at,
    }),
    />= 2/,
  );
});
