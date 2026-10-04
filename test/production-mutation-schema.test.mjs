import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
  DUE_SLOT_EXCLUSION_MINUTES,
  PRODUCTION_SCHEMA_CONFIRM,
  PUBLICATION_SAFETY_SQL,
  bookmarkPrecedes,
  compareSchema,
  evaluateSchemaGates,
  expectedSchemaChange,
  isD1Bookmark,
  localMigrations,
  main,
  parseArgs,
  planSchemaMigration,
  replaySchema,
} from '../scripts/production-mutation-schema.mjs';
import { REQUIRED_MUTATION_MIGRATIONS } from '../scripts/production-mutation-intake.mjs';

const LOCAL = localMigrations();
const NAMES = LOCAL.map((item) => item.name);
const APPLIED_0014 = NAMES.filter((name) => !REQUIRED_MUTATION_MIGRATIONS.includes(name));
const SHA = 'a'.repeat(40);
const BOOKMARK_1 = '0000007b-0000b26e-00001538-0c3e87bb37b3db5cc52eedb93cd3b96b';
const BOOKMARK_2 = '0000007b-0000b26e-00001600-1c3e87bb37b3db5cc52eedb93cd3b96b';

function auth(overrides = {}) {
  return { ok: true, environment: 'production', d1: { readable: true }, ...overrides };
}

function candidate(overrides = {}) {
  return { branch: 'main', clean: true, headSha: SHA, originMainSha: SHA, ...overrides };
}

function safety(overrides = {}) {
  return {
    authority: {
      owner: 'cloudflare',
      generation: 6,
      transition_state: 'stable',
      candidate_sha: 'b'.repeat(40),
      deployment_id: 'cloudflare-worker:xqueue-publisher-production:version:827d3e0a',
    },
    halt: { halted: 0, generation: 9 },
    unresolvedAttemptCount: 0,
    heldLeaseCount: 0,
    leaseGeneration: 32,
    eventCursor: 64,
    runtimeSnapshotObserved: true,
    inflight: null,
    runtimeHead: { generation: 3, revision_digest: 'c'.repeat(64) },
    nextDue: '2026-10-05T19:30:00.000Z',
    dbNow: '2026-10-04T14:30:00.000Z',
    ...overrides,
  };
}

function safetyPayload(value) {
  return [
    { results: [value.authority] },
    { results: [value.halt] },
    { results: [{ unresolved: value.unresolvedAttemptCount }] },
    { results: [{ held_leases: value.heldLeaseCount }] },
    { results: [{ lease_generation: value.leaseGeneration }] },
    { results: [{ event_cursor: value.eventCursor }] },
    { results: value.runtimeSnapshotObserved ? [{ inflight: value.inflight }] : [] },
    { results: [value.runtimeHead] },
    { results: [{ next_due: value.nextDue }] },
    { results: [{ db_now: value.dbNow }] },
  ];
}

