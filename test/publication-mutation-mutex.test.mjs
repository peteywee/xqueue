import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { acquirePublicationLease, releasePublicationLease } from '../cloudflare/src/publication-lease.mjs';
import {
  compileProductionAuthorityBootstrapSql,
  compileProductionCloudflareRebindSql,
  compileProductionNoneToCloudflareSql,
} from '../src/production-authority-sql.mjs';

class Statement {
  constructor(db, sql, params = []) { this.db = db; this.sql = sql; this.params = params; }
  bind(...params) { return new Statement(this.db, this.sql, params); }
  execute() {
    const statement = this.db.prepare(this.sql);
    if (/^\s*SELECT\b/i.test(this.sql)) {
      return { success: true, results: statement.all(...this.params).map((row) => ({ ...row })), meta: { changes: 0 } };
    }
    const result = statement.run(...this.params);
    return { success: true, results: [], meta: { changes: Number(result.changes) } };
  }
  async first() {
    const row = this.db.prepare(this.sql).get(...this.params);
    return row ? { ...row } : null;
  }
}
class SqliteD1 {
  constructor(db) { this.db = db; }
  prepare(sql) { return new Statement(this.db, sql); }
  async batch(statements) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = statements.map((statement) => statement.execute());
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
}
function fullFixture() {
  const sqlite = new DatabaseSync(':memory:');
  const dir = new URL('../cloudflare/migrations/', import.meta.url);
  for (const name of readdirSync(dir).filter((x) => /^\d+.*\.sql$/.test(x)).sort()) {
    sqlite.exec(readFileSync(new URL(name, dir), 'utf8'));
  }
  return { sqlite, db: new SqliteD1(sqlite) };
}

test('publisher lease acquisition is excluded while the mutation lane is active', async () => {
  const { sqlite, db } = fullFixture();
  const initial = await acquirePublicationLease(db, {
    ownerToken: 'publisher-owner-alpha',
    acquisitionId: 'publisher-acquisition-alpha',
    nowMs: 1000,
    ttlMs: 5000,
  });
  assert.equal(initial.acquired, true);
  assert.equal((await releasePublicationLease(db, initial.lease, { nowMs: 1500 })).released, true);

  sqlite.prepare(
    "UPDATE mutation_lane_state SET generation=generation+1,active_operation_id=?,actor_class='automation',updated_at=? WHERE singleton_id=1",
  ).run('mutation-intake-mutex-test', '2026-10-03T13:30:00.000Z');

  await assert.rejects(
    acquirePublicationLease(db, {
      ownerToken: 'publisher-owner-bravo',
      acquisitionId: 'publisher-acquisition-bravo',
      nowMs: 2000,
      ttlMs: 5000,
    }),
    /publication lease acquisition blocked by active mutation lane/,
  );

  const blockedLease = sqlite.prepare(
    "SELECT owner_token,generation FROM publication_leases WHERE lease_name='publisher'",
  ).get();
  assert.equal(blockedLease.owner_token, null);
  assert.equal(blockedLease.generation, 1);

  sqlite.prepare(
    "UPDATE mutation_lane_state SET active_operation_id=NULL,actor_class='automation',updated_at=? WHERE singleton_id=1",
  ).run('2026-10-03T13:31:00.000Z');

  const afterRelease = await acquirePublicationLease(db, {
    ownerToken: 'publisher-owner-bravo',
    acquisitionId: 'publisher-acquisition-bravo',
    nowMs: 2500,
    ttlMs: 5000,
  });
  assert.equal(afterRelease.acquired, true);
  assert.equal(afterRelease.lease.generation, 2);
  sqlite.close();
});

function laneFixture(lane) {
  const sqlite = new DatabaseSync(':memory:');
  const dir = new URL(`../cloudflare/${lane}/`, import.meta.url);
  for (const name of readdirSync(dir).filter((x) => /^\d+.*\.sql$/.test(x)).sort()) {
    sqlite.exec(readFileSync(new URL(name, dir), 'utf8'));
  }
  return sqlite;
}

function setLane(sqlite, operationId) {
  if (operationId) {
    sqlite.prepare(
      "UPDATE mutation_lane_state SET generation=generation+1,active_operation_id=?,actor_class='automation',updated_at=? WHERE singleton_id=1",
    ).run(operationId, '2026-10-04T15:20:00.000Z');
  } else {
    sqlite.prepare(
      "UPDATE mutation_lane_state SET active_operation_id=NULL,actor_class='automation',updated_at=? WHERE singleton_id=1",
    ).run('2026-10-04T15:21:00.000Z');
  }
}

const BLOCKED = /authority transition blocked by active mutation lane/;

