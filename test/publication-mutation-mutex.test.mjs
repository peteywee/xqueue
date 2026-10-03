import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { acquirePublicationLease, releasePublicationLease } from '../cloudflare/src/publication-lease.mjs';

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