// Simulated production D1: the committed lane replayed into SQLite with a
// wrangler-style d1_migrations table. Safety reads are served from a script so
// tests can change publication state between reads.
function simulatedProduction({
  applied = APPLIED_0014,
  safetyReads = [safety()],
  drift = null,
  applyFailsAfter = null,
  applySilentlyStopsAfter = null,
  skipSqlFor = null,
  skipTrackingFor = null,
  afterApplySql = null,
} = {}) {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TEXT)');
  for (const name of applied) {
    db.exec(LOCAL.find((item) => item.name === name).sql);
    db.prepare("INSERT INTO d1_migrations (name, applied_at) VALUES (?, '2026-09-26 15:23:18')").run(name);
  }
  if (drift) db.exec(drift);

  const calls = [];
  let safetyIndex = 0;
  const run = (command, argv) => {
    const key = [command, ...argv].join(' ');
    calls.push(key);
    if (key === 'git branch --show-current') return 'main\n';
    if (key === 'git status --porcelain --untracked-files=all') return '';
    if (key === 'git fetch origin main') return '';
    if (key === 'git rev-parse HEAD' || key === 'git rev-parse origin/main') return SHA + '\n';
    if (key === 'pnpm cf:auth:preflight --environment production') return JSON.stringify(auth());
    if (key.startsWith('pnpm wrangler d1 migrations apply xqueue-production')) {
      assert.deepEqual(argv, [
        'wrangler', 'd1', 'migrations', 'apply', 'xqueue-production',
        '--config', 'wrangler.status.jsonc', '--remote',
      ]);
      const done = new Set(db.prepare('SELECT name FROM d1_migrations').all().map((row) => row.name));
      let count = 0;
      for (const migration of LOCAL.filter((item) => !done.has(item.name))) {
        if (applyFailsAfter !== null && count === applyFailsAfter) {
          throw new Error('wrangler d1 migrations apply failed: network connection lost');
        }
        if (applySilentlyStopsAfter !== null && count === applySilentlyStopsAfter) break;
        if (migration.name !== skipSqlFor) db.exec(migration.sql);
        if (migration.name !== skipTrackingFor) {
          db.prepare("INSERT INTO d1_migrations (name, applied_at) VALUES (?, '2026-10-04 15:00:00')").run(migration.name);
        }
        count += 1;
      }
      if (afterApplySql) db.exec(afterApplySql);
      return 'Migrations applied';
    }
    if (key.startsWith('pnpm wrangler d1 execute xqueue-production')) {
      const sql = argv[argv.indexOf('--command') + 1];
      if (sql === PUBLICATION_SAFETY_SQL) {
        const value = safetyReads[Math.min(safetyIndex, safetyReads.length - 1)];
        safetyIndex += 1;
        return JSON.stringify(safetyPayload(value));
      }
      const statements = sql.split(';').map((part) => part.trim()).filter(Boolean);
      return JSON.stringify(statements.map((statement) => ({
        results: db.prepare(statement).all().map((row) => ({ ...row })),
      })));
    }
    throw new Error('unexpected command: ' + key);
  };
  return { db, run, calls };
}

async function runMain(argv, deps) {
  const previous = process.exitCode;
  const output = mkdtempSync(join(tmpdir(), 'xqueue-schema-'));
  const log = console.log;
  console.log = () => {};
  try {
    const evidence = await main([...argv, '--output', output], {
      checkPublisher: () => ({ ok: false, reason: 'publisher_predates_mutation_mutex' }),
      ...deps,
    });
    const written = JSON.parse(readFileSync(join(output, 'production-mutation-schema-evidence.json'), 'utf8'));
    return { evidence, written, exitCode: process.exitCode };
  } finally {
    console.log = log;
    process.exitCode = previous;
  }
}

function applied(db) {
  return db.prepare('SELECT name FROM d1_migrations ORDER BY id').all().map((row) => row.name);
}

test('schema path requires explicit production and an exact apply confirmation', () => {
  assert.throws(() => parseArgs([]), /explicit --environment production/);
  assert.throws(
    () => parseArgs(['--environment', 'production', '--apply']),
    new RegExp('--apply requires --confirm ' + PRODUCTION_SCHEMA_CONFIRM),
  );
  assert.equal(parseArgs(['--environment', 'production']).apply, false);
  assert.equal(
    parseArgs(['--environment', 'production', '--apply', '--confirm', PRODUCTION_SCHEMA_CONFIRM]).apply,
    true,
  );
});

test('plan accepts only the exact mutation-control suffix on an exact production prefix', () => {
  const exact = planSchemaMigration({ applied: APPLIED_0014, local: LOCAL });
  assert.equal(exact.status, 'pending_exact');
  assert.deepEqual(exact.pending, REQUIRED_MUTATION_MIGRATIONS);

  assert.equal(planSchemaMigration({ applied: NAMES, local: LOCAL }).status, 'already_active');

  const partial = planSchemaMigration({ applied: [...APPLIED_0014, NAMES.at(-3)], local: LOCAL });
  assert.equal(partial.status, 'blocked');
  assert.ok(partial.blockers.some((item) => item.id === 'unexpected_pending_migrations'));

  const extra = planSchemaMigration({
    applied: APPLIED_0014,
    local: [...LOCAL, { name: '9999_future.sql', sql: 'SELECT 1;' }],
  });
  assert.ok(extra.blockers.some((item) => item.id === 'unexpected_pending_migrations'));

  const gap = planSchemaMigration({ applied: APPLIED_0014.filter((_, i) => i !== 2), local: LOCAL });
  assert.ok(gap.blockers.some((item) => item.id === 'applied_migrations_not_a_prefix'));

  const foreign = planSchemaMigration({ applied: [...APPLIED_0014, '0099_manual.sql'], local: LOCAL });
  assert.ok(foreign.blockers.some((item) => item.id === 'applied_migration_missing_locally'));
  assert.deepEqual(foreign.pending, []);
});

