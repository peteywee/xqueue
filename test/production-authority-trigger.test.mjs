import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import {
  compileProductionAuthorityBootstrapSql,
  compileProductionCloudflareRebindSql,
  compileProductionNoneToCloudflareSql,
} from '../src/production-authority-sql.mjs';

const candidate1 = '83c7ffffea11950960cee66b413006db827fec2d';
const candidate2 = 'fc9f105e24b8da64fc01dd8515b2dc646e9de1d2';
const version1 =
  'cloudflare-worker:xqueue-publisher-production:version:' +
  '8646c543-65f0-4353-a29b-5c457e914010';
const version2 =
  'cloudflare-worker:xqueue-publisher-production:version:' +
  'ddd904f7-9271-4c6b-9b91-e3da898bc349';

function fixture() {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(
    new URL('../cloudflare/migrations-production/0013_authority_ownership.sql', import.meta.url),
    'utf8',
  ));
  db.exec(readFileSync(
    new URL('../cloudflare/migrations-production/0014_authority_event_projection.sql', import.meta.url),
    'utf8',
  ));
  return db;
}

function state(db) {
  return db.prepare('SELECT * FROM authority_state WHERE singleton_id=1').get() ?? null;
}

function events(db) {
  return db.prepare('SELECT * FROM authority_events ORDER BY generation').all();
}

test('event append atomically projects bootstrap, transfer, and generic rebind', () => {
  const db = fixture();

  db.exec(compileProductionAuthorityBootstrapSql({
    candidateSha: candidate1,
    transitionId: 'bootstrap',
    eventAt: '2026-09-26T00:00:00.000Z',
  }));

  assert.equal(state(db).owner, 'none');
  assert.equal(state(db).generation, 1);
  assert.equal(events(db).length, 1);

  db.exec(compileProductionNoneToCloudflareSql({
    candidateSha: candidate1,
    deploymentId: version1,
    transitionId: 'transfer',
    eventAt: '2026-09-26T00:01:00.000Z',
  }));

  assert.equal(state(db).owner, 'cloudflare');
  assert.equal(state(db).generation, 2);
  assert.equal(state(db).deployment_id, version1);
  assert.equal(events(db).length, 2);

  db.exec(compileProductionCloudflareRebindSql({
    candidateSha: candidate2,
    deploymentId: version2,
    previousCandidateSha: candidate1,
    previousDeploymentId: version1,
    expectedGeneration: 2,
    transitionId: 'rebind-g3',
    eventAt: '2026-09-26T00:02:00.000Z',
  }));

  assert.equal(state(db).owner, 'cloudflare');
  assert.equal(state(db).generation, 3);
  assert.equal(state(db).candidate_sha, candidate2);
  assert.equal(state(db).deployment_id, version2);
  assert.equal(events(db).length, 3);

  db.exec(compileProductionCloudflareRebindSql({
    candidateSha: candidate1,
    deploymentId: version1,
    previousCandidateSha: candidate2,
    previousDeploymentId: version2,
    expectedGeneration: 3,
    transitionId: 'rollback-g4',
    eventAt: '2026-09-26T00:03:00.000Z',
  }));

  assert.equal(state(db).owner, 'cloudflare');
  assert.equal(state(db).generation, 4);
  assert.equal(state(db).candidate_sha, candidate1);
  assert.equal(state(db).deployment_id, version1);
  assert.equal(events(db).length, 4);
});

test('trigger abort rolls back the event when projection preconditions fail', () => {
  const db = fixture();

  db.exec(compileProductionAuthorityBootstrapSql({
    candidateSha: candidate1,
    transitionId: 'bootstrap',
    eventAt: '2026-09-26T00:00:00.000Z',
  }));

  assert.throws(
    () => db.exec(`
      INSERT INTO authority_events (
        generation,transition_id,previous_owner,next_owner,transition_state,
        candidate_sha,deployment_id,event_at,detail
      ) VALUES (
        2,'bad-transition','cloudflare','cloudflare','stable',
        '${candidate1}','${version1}','2026-09-26T00:01:00.000Z','bad'
      );
    `),
    /authority event projection failed/,
  );

  assert.equal(events(db).length, 1);
  assert.equal(state(db).generation, 1);
  assert.equal(state(db).owner, 'none');
});

test('rebind refuses stale previous candidate/version without partial evidence', () => {
  const db = fixture();

  db.exec(compileProductionAuthorityBootstrapSql({
    candidateSha: candidate1,
    transitionId: 'bootstrap',
    eventAt: '2026-09-26T00:00:00.000Z',
  }));
  db.exec(compileProductionNoneToCloudflareSql({
    candidateSha: candidate1,
    deploymentId: version1,
    transitionId: 'transfer',
    eventAt: '2026-09-26T00:01:00.000Z',
  }));

  db.exec(compileProductionCloudflareRebindSql({
    candidateSha: candidate2,
    deploymentId: version2,
    previousCandidateSha: candidate2,
    previousDeploymentId: version1,
    expectedGeneration: 2,
    transitionId: 'wrong-prior',
    eventAt: '2026-09-26T00:02:00.000Z',
  }));

  assert.equal(events(db).length, 2);
  assert.equal(state(db).generation, 2);
  assert.equal(state(db).candidate_sha, candidate1);
  assert.equal(state(db).deployment_id, version1);
});

test('replaying an already-consumed generation is an idempotent no-op', () => {
  const db = fixture();

  db.exec(compileProductionAuthorityBootstrapSql({
    candidateSha: candidate1,
    transitionId: 'bootstrap',
    eventAt: '2026-09-26T00:00:00.000Z',
  }));
  db.exec(compileProductionNoneToCloudflareSql({
    candidateSha: candidate1,
    deploymentId: version1,
    transitionId: 'transfer',
    eventAt: '2026-09-26T00:01:00.000Z',
  }));

  const sql = compileProductionCloudflareRebindSql({
    candidateSha: candidate2,
    deploymentId: version2,
    previousCandidateSha: candidate1,
    previousDeploymentId: version1,
    expectedGeneration: 2,
    transitionId: 'rebind-g3',
    eventAt: '2026-09-26T00:02:00.000Z',
  });

  db.exec(sql);
  db.exec(sql);

  assert.equal(events(db).length, 3);
  assert.equal(state(db).generation, 3);
});
