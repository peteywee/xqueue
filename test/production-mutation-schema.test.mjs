import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
  DUE_SLOT_EXCLUSION_MINUTES,
  PRODUCTION_SCHEMA_CONFIRM,
  PUBLICATION_SAFETY_SQL,
  bookmarkStrictlyPrecedes,
  compareSchema,
  evaluateSchemaGates,
  expectedSchemaChange,
  intakeFrontierReady,
  intakeFrontierSeedable,
  isD1Bookmark,
  localMigrations,
  main,
  parseArgs,
  planSchemaMigration,
  replaySchema,
} from '../scripts/production-mutation-schema.mjs';
import { REQUIRED_MUTATION_MIGRATIONS, defaultProbeWorkersAccess } from '../scripts/production-mutation-intake.mjs';

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
  onApply = null,
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
    if (key === 'git rev-parse HEAD' || key === 'git rev-parse FETCH_HEAD') return SHA + '\n';
    if (key === 'pnpm cf:auth:preflight --environment production') return JSON.stringify(auth());
    if (key.startsWith('git ls-tree HEAD -- ')) {
      const dir = argv[3].replace(/\/$/, '');
      return LOCAL.map((item) => '100644 blob ' + item.gitBlob + '\t' + dir + '/' + item.name).join('\n') + '\n';
    }
    if (key.startsWith('pnpm wrangler d1 migrations apply xqueue-production')) {
      onApply?.();
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
      const execute = (text) => text.split(';').map((part) => part.trim()).filter(Boolean).map((statement) => ({
        results: db.prepare(statement).all().map((row) => ({ ...row })),
      }));
      if (sql.startsWith(PUBLICATION_SAFETY_SQL)) {
        // Publication facts are scripted; anything batched after them (the
        // post-checkpoint re-read) runs against the simulated database.
        const value = safetyReads[Math.min(safetyIndex, safetyReads.length - 1)];
        safetyIndex += 1;
        return JSON.stringify([...safetyPayload(value), ...execute(sql.slice(PUBLICATION_SAFETY_SQL.length))]);
      }
      return JSON.stringify(execute(sql));
    }
    throw new Error('unexpected command: ' + key);
  };
  return { db, run, calls };
}

const GOVERNED_ENV = Object.freeze({
  GITHUB_ACTIONS: 'true',
  GITHUB_WORKFLOW: 'Production Mutation Schema',
  GITHUB_REF: 'refs/heads/main',
  GITHUB_WORKFLOW_REF: 'peteywee/xqueue/.github/workflows/production-mutation-schema.yml@refs/heads/main',
  CLOUDFLARE_ACCOUNT_ID: 'acct',
  CLOUDFLARE_API_TOKEN: 'd1-scoped-token',
});