test('gates refuse unverified auth, inexact candidates, and unsafe publication state', () => {
  const plan = planSchemaMigration({ applied: APPLIED_0014, local: LOCAL });
  assert.equal(evaluateSchemaGates({ auth: auth(), candidate: candidate(), plan, safety: safety() }).ok, true);

  const cases = [
    [{ auth: auth({ ok: false }) }, 'production_auth_not_verified'],
    [{ candidate: candidate({ branch: 'feature' }) }, 'candidate_not_main'],
    [{ candidate: candidate({ clean: false }) }, 'candidate_dirty'],
    [{ candidate: candidate({ originMainSha: 'f'.repeat(40) }) }, 'candidate_not_exact_main'],
    [{ safety: safety({ authority: { ...safety().authority, transition_state: 'transitioning' } }) }, 'publication_authority_not_stable'],
    [{ safety: safety({ unresolvedAttemptCount: 1 }) }, 'unresolved_publication_attempt'],
    [{ safety: safety({ heldLeaseCount: 1 }) }, 'publication_lease_held'],
    [{ safety: safety({ inflight: '{"postId":"C1"}' }) }, 'runtime_inflight_or_unobserved'],
    [{ safety: safety({ runtimeSnapshotObserved: false }) }, 'runtime_inflight_or_unobserved'],
    [{ safety: safety({ nextDue: '2026-10-04T14:45:00.000Z' }) }, 'publication_window_too_close'],
    [{ safety: safety({ nextDue: '2026-10-04T14:20:00.000Z' }) }, 'publication_window_too_close'],
    [{ safety: safety({ dbNow: null }) }, 'database_clock_unreadable'],
  ];
  for (const [override, id] of cases) {
    const result = evaluateSchemaGates({ auth: auth(), candidate: candidate(), plan, safety: safety(), ...override });
    assert.equal(result.ok, false, id);
    assert.ok(result.blockers.some((item) => item.id === id), id);
  }
  assert.equal(DUE_SLOT_EXCLUSION_MINUTES, 30);
});

test('schema comparison requires the same objects bound to the same tables with identical SQL', () => {
  const expected = replaySchema(LOCAL, APPLIED_0014);
  assert.equal(compareSchema(expected, expected).identical, true);

  const [first, ...rest] = expected;
  assert.deepEqual(compareSchema(expected, rest).missing, [first.type + ':' + first.name]);
  assert.deepEqual(
    compareSchema(expected, [...expected, { type: 'table', name: 'rogue', tbl_name: 'rogue', sql: 'CREATE TABLE rogue (x)' }]).unexpected,
    ['table:rogue'],
  );
  assert.deepEqual(
    compareSchema(expected, [{ ...first, sql: first.sql + ' ' }, ...rest]).changed,
    [first.type + ':' + first.name],
  );
});

test('expected change is exactly the mutation-control objects and initial lane singletons', () => {
  const change = expectedSchemaChange(LOCAL, REQUIRED_MUTATION_MIGRATIONS);
  const names = change.objects.map((row) => row.name);
  for (const name of [
    'mutation_lane_state',
    'mutation_lane_halt_state',
    'mutation_operations',
    'mutation_operation_items',
    'publication_lease_mutation_lane_insert_guard',
    'publication_lease_mutation_lane_update_guard',
    'authority_event_mutation_lane_guard',
    'authority_state_mutation_lane_guard',
  ]) {
    assert.ok(names.includes(name), name);
  }
  assert.ok(change.objects.every((row) =>
    /^(mutation_|publication_lease_mutation_lane_|authority_(event|state)_mutation_lane_guard$)/.test(row.name)));
  assert.deepEqual(change.singletons, {
    mutation_lane_state: [{ singleton_id: 1, generation: 1, active_operation_id: null, actor_class: 'migration' }],
    mutation_lane_halt_state: [{ singleton_id: 1, halted: 0, generation: 1, reason: 'initial_unhalted', actor_class: 'migration' }],
  });
});

