import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import controlWorker, {
  validateMutationStatement,
} from '../cloudflare/src/production-control-local.mjs';
import {
  splitSqlStatements,
} from '../src/production-control-client.mjs';

function readJsonc(path) {
  return JSON.parse(
    readFileSync(new URL('../' + path, import.meta.url), 'utf8')
      .replace(/^\s*\/\/.*$/gm, ''),
  );
}

function fakeDb() {
  const prepared = [];
  const batches = [];
  return {
    prepared,
    batches,
    prepare(sql) {
      const statement = {
        sql,
        params: [],
        bind(...params) {
          return { ...statement, params };
        },
      };
      prepared.push(statement);
      return statement;
    },
    async batch(statements) {
      batches.push(statements);
      return statements.map(() => ({
        success: true,
        results: [],
        meta: { changes: 0 },
      }));
    },
  };
}

test('production control allows only known queue mutation tables', () => {
  assert.equal(
    validateMutationStatement(
      "UPDATE queue_content SET status='retired' WHERE content_id='A1'",
    ).table,
    'queue_content',
  );
  assert.equal(
    validateMutationStatement(
      "INSERT OR IGNORE INTO queue_assignments (assignment_id) VALUES ('A1')",
    ).table,
    'queue_assignments',
  );

  assert.throws(
    () => validateMutationStatement(
      "UPDATE authority_state SET owner='none' WHERE singleton_id=1",
    ),
    /not allowed: authority_state/,
  );
  assert.throws(
    () => validateMutationStatement(
      "UPDATE publication_halt_state SET halted=0 WHERE singleton_id=1",
    ),
    /not allowed: publication_halt_state/,
  );
  assert.throws(
    () => validateMutationStatement('DROP TABLE queue_content'),
    /transaction\/schema-control SQL is forbidden/,
  );
  assert.throws(
    () => validateMutationStatement('BEGIN IMMEDIATE'),
    /transaction\/schema-control SQL is forbidden/,
  );
});

test('SQL splitter preserves semicolons inside exact content literals', () => {
  const statements = splitSqlStatements(
    "INSERT INTO queue_content_events(detail) VALUES ('one;two');" +
    "UPDATE queue_content SET intake_state='scheduled' WHERE content_id='A1';",
  );
  assert.equal(statements.length, 2);
  assert.match(statements[0], /one;two/);
  assert.match(statements[1], /^UPDATE queue_content/);
});

test('localhost control Worker rejects missing token before D1 access', async () => {
  const DB = fakeDb();
  const response = await controlWorker.fetch(
    new Request('http://127.0.0.1/batch', {
      method: 'POST',
      body: JSON.stringify({}),
      headers: { 'content-type': 'application/json' },
    }),
    { DB, XQUEUE_CONTROL_TOKEN: 'secret' },
  );

  assert.equal(response.status, 401);
  assert.equal(DB.batches.length, 0);
});

test('control Worker inserts exact production guard before queue mutation batch', async () => {
  const DB = fakeDb();
  const response = await controlWorker.fetch(
    new Request('http://127.0.0.1/batch', {
      method: 'POST',
      headers: {
        authorization: 'Bearer secret',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        operationKind: 'owner-operation',
        expected: {
          haltGeneration: 8,
          candidateSha: 'a'.repeat(40),
          deploymentId:
            'cloudflare-worker:xqueue-publisher-production:version:' +
            '30c688d4-8718-4bf7-b1c1-d8d146adafea',
        },
        statements: [
          "UPDATE queue_content SET intake_state='scheduled' WHERE content_id='A1'",
        ],
      }),
    }),
    { DB, XQUEUE_CONTROL_TOKEN: 'secret' },
  );

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.equal(DB.batches.length, 1);
  assert.equal(DB.batches[0].length, 2);

  const guard = DB.batches[0][0];
  assert.match(guard.sql, /publication_halt_state/);
  assert.match(guard.sql, /authority_state/);
  assert.match(guard.sql, /publication_leases/);
  assert.match(guard.sql, /needs_reconciliation/);
  assert.deepEqual(guard.params, [
    8,
    'a'.repeat(40),
    'cloudflare-worker:xqueue-publisher-production:version:' +
      '30c688d4-8718-4bf7-b1c1-d8d146adafea',
  ]);
});

test('control Worker refuses authority mutation before DB.batch', async () => {
  const DB = fakeDb();
  const response = await controlWorker.fetch(
    new Request('http://127.0.0.1/batch', {
      method: 'POST',
      headers: {
        authorization: 'Bearer secret',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        operationKind: 'malicious-test',
        expected: {
          haltGeneration: 8,
          candidateSha: 'a'.repeat(40),
          deploymentId:
            'cloudflare-worker:xqueue-publisher-production:version:' +
            '30c688d4-8718-4bf7-b1c1-d8d146adafea',
        },
        statements: [
          "UPDATE authority_state SET owner='none' WHERE singleton_id=1",
        ],
      }),
    }),
    { DB, XQUEUE_CONTROL_TOKEN: 'secret' },
  );

  assert.equal(response.status, 400);
  assert.equal(DB.batches.length, 0);
});

test('control config is remote-production-D1 only and has no publish/media/scheduler capability', () => {
  const config = readJsonc('wrangler.control.jsonc');

  assert.equal(config.name, 'xqueue-production-control-local');
  assert.equal(config.main, 'cloudflare/src/production-control-local.mjs');
  assert.equal(config.d1_databases?.length, 1);
  assert.equal(
    config.d1_databases?.[0]?.database_id,
    'fc85026e-bfc8-435f-8bb0-c60e139178a3',
  );
  assert.equal(config.d1_databases?.[0]?.remote, true);
  assert.equal(config.r2_buckets, undefined);
  assert.equal(config.triggers, undefined);
  assert.equal(config.services, undefined);
  assert.equal(config.vars, undefined);
});
