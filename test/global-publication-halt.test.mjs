import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import {
  publicationHaltVerdict,
  readGlobalPublicationHalt,
  setGlobalPublicationHaltByAutomation,
} from '../cloudflare/src/publication-halt.mjs';
import {
  renderOwnerClearPublicationHaltSql,
  renderOwnerSetPublicationHaltSql,
} from '../src/publication-halt-owner.mjs';
import {
  buildWranglerArgs,
  parseArgs,
  parseOwnerClearResult,
  parseOwnerSetResult,
  validateOwnerAction,
} from '../scripts/publication-halt-owner.mjs';

function statement(sqlite, sql, params = []) {
  return {
    sql,
    params,
    bind(...next) {
      return statement(sqlite, sql, next);
    },
    async first() {
      const row = sqlite.prepare(sql).get(...params);
      return row ? { ...row } : null;
    },
    execute() {
      const prepared = sqlite.prepare(sql);
      if (/^\s*SELECT\b/i.test(sql)) {
        return {
          success: true,
          results: prepared.all(...params).map((row) => ({ ...row })),
        };
      }
      prepared.run(...params);
      return { success: true, results: [] };
    },
  };
}

function d1(sqlite) {
  return {
    prepare(sql) {
      return statement(sqlite, sql);
    },
    async batch(statements) {
      sqlite.exec('BEGIN IMMEDIATE');
      try {
        const results = statements.map((entry) => entry.execute());
        sqlite.exec('COMMIT');
        return results;
      } catch (error) {
        sqlite.exec('ROLLBACK');
        throw error;
      }
    },
  };
}

function fixture() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(
    readFileSync(
      new URL(
        '../cloudflare/migrations/0011_global_publication_halt.sql',
        import.meta.url,
      ),
      'utf8',
    ),
  );
  return { sqlite, db: d1(sqlite) };
}

function row(sqlite) {
  return {
    ...sqlite.prepare(
      'SELECT singleton_id,halted,generation,reason,actor_class,updated_at ' +
      'FROM publication_halt_state WHERE singleton_id=1',
    ).get(),
  };
}

function events(sqlite) {
  return sqlite.prepare(
    'SELECT generation,action,actor_class,reason,event_at ' +
    'FROM publication_halt_events ORDER BY id',
  ).all().map((entry) => ({ ...entry }));
}

test('migration initializes one durable unhalted singleton with immutable audit evidence', async () => {
  const { sqlite, db } = fixture();
  const state = await readGlobalPublicationHalt(db);

  assert.equal(state.ok, true);
  assert.equal(state.halted, false);
  assert.equal(state.generation, 1);
  assert.equal(state.reason, 'initial_unhalted');
  assert.equal(state.actorClass, 'migration');

  assert.deepEqual(
    events(sqlite).map(({ generation, action, actor_class, reason }) => ({
      generation,
      action,
      actor_class,
      reason,
    })),
    [{
      generation: 1,
      action: 'initialized',
      actor_class: 'migration',
      reason: 'initial_unhalted',
    }],
  );

  assert.throws(
    () => sqlite.prepare(
      "UPDATE publication_halt_events SET reason='forged' WHERE generation=1",
    ).run(),
    /immutable/,
  );
  assert.throws(
    () => sqlite.prepare(
      'DELETE FROM publication_halt_events WHERE generation=1',
    ).run(),
    /immutable/,
  );
  assert.throws(
    () => sqlite.prepare(
      'DELETE FROM publication_halt_state WHERE singleton_id=1',
    ).run(),
    /cannot be deleted/,
  );
});

test('automation may set halt once with CAS and append exact audit evidence', async () => {
  const { sqlite, db } = fixture();

  const result = await setGlobalPublicationHaltByAutomation(db, {
    reason: 'ambiguous publication outcome',
    expectedGeneration: 1,
    now: new Date('2026-09-21T16:00:00.000Z'),
  });

  assert.equal(result.changed, true);
  assert.equal(result.state.halted, true);
  assert.equal(result.state.generation, 2);
  assert.equal(result.state.actorClass, 'automation');
  assert.equal(result.state.reason, 'ambiguous publication outcome');

  const audit = events(sqlite);
  assert.equal(audit.length, 2);
  assert.deepEqual(
    {
      generation: audit[1].generation,
      action: audit[1].action,
      actor_class: audit[1].actor_class,
      reason: audit[1].reason,
    },
    {
      generation: 2,
      action: 'set',
      actor_class: 'automation',
      reason: 'ambiguous publication outcome',
    },
  );

  const replay = await setGlobalPublicationHaltByAutomation(db, {
    reason: 'different reason is not a second transition',
    now: new Date('2026-09-21T16:01:00.000Z'),
  });
  assert.equal(replay.changed, false);
  assert.equal(replay.state.generation, 2);
  assert.equal(events(sqlite).length, 2);
});

