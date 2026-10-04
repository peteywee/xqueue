#!/usr/bin/env node

import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { authorizeProductionIntakeInput } from '../cloudflare/src/mutation-production-intake-worker.mjs';
import { evaluateProductionMutationPreflight } from '../src/mutation-production-preflight.mjs';
import { getD1TimeTravelBookmark } from '../src/mutation-control-transport.mjs';
import { ownerPublicKeyFingerprint } from '../src/authoring/owner-approval.mjs';

export const PRODUCTION_INTAKE_CONFIRM = 'xqueue-production-intake';
export const REQUIRED_MUTATION_MIGRATIONS = Object.freeze([
  '0015_mutation_control_plane.sql',
  '0016_mutation_completion_item_guard.sql',
  '0017_publication_mutation_mutex.sql',
]);

// Names alone do not prove content (0017 gained its authority guards after it
// was first written), so readiness also requires every trigger these
// migrations create, read from the committed files.
export const REQUIRED_MUTATION_TRIGGERS = Object.freeze(
  REQUIRED_MUTATION_MIGRATIONS.flatMap((name) =>
    [...readFileSync(new URL('../cloudflare/migrations-production/' + name, import.meta.url), 'utf8')
      .matchAll(/CREATE TRIGGER\s+([A-Za-z_][A-Za-z0-9_]*)/g)].map((match) => match[1]),
  ).sort(),
);

// The last #168 commit that touched the publisher's module graph (5185545).
// From here on, the publisher holds its lease across missed-slot deferral and
// runtime promotion, and reports mutation-lane exclusion as a lease block. An
// older deployed publisher can still defer without the lease while an intake
// holds the mutation lane.
export const MUTEX_COMPATIBLE_PUBLISHER_COMMIT = '518554553c0a6654447a63a4871ce330ed100ad7';

const DEFAULT_PORT = 8789;
export const MUTATION_WORKER_DESCRIPTOR = 'wrangler.mutation-production-intake.jsonc';
export const MUTATION_WORKER_SERVICE = 'xqueue-mutation-production-intake';
const HEALTH_REQUEST_TIMEOUT_MS = 2_000;
const HEALTH_DEADLINE_MS = 60_000;
const INTAKE_REQUEST_TIMEOUT_MS = 120_000;
const CLOUDFLARE_PROBE_TIMEOUT_MS = 10_000;
const MUTATION_WORKER_SECRETS = Object.freeze(['MUTATION_CONTROL_TOKEN', 'MUTATION_D1_API_TOKEN']);
const CHILD_OUTPUT_TAIL_BYTES = 4_096;

export function checkPublisherMutexCompatibility(candidateSha, spawnImpl = spawnSync) {
  const sha = String(candidateSha ?? '').toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(sha)) {
    return Object.freeze({ ok: false, reason: 'publisher_candidate_invalid', candidateSha: sha });
  }
  const result = spawnImpl(
    'git',
    ['merge-base', '--is-ancestor', MUTEX_COMPATIBLE_PUBLISHER_COMMIT, sha],
    { cwd: process.cwd(), encoding: 'utf8' },
  );
  if (result?.status === 0) {
    return Object.freeze({ ok: true, reason: 'publisher_mutex_compatible', candidateSha: sha });
  }
  if (result?.status === 1) {
    return Object.freeze({ ok: false, reason: 'publisher_predates_mutation_mutex', candidateSha: sha });
  }
  return Object.freeze({ ok: false, reason: 'publisher_candidate_unverifiable', candidateSha: sha });
}

function fail(message) {
  throw new Error(message);
}

export function parseArgs(argv = []) {
  const options = {
    environment: null,
    file: null,
    mode: 'single',
    sourceMode: 'owner-manual',
    ownerApprovalFile: null,
    approvedCandidateFile: null,
    apply: false,
    confirm: null,
    port: DEFAULT_PORT,
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
    else if (arg === '--file') options.file = next();
    else if (arg.startsWith('--file=')) options.file = arg.slice(7);
    else if (arg === '--mode') options.mode = next();
    else if (arg.startsWith('--mode=')) options.mode = arg.slice(7);
    else if (arg === '--automated') options.sourceMode = 'automated';
    else if (arg === '--approval-file') options.ownerApprovalFile = next();
    else if (arg.startsWith('--approval-file=')) options.ownerApprovalFile = arg.slice(16);
    else if (arg === '--approved-candidate-file') options.approvedCandidateFile = next();
    else if (arg.startsWith('--approved-candidate-file=')) {
      options.approvedCandidateFile = arg.slice(26);
    }
    else if (arg === '--apply') options.apply = true;
    else if (arg === '--confirm') options.confirm = next();
    else if (arg.startsWith('--confirm=')) options.confirm = arg.slice(10);
    else if (arg === '--port') options.port = Number(next());
    else if (arg.startsWith('--port=')) options.port = Number(arg.slice(7));
    else fail('unknown argument: ' + arg);
  }

  if (options.environment !== 'production') {
    fail('production intake requires explicit --environment production');
  }
  if (!options.file) fail('production intake requires --file <json>');
  if (!['single', 'batch'].includes(options.mode)) fail('--mode must be single or batch');
  if (!Number.isSafeInteger(options.port) || options.port < 1024 || options.port > 65535) {
    fail('--port must be an integer from 1024 through 65535');
  }
  if (options.ownerApprovalFile && options.sourceMode !== 'automated') {
    fail('--approval-file is valid only with --automated');
  }
  if (options.approvedCandidateFile && options.sourceMode !== 'automated') {
    fail('--approved-candidate-file is valid only with --automated');
  }
  if (Boolean(options.ownerApprovalFile) !== Boolean(options.approvedCandidateFile)) {
    fail('--approval-file and --approved-candidate-file must be supplied together');
  }
  if (options.apply && options.confirm !== PRODUCTION_INTAKE_CONFIRM) {
    fail('--apply requires --confirm ' + PRODUCTION_INTAKE_CONFIRM);
  }
  return Object.freeze(options);
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
    throw new Error(
      [command, ...argv].join(' ') + ' failed with exit ' + result.status +
      (detail ? '\n' + detail : ''),
    );
  }
  return result.stdout ?? '';
}

