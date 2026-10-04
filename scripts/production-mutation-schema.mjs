#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { getD1TimeTravelBookmark } from '../src/mutation-control-transport.mjs';
import {
  REQUIRED_MUTATION_MIGRATIONS,
  checkPublisherMutexCompatibility,
  collectExactMainCandidate,
  defaultProbeWorkersAccess,
  parseJsonOutput,
} from './production-mutation-intake.mjs';

export const PRODUCTION_SCHEMA_CONFIRM = 'xqueue-production-mutation-schema';
export const PRODUCTION_DATABASE_ID = 'fc85026e-bfc8-435f-8bb0-c60e139178a3';
export const PRODUCTION_MIGRATIONS_DIR = 'cloudflare/migrations-production';
const PRODUCTION_CONFIG = 'wrangler.status.jsonc';
// Apply runs only inside the governed workflow: main only, one run at a time
// (its concurrency group), behind its protected environment.
export const GOVERNED_WORKFLOW = 'Production Mutation Schema';
// The publisher wakes every 15 minutes and publishes within a 20-minute grace.
// Refusing to change schema near a due slot keeps the apply out of that window.
export const DUE_SLOT_EXCLUSION_MINUTES = 30;

function fail(message) {
  throw new Error(message);
}

export function parseArgs(argv = []) {
  const options = {
    environment: null,
    apply: false,
    confirm: null,
    output: '/tmp/xqueue-production-mutation-schema',
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      const value = argv[index + 1];
      if (value === undefined) fail(arg + ' requires a value');
      index += 1;
      return value;
    };
    if (arg === '--environment') options.environment = next();
    else if (arg.startsWith('--environment=')) options.environment = arg.slice(14);
    else if (arg === '--apply') options.apply = true;
    else if (arg === '--confirm') options.confirm = next();
    else if (arg.startsWith('--confirm=')) options.confirm = arg.slice(10);
    else if (arg === '--output') options.output = next();
    else if (arg.startsWith('--output=')) options.output = arg.slice(9);
    else fail('unknown argument: ' + arg);
  }
  if (options.environment !== 'production') {
    fail('production mutation schema requires explicit --environment production');
  }
  if (options.apply && options.confirm !== PRODUCTION_SCHEMA_CONFIRM) {
    fail('--apply requires --confirm ' + PRODUCTION_SCHEMA_CONFIRM);
  }
  return Object.freeze(options);
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function gitBlobSha(bytes) {
  return createHash('sha1')
    .update(`blob ${bytes.length}\0`)
    .update(bytes)
    .digest('hex');
}

export function localMigrations(dir = PRODUCTION_MIGRATIONS_DIR) {
  return readdirSync(resolve(dir))
    .filter((name) => /^\d{4}_[a-z0-9_]+\.sql$/.test(name))
    .sort()
    .map((name) => {
      const bytes = readFileSync(resolve(dir, name));
      return Object.freeze({
        name,
        sha256: sha256(bytes),
        gitBlob: gitBlobSha(bytes),
        sql: bytes.toString('utf8'),
      });
    });
}