test('D1 bookmarks are validated and ordered lexically, as documented', () => {
  assert.equal(isD1Bookmark(BOOKMARK_1), true);
  assert.equal(isD1Bookmark('bookmark_12345'), false);
  assert.equal(bookmarkPrecedes(BOOKMARK_1, BOOKMARK_2), true);
  assert.equal(bookmarkPrecedes(BOOKMARK_1, BOOKMARK_1), true);
  assert.equal(bookmarkPrecedes(BOOKMARK_2, BOOKMARK_1), false);
  assert.equal(bookmarkPrecedes(BOOKMARK_1, null), false);
});

test('observe mode proves compatibility and identities without changing production', async () => {
  const sim = simulatedProduction();
  let bookmarks = 0;
  const { evidence, written, exitCode } = await runMain(['--environment', 'production'], {
    run: sim.run,
    captureBookmark: async () => { bookmarks += 1; return BOOKMARK_1; },
  });

  assert.equal(evidence.status, 'ready');
  assert.equal(exitCode, undefined);
  assert.equal(written.status, 'ready');
  assert.equal(evidence.compatibility.identical, true);
  assert.deepEqual(evidence.migrations.plan.pending, REQUIRED_MUTATION_MIGRATIONS);
  assert.deepEqual(
    evidence.migrations.identities.map((item) => item.name),
    REQUIRED_MUTATION_MIGRATIONS,
  );
  for (const item of evidence.migrations.identities) {
    assert.match(item.sha256, /^[0-9a-f]{64}$/);
    assert.match(item.gitBlob, /^[0-9a-f]{40}$/);
  }
  assert.equal(evidence.publisherMutex.reason, 'publisher_predates_mutation_mutex');
  assert.equal(bookmarks, 0);
  assert.deepEqual(applied(sim.db), APPLIED_0014);
  assert.equal(sim.calls.some((key) => key.includes('migrations apply')), false);
});

test('apply checkpoints, applies exactly 0015-0017, and proves the schema by readback', async () => {
  const sim = simulatedProduction();
  const bookmarks = [BOOKMARK_1, BOOKMARK_2];
  const { evidence, exitCode } = await runMain(
    ['--environment', 'production', '--apply', '--confirm', PRODUCTION_SCHEMA_CONFIRM],
    { run: sim.run, captureBookmark: async () => bookmarks.shift() },
  );

  assert.equal(evidence.status, 'applied', JSON.stringify(evidence.blockers));
  assert.equal(exitCode, undefined);
  assert.equal(evidence.checkpoint.bookmark, BOOKMARK_1);
  assert.equal(evidence.readback.migrationsExact, true);
  assert.equal(evidence.readback.schema.identical, true);
  assert.equal(evidence.readback.singletonsExact, true);
  assert.equal(evidence.readback.authorityUnchanged, true);
  assert.equal(evidence.readback.checkpointPrecedesApply, true);
  assert.deepEqual(applied(sim.db), NAMES);
  assert.equal(sim.calls.filter((key) => key.includes('migrations apply')).length, 1);
});

test('apply refuses when publication state moves between checkpoint and apply', async () => {
  const sim = simulatedProduction({
    safetyReads: [safety(), safety({ leaseGeneration: 33, eventCursor: 65 })],
  });
  const { evidence, exitCode } = await runMain(
    ['--environment', 'production', '--apply', '--confirm', PRODUCTION_SCHEMA_CONFIRM],
    { run: sim.run, captureBookmark: async () => BOOKMARK_1 },
  );

  assert.equal(evidence.status, 'blocked');
  assert.equal(exitCode, 1);
  assert.ok(evidence.blockers.some((item) => item.id === 'publication_state_changed_before_apply'));
  assert.deepEqual(applied(sim.db), APPLIED_0014);
  assert.equal(sim.calls.some((key) => key.includes('migrations apply')), false);
});