test('stale automation generation is rejected without state or event mutation', async () => {
  const { sqlite, db } = fixture();
  const before = row(sqlite);
  const beforeEvents = events(sqlite);

  await assert.rejects(
    () => setGlobalPublicationHaltByAutomation(db, {
      reason: 'stale writer',
      expectedGeneration: 2,
      now: new Date('2026-09-21T16:00:00.000Z'),
    }),
    /stale halt generation/,
  );

  assert.deepEqual(row(sqlite), before);
  assert.deepEqual(events(sqlite), beforeEvents);
});

test('owner CAS set succeeds once, is generation-fenced, and is audited', () => {
  const { sqlite } = fixture();

  sqlite.exec(renderOwnerSetPublicationHaltSql({
    expectedGeneration: 1,
    reason: 'owner controlled cutover halt',
    at: '2026-09-25T20:10:00.000Z',
  }));

  const halted = row(sqlite);
  assert.equal(halted.halted, 1);
  assert.equal(halted.generation, 2);
  assert.equal(halted.actor_class, 'owner');
  assert.equal(halted.reason, 'owner controlled cutover halt');

  const audit = events(sqlite);
  assert.equal(audit.length, 2);
  assert.deepEqual(
    {
      generation: audit[1].generation,
      action: audit[1].action,
      actor_class: audit[1].actor_class,
      reason: audit[1].reason,
    },
    {
      generation: 2,
      action: 'set',
      actor_class: 'owner',
      reason: 'owner controlled cutover halt',
    },
  );

  const before = row(sqlite);
  const beforeEvents = events(sqlite);
  sqlite.exec(renderOwnerSetPublicationHaltSql({
    expectedGeneration: 1,
    reason: 'stale replay',
    at: '2026-09-25T20:11:00.000Z',
  }));
  assert.deepEqual(row(sqlite), before);
  assert.deepEqual(events(sqlite), beforeEvents);
});

test('database rejects automation clear while owner CAS clear succeeds and is audited', async () => {
  const { sqlite, db } = fixture();

  await setGlobalPublicationHaltByAutomation(db, {
    reason: 'operator safety stop',
    now: new Date('2026-09-21T16:00:00.000Z'),
  });

  assert.throws(
    () => sqlite.prepare(
      "UPDATE publication_halt_state " +
      "SET halted=0,generation=generation+1,reason='forged clear'," +
      "actor_class='automation',updated_at='2026-09-21T16:01:00.000Z' " +
      'WHERE singleton_id=1 AND generation=2',
    ).run(),
    /only be cleared by owner/,
  );

  sqlite.exec(renderOwnerClearPublicationHaltSql({
    expectedGeneration: 2,
    reason: 'owner reviewed and cleared',
    at: '2026-09-21T16:02:00.000Z',
  }));

  const cleared = row(sqlite);
  assert.equal(cleared.halted, 0);
  assert.equal(cleared.generation, 3);
  assert.equal(cleared.actor_class, 'owner');
  assert.equal(cleared.reason, 'owner reviewed and cleared');

  assert.deepEqual(
    events(sqlite).map(({ generation, action, actor_class }) => ({
      generation,
      action,
      actor_class,
    })),
    [
      { generation: 1, action: 'initialized', actor_class: 'migration' },
      { generation: 2, action: 'set', actor_class: 'automation' },
      { generation: 3, action: 'clear', actor_class: 'owner' },
    ],
  );
});

test('owner clear is generation-fenced and stale clear cannot alter state', async () => {
  const { sqlite, db } = fixture();

  await setGlobalPublicationHaltByAutomation(db, {
    reason: 'halted',
    now: new Date('2026-09-21T16:00:00.000Z'),
  });

  const before = row(sqlite);
  const beforeEvents = events(sqlite);

  sqlite.exec(renderOwnerClearPublicationHaltSql({
    expectedGeneration: 1,
    reason: 'stale owner clear',
    at: '2026-09-21T16:02:00.000Z',
  }));

  assert.deepEqual(row(sqlite), before);
  assert.deepEqual(events(sqlite), beforeEvents);
});

test('missing or unreadable halt state fails closed', async () => {
  const missing = await readGlobalPublicationHalt({
    prepare() {
      return {
        async first() {
          return null;
        },
      };
    },
  });
  assert.equal(missing.ok, false);
  assert.equal(missing.halted, true);
  assert.equal(publicationHaltVerdict(missing).ok, false);

  const unavailable = await readGlobalPublicationHalt({
    prepare() {
      throw new Error('D1 down');
    },
  });
  assert.equal(unavailable.ok, false);
  assert.equal(unavailable.halted, true);
  assert.equal(unavailable.reason, 'halt_store_unavailable');
  assert.equal(publicationHaltVerdict(unavailable).ok, false);
});