// wrangler 4.131 applies every non-hidden top-level *.sql file in
// migrations_dir, ordered by leading number and then by name. The plan must
// cover exactly that set, and every such file must be the committed blob.
export function migrationFileBlockers({ dir = PRODUCTION_MIGRATIONS_DIR, local, committed }) {
  const visible = readdirSync(resolve(dir), { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.sql') && !entry.name.startsWith('.'))
    .map((entry) => entry.name)
    .sort();
  const localNames = new Set(local.map((item) => item.name));
  const blockers = [];
  const unrecognized = visible.filter((name) => !localNames.has(name));
  if (unrecognized.length > 0) {
    blockers.push({
      id: 'unrecognized_migration_file',
      detail: 'wrangler would apply files outside the planned lane: ' + unrecognized.join(', '),
    });
  }
  const uncommitted = local
    .filter((item) => committed.get(dir + '/' + item.name) !== item.gitBlob)
    .map((item) => item.name);
  if (uncommitted.length > 0) {
    blockers.push({
      id: 'migration_file_not_committed',
      detail: 'Migration files differ from, or are absent in, the committed tree at HEAD: ' + uncommitted.join(', '),
    });
  }
  return blockers;
}

export function readCommittedMigrationBlobs(run, dir = PRODUCTION_MIGRATIONS_DIR) {
  const committed = new Map();
  for (const line of run('git', ['ls-tree', 'HEAD', '--', dir + '/']).split('\n')) {
    const match = /^\d+ blob ([0-9a-f]{40})\t(.+)$/.exec(line.trim());
    if (match) committed.set(match[2], match[1]);
  }
  return committed;
}

// The bookmark is taken for PRODUCTION_DATABASE_ID while wrangler resolves the
// database and migrations directory from the config, so they must agree.
export function productionConfigBlockers(path = PRODUCTION_CONFIG) {
  let database = null;
  try {
    const config = JSON.parse(readFileSync(resolve(path), 'utf8').replace(/^\s*\/\/.*$/gm, ''));
    database = (config.d1_databases ?? []).find((item) => item.database_name === 'xqueue-production') ?? null;
  } catch {
    database = null;
  }
  if (
    database?.database_id !== PRODUCTION_DATABASE_ID ||
    database?.migrations_dir !== PRODUCTION_MIGRATIONS_DIR ||
    database?.migrations_pattern !== undefined ||
    database?.migrations_table !== undefined
  ) {
    return [{
      id: 'production_config_mismatch',
      detail: PRODUCTION_CONFIG + ' must bind xqueue-production to ' + PRODUCTION_DATABASE_ID +
        ' with migrations_dir ' + PRODUCTION_MIGRATIONS_DIR + ' and the default pattern and table.',
    }];
  }
  return [];
}

// Production may only be a prefix of the committed lane, and the pending
// suffix must be exactly the mutation-control migrations. Anything else is
// drift that this path refuses to resolve.
export function planSchemaMigration({ applied, local, required = REQUIRED_MUTATION_MIGRATIONS }) {
  const localNames = local.map((item) => item.name);
  const blockers = [];
  const missing = applied.filter((name) => !localNames.includes(name));
  if (missing.length > 0) {
    blockers.push({
      id: 'applied_migration_missing_locally',
      detail: 'Production has applied migrations absent from the committed lane: ' + missing.join(', '),
    });
  }
  const prefix = localNames.slice(0, applied.length);
  if (missing.length === 0 && JSON.stringify(prefix) !== JSON.stringify(applied)) {
    blockers.push({
      id: 'applied_migrations_not_a_prefix',
      detail: 'Production migration history is not an exact prefix of the committed lane.',
    });
  }
  const pending = blockers.length === 0 ? localNames.slice(applied.length) : [];
  let status = 'blocked';
  if (blockers.length === 0) {
    if (pending.length === 0 && required.every((name) => applied.includes(name))) {
      status = 'already_active';
    } else if (JSON.stringify(pending) === JSON.stringify(required)) {
      status = 'pending_exact';
    } else {
      blockers.push({
        id: 'unexpected_pending_migrations',
        detail:
          'Pending migrations [' + pending.join(', ') + '] are not exactly [' +
          required.join(', ') + ']; this path applies only the mutation-control schema.',
      });
    }
  }
  return Object.freeze({
    status,
    applied: Object.freeze([...applied]),
    pending: Object.freeze(pending),
    required: Object.freeze([...required]),
    blockers: Object.freeze(blockers),
  });
}

function schemaObjects(db) {
  return db.prepare(
    "SELECT type,name,tbl_name,sql FROM sqlite_master " +
    "WHERE substr(name,1,7) <> 'sqlite_' AND sql IS NOT NULL ORDER BY type,name",
  ).all().map((row) => ({ ...row }));
}

const SINGLETON_SQL = Object.freeze({
  mutation_lane_state:
    'SELECT singleton_id,generation,active_operation_id,actor_class FROM mutation_lane_state ORDER BY singleton_id',
  mutation_lane_halt_state:
    'SELECT singleton_id,halted,generation,reason,actor_class FROM mutation_lane_halt_state ORDER BY singleton_id',
});

// Replays the committed lane into SQLite. Objects that the pending files add
// or redefine, plus the initial singleton rows, are what production must
// read back after the apply.
export function expectedSchemaChange(local, pending) {
  const db = new DatabaseSync(':memory:');
  try {
    for (const migration of local.filter((item) => !pending.includes(item.name))) {
      db.exec(migration.sql);
    }
    const before = new Map(schemaObjects(db).map((row) => [row.type + ':' + row.name, row.sql]));
    for (const name of pending) {
      db.exec(local.find((item) => item.name === name).sql);
    }
    const objects = schemaObjects(db).filter(
      (row) => before.get(row.type + ':' + row.name) !== row.sql,
    );
    const singletons = {};
    for (const [table, sql] of Object.entries(SINGLETON_SQL)) {
      singletons[table] = db.prepare(sql).all().map((row) => ({ ...row }));
    }
    return Object.freeze({ objects: Object.freeze(objects), singletons: Object.freeze(singletons) });
  } finally {
    db.close();
  }
}

function runSync(command, argv, { env = process.env } = {}) {
  const result = spawnSync(command, argv, {
    cwd: process.cwd(),
    env,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = [result.stderr, result.stdout].filter(Boolean).join('\n').trim();
    const error = new Error(
      [command, ...argv].join(' ') + ' failed with exit ' + result.status +
      (detail ? '\n' + detail : ''),
    );
    error.exitStatus = result.status;
    throw error;
  }
  return result.stdout ?? '';
}

function d1Query(run, sql) {
  return parseJsonOutput(run('pnpm', [
    'wrangler', 'd1', 'execute', 'xqueue-production',
    '--config', PRODUCTION_CONFIG,
    '--remote', '--yes', '--json',
    '--command', sql,
  ]));
}

function firstRow(payload, index) {
  return payload?.[index]?.results?.[0] ?? null;
}

export function readAppliedMigrations(run) {
  return (d1Query(run, 'SELECT name FROM d1_migrations ORDER BY id;')?.[0]?.results ?? [])
    .map((row) => row.name);
}

// substr, not LIKE: '_' is a LIKE wildcard and would hide names such as xcf_x.
export const REMOTE_SCHEMA_SQL =
  "SELECT type,name,tbl_name,sql FROM sqlite_master WHERE substr(name,1,7) <> 'sqlite_' " +
  "AND substr(name,1,4) <> '_cf_' AND name <> 'd1_migrations' AND sql IS NOT NULL ORDER BY type,name;";

export function readRemoteSchema(run) {
  return (d1Query(run, REMOTE_SCHEMA_SQL)?.[0]?.results ?? []).map((row) => ({
    type: row.type,
    name: row.name,
    tbl_name: row.tbl_name,
    sql: row.sql,
  }));
}

// Publication-only facts: readable before the mutation tables exist.
export const PUBLICATION_SAFETY_SQL = [
  'SELECT owner,generation,transition_state,candidate_sha,deployment_id FROM authority_state WHERE singleton_id=1;',
  'SELECT halted,generation FROM publication_halt_state WHERE singleton_id=1;',
  "SELECT COUNT(*) AS unresolved FROM publication_state WHERE status IN ('prepared','publishing','needs_reconciliation');",
  'SELECT COUNT(*) AS held_leases FROM publication_leases WHERE owner_token IS NOT NULL;',
  "SELECT generation AS lease_generation FROM publication_leases WHERE lease_name='publisher';",
  'SELECT COALESCE(MAX(id),0) AS event_cursor FROM publication_events;',
  "SELECT json_extract(value,'$.inflight') AS inflight FROM runtime_metadata WHERE key='state.snapshot_json';",
  'SELECT generation,revision_digest FROM queue_runtime_revisions ORDER BY generation DESC LIMIT 1;',
  // Every scheduled assignment, overdue included: an unhalted publisher acts
  // on overdue slots (deferral) at its next tick.
  "SELECT MIN(resolved_at) AS next_due FROM queue_assignments WHERE status='active' AND lifecycle_state='scheduled';",
  "SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now') AS db_now;",
].join(' ');

export function parsePublicationSafety(payload) {
  const runtimeObserved = payload?.[6]?.results?.length === 1;
  return Object.freeze({
    authority: firstRow(payload, 0),
    halt: firstRow(payload, 1),
    unresolvedAttemptCount: Number(firstRow(payload, 2)?.unresolved ?? -1),
    heldLeaseCount: Number(firstRow(payload, 3)?.held_leases ?? -1),
    leaseGeneration: Number(firstRow(payload, 4)?.lease_generation ?? -1),
    eventCursor: Number(firstRow(payload, 5)?.event_cursor ?? -1),
    runtimeSnapshotObserved: runtimeObserved,
    inflight: firstRow(payload, 6)?.inflight ?? null,
    runtimeHead: firstRow(payload, 7),
    nextDue: firstRow(payload, 8)?.next_due ?? null,
    dbNow: firstRow(payload, 9)?.db_now ?? null,
  });
}

export function readPublicationSafety(run) {
  return parsePublicationSafety(d1Query(run, PUBLICATION_SAFETY_SQL));
}

export function evaluateSchemaGates({ auth, candidate, plan, safety }) {
  const blockers = [...plan.blockers];
  if (auth?.ok !== true || auth?.environment !== 'production' || auth?.d1?.readable !== true) {
    blockers.push({ id: 'production_auth_not_verified', detail: 'Typed production Cloudflare auth with D1 read is required.' });
  }
  if (candidate?.branch !== 'main') {
    blockers.push({ id: 'candidate_not_main', detail: 'The schema path runs only from main.' });
  }
  if (candidate?.clean !== true) {
    blockers.push({ id: 'candidate_dirty', detail: 'The checkout must be clean.' });
  }
  if (!candidate?.headSha || candidate.headSha !== candidate.originMainSha) {
    blockers.push({
      id: 'candidate_not_exact_main',
      detail: 'HEAD must equal fetched origin/main.' +
        (candidate?.originMainError ? ' Cause: git fetch origin main failed: ' + candidate.originMainError : ''),
    });
  }
  const authority = safety?.authority;
  if (authority?.owner !== 'cloudflare' || authority?.transition_state !== 'stable') {
    blockers.push({ id: 'publication_authority_not_stable', detail: 'Publication authority must be stable Cloudflare.' });
  }
  if (safety?.unresolvedAttemptCount !== 0) {
    blockers.push({ id: 'unresolved_publication_attempt', detail: 'Unresolved publication state must be zero.' });
  }
  if (safety?.heldLeaseCount !== 0) {
    blockers.push({ id: 'publication_lease_held', detail: 'No publication lease may be held.' });
  }
  if (safety?.runtimeSnapshotObserved !== true || safety?.inflight !== null) {
    blockers.push({ id: 'runtime_inflight_or_unobserved', detail: 'Runtime must be observed with inflight=null.' });
  }
  const now = Date.parse(safety?.dbNow ?? '');
  const due = safety?.nextDue == null ? null : Date.parse(safety.nextDue);
  if (!Number.isFinite(now)) {
    blockers.push({ id: 'database_clock_unreadable', detail: 'D1 clock could not be read.' });
  } else if (due !== null && !Number.isFinite(due)) {
    blockers.push({ id: 'next_due_unreadable', detail: 'The next scheduled assignment time is not a valid instant: ' + String(safety.nextDue) });
  } else if (due !== null && due - now < DUE_SLOT_EXCLUSION_MINUTES * 60_000) {
    blockers.push({
      id: 'publication_window_too_close',
      detail: 'A scheduled assignment is overdue or due within ' + DUE_SLOT_EXCLUSION_MINUTES +
        ' minutes (next_due ' + safety.nextDue + ', publication ' +
        (Number(safety?.halt?.halted) === 1 ? 'halted' : 'not halted') + ').',
    });
  }
  return Object.freeze({ ok: blockers.length === 0, blockers: Object.freeze(blockers) });
}

function objectKey(row) {
  return row.type + ':' + row.name;
}

// The remote schema must equal the replay of exactly the applied migrations:
// same object set, same table binding, byte-identical CREATE text.
export function compareSchema(expectedRows, remoteRows) {
  const expected = new Map(expectedRows.map((row) => [objectKey(row), row]));
  const remote = new Map(remoteRows.map((row) => [objectKey(row), row]));
  const missing = [...expected.keys()].filter((key) => !remote.has(key));
  const unexpected = [...remote.keys()].filter((key) => !expected.has(key));
  const changed = [...expected.keys()].filter((key) =>
    remote.has(key) &&
    (remote.get(key).sql !== expected.get(key).sql ||
      remote.get(key).tbl_name !== expected.get(key).tbl_name));
  return Object.freeze({
    identical: missing.length === 0 && unexpected.length === 0 && changed.length === 0,
    objectCount: remoteRows.length,
    missing: Object.freeze(missing),
    unexpected: Object.freeze(unexpected),
    changed: Object.freeze(changed),
  });
}

export function replaySchema(local, names) {
  const db = new DatabaseSync(':memory:');
  try {
    for (const name of names) db.exec(local.find((item) => item.name === name).sql);
    return schemaObjects(db);
  } finally {
    db.close();
  }
}

function readSingletons(run) {
  const payload = d1Query(run, Object.values(SINGLETON_SQL).map((sql) => sql + ';').join(' '));
  const tables = Object.keys(SINGLETON_SQL);
  return Object.fromEntries(tables.map((table, index) => [
    table,
    (payload?.[index]?.results ?? []).map((row) => ({ ...row })),
  ]));
}

// D1 bookmarks are documented as lexically comparable: an earlier point in
// time compares less than a later one under plain string comparison.
const D1_BOOKMARK_RE = /^[0-9a-f]{8}-[0-9a-f]{8}-[0-9a-f]{8}-[0-9a-f]{32}$/;

export function isD1Bookmark(bookmark) {
  return typeof bookmark === 'string' && D1_BOOKMARK_RE.test(bookmark);
}

export function bookmarkPrecedes(earlier, later) {
  return isD1Bookmark(earlier) && isD1Bookmark(later) && earlier <= later;
}

// The apply writes, so a post-apply bookmark must be strictly later.
export function bookmarkStrictlyPrecedes(earlier, later) {
  return isD1Bookmark(earlier) && isD1Bookmark(later) && earlier < later;
}

function epochs(safety) {
  return Object.freeze({
    authorityGeneration: safety?.authority?.generation ?? null,
    authorityCandidateSha: safety?.authority?.candidate_sha ?? null,
    authorityDeploymentId: safety?.authority?.deployment_id ?? null,
    haltGeneration: safety?.halt?.generation ?? null,
    halted: safety?.halt?.halted ?? null,
    leaseGeneration: safety?.leaseGeneration ?? null,
    eventCursor: safety?.eventCursor ?? null,
    runtimeGeneration: safety?.runtimeHead?.generation ?? null,
    runtimeRevisionDigest: safety?.runtimeHead?.revision_digest ?? null,
  });
}

// One file per run, so a later run never overwrites an earlier apply's
// checkpoint and readback.
export function evidenceFileName(evidence) {
  return 'production-mutation-schema-evidence-' + evidence.mode + '-' +
    String(evidence.recorded_at).replace(/[:.]/g, '-') + '.json';
}

function writeEvidence(outputDir, evidence) {
  mkdirSync(resolve(outputDir), { recursive: true });
  const path = join(resolve(outputDir), evidenceFileName(evidence));
  writeFileSync(path, JSON.stringify(evidence, null, 2) + '\n', 'utf8');
  return path;
}

function message(error) {
  return error instanceof Error ? error.message : String(error);
}

export async function main(
  argv = process.argv.slice(2),
  {
    run = runSync,
    env = process.env,
    captureBookmark = () => getD1TimeTravelBookmark({
      accountId: env.CLOUDFLARE_ACCOUNT_ID,
      databaseId: PRODUCTION_DATABASE_ID,
      apiToken: env.CLOUDFLARE_API_TOKEN,
    }),
    probeWorkersAccess = () => defaultProbeWorkersAccess({
      token: env.CLOUDFLARE_API_TOKEN,
      accountId: env.CLOUDFLARE_ACCOUNT_ID,
    }),
    checkPublisher = checkPublisherMutexCompatibility,
    migrationsDir = PRODUCTION_MIGRATIONS_DIR,
    configPath = PRODUCTION_CONFIG,
    now = () => new Date(),
  } = {},
) {
  const options = parseArgs(argv);
  const local = localMigrations(migrationsDir);
  const candidate = collectExactMainCandidate(run);
  const auth = parseJsonOutput(run('pnpm', ['cf:auth:preflight', '--environment', 'production']));
  const appliedBefore = readAppliedMigrations(run);
  const plan = planSchemaMigration({ applied: appliedBefore, local });
  const safetyBefore = readPublicationSafety(run);
  const gates = evaluateSchemaGates({ auth, candidate, plan, safety: safetyBefore });

  // The live schema must already equal the replay of what production claims
  // to have applied; drift is never "fixed" by applying more migrations.
  const compatibility = plan.blockers.length === 0
    ? compareSchema(replaySchema(local, appliedBefore), readRemoteSchema(run))
    : null;
  const blockers = [
    ...gates.blockers,
    ...productionConfigBlockers(configPath),
    ...migrationFileBlockers({ dir: migrationsDir, local, committed: readCommittedMigrationBlobs(run, migrationsDir) }),
  ];
  if (compatibility && !compatibility.identical) {
    blockers.push({ id: 'production_schema_drift', detail: 'Live schema differs from the replay of applied migrations.' });
  }

  // The schema path is part of the mutation plane: its credential may reach D1
  // and Time Travel, never Workers scripts (which is what deploys the publisher).
  try {
    const access = await probeWorkersAccess();
    if (access !== 'denied') {
      blockers.push({
        id: 'schema_token_overscoped',
        detail: 'The schema credential can access Workers scripts; use the D1 + Time Travel only token.',
      });
    }
  } catch (error) {
    blockers.push({
      id: 'schema_token_scope_unverified',
      detail: 'Could not prove the schema credential lacks Workers access: ' + message(error),
    });
  }

  if (options.apply && (
    env.GITHUB_ACTIONS !== 'true' ||
    env.GITHUB_WORKFLOW !== GOVERNED_WORKFLOW ||
    env.GITHUB_REF !== 'refs/heads/main'
  )) {
    blockers.push({
      id: 'apply_outside_governed_workflow',
      detail: 'Apply runs only in the "' + GOVERNED_WORKFLOW + '" workflow on main.',
    });
  }

  const identities = local
    .filter((item) => plan.pending.includes(item.name) || plan.required.includes(item.name))
    .map(({ name, sha256: digest, gitBlob }) => ({ name, sha256: digest, gitBlob }));
  const evidence = {
    schema_version: 2,
    kind: 'xqueue-production-mutation-schema',
    mode: options.apply ? 'apply' : 'observe',
    environment: 'production',
    database_id: PRODUCTION_DATABASE_ID,
    recorded_at: now().toISOString(),
    candidate,
    auth: { ok: auth?.ok === true, environment: auth?.environment ?? null, d1Readable: auth?.d1?.readable === true },
    migrations: { appliedBefore, plan, identities },
    publicationBefore: epochs(safetyBefore),
    nextDue: safetyBefore.nextDue,
    compatibility,
    // Activation evidence only: the schema is safe under either publisher.
    publisherMutex: checkPublisher(safetyBefore.authority?.candidate_sha),
    blockers,
    status: null,
  };

  let evidencePath = null;
  const persist = (status, extra = {}) => {
    Object.assign(evidence, extra, { status });
    evidencePath = writeEvidence(options.output, evidence);
  };
  const finish = (status, extra = {}) => {
    persist(status, extra);
    console.log(JSON.stringify({ ...evidence, evidencePath }, null, 2));
    if (!['ready', 'already_active', 'applied'].includes(status)) process.exitCode = 1;
    return evidence;
  };

  if (blockers.length > 0) return finish('blocked');
  if (plan.status === 'already_active') return finish('already_active');
  if (!options.apply) return finish('ready');

  // Checkpoint first, then fresh reads: the apply must start from the state the
  // checkpoint covers, with no publication or migration activity in between.
  let checkpoint;
  try {
    const bookmark = await captureBookmark();
    if (!isD1Bookmark(bookmark)) throw new Error('bookmark is not a D1 Time Travel bookmark');
    checkpoint = { bookmark, capturedAt: now().toISOString() };
  } catch (error) {
    blockers.push({ id: 'recovery_checkpoint_unavailable', detail: message(error) });
    return finish('blocked');
  }

  let safetyFresh;
  let appliedFresh;
  try {
    safetyFresh = readPublicationSafety(run);
    appliedFresh = readAppliedMigrations(run);
  } catch (error) {
    blockers.push({ id: 'pre_apply_reread_failed', detail: message(error) + '; nothing was applied.' });
    return finish('blocked', { checkpoint });
  }
  const fresh = evaluateSchemaGates({ auth, candidate, plan, safety: safetyFresh });
  if (!fresh.ok || JSON.stringify(epochs(safetyFresh)) !== JSON.stringify(epochs(safetyBefore))) {
    blockers.push(...fresh.blockers, {
      id: 'publication_state_changed_before_apply',
      detail: 'Publication or runtime epochs changed after the checkpoint; nothing was applied. Re-run observe first.',
    });
    return finish('blocked', { checkpoint, publicationFresh: epochs(safetyFresh) });
  }
  if (JSON.stringify(appliedFresh) !== JSON.stringify(appliedBefore)) {
    blockers.push({
      id: 'migration_state_changed_before_apply',
      detail: 'd1_migrations changed after the checkpoint; nothing was applied. Re-run observe first.',
    });
    return finish('blocked', { checkpoint, appliedFresh });
  }

  // The restore point is on disk before production changes, so a killed or
  // timed-out run still leaves it for the operator.
  persist('applying', { checkpoint });

  let applyError = null;
  try {
    run('pnpm', [
      'wrangler', 'd1', 'migrations', 'apply', 'xqueue-production',
      '--config', PRODUCTION_CONFIG, '--remote',
    ]);
  } catch (error) {
    applyError = message(error);
  }

  // Readback before any conclusion, success or failure. A failed command may
  // still have applied some migrations; this path never retries on its own.
  // Each read is recorded on its own, so one failing read cannot lose the rest.
  const readbackErrors = {};
  const attempt = async (label, read) => {
    try {
      return await read();
    } catch (error) {
      readbackErrors[label] = message(error);
      return null;
    }
  };
  const expectedApplied = [...appliedBefore, ...plan.pending];
  const appliedAfter = await attempt('migrations', () => readAppliedMigrations(run));
  const remoteAfter = await attempt('schema', () => readRemoteSchema(run));
  const singletons = await attempt('singletons', () => readSingletons(run));
  const safetyAfter = await attempt('publication', () => readPublicationSafety(run));
  const postCheckpoint = await attempt('postCheckpoint', async () => {
    const bookmark = await captureBookmark();
    if (!isD1Bookmark(bookmark)) throw new Error('bookmark is not a D1 Time Travel bookmark');
    return bookmark;
  });
  const schemaAfter = remoteAfter === null
    ? null
    : compareSchema(replaySchema(local, expectedApplied), remoteAfter);
  const expectedChange = expectedSchemaChange(local, plan.pending);
  const publicationAfter = safetyAfter === null ? null : epochs(safetyAfter);

  const readback = {
    appliedAfter,
    migrationsExact: appliedAfter !== null && JSON.stringify(appliedAfter) === JSON.stringify(expectedApplied),
    schema: schemaAfter,
    singletonsExact: singletons !== null && JSON.stringify(singletons) === JSON.stringify(expectedChange.singletons),
    singletons,
    publicationAfter,
    authorityUnchanged: publicationAfter !== null && JSON.stringify([
      publicationAfter.authorityGeneration,
      publicationAfter.authorityCandidateSha,
      publicationAfter.authorityDeploymentId,
      publicationAfter.haltGeneration,
    ]) === JSON.stringify([
      epochs(safetyBefore).authorityGeneration,
      epochs(safetyBefore).authorityCandidateSha,
      epochs(safetyBefore).authorityDeploymentId,
      epochs(safetyBefore).haltGeneration,
    ]),
    // Any publication or runtime write during the apply means the checkpoint
    // no longer restores only the schema change.
    publicationQuiet: publicationAfter !== null &&
      JSON.stringify(publicationAfter) === JSON.stringify(epochs(safetyBefore)),
    postCheckpoint,
    checkpointPrecedesApply: bookmarkStrictlyPrecedes(checkpoint.bookmark, postCheckpoint),
    errors: readbackErrors,
  };

  const failures = [];
  if (applyError !== null) failures.push({ id: 'apply_command_failed', detail: applyError });
  for (const [label, detail] of Object.entries(readbackErrors)) {
    failures.push({ id: 'readback_unavailable', detail: label + ': ' + detail });
  }
  if (appliedAfter !== null && !readback.migrationsExact) {
    failures.push({ id: 'migrations_readback_mismatch', detail: 'd1_migrations is not exactly the planned history.' });
  }
  if (schemaAfter !== null && !schemaAfter.identical) {
    failures.push({ id: 'schema_readback_mismatch', detail: 'Live schema is not exactly the planned schema.' });
  }
  if (singletons !== null && !readback.singletonsExact) {
    failures.push({ id: 'singletons_readback_mismatch', detail: 'Lane singletons are not the migration initial state.' });
  }
  if (publicationAfter !== null && !readback.authorityUnchanged) {
    failures.push({ id: 'authority_changed_during_apply', detail: 'Publication authority or halt moved during the apply.' });
  } else if (publicationAfter !== null && !readback.publicationQuiet) {
    failures.push({
      id: 'publication_activity_during_apply',
      detail: 'Publication or runtime state changed during the apply. Do not restore the checkpoint without ' +
        'reconciling that activity; the schema readback is reported separately.',
    });
  }
  if (postCheckpoint !== null && !readback.checkpointPrecedesApply) {
    failures.push({ id: 'checkpoint_not_before_apply', detail: 'The post-apply bookmark is not later than the checkpoint.' });
  }

  if (failures.length > 0) {
    blockers.push(...failures);
    return finish('requires_reconciliation', { checkpoint, readback, applyError });
  }
  return finish('applied', { checkpoint, readback, applyError });
}

if (import.meta.url === new URL(process.argv[1], 'file:').href) {
  main().catch((error) => {
    console.error('XQUEUE PRODUCTION MUTATION SCHEMA: STOP');
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