export function parseJsonOutput(raw) {
  const text = String(raw ?? '').trim();
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] !== '[' && text[index] !== '{') continue;
    try {
      return JSON.parse(text.slice(index));
    } catch {
      // Keep scanning past package-manager chatter.
    }
  }
  throw new Error('command output did not contain valid JSON');
}

function localTreeState(run) {
  return {
    branch: run('git', ['branch', '--show-current']).trim(),
    clean: run('git', ['status', '--porcelain', '--untracked-files=all']).trim() === '',
    headSha: run('git', ['rev-parse', 'HEAD']).trim().toLowerCase(),
  };
}

export function collectExactMainCandidate(run = runSync) {
  const local = localTreeState(run);
  run('git', ['fetch', 'origin', 'main']);
  // FETCH_HEAD is what this fetch wrote; origin/main can be stale when the
  // clone's refspec does not track main.
  const originMainSha = run('git', ['rev-parse', 'FETCH_HEAD']).trim().toLowerCase();
  return Object.freeze({ ...local, originMainSha });
}

export function assertMutationSchema(migrationNames) {
  const names = new Set(migrationNames);
  const missing = REQUIRED_MUTATION_MIGRATIONS.filter((name) => !names.has(name));
  if (missing.length > 0) {
    fail(
      'production mutation schema is not active; missing ' +
      missing.join(', ') +
      '. This command never auto-applies production migrations.',
    );
  }
  return true;
}

function first(payload, index) {
  return payload?.[index]?.results?.[0] ?? null;
}

export function parseSafetyPayload(payload) {
  return Object.freeze({
    authority: first(payload, 0),
    unresolvedAttemptCount: Number(first(payload, 1)?.unresolved ?? -1),
    activeLeaseCount: Number(first(payload, 2)?.active_leases ?? -1),
    runtimeSnapshotObserved: first(payload, 3) !== null,
    inflight: first(payload, 3)?.inflight ?? null,
    publicationLeaseGeneration: Number(
      first(payload, 4)?.publication_lease_generation ?? -1,
    ),
    publicationEventCursor: Number(
      first(payload, 5)?.publication_event_cursor ?? -1,
    ),
    mutationHalt: first(payload, 6),
    mutationLane: first(payload, 7),
    runtimeState: first(payload, 8),
  });
}

export const SAFETY_SQL = [
  "SELECT owner,generation,transition_state,candidate_sha,deployment_id,updated_at FROM authority_state WHERE singleton_id=1;",
  "SELECT COUNT(*) AS unresolved FROM publication_state WHERE status IN ('prepared','publishing','needs_reconciliation');",
  // Any held publisher lease excludes mutation, expired or not: the Worker
  // transport and the atomic lane claim use the same predicate.
  'SELECT COUNT(*) AS active_leases FROM publication_leases WHERE owner_token IS NOT NULL;',
  "SELECT json_extract(value, '$.inflight') AS inflight FROM runtime_metadata WHERE key='state.snapshot_json';",
  "SELECT generation AS publication_lease_generation FROM publication_leases WHERE lease_name='publisher';",
  "SELECT COALESCE(MAX(id),0) AS publication_event_cursor FROM publication_events;",
  "SELECT halted,generation,reason,actor_class,updated_at FROM mutation_lane_halt_state WHERE singleton_id=1;",
  "SELECT generation,active_operation_id,actor_class,updated_at FROM mutation_lane_state WHERE singleton_id=1;",
  "SELECT generation,revision_digest,source_operation_id,created_at FROM queue_runtime_revisions ORDER BY generation DESC LIMIT 1;",
].join(' ');