async function runMain(argv, { output: outputDir = null, ...deps } = {}) {
  const previous = process.exitCode;
  const output = outputDir ?? mkdtempSync(join(tmpdir(), 'xqueue-schema-'));
  const log = console.log;
  console.log = () => {};
  try {
    const evidence = await main([...argv, '--output', output], {
      checkPublisher: () => ({ ok: false, reason: 'publisher_predates_mutation_mutex' }),
      probeWorkersAccess: async () => 'denied',
      env: GOVERNED_ENV,
      ...deps,
    });
    const files = readdirSync(output).sort();
    if (!outputDir) assert.equal(files.length, 1, 'one evidence file per run');
    const written = JSON.parse(readFileSync(join(output, files.at(-1)), 'utf8'));
    return { evidence, written, files, exitCode: process.exitCode };
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

  const partial = planSchemaMigration({ applied: [...APPLIED_0014, REQUIRED_MUTATION_MIGRATIONS[0]], local: LOCAL });
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
    // Overdue slots count: an unhalted publisher defers them at its next tick.
    [{ safety: safety({ nextDue: '2026-10-04T09:00:00.000Z' }) }, 'publication_window_too_close'],
    [{ safety: safety({ nextDue: 'garbage' }) }, 'next_due_unreadable'],
  ];
  // A halted publisher idles before any lease, deferral or post, so due slots
  // cannot act while halted.
  for (const nextDue of ['2026-10-04T09:00:00.000Z', '2026-10-04T14:35:00.000Z', 'garbage']) {
    const haltedGates = evaluateSchemaGates({
      auth: auth(), candidate: candidate(), plan, safety: safety({ nextDue, halt: { halted: 1, generation: 10 } }),
    });
    assert.equal(haltedGates.ok, true, nextDue);
  }
  for (const [override, id] of cases) {
    const result = evaluateSchemaGates({ auth: auth(), candidate: candidate(), plan, safety: safety(), ...override });
    assert.equal(result.ok, false, id);
    assert.ok(result.blockers.some((item) => item.id === id), id);
  }
  assert.equal(DUE_SLOT_EXCLUSION_MINUTES, 30);

  // A failed origin fetch is reported with its cause, never as exact main.
  const unfetched = evaluateSchemaGates({
    auth: auth(),
    candidate: candidate({ originMainSha: null, originMainError: 'Could not resolve host: github.com' }),
    plan,
    safety: safety(),
  });
  const exact = unfetched.blockers.find((item) => item.id === 'candidate_not_exact_main');
  assert.match(exact.detail, /Cause: git fetch origin main failed: Could not resolve host/);
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
  assert.equal(bookmarkStrictlyPrecedes(BOOKMARK_1, BOOKMARK_2), true);
  assert.equal(bookmarkStrictlyPrecedes(BOOKMARK_1, BOOKMARK_1), false, 'an apply writes, so equal is not later');
  assert.equal(bookmarkStrictlyPrecedes(BOOKMARK_2, BOOKMARK_1), false);
  assert.equal(bookmarkStrictlyPrecedes(BOOKMARK_1, null), false);
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
  assert.ok(evidence.blockers.some((item) => item.id === 'migrations_readback_mismatch'));
  assert.ok(evidence.blockers.some((item) => item.id === 'schema_readback_mismatch'));
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

const APPLY = ['--environment', 'production', '--apply', '--confirm', PRODUCTION_SCHEMA_CONFIRM];

test('an apply that fails before 0015 lands still reads back and records everything', async () => {
  const sim = simulatedProduction({ applyFailsAfter: 0 });
  const bookmarks = [BOOKMARK_1, BOOKMARK_2];
  const { evidence, written, exitCode } = await runMain(APPLY, { run: sim.run, captureBookmark: async () => bookmarks.shift() });
  assert.equal(evidence.status, 'requires_reconciliation');
  assert.equal(written.status, 'requires_reconciliation');
  assert.equal(exitCode, 1);
  assert.equal(written.checkpoint.bookmark, BOOKMARK_1);
  assert.match(evidence.readback.errors.singletons, /no such table: mutation_lane_state/);
  assert.deepEqual(evidence.readback.appliedAfter, APPLIED_0014);
  const ids = evidence.blockers.map((item) => item.id);
  for (const id of ['apply_command_failed', 'readback_unavailable', 'migrations_readback_mismatch', 'schema_readback_mismatch']) {
    assert.ok(ids.includes(id), id);
  }
});

test('the recovery checkpoint is on disk before production changes', async () => {
  const output = mkdtempSync(join(tmpdir(), 'xqueue-schema-'));
  let seen = null;
  const sim = simulatedProduction({
    onApply: () => {
      const files = readdirSync(output);
      seen = JSON.parse(readFileSync(join(output, files[0]), 'utf8'));
    },
  });
  const bookmarks = [BOOKMARK_1, BOOKMARK_2];
  const { evidence } = await runMain(APPLY, { output, run: sim.run, captureBookmark: async () => bookmarks.shift() });
  assert.equal(seen.status, 'applying');
  assert.equal(seen.checkpoint.bookmark, BOOKMARK_1);
  assert.equal(evidence.status, 'applied');
  assert.equal(readdirSync(output).length, 1, 'the final evidence replaces the in-progress file of the same run');
});

test('runs never overwrite each other\'s evidence', async () => {
  const output = mkdtempSync(join(tmpdir(), 'xqueue-schema-'));
  const times = ['2026-10-04T15:00:00.000Z', '2026-10-04T15:05:00.000Z'];
  for (const time of times) {
    await runMain(['--environment', 'production'], { output, run: simulatedProduction().run, now: () => new Date(time) });
  }
  assert.deepEqual(readdirSync(output).sort(), [
    'production-mutation-schema-evidence-observe-2026-10-04T15-00-00-000Z.json',
    'production-mutation-schema-evidence-observe-2026-10-04T15-05-00-000Z.json',
  ]);
});

test('wrangler-visible migration files outside the committed lane block the plan', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'xqueue-migrations-'));
  for (const item of LOCAL) writeFileSync(join(dir, item.name), item.sql);
  writeFileSync(join(dir, '.hidden.sql'), 'SELECT 1;'); // wrangler ignores dot files
  const clean = await runMain(['--environment', 'production'], { run: simulatedProduction().run, migrationsDir: dir });
  assert.equal(clean.evidence.status, 'ready');

  writeFileSync(join(dir, '0017_publication_mutation_mutex.pre-guards.sql'), 'SELECT 1;');
  const stray = await runMain(['--environment', 'production'], { run: simulatedProduction().run, migrationsDir: dir });
  assert.equal(stray.evidence.status, 'blocked');
  assert.match(
    stray.evidence.blockers.find((item) => item.id === 'unrecognized_migration_file').detail,
    /0017_publication_mutation_mutex\.pre-guards\.sql/,
  );

  const edited = mkdtempSync(join(tmpdir(), 'xqueue-migrations-'));
  for (const item of LOCAL) writeFileSync(join(edited, item.name), item.name === '0016_mutation_completion_item_guard.sql' ? item.sql + '\n-- edited\n' : item.sql);
  const changed = await runMain(['--environment', 'production'], { run: simulatedProduction().run, migrationsDir: edited });
  assert.match(
    changed.evidence.blockers.find((item) => item.id === 'migration_file_not_committed').detail,
    /0016_mutation_completion_item_guard\.sql/,
  );
});