test('schema drift blocks apply instead of being papered over', async () => {
  const sim = simulatedProduction({ drift: 'CREATE TABLE operator_scratch (x TEXT)' });
  const { evidence, exitCode } = await runMain(
    ['--environment', 'production', '--apply', '--confirm', PRODUCTION_SCHEMA_CONFIRM],
    { run: sim.run, captureBookmark: async () => BOOKMARK_1 },
  );

  assert.equal(evidence.status, 'blocked');
  assert.equal(exitCode, 1);
  assert.deepEqual(evidence.compatibility.unexpected, ['table:operator_scratch']);
  assert.ok(evidence.blockers.some((item) => item.id === 'production_schema_drift'));
  assert.deepEqual(applied(sim.db), APPLIED_0014);
});

test('a failed apply is read back and reported for reconciliation, never retried', async () => {
  const sim = simulatedProduction({ applyFailsAfter: 1 });
  const bookmarks = [BOOKMARK_1, BOOKMARK_2];
  const { evidence, exitCode } = await runMain(
    ['--environment', 'production', '--apply', '--confirm', PRODUCTION_SCHEMA_CONFIRM],
    { run: sim.run, captureBookmark: async () => bookmarks.shift() },
  );

  assert.equal(evidence.status, 'requires_reconciliation');
  assert.equal(exitCode, 1);
  assert.match(evidence.applyError, /network connection lost/);
  assert.deepEqual(evidence.readback.appliedAfter, [...APPLIED_0014, REQUIRED_MUTATION_MIGRATIONS[0]]);
  assert.equal(evidence.readback.migrationsExact, false);
  assert.equal(evidence.readback.schema.identical, false);
  assert.ok(evidence.blockers.some((item) => item.id === 'apply_command_failed'));
  assert.equal(sim.calls.filter((key) => key.includes('migrations apply')).length, 1);
});

test('a successful-looking apply that readback contradicts is never reported as applied', async () => {
  const sim = simulatedProduction({ applySilentlyStopsAfter: 2 });
  const bookmarks = [BOOKMARK_1, BOOKMARK_2];
  const { evidence, exitCode } = await runMain(
    ['--environment', 'production', '--apply', '--confirm', PRODUCTION_SCHEMA_CONFIRM],
    { run: sim.run, captureBookmark: async () => bookmarks.shift() },
  );

  assert.equal(evidence.applyError, null);
  assert.equal(evidence.status, 'requires_reconciliation');
  assert.equal(exitCode, 1);
  assert.equal(evidence.readback.migrationsExact, false);
  assert.ok(evidence.readback.schema.missing.includes('trigger:publication_lease_mutation_lane_insert_guard'));
  assert.ok(evidence.blockers.some((item) => item.id === 'post_apply_readback_contradicts_plan'));
});

test('tracking that claims a migration whose schema never landed is contradictory', async () => {
  const sim = simulatedProduction({ skipSqlFor: REQUIRED_MUTATION_MIGRATIONS[2] });
  const bookmarks = [BOOKMARK_1, BOOKMARK_2];
  const { evidence } = await runMain(
    ['--environment', 'production', '--apply', '--confirm', PRODUCTION_SCHEMA_CONFIRM],
    { run: sim.run, captureBookmark: async () => bookmarks.shift() },
  );

  assert.equal(evidence.readback.migrationsExact, true);
  assert.equal(evidence.readback.schema.identical, false);
  assert.equal(evidence.status, 'requires_reconciliation');
});

test('schema that landed without its tracking row is contradictory', async () => {
  const sim = simulatedProduction({ skipTrackingFor: REQUIRED_MUTATION_MIGRATIONS[2] });
  const bookmarks = [BOOKMARK_1, BOOKMARK_2];
  const { evidence } = await runMain(
    ['--environment', 'production', '--apply', '--confirm', PRODUCTION_SCHEMA_CONFIRM],
    { run: sim.run, captureBookmark: async () => bookmarks.shift() },
  );

  assert.equal(evidence.readback.schema.identical, true);
  assert.equal(evidence.readback.migrationsExact, false);
  assert.equal(evidence.status, 'requires_reconciliation');
});

