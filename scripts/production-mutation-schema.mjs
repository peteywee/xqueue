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
  parseJsonOutput,
} from './production-mutation-intake.mjs';

export const PRODUCTION_SCHEMA_CONFIRM = 'xqueue-production-mutation-schema';
export const PRODUCTION_DATABASE_ID = 'fc85026e-bfc8-435f-8bb0-c60e139178a3';
export const PRODUCTION_MIGRATIONS_DIR = 'cloudflare/migrations-production';
const PRODUCTION_CONFIG = 'wrangler.status.jsonc';
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
    "WHERE name NOT LIKE 'sqlite_%' AND sql IS NOT NULL ORDER BY type,name",
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

export const REMOTE_SCHEMA_SQL =
  "SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' " +
  "AND name NOT LIKE '_cf_%' AND name <> 'd1_migrations' AND sql IS NOT NULL ORDER BY type,name;";

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
  "SELECT MIN(resolved_at) AS next_due FROM queue_assignments WHERE status='active' AND lifecycle_state='scheduled' " +
    "AND resolved_at > strftime('%Y-%m-%dT%H:%M:%fZ','now','-20 minutes');",
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
    blockers.push({ id: 'candidate_not_exact_main', detail: 'HEAD must equal fetched origin/main.' });
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
  } else if (due !== null && due - now < DUE_SLOT_EXCLUSION_MINUTES * 60_000) {
    blockers.push({
      id: 'publication_window_too_close',
      detail: 'A scheduled assignment is due within ' + DUE_SLOT_EXCLUSION_MINUTES + ' minutes or inside its grace window.',
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

function epochs(safety) {
  return Object.freeze({
    authorityGeneration: safety?.authority?.generation ?? null,
    authorityCandidateSha: safety?.authority?.candidate_sha ?? null,
    authorityDeploymentId: safety?.authority?.deployment_id ?? null,
    haltGeneration: safety?.halt?.generation ?? null,
    halted: safety?.halt?.halted ?? null,
    leaseGeneration: safety?.leaseGeneration ?? null,
    eventCursor: safety?.eventCursor ?? null,
  });
}

function writeEvidence(outputDir, evidence) {
  mkdirSync(resolve(outputDir), { recursive: true });
  const path = join(resolve(outputDir), 'production-mutation-schema-evidence.json');
  writeFileSync(path, JSON.stringify(evidence, null, 2) + '\n', 'utf8');
  return path;
}

export async function main(
  argv = process.argv.slice(2),
  {
    run = runSync,
    captureBookmark = () => getD1TimeTravelBookmark({
      accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
      databaseId: PRODUCTION_DATABASE_ID,
      apiToken: process.env.CLOUDFLARE_API_TOKEN,
    }),
    checkPublisher = checkPublisherMutexCompatibility,
    migrationsDir = PRODUCTION_MIGRATIONS_DIR,
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
  const blockers = [...gates.blockers];
  if (compatibility && !compatibility.identical) {
    blockers.push({ id: 'production_schema_drift', detail: 'Live schema differs from the replay of applied migrations.' });
  }

  const identities = local
    .filter((item) => plan.pending.includes(item.name) || plan.required.includes(item.name))
    .map(({ name, sha256: digest, gitBlob }) => ({ name, sha256: digest, gitBlob }));
  const evidence = {
    schema_version: 1,
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

  const finish = (status, extra = {}) => {
    Object.assign(evidence, extra, { status });
    const path = writeEvidence(options.output, evidence);
    console.log(JSON.stringify({ ...evidence, evidencePath: path }, null, 2));
    if (!['ready', 'already_active', 'applied'].includes(status)) process.exitCode = 1;
    return evidence;
  };

  if (blockers.length > 0) return finish('blocked');
  if (plan.status === 'already_active') return finish('already_active');
  if (!options.apply) return finish('ready');

  // Checkpoint first, then a fresh safety read: the apply must start from the
  // state the checkpoint covers, with no publication activity in between.
  let checkpoint;
  try {
    const bookmark = await captureBookmark();
    if (!isD1Bookmark(bookmark)) throw new Error('bookmark is not a D1 Time Travel bookmark');
    checkpoint = { bookmark, capturedAt: now().toISOString() };
  } catch (error) {
    blockers.push({ id: 'recovery_checkpoint_unavailable', detail: error instanceof Error ? error.message : String(error) });
    return finish('blocked');
  }

  const safetyFresh = readPublicationSafety(run);
  const fresh = evaluateSchemaGates({ auth, candidate, plan, safety: safetyFresh });
  if (!fresh.ok || JSON.stringify(epochs(safetyFresh)) !== JSON.stringify(epochs(safetyBefore))) {
    blockers.push(...fresh.blockers, {
      id: 'publication_state_changed_before_apply',
      detail: 'Publication epochs changed after the checkpoint; nothing was applied. Re-run observe first.',
    });
    return finish('blocked', { checkpoint, publicationFresh: epochs(safetyFresh) });
  }

  let applyError = null;
  try {
    run('pnpm', [
      'wrangler', 'd1', 'migrations', 'apply', 'xqueue-production',
      '--config', PRODUCTION_CONFIG, '--remote',
    ]);
  } catch (error) {
    applyError = error instanceof Error ? error.message : String(error);
  }

  // Readback before any conclusion, success or failure. A failed command may
  // still have applied some migrations; this path never retries on its own.
  const appliedAfter = readAppliedMigrations(run);
  const expectedApplied = [...appliedBefore, ...plan.pending];
  const schemaAfter = compareSchema(replaySchema(local, expectedApplied), readRemoteSchema(run));
  const expectedChange = expectedSchemaChange(local, plan.pending);
  const singletons = readSingletons(run);
  const safetyAfter = readPublicationSafety(run);
  let postCheckpoint = null;
  try {
    postCheckpoint = await captureBookmark();
  } catch {
    postCheckpoint = null;
  }

  const readback = {
    appliedAfter,
    migrationsExact: JSON.stringify(appliedAfter) === JSON.stringify(expectedApplied),
    schema: schemaAfter,
    singletonsExact: JSON.stringify(singletons) === JSON.stringify(expectedChange.singletons),
    singletons,
    publicationAfter: epochs(safetyAfter),
    authorityUnchanged:
      JSON.stringify([
        epochs(safetyAfter).authorityGeneration,
        epochs(safetyAfter).authorityCandidateSha,
        epochs(safetyAfter).authorityDeploymentId,
        epochs(safetyAfter).haltGeneration,
      ]) === JSON.stringify([
        epochs(safetyBefore).authorityGeneration,
        epochs(safetyBefore).authorityCandidateSha,
        epochs(safetyBefore).authorityDeploymentId,
        epochs(safetyBefore).haltGeneration,
      ]),
    postCheckpoint,
    checkpointPrecedesApply: bookmarkPrecedes(checkpoint.bookmark, postCheckpoint),
  };
  const proven =
    applyError === null &&
    readback.migrationsExact &&
    readback.schema.identical &&
    readback.singletonsExact &&
    readback.authorityUnchanged &&
    readback.checkpointPrecedesApply;

  if (!proven) {
    blockers.push({
      id: applyError === null ? 'post_apply_readback_contradicts_plan' : 'apply_command_failed',
      detail: applyError ?? 'Readback did not prove the exact planned schema; reconcile from evidence before any retry.',
    });
  }
  return finish(proven ? 'applied' : 'requires_reconciliation', { checkpoint, readback, applyError });
}

if (import.meta.url === new URL(process.argv[1], 'file:').href) {
  main().catch((error) => {
    console.error('XQUEUE PRODUCTION MUTATION SCHEMA: STOP');
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