test('the configured database and migrations directory must be the ones the checkpoint covers', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'xqueue-config-'));
  const base = JSON.parse(readFileSync('wrangler.status.jsonc', 'utf8').replace(/^\s*\/\/.*$/gm, ''));
  const write = (mutate) => {
    const config = structuredClone(base);
    mutate(config.d1_databases.find((item) => item.database_name === 'xqueue-production'));
    const path = join(dir, 'config-' + Math.random().toString(16).slice(2) + '.jsonc');
    writeFileSync(path, JSON.stringify(config));
    return path;
  };
  for (const mutate of [
    (db) => { db.database_id = '00000000-0000-0000-0000-000000000000'; },
    (db) => { db.migrations_dir = 'cloudflare/migrations'; },
    (db) => { db.migrations_pattern = 'cloudflare/migrations-production/**/*.sql'; },
  ]) {
    const { evidence } = await runMain(['--environment', 'production'], { run: simulatedProduction().run, configPath: write(mutate) });
    assert.ok(evidence.blockers.some((item) => item.id === 'production_config_mismatch'));
  }
});

test('a schema credential with Workers access, or unproven scope, is refused', async () => {
  for (const [probe, id] of [
    [async () => 'granted', 'schema_token_overscoped'],
    [async () => { throw new Error('HTTP 500'); }, 'schema_token_scope_unverified'],
  ]) {
    const { evidence } = await runMain(['--environment', 'production'], { run: simulatedProduction().run, probeWorkersAccess: probe });
    assert.equal(evidence.status, 'blocked');
    assert.ok(evidence.blockers.some((item) => item.id === id), id);
  }
});

