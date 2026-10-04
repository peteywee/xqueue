import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import {
  classifyD1TransportException,
  createD1MutationTransport,
  getD1TimeTravelBookmark,
  timeTravelBookmarkUrl,
} from '../src/mutation-control-transport.mjs';

function fakeDb() {
  const calls = [];
  const rows = new Map([
    ['SELECT halted,generation,reason,actor_class,updated_at FROM mutation_lane_halt_state WHERE singleton_id=1', { halted: 0, generation: 3 }],
    ['SELECT generation,active_operation_id,actor_class,updated_at FROM mutation_lane_state WHERE singleton_id=1', { generation: 7, active_operation_id: null }],
    ['SELECT generation,revision_digest,source_operation_id,created_at FROM queue_runtime_revisions ORDER BY generation DESC LIMIT 1', { generation: 9, revision_digest: 'a'.repeat(64) }],
  ]);
  return {
    calls,
    prepare(sql) {
      const state = { sql, args: [] };
      calls.push(state);
      return {
        bind(...args) { state.args = args; return this; },
        async first() {
          if (sql.startsWith('SELECT * FROM mutation_operations')) return { operation_id: state.args[0] };
          if (sql.startsWith('SELECT owner,generation,transition_state')) {
            return {
              owner: 'cloudflare',
              generation: 9,
              transition_state: 'stable',
              candidate_sha: 'a'.repeat(40),
              deployment_id: 'cloudflare-worker:xqueue-publisher-production:version:11111111-1111-4111-8111-111111111111',
            };
          }
          if (sql.startsWith('SELECT COUNT(*) AS unresolved')) return { unresolved: 0 };
          if (sql.startsWith('SELECT COUNT(*) AS active_leases')) return { active_leases: 0 };
          if (sql.startsWith('SELECT json_extract')) return { inflight: null };
          if (sql.startsWith("SELECT generation FROM publication_leases")) return { generation: 5 };
          if (sql.startsWith('SELECT COALESCE(MAX(id),0) AS event_cursor')) return { event_cursor: 17 };
          return rows.get(sql) ?? null;
        },
        async all() {
          if (sql.startsWith('SELECT * FROM mutation_operation_items')) {
            return { results: [{ operation_id: state.args[0], item_key: 'I-1', readback_status: 'applied' }] };
          }
          return { results: [] };
        },
        async run() { return { success: true }; },
      };
    },
    async batch(statements) {
      return statements.map(() => ({ success: true }));
    },
  };
}

test('bookmark URL is exact and safely encoded', () => {
  assert.equal(
    timeTravelBookmarkUrl({ accountId: 'acct/a', databaseId: 'db b' }),
    'https://api.cloudflare.com/client/v4/accounts/acct%2Fa/d1/database/db%20b/time_travel/bookmark',
  );
});

test('bookmark capture requires an explicit successful usable response', async () => {
  const calls = [];
  const bookmark = await getD1TimeTravelBookmark({
    accountId: 'acct',
    databaseId: 'db',
    apiToken: 'token',
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return { ok: true, json: async () => ({ success: true, result: { bookmark: 'bookmark_12345' } }) };
    },
  });
  assert.equal(bookmark, 'bookmark_12345');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.method, 'GET');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer token');
});

test('bookmark service outages are unavailable reads, not checkpoint corruption', async () => {
  const outages = [
    async () => { throw new Error('network down'); },
    async () => ({ ok: false, status: 503, json: async () => { throw new SyntaxError('Unexpected token <'); } }),
    async () => ({ ok: false, status: 500, json: async () => ({ success: false }) }),
    async () => ({ ok: false, status: 429, json: async () => ({ success: false }) }),
  ];
  for (const fetchImpl of outages) {
    await assert.rejects(
      getD1TimeTravelBookmark({ accountId: 'acct', databaseId: 'db', apiToken: 'token', fetchImpl }),
      (error) => error?.code === 'D1_READ_UNAVAILABLE',
    );
  }
});

test('unusable bookmark responses fail closed as checkpoint corruption', async () => {
  const unusable = [
    async () => ({ ok: true, status: 200, json: async () => ({ success: true, result: { bookmark: 'bad' } }) }),
    async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('Unexpected token <'); } }),
    async () => ({ ok: true, status: 200, json: async () => ({ success: false }) }),
    async () => ({ ok: false, status: 401, json: async () => ({ success: false }) }),
    async () => ({ ok: false, status: 403, json: async () => ({ success: false }) }),
    async () => ({ ok: false, status: 404, json: async () => ({ success: false }) }),
  ];
  for (const fetchImpl of unusable) {
    await assert.rejects(
      getD1TimeTravelBookmark({ accountId: 'acct', databaseId: 'db', apiToken: 'token', fetchImpl }),
      (error) => error?.code === 'CHECKPOINT_CORRUPT',
    );
  }
});