test('owner control defaults to preview status and production mutations require explicit owner confirmation', () => {
  assert.deepEqual(parseArgs([]), {
    action: 'status',
    environment: 'preview',
    expectedGeneration: null,
    reason: null,
    apply: false,
    confirm: null,
  });

  assert.throws(
    () => validateOwnerAction(parseArgs([
      '--action', 'clear',
      '--environment', 'preview',
      '--expected-generation', '2',
      '--reason', 'reviewed',
    ])),
    /dry-run by default/,
  );

  assert.throws(
    () => validateOwnerAction(parseArgs([
      '--action', 'clear',
      '--environment', 'production',
      '--expected-generation', '2',
      '--reason', 'reviewed',
      '--apply',
    ])),
    /production owner clear requires/,
  );

  assert.throws(
    () => validateOwnerAction(parseArgs([
      '--action', 'set',
      '--environment', 'production',
      '--expected-generation', '1',
      '--reason', 'cutover halt',
      '--apply',
    ])),
    /production owner set requires/,
  );

  assert.doesNotThrow(() => validateOwnerAction(parseArgs([
    '--action', 'set',
    '--environment', 'production',
    '--expected-generation', '1',
    '--reason', 'cutover halt',
    '--apply',
    '--confirm', 'xqueue-production-owner-set',
  ])));

  assert.doesNotThrow(() => validateOwnerAction(parseArgs([
    '--action', 'clear',
    '--environment', 'production',
    '--expected-generation', '2',
    '--reason', 'reviewed',
    '--apply',
    '--confirm', 'xqueue-production-owner-clear',
  ])));

  const args = buildWranglerArgs({
    environment: 'production',
    sql: 'SELECT 1;',
  });
  assert.equal(args.includes('xqueue-production'), true);
  assert.equal(args.includes('wrangler.jsonc'), true);
  assert.equal(args.includes('xqueue-preview'), false);

  assert.throws(
    () => parseOwnerClearResult(JSON.stringify([
      { success: true, results: [] },
      { success: true, results: [{ direct_changes: 0 }] },
      { success: true, results: [{
        singleton_id: 1,
        halted: 1,
        generation: 2,
        reason: 'still halted',
        actor_class: 'automation',
        updated_at: '2026-09-21T16:00:00.000Z',
      }] },
    ])),
    /did not change exactly one row/,
  );

  assert.throws(
    () => parseOwnerSetResult(JSON.stringify([
      { success: false, results: [] },
      { success: true, results: [{ direct_changes: 1 }] },
      { success: true, results: [{
        singleton_id: 1,
        halted: 1,
        generation: 2,
        reason: 'cutover halt',
        actor_class: 'owner',
        updated_at: '2026-09-25T20:10:00.000Z',
      }] },
    ]), {
      expectedGeneration: 1,
      reason: 'cutover halt',
    }),
    /did not report success/,
  );

  assert.throws(
    () => parseOwnerSetResult(JSON.stringify([
      { success: true, results: [] },
      { success: true, results: [{ direct_changes: 1 }] },
      { success: true, results: [{
        singleton_id: 1,
        halted: 1,
        generation: 9,
        reason: 'wrong',
        actor_class: 'owner',
        updated_at: '2026-09-25T20:10:00.000Z',
      }] },
    ]), {
      expectedGeneration: 1,
      reason: 'cutover halt',
    }),
    /readback is not exact/,
  );

  assert.deepEqual(
    parseOwnerSetResult(JSON.stringify([
      { success: true, results: [] },
      { success: true, results: [{ direct_changes: 1 }] },
      { success: true, results: [{
        singleton_id: 1,
        halted: 1,
        generation: 2,
        reason: 'cutover halt',
        actor_class: 'owner',
        updated_at: '2026-09-25T20:10:00.000Z',
      }] },
    ]), {
      expectedGeneration: 1,
      reason: 'cutover halt',
    }),
    {
      singleton_id: 1,
      halted: 1,
      generation: 2,
      reason: 'cutover halt',
      actor_class: 'owner',
      updated_at: '2026-09-25T20:10:00.000Z',
    },
  );

  assert.deepEqual(
    parseOwnerClearResult(JSON.stringify([
      { success: true, results: [] },
      { success: true, results: [{ direct_changes: 1 }] },
      { success: true, results: [{
        singleton_id: 1,
        halted: 0,
        generation: 3,
        reason: 'reviewed',
        actor_class: 'owner',
        updated_at: '2026-09-21T16:02:00.000Z',
      }] },
    ]), {
      expectedGeneration: 2,
      reason: 'reviewed',
    }),
    {
      singleton_id: 1,
      halted: 0,
      generation: 3,
      reason: 'reviewed',
      actor_class: 'owner',
      updated_at: '2026-09-21T16:02:00.000Z',
    },
  );
});