test('apply runs only inside the governed workflow on main', async () => {
  for (const env of [
    {},
    { ...GOVERNED_ENV, GITHUB_ACTIONS: undefined },
    { ...GOVERNED_ENV, GITHUB_WORKFLOW: 'Other' },
    { ...GOVERNED_ENV, GITHUB_REF: 'refs/heads/feature' },
  ]) {
    const sim = simulatedProduction();
    const { evidence } = await runMain(APPLY, { run: sim.run, env, captureBookmark: async () => BOOKMARK_1 });
    assert.equal(evidence.status, 'blocked');
    assert.ok(evidence.blockers.some((item) => item.id === 'apply_outside_governed_workflow'));
    assert.equal(sim.calls.some((key) => key.includes('migrations apply')), false);
  }
  // Observe is read-only and runs anywhere.
  const { evidence } = await runMain(['--environment', 'production'], { run: simulatedProduction().run, env: {} });
  assert.equal(evidence.status, 'ready');
});

test('runtime or migration changes after the checkpoint stop the apply', async () => {
  const moved = simulatedProduction({
    safetyReads: [safety(), safety({ runtimeHead: { generation: 4, revision_digest: 'd'.repeat(64) } })],
  });
  const runtime = await runMain(APPLY, { run: moved.run, captureBookmark: async () => BOOKMARK_1 });
  assert.ok(runtime.evidence.blockers.some((item) => item.id === 'publication_state_changed_before_apply'));
  assert.equal(moved.calls.some((key) => key.includes('migrations apply')), false);

  const raced = simulatedProduction();
  const concurrent = await runMain(APPLY, {
    run: raced.run,
    captureBookmark: async () => {
      // Another apply records 0015 between our checkpoint and fresh read.
      raced.db.prepare("INSERT INTO d1_migrations (name, applied_at) VALUES ('0015_mutation_control_plane.sql', 'x')").run();
      return BOOKMARK_1;
    },
  });
  assert.ok(concurrent.evidence.blockers.some((item) => item.id === 'migration_state_changed_before_apply'));
  assert.equal(raced.calls.some((key) => key.includes('migrations apply')), false);
});

test('publication activity during the apply is reported, not hidden behind "applied"', async () => {
  const sim = simulatedProduction({ safetyReads: [safety(), safety(), safety({ eventCursor: 65, leaseGeneration: 33 })] });
  const bookmarks = [BOOKMARK_1, BOOKMARK_2];
  const { evidence } = await runMain(APPLY, { run: sim.run, captureBookmark: async () => bookmarks.shift() });
  assert.equal(evidence.status, 'requires_reconciliation');
  assert.equal(evidence.readback.schema.identical, true, 'the schema itself is reported as exact');
  assert.equal(evidence.readback.publicationQuiet, false);
  assert.ok(evidence.blockers.some((item) => item.id === 'publication_activity_during_apply'));
});

test('each failed proof is named on its own, with its cause', async () => {
  const noPost = simulatedProduction();
  const bookmarks = [BOOKMARK_1];
  const { evidence } = await runMain(APPLY, {
    run: noPost.run,
    captureBookmark: async () => {
      if (bookmarks.length === 0) throw new Error('Time Travel HTTP 503');
      return bookmarks.shift();
    },
  });
  assert.equal(evidence.status, 'requires_reconciliation');
  assert.equal(evidence.readback.schema.identical, true);
  assert.equal(evidence.readback.migrationsExact, true);
  assert.deepEqual(evidence.blockers.map((item) => item.id), ['readback_unavailable']);
  assert.match(evidence.blockers[0].detail, /^postCheckpoint: Time Travel HTTP 503$/);

  // An unchanged bookmark cannot follow an apply that wrote.
  const same = await runMain(APPLY, { run: simulatedProduction().run, captureBookmark: async () => BOOKMARK_1 });
  assert.deepEqual(same.evidence.blockers.map((item) => item.id), ['checkpoint_not_before_apply']);
});