export function evaluateOperatorReadiness({
  auth,
  candidate,
  migrations,
  safety,
  publisherMutex = null,
  plannedOperationId = null,
  d1Token = null,
}) {
  const blockers = [];
  if (d1Token?.ok === true) {
    // Proven.
  } else if (Array.isArray(d1Token?.blockers) && d1Token.blockers.length > 0) {
    blockers.push(...d1Token.blockers);
  } else {
    blockers.push({
      id: 'mutation_d1_token_unverified',
      detail: 'The Worker credential (MUTATION_D1_API_TOKEN) was not proven.',
    });
  }
  try {
    assertMutationSchema(migrations);
  } catch (error) {
    blockers.push({
      id: 'production_mutation_schema_not_active',
      detail: error instanceof Error ? error.message : String(error),
    });
  }

  const production = evaluateProductionMutationPreflight({
    environment: 'production',
    auth,
    candidate,
    safety,
  });
  blockers.push(...production.blockers);

  if (publisherMutex?.ok !== true) {
    blockers.push({
      id: publisherMutex?.reason ?? 'publisher_mutex_compatibility_unknown',
      detail:
        'The authority-bound publisher candidate must descend from ' +
        MUTEX_COMPATIBLE_PUBLISHER_COMMIT +
        ' so publication cannot defer missed slots outside the lease while the mutation lane is held.',
    });
  }

  if (!safety?.mutationHalt) {
    blockers.push({
      id: 'mutation_lane_halt_unreadable',
      detail: 'The mutation lane halt state row is missing or unreadable.',
    });
  } else if (Number(safety.mutationHalt.halted) !== 0) {
    blockers.push({
      id: 'mutation_lane_halted',
      detail: 'The dedicated mutation lane is halted.',
    });
  }
  if (!safety?.mutationLane) {
    blockers.push({
      id: 'mutation_lane_unreadable',
      detail: 'The mutation lane state row is missing or unreadable.',
    });
  } else if (
    safety.mutationLane.active_operation_id != null &&
    safety.mutationLane.active_operation_id !== plannedOperationId
  ) {
    // A lane held by this exact planned operation is an interrupted apply; the
    // Worker's replay path resumes and finalizes it, so it is not contention.
    blockers.push({
      id: 'mutation_lane_contended',
      detail: 'Another mutation operation owns the mutation lane.',
    });
  }
  if (
    !safety?.runtimeState ||
    !Number.isSafeInteger(Number(safety.runtimeState.generation)) ||
    !/^[a-f0-9]{64}$/i.test(String(safety.runtimeState.revision_digest ?? ''))
  ) {
    blockers.push({
      id: 'mutation_runtime_unreadable',
      detail: 'Canonical mutation runtime state is missing or invalid.',
    });
  }

  return Object.freeze({
    ok: blockers.length === 0,
    blockers: Object.freeze(blockers),
    productionPreflight: production,
  });
}

function readSchema(run) {
  const raw = run('pnpm', [
    'wrangler', 'd1', 'execute', 'xqueue-production',
    '--config', 'wrangler.status.jsonc',
    '--remote', '--yes', '--json',
    '--command',
    "SELECT name FROM d1_migrations ORDER BY id; SELECT name FROM sqlite_master WHERE type='trigger' ORDER BY name;",
  ]);
  const payload = parseJsonOutput(raw);
  return {
    migrations: (payload?.[0]?.results ?? []).map((row) => row.name),
    triggers: (payload?.[1]?.results ?? []).map((row) => row.name),
  };
}

function readSafety(run) {
  const raw = run('pnpm', [
    'wrangler', 'd1', 'execute', 'xqueue-production',
    '--config', 'wrangler.status.jsonc',
    '--remote', '--yes', '--json',
    '--command', SAFETY_SQL,
  ]);
  return parseSafetyPayload(parseJsonOutput(raw));
}

// Blockers that only describe publication, lane or publisher facts. When those
// facts could not be read, these are artifacts of the missing read and are
// dropped; every other blocker (including new ones) is still reported.
const SAFETY_DEPENDENT_BLOCKERS = new Set([
  'publication_authority_not_stable',
  'publication_deployment_invalid',
  'publication_safety_unreadable',
  'unresolved_publication_attempt',
  'active_publication_lease',
  'publication_epoch_unreadable',
  'runtime_snapshot_unreadable',
  'publication_inflight',
  'publisher_mutex_compatibility_unknown',
  'mutation_lane_halt_unreadable',
  'mutation_lane_halted',
  'mutation_lane_unreadable',
  'mutation_lane_contended',
  'mutation_runtime_unreadable',
]);

function withAuthCause(blockers, authError) {
  if (!authError) return blockers;
  return blockers.map((item) => (item.id === 'cloudflare_auth_not_verified'
    ? { ...item, detail: item.detail + ' Cause: ' + authError }
    : item));
}

function blockedWithoutSafety({ auth, candidate, migrations, plannedOperationId, d1Token, extra, authError = null }) {
  const readiness = evaluateOperatorReadiness({
    auth,
    candidate,
    migrations: migrations ?? [],
    safety: null,
    publisherMutex: null,
    plannedOperationId,
    d1Token,
  });
  return Object.freeze({
    candidate,
    auth,
    migrations: migrations ?? [],
    safety: null,
    publisherMutex: null,
    readiness: Object.freeze({
      ok: false,
      blockers: Object.freeze(withAuthCause([
        ...extra,
        ...readiness.blockers.filter((item) =>
          !SAFETY_DEPENDENT_BLOCKERS.has(item.id) &&
          !(migrations === null && item.id === 'production_mutation_schema_not_active')),
      ], authError)),
      productionPreflight: null,
    }),
  });
}

function boundedFetch(timeoutMs = CLOUDFLARE_PROBE_TIMEOUT_MS) {
  return (url, init = {}) => globalThis.fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
}

async function defaultProbeTimeTravel({ token, accountId, databaseId }) {
  await getD1TimeTravelBookmark({ apiToken: token, accountId, databaseId, fetchImpl: boundedFetch() });
  return true;
}