test('production authority rebind is excluded while the mutation lane is active', () => {
  const sqlite = laneFixture('migrations-production');
  const candidate1 = '83c7ffffea11950960cee66b413006db827fec2d';
  const candidate2 = 'fc9f105e24b8da64fc01dd8515b2dc646e9de1d2';
  const version1 = 'cloudflare-worker:xqueue-publisher-production:version:8646c543-65f0-4353-a29b-5c457e914010';
  const version2 = 'cloudflare-worker:xqueue-publisher-production:version:ddd904f7-9271-4c6b-9b91-e3da898bc349';
  sqlite.exec(`
    UPDATE publication_halt_state
    SET halted=1, generation=2, reason='authority test halt', actor_class='owner',
        updated_at='2026-10-04T15:00:00.000Z'
    WHERE singleton_id=1;
  `);
  sqlite.exec(compileProductionAuthorityBootstrapSql({
    candidateSha: candidate1,
    transitionId: 'bootstrap',
    eventAt: '2026-10-04T15:01:00.000Z',
  }));
  sqlite.exec(compileProductionNoneToCloudflareSql({
    candidateSha: candidate1,
    deploymentId: version1,
    expectedHaltGeneration: 2,
    transitionId: 'transfer',
    eventAt: '2026-10-04T15:02:00.000Z',
  }));
  const rebind = (transitionId) => compileProductionCloudflareRebindSql({
    candidateSha: candidate2,
    deploymentId: version2,
    previousCandidateSha: candidate1,
    previousDeploymentId: version1,
    expectedGeneration: 2,
    expectedHaltGeneration: 2,
    transitionId,
    eventAt: '2026-10-04T15:22:00.000Z',
  });
  const authority = () => sqlite.prepare(
    'SELECT generation,candidate_sha,deployment_id FROM authority_state WHERE singleton_id=1',
  ).get();
  const eventCount = () => sqlite.prepare('SELECT COUNT(*) AS n FROM authority_events').get().n;

  setLane(sqlite, 'mutation-intake-authority-test');
  assert.throws(() => sqlite.exec(rebind('rebind-during-mutation')), BLOCKED);
  assert.deepEqual({ ...authority() }, { generation: 2, candidate_sha: candidate1, deployment_id: version1 });
  assert.equal(eventCount(), 2);

  setLane(sqlite, null);
  sqlite.exec(rebind('rebind-after-release'));
  assert.deepEqual({ ...authority() }, { generation: 3, candidate_sha: candidate2, deployment_id: version2 });
  assert.equal(eventCount(), 3);
  sqlite.close();
});

test('canonical-lane authority events and state updates are excluded while the mutation lane is active', () => {
  const sqlite = laneFixture('migrations');
  const sha = 'a'.repeat(40);
  sqlite.exec(`
    INSERT INTO authority_events
      (generation,transition_id,previous_owner,next_owner,transition_state,candidate_sha,deployment_id,event_at,detail)
    VALUES (1,'bootstrap',NULL,'none','stable','${sha}',NULL,'2026-10-04T15:00:00.000Z',NULL);
    INSERT INTO authority_state
      (singleton_id,owner,generation,transition_state,transition_id,previous_owner,candidate_sha,deployment_id,transitioned_at,updated_at)
    VALUES (1,'none',1,'stable','bootstrap',NULL,'${sha}',NULL,'2026-10-04T15:00:00.000Z','2026-10-04T15:00:00.000Z');
  `);
  const transition = `
    INSERT INTO authority_events
      (generation,transition_id,previous_owner,next_owner,transition_state,candidate_sha,deployment_id,event_at,detail)
    VALUES (2,'transition','none','cloudflare','stable','${sha}','deployment-x','2026-10-04T15:22:00.000Z',NULL)`;
  const update = `
    UPDATE authority_state
    SET owner='cloudflare', generation=2, transition_id='transition', previous_owner='none',
        deployment_id='deployment-x', transitioned_at='2026-10-04T15:22:00.000Z',
        updated_at='2026-10-04T15:22:00.000Z'
    WHERE singleton_id=1`;

  setLane(sqlite, 'mutation-intake-authority-test');
  assert.throws(() => sqlite.exec(transition), BLOCKED);
  assert.throws(() => sqlite.exec(update), BLOCKED);
  assert.equal(sqlite.prepare('SELECT generation FROM authority_state').get().generation, 1);

  setLane(sqlite, null);
  sqlite.exec(transition);
  sqlite.exec(update);
  assert.equal(sqlite.prepare('SELECT generation FROM authority_state').get().generation, 2);
  sqlite.close();
});