test('drift with names that LIKE wildcards would hide is still detected', async () => {
  const sim = simulatedProduction({ drift: 'CREATE TABLE xcf_scratch (x INTEGER)' });
  const { evidence } = await runMain(['--environment', 'production'], { run: sim.run });
  assert.equal(evidence.status, 'blocked');
  assert.ok(evidence.compatibility.unexpected.includes('table:xcf_scratch'));
});

test('the next-due read covers every slot an unhalted publisher may take its lease for', () => {
  const statement = PUBLICATION_SAFETY_SQL.split(';').map((part) => part.trim()).find((part) => part.includes('next_due'));
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('CREATE TABLE queue_assignments (content_id TEXT, status TEXT, lifecycle_state TEXT, resolved_at TEXT)');
    db.exec('CREATE TABLE publication_state (post_id TEXT, status TEXT)');
    const add = (id, status, lifecycle, at, publication) => {
      db.prepare('INSERT INTO queue_assignments VALUES (?,?,?,?)').run(id, status, lifecycle, at);
      if (publication) db.prepare('INSERT INTO publication_state VALUES (?,?)').run(id, publication);
    };
    add('posted', 'active', 'scheduled', '1990-01-01T00:00:00.000Z', 'posted');
    add('skipped', 'active', 'scheduled', '1991-01-01T00:00:00.000Z', 'skipped');
    add('deferred', 'active', 'deferred', '1993-01-01T00:00:00.000Z', 'scheduled');
    add('superseded', 'superseded', 'scheduled', '1994-01-01T00:00:00.000Z', 'scheduled');
    add('overdue', 'active', 'scheduled', '2000-01-01T00:00:00.000Z', 'scheduled');
    add('future', 'active', 'scheduled', '2999-01-01T00:00:00.000Z', 'scheduled');
    assert.equal(db.prepare(statement).get().next_due, '2000-01-01T00:00:00.000Z');
    // No publication_state row: the publisher still takes its lease for it.
    add('orphan', 'active', 'scheduled', '1992-01-01T00:00:00.000Z', null);
    assert.equal(db.prepare(statement).get().next_due, '1992-01-01T00:00:00.000Z');
    db.exec("DELETE FROM queue_assignments WHERE content_id IN ('overdue','future','orphan')");
    assert.equal(db.prepare(statement).get().next_due, null, 'resolved slots never block');
  } finally {
    db.close();
  }
});

test('pending migrations must replay locally before production is touched', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'xqueue-migrations-'));
  for (const item of LOCAL) {
    writeFileSync(join(dir, item.name), item.name === '0017_publication_mutation_mutex.sql' ? 'CREATE TRIGGER broken;' : item.sql);
  }
  const sim = simulatedProduction();
  const { evidence } = await runMain(APPLY, { run: sim.run, migrationsDir: dir, captureBookmark: async () => BOOKMARK_1 });
  assert.equal(evidence.status, 'blocked');
  assert.ok(evidence.blockers.some((item) => item.id === 'pending_migrations_do_not_replay'));
  assert.equal(sim.calls.some((key) => key.includes('migrations apply')), false);
});

test('schema drift or a closing window after the checkpoint stops the apply, with accurate blockers', async () => {
  const drifted = simulatedProduction();
  const late = await runMain(APPLY, {
    run: drifted.run,
    captureBookmark: async () => {
      drifted.db.exec('CREATE TABLE late_drift (x INTEGER)');
      return BOOKMARK_1;
    },
  });
  assert.deepEqual(late.evidence.blockers.map((item) => item.id), ['production_schema_drift']);
  assert.equal(late.evidence.checkpoint.bookmark, BOOKMARK_1);
  assert.equal(drifted.calls.some((key) => key.includes('migrations apply')), false);

  // Only time passed: the window closed, but no epoch moved.
  const closing = simulatedProduction({
    safetyReads: [
      safety({ nextDue: '2026-10-04T15:01:00.000Z' }),
      safety({ nextDue: '2026-10-04T15:01:00.000Z', dbNow: '2026-10-04T14:32:00.000Z' }),
    ],
  });
  const { evidence } = await runMain(APPLY, { run: closing.run, captureBookmark: async () => BOOKMARK_1 });
  const ids = evidence.blockers.map((item) => item.id);
  assert.ok(ids.includes('publication_window_too_close'));
  assert.ok(ids.includes('gates_failed_after_checkpoint'));
  assert.equal(ids.includes('publication_state_changed_before_apply'), false);
});