test('D1-only transport exposes reads, checkpoint and batch with no publication surface', async () => {
  const db = fakeDb();
  const transport = createD1MutationTransport({
    db,
    accountId: 'acct',
    databaseId: 'db',
    apiToken: 'token',
    fetchImpl: async () => ({ ok: true, json: async () => ({ success: true, result: { bookmark: 'bookmark_12345' } }) }),
  });
  assert.deepEqual(Object.keys(transport).sort(), [
    'batch', 'captureCheckpoint', 'prepare', 'readHaltState', 'readLaneState', 'readOperation', 'readOperationItems', 'readPublicationSafety', 'readRuntimeState',
  ]);
  assert.equal((await transport.readHaltState()).generation, 3);
  assert.equal((await transport.readLaneState()).generation, 7);
  assert.equal((await transport.readRuntimeState()).generation, 9);
  assert.equal((await transport.readOperation('op-1')).operation_id, 'op-1');
  assert.equal((await transport.readOperationItems('op-1'))[0].item_key, 'I-1');
  const safety = await transport.readPublicationSafety();
  assert.equal(safety.authority.owner, 'cloudflare');
  assert.equal(safety.unresolvedAttemptCount, 0);
  assert.equal(safety.activeLeaseCount, 0);
  assert.equal(safety.publicationLeaseGeneration, 5);
  assert.equal(safety.publicationEventCursor, 17);
  assert.equal(safety.runtimeSnapshotObserved, true);
  assert.equal(safety.inflight, null);
  assert.equal(await transport.captureCheckpoint(), 'bookmark_12345');
  const prepared = transport.prepare('UPDATE mutation_operations SET state=state');
  assert.equal(typeof prepared.run, 'function');
  const stmt = db.prepare('UPDATE mutation_operations SET state=state');
  assert.equal((await transport.batch([stmt]))[0].success, true);
});

test('batch rejects raw/unprepared input', async () => {
  const transport = createD1MutationTransport({ db: fakeDb() });
  await assert.rejects(transport.batch([]), /statements are required/);
  await assert.rejects(transport.batch([{}]), /prepared D1 statements/);
});

test('exception classifier emits only control-plane codes', () => {
  assert.equal(classifyD1TransportException(Object.assign(new Error('x'), { code: 'CHECKPOINT_CORRUPT' })), 'CHECKPOINT_CORRUPT');
  assert.equal(classifyD1TransportException(new Error('network timeout')), 'D1_BATCH_AMBIGUOUS');
  assert.equal(classifyD1TransportException(new Error('unique slot conflict')), 'UNMAPPED');
  assert.equal(classifyD1TransportException(new Error('runtime stale')), 'STALE_RUNTIME');
  assert.equal(classifyD1TransportException(new Error('assignment stale')), 'STALE_ASSIGNMENT');
  assert.equal(classifyD1TransportException(new Error('database locked')), 'MUTATION_LANE_CONTENDED');
  assert.equal(classifyD1TransportException(new Error('something novel')), 'UNMAPPED');
});


test('real node:sqlite duplicate assignment slot maps to DUPLICATE_SLOT despite generic sqlite code', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(
    "CREATE TABLE queue_assignments (" +
      "target_account TEXT NOT NULL," +
      "resolved_at TEXT NOT NULL," +
      "status TEXT NOT NULL" +
    ");" +
    "CREATE UNIQUE INDEX queue_assignments_active_slot_uq " +
      "ON queue_assignments(target_account,resolved_at) WHERE status='active';",
  );
  db.prepare(
    "INSERT INTO queue_assignments(target_account,resolved_at,status) VALUES (?,?,?)",
  ).run('x-primary', '2026-09-30T10:00:00.000Z', 'active');

  let caught = null;
  try {
    db.prepare(
      "INSERT INTO queue_assignments(target_account,resolved_at,status) VALUES (?,?,?)",
    ).run('x-primary', '2026-09-30T10:00:00.000Z', 'active');
  } catch (error) {
    caught = error;
  }

  assert.ok(caught);
  assert.equal(typeof caught.code, 'string');
  assert.equal(classifyD1TransportException(caught), 'DUPLICATE_SLOT');
  db.close();
});

test('unrelated sqlite UNIQUE failures remain UNMAPPED', () => {
  const db = new DatabaseSync(':memory:');
  db.exec("CREATE TABLE queue_content(slot_label TEXT UNIQUE);");
  db.prepare("INSERT INTO queue_content(slot_label) VALUES (?)").run('morning');

  let caught = null;
  try {
    db.prepare("INSERT INTO queue_content(slot_label) VALUES (?)").run('morning');
  } catch (error) {
    caught = error;
  }

  assert.ok(caught);
  assert.equal(typeof caught.code, 'string');
  assert.equal(classifyD1TransportException(caught), 'UNMAPPED');
  db.close();
});