// Least-privilege probe (read-only): a D1 + Time Travel token cannot list the
// account's Workers scripts. If it can, it has Workers access the mutation
// plane must not hold, since that is what redeploys the publisher.
async function defaultProbeWorkersAccess({ token, accountId, fetchImpl = boundedFetch() }) {
  const response = await fetchImpl(
    'https://api.cloudflare.com/client/v4/accounts/' + encodeURIComponent(accountId) + '/workers/scripts',
    { method: 'GET', headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' } },
  );
  if (response.ok) return 'granted';
  if (response.status === 401 || response.status === 403) return 'denied';
  throw new Error('Workers scripts probe returned HTTP ' + response.status);
}

function secretsExact(descriptor) {
  const required = [...(descriptor?.secrets?.required ?? [])].sort();
  return JSON.stringify(required) === JSON.stringify([...MUTATION_WORKER_SECRETS].sort());
}

// The single definition of a launchable configuration. Observe mode reports
// these as blockers; apply refuses to spawn on any of them.
export function launchConfigurationBlockers(env, descriptor) {
  const blockers = [];
  const add = (id, detail) => blockers.push({ id, detail });
  if (!secretsExact(descriptor)) {
    add('mutation_descriptor_secrets_invalid',
      'The mutation Worker descriptor must require exactly MUTATION_D1_API_TOKEN and MUTATION_CONTROL_TOKEN.');
  }
  const launchToken = env?.CLOUDFLARE_API_TOKEN;
  if (typeof launchToken !== 'string' || launchToken.trim() === '') {
    add('launch_token_missing',
      'CLOUDFLARE_API_TOKEN (the wrangler launch credential) must be set in the process environment.');
  }
  if (env?.CLOUDFLARE_ACCOUNT_ID !== descriptor?.vars?.CLOUDFLARE_ACCOUNT_ID) {
    add('launch_account_mismatch', 'CLOUDFLARE_ACCOUNT_ID must equal the mutation Worker descriptor account id.');
  }
  const workerToken = env?.MUTATION_D1_API_TOKEN;
  if (typeof workerToken !== 'string' || workerToken.trim() === '') {
    add('mutation_d1_token_missing',
      'MUTATION_D1_API_TOKEN (D1 + Time Travel scoped, no Workers script rights) is not set.');
  } else if (workerToken === launchToken) {
    add('mutation_d1_token_not_separated',
      'MUTATION_D1_API_TOKEN must differ from the CLOUDFLARE_API_TOKEN launch credential.');
  }
  return blockers;
}

// Keeps the whole failure (command line and stderr), redacted and bounded.
function redactedReason(error, secrets) {
  const text = redact(String(error instanceof Error ? error.message : error), secrets)
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join(' | ');
  return text.length > 600 ? text.slice(0, 600) + '...' : text;
}

// The Worker verifies and uses MUTATION_D1_API_TOKEN, not the launch token, so
// readiness proves that credential directly: typed auth plus a D1 read through
// the existing preflight, and a read-only Time Travel bookmark request.
export async function collectD1TokenReadiness({
  run = runSync,
  env = process.env,
  descriptor,
  probeTimeTravel = defaultProbeTimeTravel,
  probeWorkersAccess = defaultProbeWorkersAccess,
}) {
  // Launch configuration that apply would refuse is reported here, so observe
  // mode never says ready for a setup apply cannot run.
  const launchBlockers = launchConfigurationBlockers(env, descriptor);
  if (launchBlockers.length > 0) {
    return Object.freeze({ ok: false, blockers: Object.freeze(launchBlockers) });
  }

  const token = env.MUTATION_D1_API_TOKEN;
  const secrets = [token, env.CLOUDFLARE_API_TOKEN];
  let auth = null;
  try {
    auth = parseJsonOutput(run(
      'pnpm',
      ['cf:auth:preflight', '--environment', 'production'],
      { env: { ...env, CLOUDFLARE_API_TOKEN: token } },
    ));
  } catch (error) {
    auth = { ok: false, error: redactedReason(error, secrets) };
  }
  if (auth?.ok !== true || auth?.d1?.readable !== true) {
    return Object.freeze({
      ok: false,
      blockers: Object.freeze([{
        id: 'mutation_d1_token_not_verified',
        detail: 'MUTATION_D1_API_TOKEN did not pass typed auth and a production D1 read' +
          (auth?.error ? ': ' + auth.error : '.'),
      }]),
    });
  }
  try {
    const access = await probeWorkersAccess({ token, accountId: descriptor.vars.CLOUDFLARE_ACCOUNT_ID });
    if (access !== 'denied') {
      return Object.freeze({
        ok: false,
        blockers: Object.freeze([{
          id: 'mutation_d1_token_overscoped',
          detail: 'MUTATION_D1_API_TOKEN can access Workers scripts; use a D1 + Time Travel only token.',
        }]),
      });
    }
  } catch (error) {
    return Object.freeze({
      ok: false,
      blockers: Object.freeze([{
        id: 'mutation_d1_token_scope_unverified',
        detail: 'Could not prove MUTATION_D1_API_TOKEN lacks Workers access: ' + redactedReason(error, secrets),
      }]),
    });
  }
  try {
    await probeTimeTravel({
      token,
      accountId: descriptor?.vars?.CLOUDFLARE_ACCOUNT_ID,
      databaseId: descriptor?.vars?.XQUEUE_PRODUCTION_DATABASE_ID,
    });
  } catch (error) {
    return Object.freeze({
      ok: false,
      blockers: Object.freeze([{
        id: 'mutation_d1_time_travel_unavailable',
        detail: 'MUTATION_D1_API_TOKEN could not read a production Time Travel bookmark: ' +
          redactedReason(error, secrets),
      }]),
    });
  }
  return Object.freeze({ ok: true, blockers: Object.freeze([]) });
}

export function collectOperatorPreflight(
  run = runSync,
  checkPublisher = checkPublisherMutexCompatibility,
  { plannedOperationId = null, d1Token = null } = {},
) {
  const candidate = collectExactMainCandidate(run);
  let auth;
  let authError = null;
  try {
    auth = parseJsonOutput(run('pnpm', ['cf:auth:preflight', '--environment', 'production']));
  } catch (error) {
    // cf:auth:preflight exits non-zero on every failure; report it as a blocker.
    auth = { ok: false };
    authError = redactedReason(error, [process.env.CLOUDFLARE_API_TOKEN]);
  }
  let migrations = null;
  let triggers = [];
  let schemaReadError = null;
  try {
    ({ migrations, triggers } = readSchema(run));
  } catch (error) {
    migrations = null;
    schemaReadError = redactedReason(error, [process.env.CLOUDFLARE_API_TOKEN]);
  }
  const schemaActive = Array.isArray(migrations) &&
    REQUIRED_MUTATION_MIGRATIONS.every((name) => migrations.includes(name));
  if (!schemaActive) {
    // The safety read needs the mutation tables, so report the schema blocker
    // as structured evidence instead of querying tables that do not exist.
    return blockedWithoutSafety({
      auth, candidate, migrations, plannedOperationId, d1Token, authError,
      extra: migrations === null
        ? [{ id: 'production_migrations_unreadable', detail: 'Production d1_migrations could not be read: ' + schemaReadError }]
        : [],
    });
  }
  const missingTriggers = REQUIRED_MUTATION_TRIGGERS.filter((name) => !triggers.includes(name));
  if (missingTriggers.length > 0) {
    return blockedWithoutSafety({
      auth, candidate, migrations, plannedOperationId, d1Token, authError,
      extra: [{
        id: 'production_mutation_schema_incomplete',
        detail: 'Applied mutation migrations lack required triggers: ' + missingTriggers.join(', '),
      }],
    });
  }
  let safety;
  try {
    safety = readSafety(run);
  } catch {
    return blockedWithoutSafety({
      auth, candidate, migrations, plannedOperationId, d1Token, authError,
      extra: [{
        id: 'publication_safety_unreadable',
        detail: 'Production publication, lane and runtime safety facts could not be read.',
      }],
    });
  }
  const publisherMutex = checkPublisher(safety.authority?.candidate_sha);
  const evaluated = evaluateOperatorReadiness({
    auth,
    candidate,
    migrations,
    safety,
    publisherMutex,
    plannedOperationId,
    d1Token,
  });
  const readiness = Object.freeze({
    ...evaluated,
    blockers: Object.freeze(withAuthCause(evaluated.blockers, authError)),
  });
  return Object.freeze({ candidate, auth, migrations, safety, publisherMutex, readiness });
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

export function readMutationWorkerDescriptor(path = MUTATION_WORKER_DESCRIPTOR) {
  // The repository's wrangler descriptors use whole-line comments only; the
  // credential-separation suite parses this file the same way.
  return JSON.parse(readFileSync(resolve(path), 'utf8').replace(/^\s*\/\/.*$/gm, ''));
}

export function mutationWorkerOwnerPublicKey(path = MUTATION_WORKER_DESCRIPTOR) {
  return readMutationWorkerDescriptor(path)?.vars?.OWNER_APPROVAL_PUBLIC_KEY_PEM ?? null;
}

export function expectedBindingNames(descriptor) {
  return Object.freeze([...new Set([
    ...Object.keys(descriptor?.vars ?? {}),
    ...(descriptor?.secrets?.required ?? []),
    ...(descriptor?.d1_databases ?? []).map((database) => database.binding),
  ])].sort());
}

export function expectedTrustRoot(descriptor) {
  const vars = descriptor?.vars ?? {};
  return Object.freeze({
    bindingNames: expectedBindingNames(descriptor),
    accountId: vars.CLOUDFLARE_ACCOUNT_ID ?? null,
    productionDatabaseId: vars.XQUEUE_PRODUCTION_DATABASE_ID ?? null,
    ownerApprovalKeyFingerprint:
      typeof vars.OWNER_APPROVAL_PUBLIC_KEY_PEM === 'string'
        ? ownerPublicKeyFingerprint(vars.OWNER_APPROVAL_PUBLIC_KEY_PEM)
        : null,
  });
}

// wrangler dev lets same-named process.env and .env entries override committed
// vars, with process.env taking precedence over .env (observed with wrangler
// 4.131). The child therefore carries every committed var explicitly, which
// also shadows any .env entry. The Worker's Cloudflare credential is
// MUTATION_D1_API_TOKEN; CLOUDFLARE_API_TOKEN is wrangler's own launch
// credential and is never bound into the Worker.
const WRANGLER_DEV_SWITCHES = Object.freeze([
  'CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV',
  'CLOUDFLARE_INCLUDE_PROCESS_ENV',
  'CLOUDFLARE_ENV',
]);

export function childEnvironment({ env = process.env, descriptor, controlToken }) {
  const vars = descriptor?.vars ?? {};
  const blockers = launchConfigurationBlockers(env, descriptor);
  if (blockers.length > 0) {
    fail('apply refused: ' + blockers.map((item) => item.id + ' (' + item.detail + ')').join('; '));
  }
  const child = { ...env };
  for (const name of WRANGLER_DEV_SWITCHES) delete child[name];
  for (const [name, value] of Object.entries(vars)) child[name] = value;
  child.MUTATION_CONTROL_TOKEN = controlToken;
  return child;
}


export function probePortFree(port, connectImpl = connect) {
  return new Promise((resolveProbe, rejectProbe) => {
    const socket = connectImpl({ host: '127.0.0.1', port });
    socket.once('connect', () => {
      socket.destroy();
      rejectProbe(new Error('port ' + port + ' already has a listener; refusing to launch'));
    });
    socket.once('error', (error) => {
      socket.destroy();
      if (error?.code === 'ECONNREFUSED') resolveProbe(true);
      else rejectProbe(error);
    });
  });
}

// Holds up to 1 MB of raw output and redacts before cutting the tail, so a
// secret can never be split by the cut and printed in part.
const CHILD_OUTPUT_RETAIN_CHARS = 1_000_000;

function tailBuffer(limit = CHILD_OUTPUT_TAIL_BYTES) {
  let text = '';
  return {
    push(chunk) {
      text = (text + String(chunk)).slice(-CHILD_OUTPUT_RETAIN_CHARS);
    },
    value(secrets = []) {
      return redact(text, secrets).slice(-limit);
    },
  };
}

function redact(text, secrets) {
  let out = String(text ?? '');
  for (const secret of secrets) {
    if (typeof secret === 'string' && secret.length >= 8) out = out.split(secret).join('[redacted]');
  }
  return out;
}

export function assertHealthIdentity(body, expected) {
  if (
    body?.service !== MUTATION_WORKER_SERVICE ||
    body?.role !== 'production-mutation-intake' ||
    body?.environment !== 'production' ||
    body?.publicationCapable !== false ||
    body?.schedulerAuthority !== false
  ) {
    fail('the listener on the intake port is not the ephemeral production mutation Worker');
  }
  const bound = body?.bindings ?? {};
  if (
    bound.secretsBound?.MUTATION_D1_API_TOKEN !== true ||
    bound.secretsBound?.MUTATION_CONTROL_TOKEN !== true
  ) {
    fail('the ephemeral Worker did not bind both mutation secrets');
  }
  if (JSON.stringify(bound.bindingNames ?? null) !== JSON.stringify(expected?.bindingNames ?? [])) {
    fail(
      'the ephemeral Worker has bindings ' + JSON.stringify(bound.bindingNames ?? null) +
      ', expected exactly ' + JSON.stringify(expected?.bindingNames ?? []),
    );
  }
  for (const key of ['accountId', 'productionDatabaseId', 'ownerApprovalKeyFingerprint']) {
    if (typeof expected?.[key] !== 'string' || bound[key] !== expected[key]) {
      fail(
        'the ephemeral Worker bound ' + key + ' that does not match the committed descriptor; ' +
        'a local override is present',
      );
    }
  }
  return true;
}

async function waitForHealth(url, fetchImpl, state, expected, deadlineMs = HEALTH_DEADLINE_MS) {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    if (state.exited) {
      throw new Error('ephemeral production mutation Worker exited before health became ready');
    }
    let body = null;
    try {
      const response = await fetchImpl(url + '/health', {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(HEALTH_REQUEST_TIMEOUT_MS),
      });
      if (response.ok) body = await response.json();
    } catch {
      // Bounded readiness polling only; no credential-bearing request has been sent.
    }
    if (body) {
      assertHealthIdentity(body, expected);
      return body;
    }
    await sleep(250);
  }
  throw new Error('ephemeral production mutation Worker did not become healthy');
}

export function verifyTreeUnchanged(candidate, run = runSync) {
  const { branch, clean, headSha } = localTreeState(run);
  if (branch !== candidate?.branch || !clean || headSha !== candidate?.headSha) {
    fail('the checkout changed after preflight; refusing to send the production intake request');
  }
  return true;
}

function postDispatchAmbiguity(message, cause) {
  const error = new Error(message + '; production may have changed, reconcile by readback before any retry');
  error.cause = cause;
  error.response = {
    requiresReadback: true,
    faultClass: 'POST_DISPATCH_TRANSPORT_AMBIGUOUS',
  };
  return error;
}

export async function invokeEphemeralWorker({
  payload,
  candidate,
  expectedPublicationAuthority,
  port = DEFAULT_PORT,
  spawnImpl = spawn,
  fetchImpl = globalThis.fetch,
  env = process.env,
  descriptorPath = MUTATION_WORKER_DESCRIPTOR,
  readDescriptor = readMutationWorkerDescriptor,
  probePort = probePortFree,
  verifyTree = verifyTreeUnchanged,
  healthDeadlineMs = HEALTH_DEADLINE_MS,
  intakeTimeoutMs = INTAKE_REQUEST_TIMEOUT_MS,
  processImpl = process,
}) {
  if (typeof fetchImpl !== 'function') fail('fetch support is required');
  const descriptor = readDescriptor(descriptorPath);
  const expected = expectedTrustRoot(descriptor);
  const controlToken = randomBytes(32).toString('hex');
  const childEnv = childEnvironment({ env, descriptor, controlToken });
  await probePort(port);
  // An empty --env-file makes wrangler skip .env and .dev.vars entirely while
  // still binding declared secrets from the process environment (observed with
  // wrangler 4.131), so no local file can override a binding.
  const envDir = mkdtempSync(join(tmpdir(), 'xqueue-mutation-env-'));
  const envFile = join(envDir, 'empty.env');

  const state = { exited: false, spawnError: null };
  let child = null;
  // The Worker binds production D1 and holds the control token, so it must not
  // outlive this process even when the CLI is interrupted by a signal.
  // The child leads its own process group (detached), so pnpm, wrangler and
  // workerd are signalled together even if pnpm has already exited.
  const killGroup = (signal) => {
    if (!child?.pid) return;
    try {
      processImpl.kill(-child.pid, signal);
    } catch {
      // Group already gone.
    }
  };
  const cleanup = async () => {
    if (child?.pid) {
      killGroup('SIGTERM');
      const deadline = Date.now() + 5_000;
      while (!state.exited && Date.now() < deadline) await sleep(50);
      killGroup('SIGKILL');
    }
    rmSync(envDir, { recursive: true, force: true });
  };
  const forwardedSignals = ['SIGINT', 'SIGTERM', 'SIGHUP'];
  const onSignal = (signal) => {
    // No time to wait on a signal: kill the whole group outright.
    killGroup('SIGKILL');
    rmSync(envDir, { recursive: true, force: true });
    for (const name of forwardedSignals) processImpl.removeListener(name, onSignal);
    processImpl.kill(processImpl.pid, signal);
  };
  for (const name of forwardedSignals) processImpl.once(name, onSignal);

  const stderr = tailBuffer();
  const secrets = [controlToken, env.MUTATION_D1_API_TOKEN, env.CLOUDFLARE_API_TOKEN];
  const withOutput = (error) => {
    const detail = stderr.value(secrets).trim();
    if (detail && error instanceof Error && !error.response) {
      error.message += '\nwrangler stderr (tail):\n' + detail;
    }
    return error;
  };

  const baseUrl = 'http://127.0.0.1:' + port;
  try {
    writeFileSync(envFile, '', { mode: 0o600 });
    child = spawnImpl(
      'pnpm',
      [
        'wrangler', 'dev',
        '--config', descriptorPath,
        '--remote',
        '--ip', '127.0.0.1',
        '--port', String(port),
        '--env-file', envFile,
        // wrangler always opens a devtools inspector; keep it on loopback. A
        // same-user local process could already read this CLI's environment.
        '--inspector-ip', '127.0.0.1',
      ],
      {
        cwd: process.cwd(),
        env: childEnv,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true,
      },
    );
    // Drain both pipes so wrangler never blocks on a full buffer.
    child.stdout?.resume?.();
    child.stderr?.on('data', (chunk) => stderr.push(chunk));
    child.on?.('error', (error) => {
      state.exited = true;
      state.spawnError = error;
    });
    child.on?.('exit', () => {
      state.exited = true;
    });

    try {
      await waitForHealth(baseUrl, fetchImpl, state, expected, healthDeadlineMs);
    } catch (error) {
      throw withOutput(state.spawnError ?? error);
    }

    // wrangler dev rebuilds on file changes, so the tree proven at preflight
    // must still be the tree serving the request.
    verifyTree(candidate);

    // From here on the request may reach production: any failure without a
    // definitive Worker answer is post-dispatch ambiguity.
    let response;
    try {
      response = await fetchImpl(baseUrl + '/production-intake', {
        method: 'POST',
        headers: {
          authorization: 'Bearer ' + controlToken,
          'content-type': 'application/json',
          accept: 'application/json',
        },
        // Verified fields last, so nothing in payload can replace them.
        body: JSON.stringify({
          ...payload,
          environment: 'production',
          candidate,
          expectedPublicationAuthority,
        }),
        signal: AbortSignal.timeout(intakeTimeoutMs),
      });
    } catch (error) {
      throw postDispatchAmbiguity('production intake request failed after dispatch', error);
    }

    let body;
    try {
      body = await response.json();
    } catch (error) {
      throw postDispatchAmbiguity(
        'production mutation Worker returned non-JSON (HTTP ' + response.status + ')',
        error,
      );
    }

    if (!response.ok && body?.service !== MUTATION_WORKER_SERVICE) {
      // A JSON error from something other than the Worker (wrangler's proxy)
      // says nothing about whether the intake ran.
      throw postDispatchAmbiguity('intake request failed outside the Worker (HTTP ' + response.status + ')', null);
    }
    if (!response.ok) {
      const detail = JSON.stringify(body);
      const error = new Error(
        'production mutation Worker returned HTTP ' + response.status + ': ' + detail,
      );
      error.response = body;
      error.httpStatus = response.status;
      throw error;
    }
    return body;
  } finally {
    for (const name of forwardedSignals) processImpl.removeListener(name, onSignal);
    await cleanup();
  }
}

// Runs the Worker's own authorization and identity derivation offline, so
// observe mode reports the exact operation identity that apply will claim.
export function planIntakeIdentity(payload, options = {}) {
  try {
    const { mode, sourceMode, normalized, operationId } =
      authorizeProductionIntakeInput(payload, options);
    return Object.freeze({
      ok: true,
      operationId,
      batchDigest: normalized.batch_digest,
      mode,
      sourceMode,
      itemCount: normalized.items.length,
      contentIds: Object.freeze(normalized.items.map((item) => item.content_id)),
      contentDigests: Object.freeze(normalized.items.map((item) => item.content_digest)),
    });
  } catch (error) {
    return Object.freeze({
      ok: false,
      faultClass: typeof error?.faultClass === 'string' ? error.faultClass : 'INVALID_INTAKE',
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export function assertObservedIdentity(planned, observed) {
  const same =
    observed?.operationId === planned.operationId &&
    JSON.stringify(observed?.contentIds ?? null) === JSON.stringify(planned.contentIds) &&
    JSON.stringify(observed?.contentDigests ?? null) === JSON.stringify(planned.contentDigests);
  if (!same) {
    const error = new Error(
      'production mutation Worker reported an operation identity that contradicts the ' +
      'offline plan; reconcile by readback before any retry',
    );
    error.response = { requiresReadback: true, planned, observed: observed ?? null };
    throw error;
  }
  return true;
}

export async function main(
  argv = process.argv.slice(2),
  {
    run = runSync,
    invokeWorker = invokeEphemeralWorker,
    checkPublisher = checkPublisherMutexCompatibility,
    ownerPublicKeyPem = null,
    verifyOwnerApproval = undefined,
    readJson = (path) => JSON.parse(readFileSync(resolve(path), 'utf8')),
    env = process.env,
    d1TokenReadiness = collectD1TokenReadiness,
  } = {},
) {
  const options = parseArgs(argv);
  const input = readJson(options.file);
  const ownerApproval = options.ownerApprovalFile
    ? readJson(options.ownerApprovalFile)
    : null;
  const approvedCandidate = options.approvedCandidateFile
    ? readJson(options.approvedCandidateFile)
    : null;
  const payload = {
    mode: options.mode,
    sourceMode: options.sourceMode,
    ownerApproval,
    approvedCandidate,
    input,
  };
  const planned = planIntakeIdentity(payload, {
    // Only automated intake verifies an owner signature, so owner-manual runs
    // never depend on parsing the descriptor's key.
    ownerPublicKeyPem:
      ownerPublicKeyPem ??
      (options.sourceMode === 'automated' ? mutationWorkerOwnerPublicKey() : null),
    ...(verifyOwnerApproval ? { verifyOwnerApproval } : {}),
  });
  const d1Token = await d1TokenReadiness({ run, env, descriptor: readMutationWorkerDescriptor() });
  const preflight = collectOperatorPreflight(run, checkPublisher, {
    plannedOperationId: planned.ok ? planned.operationId : null,
    d1Token,
  });
  const blockers = [...preflight.readiness.blockers];
  if (!planned.ok) {
    blockers.push({ id: planned.faultClass, detail: planned.error });
  }
  const readiness = Object.freeze({
    ...preflight.readiness,
    ok: preflight.readiness.ok && planned.ok,
    blockers: Object.freeze(blockers),
  });

  const summary = {
    status: readiness.ok ? 'ready' : 'blocked',
    mode: options.apply ? 'apply' : 'observe',
    environment: 'production',
    candidate: preflight.candidate,
    schema: {
      required: REQUIRED_MUTATION_MIGRATIONS,
      active: REQUIRED_MUTATION_MIGRATIONS.filter((name) =>
        preflight.migrations.includes(name)),
    },
    publisherMutex: preflight.publisherMutex,
    planned,
    readiness,
  };

  if (!readiness.ok) {
    console.log(JSON.stringify(summary, null, 2));
    process.exitCode = 1;
    return summary;
  }

  if (!options.apply) {
    console.log(JSON.stringify(summary, null, 2));
    return summary;
  }

  let result;
  try {
    result = await invokeWorker({
      candidate: preflight.candidate,
      // The authority whose publisher passed the mutex gate; the Worker refuses
      // unless its own fresh read is identical.
      expectedPublicationAuthority: Object.freeze({
        generation: Number(preflight.safety.authority.generation),
        candidate_sha: String(preflight.safety.authority.candidate_sha).toLowerCase(),
        deployment_id: preflight.safety.authority.deployment_id,
      }),
      payload,
      port: options.port,
      env,
    });
    assertObservedIdentity(planned, result?.planned);
  } catch (error) {
    // Readback needs the planned identity, so it travels with every failure.
    if (error && typeof error === 'object') error.planned = planned;
    throw error;
  }

  const output = {
    ...summary,
    status: 'complete',
    identityBinding: { planned: planned.operationId, observed: result.planned.operationId },
    mutation: result,
  };
  console.log(JSON.stringify(output, null, 2));
  return output;
}

if (import.meta.url === new URL(process.argv[1], 'file:').href) {
  main().catch((error) => {
    console.error('XQUEUE PRODUCTION INTAKE: STOP');
    console.error(error instanceof Error ? error.message : String(error));
    if (error?.response?.requiresReadback === true) {
      console.error('readback_required=1');
    }
    if (error?.planned || error?.response || error?.cause) {
      console.error(JSON.stringify({
        planned: error.planned ?? null,
        response: error.response ?? null,
        cause: error.cause instanceof Error
          ? { name: error.cause.name, message: error.cause.message }
          : (error.cause ?? null),
      }, null, 2));
    }
    process.exitCode = 1;
  });
}