test('readback is persisted as each step completes', async () => {
  const output = mkdtempSync(join(tmpdir(), 'xqueue-schema-'));
  let midway = null;
  let calls = 0;
  const sim = simulatedProduction();
  await runMain(APPLY, {
    output,
    run: sim.run,
    captureBookmark: async () => {
      calls += 1;
      if (calls === 1) return BOOKMARK_1;
      midway = JSON.parse(readFileSync(join(output, readdirSync(output)[0]), 'utf8'));
      return BOOKMARK_2;
    },
  });
  assert.equal(midway.status, 'reading_back');
  assert.equal(midway.checkpoint.bookmark, BOOKMARK_1);
  assert.ok(Array.isArray(midway.readbackCollected.migrations));
  assert.ok(Array.isArray(midway.readbackCollected.schema));
  assert.ok(midway.readbackCollected.publication);
  const final = JSON.parse(readFileSync(join(output, readdirSync(output)[0]), 'utf8'));
  assert.equal(final.status, 'applied');
  assert.equal(final.readbackCollected, undefined);
});

test('config selection follows wrangler, and apply requires this workflow file', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'xqueue-config-'));
  const base = JSON.parse(readFileSync('wrangler.status.jsonc', 'utf8').replace(/^\s*\/\/.*$/gm, ''));
  const shadowed = structuredClone(base);
  shadowed.d1_databases.unshift({ binding: 'xqueue-production', database_name: 'other', database_id: 'x', migrations_dir: 'other' });
  const path = join(dir, 'shadowed.jsonc');
  writeFileSync(path, JSON.stringify(shadowed));
  const { evidence } = await runMain(['--environment', 'production'], { run: simulatedProduction().run, configPath: path });
  assert.ok(evidence.blockers.some((item) => item.id === 'production_config_mismatch'));

  const sim = simulatedProduction();
  const other = await runMain(APPLY, {
    run: sim.run,
    env: { ...GOVERNED_ENV, GITHUB_WORKFLOW_REF: 'peteywee/xqueue/.github/workflows/other.yml@refs/heads/main' },
    captureBookmark: async () => BOOKMARK_1,
  });
  assert.ok(other.evidence.blockers.some((item) => item.id === 'apply_outside_governed_workflow'));
  assert.equal(sim.calls.some((key) => key.includes('migrations apply')), false);
});

test('the Workers scope probe never treats a missing account as proof', async () => {
  for (const accountId of [undefined, '', '  ']) {
    await assert.rejects(
      defaultProbeWorkersAccess({ token: 't', accountId, fetchImpl: async () => ({ ok: false, status: 403 }) }),
      /requires the Cloudflare account id/,
    );
  }
  assert.equal(
    await defaultProbeWorkersAccess({ token: 't', accountId: 'acct', fetchImpl: async () => ({ ok: false, status: 403 }) }),
    'denied',
  );
});