test('lane singletons that differ from the migration initial state are contradictory', async () => {
  const sim = simulatedProduction({
    afterApplySql:
      "UPDATE mutation_lane_halt_state SET halted=1, generation=2, reason='concurrent actor', " +
      "actor_class='automation', updated_at='2026-10-04T15:00:01.000Z' WHERE singleton_id=1",
  });
  const bookmarks = [BOOKMARK_1, BOOKMARK_2];
  const { evidence } = await runMain(
    ['--environment', 'production', '--apply', '--confirm', PRODUCTION_SCHEMA_CONFIRM],
    { run: sim.run, captureBookmark: async () => bookmarks.shift() },
  );

  assert.equal(evidence.readback.migrationsExact, true);
  assert.equal(evidence.readback.schema.identical, true);
  assert.equal(evidence.readback.singletonsExact, false);
  assert.equal(evidence.status, 'requires_reconciliation');
});

test('publication authority that moves during the apply is contradictory', async () => {
  const moved = safety({ authority: { ...safety().authority, generation: 7 } });
  const sim = simulatedProduction({ safetyReads: [safety(), safety(), moved] });
  const bookmarks = [BOOKMARK_1, BOOKMARK_2];
  const { evidence } = await runMain(
    ['--environment', 'production', '--apply', '--confirm', PRODUCTION_SCHEMA_CONFIRM],
    { run: sim.run, captureBookmark: async () => bookmarks.shift() },
  );

  assert.equal(evidence.readback.schema.identical, true);
  assert.equal(evidence.readback.authorityUnchanged, false);
  assert.equal(evidence.status, 'requires_reconciliation');
});

test('a checkpoint that cannot be shown to precede the apply is not proof', async () => {
  for (const after of [BOOKMARK_1.replace('00001538', '00000001'), null]) {
    const sim = simulatedProduction();
    const bookmarks = [BOOKMARK_1, after];
    const { evidence } = await runMain(
      ['--environment', 'production', '--apply', '--confirm', PRODUCTION_SCHEMA_CONFIRM],
      {
        run: sim.run,
        captureBookmark: async () => {
          const next = bookmarks.shift();
          if (next === null) throw new Error('bookmark request failed');
          return next;
        },
      },
    );
    assert.equal(evidence.readback.schema.identical, true);
    assert.equal(evidence.readback.checkpointPrecedesApply, false);
    assert.equal(evidence.status, 'requires_reconciliation');
  }
});

test('missing checkpoint and an already-active schema never reach the apply command', async () => {
  const noCheckpoint = simulatedProduction();
  const blocked = await runMain(
    ['--environment', 'production', '--apply', '--confirm', PRODUCTION_SCHEMA_CONFIRM],
    {
      run: noCheckpoint.run,
      captureBookmark: async () => { throw new Error('D1 Time Travel bookmark request failed'); },
    },
  );
  assert.equal(blocked.evidence.status, 'blocked');
  assert.ok(blocked.evidence.blockers.some((item) => item.id === 'recovery_checkpoint_unavailable'));
  assert.equal(noCheckpoint.calls.some((key) => key.includes('migrations apply')), false);

  const malformed = simulatedProduction();
  const badBookmark = await runMain(
    ['--environment', 'production', '--apply', '--confirm', PRODUCTION_SCHEMA_CONFIRM],
    { run: malformed.run, captureBookmark: async () => 'bookmark_12345' },
  );
  assert.equal(badBookmark.evidence.status, 'blocked');
  assert.equal(malformed.calls.some((key) => key.includes('migrations apply')), false);

  const active = simulatedProduction({ applied: NAMES });
  const already = await runMain(
    ['--environment', 'production', '--apply', '--confirm', PRODUCTION_SCHEMA_CONFIRM],
    { run: active.run, captureBookmark: async () => BOOKMARK_1 },
  );
  assert.equal(already.evidence.status, 'already_active');
  assert.equal(already.exitCode, undefined);
  assert.equal(active.calls.some((key) => key.includes('migrations apply')), false);
});