const ACTIVE_ASSIGNMENT_SQL = `
  INSERT INTO queue_content (content_id,pillar,current_revision,status,generation,created_at,updated_at)
    VALUES ('A1','A',1,'active',1,'2026-09-02T00:00:00.000Z','2026-09-02T00:00:00.000Z');
  INSERT INTO queue_content_revisions (content_id,revision,title,body,publication_text,content_digest,figure,source_ref,created_at)
    VALUES ('A1',1,'t','b','b','${'3'.repeat(64)}',NULL,'s','2026-09-02T00:00:00.000Z');
  INSERT INTO queue_assignments (assignment_id,assignment_version,content_id,content_revision,content_digest,target_account,
    policy_version,resolved_at,scheduled_date,scheduled_time,timezone,slot_label,status,superseded_by_version,generation,created_at,updated_at)
    VALUES ('A1',1,'A1',1,'${'3'.repeat(64)}','x-primary',1,'2027-01-07T20:30:00.000Z','2027-01-07','14:30','America/Chicago',
    'lull','active',NULL,1,'2026-09-02T00:00:00.000Z','2026-09-02T00:00:00.000Z');
  INSERT INTO publication_state (post_id,status,scheduled_at,scheduled_date,scheduled_time,timezone,slot,title,updated_at,generation)
    VALUES ('A1','scheduled','2027-01-07T20:30:00.000Z','2027-01-07','14:30','America/Chicago','lull','t','2026-09-02T00:00:00.000Z',1);
`;

test('the apply seeds a missing intake frontier, and observe reports it absent first', async () => {
  const sim = simulatedProduction({ drift: ACTIVE_ASSIGNMENT_SQL });
  assert.equal(sim.db.prepare('SELECT COUNT(*) n FROM queue_intake_frontier').get().n, 0, 'production shape: no frontier');
  const observe = await runMain(['--environment', 'production'], { run: sim.run });
  assert.equal(observe.evidence.status, 'ready');
  assert.deepEqual({ ...observe.evidence.intakeFrontierBefore }, {
    activeAssignments: 1,
    lastActiveSlot: '2027-01-07T20:30:00.000Z',
    publicationRows: 1,
    lastPublicationSlot: '2027-01-07T20:30:00.000Z',
    frontierRows: 0,
    frontierResolvedAt: null,
    frontierPending: null,
  });

  const bookmarks = [BOOKMARK_1, BOOKMARK_2];
  const { evidence } = await runMain(APPLY, { run: sim.run, captureBookmark: async () => bookmarks.shift() });
  assert.equal(evidence.status, 'applied');
  assert.equal(evidence.readback.intakeFrontierReady, true);
  assert.equal(evidence.readback.intakeFrontier.frontierResolvedAt, '2027-01-07T20:30:00.000Z');
});

test('frontier readiness counts every used slot, not only active assignments', () => {
  const facts = (overrides) => ({
    activeAssignments: 0, lastActiveSlot: null, publicationRows: 0, lastPublicationSlot: null,
    frontierRows: 0, frontierResolvedAt: null, frontierPending: null, ...overrides,
  });
  assert.equal(intakeFrontierReady(facts({})), true, 'an empty queue needs no frontier');
  assert.equal(intakeFrontierReady(facts({ publicationRows: 2, lastPublicationSlot: '2027-01-08T15:00:00.000Z' })), false,
    'skipped publication rows alone still need a frontier');
  assert.equal(intakeFrontierSeedable(facts({ publicationRows: 2, lastPublicationSlot: '2027-01-08T15:00:00.000Z' })), true,
    '0018 seeds a missing one');
  assert.equal(intakeFrontierReady(facts({
    activeAssignments: 1, lastActiveSlot: '2027-01-07T20:30:00.000Z', publicationRows: 1,
    lastPublicationSlot: '2027-01-07T20:30:00.000Z', frontierRows: 1, frontierResolvedAt: '2027-01-07T20:30:00.000Z',
  })), true);
  assert.equal(intakeFrontierSeedable(facts({
    activeAssignments: 1, lastActiveSlot: '2027-01-07T20:30:00.000Z', frontierRows: 1, frontierResolvedAt: '2026-01-01T00:00:00.000Z',
  })), false, 'a stale frontier is never seeded over');
  assert.equal(intakeFrontierReady(null), false);
});

test('a frontier 0018 cannot make ready blocks before production changes', async () => {
  for (const [name, frontier] of [
    ['stale', "INSERT INTO queue_intake_frontier VALUES (1, 3, '2026-12-01T00:00:00.000Z', NULL, NULL, '2026-09-02T00:00:00.000Z')"],
    ['pending', "INSERT INTO queue_intake_frontier VALUES (1, 3, '2027-01-07T20:30:00.000Z', 'intake-pending', NULL, '2026-09-02T00:00:00.000Z')"],
  ]) {
    const sim = simulatedProduction({ drift: ACTIVE_ASSIGNMENT_SQL + frontier + ';' });
    const { evidence, exitCode } = await runMain(APPLY, { run: sim.run, captureBookmark: async () => BOOKMARK_1 });
    assert.equal(evidence.status, 'blocked', name);
    assert.equal(exitCode, 1, name);
    assert.deepEqual(evidence.blockers.map((item) => item.id), ['intake_frontier_not_ready'], name);
    assert.equal(sim.calls.some((key) => key.includes('migrations apply')), false, name);
  }
});

test('a cancelled post holding a later slot keeps an older frontier from counting as ready', async () => {
  const skipped = "INSERT INTO publication_state (post_id,status,scheduled_at,updated_at,generation) " +
    "VALUES ('C2','skipped','2027-01-08T15:00:00.000Z','2026-09-03T00:00:00.000Z',2);" +
    "INSERT INTO queue_intake_frontier VALUES (1, 3, '2027-01-07T20:30:00.000Z', NULL, NULL, '2026-09-02T00:00:00.000Z');";
  const sim = simulatedProduction({ drift: ACTIVE_ASSIGNMENT_SQL + skipped });
  const { evidence } = await runMain(['--environment', 'production'], { run: sim.run });
  assert.equal(evidence.status, 'blocked');
  assert.deepEqual(evidence.blockers.map((item) => item.id), ['intake_frontier_not_ready']);
  assert.equal(evidence.intakeFrontierBefore.lastPublicationSlot, '2027-01-08T15:00:00.000Z');
});

test('already-active schema still requires a ready intake frontier', async () => {
  const sim = simulatedProduction({ applied: NAMES, drift: ACTIVE_ASSIGNMENT_SQL });
  const { evidence, exitCode } = await runMain(['--environment', 'production'], { run: sim.run });
  assert.equal(evidence.status, 'blocked');
  assert.equal(exitCode, 1);
  assert.deepEqual(evidence.blockers.map((item) => item.id), ['intake_frontier_not_ready']);
});

test('an unreadable intake frontier is a named blocker with evidence, not a crash', async () => {
  const sim = simulatedProduction({ drift: ACTIVE_ASSIGNMENT_SQL });
  const run = (command, argv) => {
    if (argv.some((arg) => String(arg).includes('last_publication_slot'))) {
      throw new Error('wrangler d1 execute timed out');
    }
    return sim.run(command, argv);
  };
  const { evidence, written, exitCode } = await runMain(APPLY, { run, captureBookmark: async () => BOOKMARK_1 });
  assert.equal(evidence.status, 'blocked');
  assert.equal(written.status, 'blocked');
  assert.equal(exitCode, 1);
  assert.equal(evidence.intakeFrontierBefore, null);
  assert.deepEqual(evidence.blockers.map((item) => item.id), ['intake_frontier_unreadable']);
  assert.equal(sim.calls.some((key) => key.includes('migrations apply')), false);
});

test('an apply whose frontier seed did not land is not reported as applied', async () => {
  const sim = simulatedProduction({ drift: ACTIVE_ASSIGNMENT_SQL, skipSqlFor: '0018_intake_frontier_seed.sql' });
  const bookmarks = [BOOKMARK_1, BOOKMARK_2];
  const { evidence } = await runMain(APPLY, { run: sim.run, captureBookmark: async () => bookmarks.shift() });
  assert.equal(evidence.status, 'requires_reconciliation');
  assert.equal(evidence.readback.schema.identical, true, '0018 adds no schema objects');
  assert.deepEqual(evidence.blockers.map((item) => item.id), ['intake_frontier_not_ready']);
});
