#!/usr/bin/env node

import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { evaluateProductionMutationPreflight } from '../src/mutation-production-preflight.mjs';

export const PRODUCTION_INTAKE_CONFIRM = 'xqueue-production-intake';
export const REQUIRED_MUTATION_MIGRATIONS = Object.freeze([
  '0015_mutation_control_plane.sql',
  '0016_mutation_completion_item_guard.sql',
  '0017_publication_mutation_mutex.sql',
]);

const DEFAULT_PORT = 8789;

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
  if (
    options.apply &&
    options.sourceMode === 'automated' &&
    options.mode === 'single' &&
    !options.ownerApprovalFile
  ) {
    fail('automated single-item apply requires --approval-file <signed-approval.json>');
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

export function collectExactMainCandidate(run = runSync) {
  const branch = run('git', ['branch', '--show-current']).trim();
  const dirty = run('git', ['status', '--porcelain', '--untracked-files=all']).trim();
  run('git', ['fetch', 'origin', 'main']);
  const headSha = run('git', ['rev-parse', 'HEAD']).trim().toLowerCase();
  const originMainSha = run('git', ['rev-parse', 'origin/main']).trim().toLowerCase();
  return Object.freeze({
    branch,
    clean: dirty === '',
    headSha,
    originMainSha,
  });
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

export function evaluateOperatorReadiness({ auth, candidate, migrations, safety }) {
  const blockers = [];
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

  if (Number(safety?.mutationHalt?.halted) !== 0) {
    blockers.push({
      id: 'mutation_lane_halted',
      detail: 'The dedicated mutation lane is halted.',
    });
  }
  if (safety?.mutationLane?.active_operation_id != null) {
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

function readMigrations(run) {
  const raw = run('pnpm', [
    'wrangler', 'd1', 'execute', 'xqueue-production',
    '--config', 'wrangler.status.jsonc',
    '--remote', '--yes', '--json',
    '--command', 'SELECT name FROM d1_migrations ORDER BY id;',
  ]);
  const payload = parseJsonOutput(raw);
  return (payload?.[0]?.results ?? []).map((row) => row.name);
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

export function collectOperatorPreflight(run = runSync) {
  const candidate = collectExactMainCandidate(run);
  const auth = parseJsonOutput(
    run('pnpm', ['cf:auth:preflight', '--environment', 'production']),
  );
  const migrations = readMigrations(run);
  assertMutationSchema(migrations);
  const safety = readSafety(run);
  const readiness = evaluateOperatorReadiness({
    auth,
    candidate,
    migrations,
    safety,
  });
  return Object.freeze({ candidate, auth, migrations, safety, readiness });
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

async function waitForHealth(url, fetchImpl, child, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode != null) {
      throw new Error('ephemeral production mutation Worker exited before health became ready');
    }
    try {
      const response = await fetchImpl(url + '/health', {
        headers: { accept: 'application/json' },
      });
      if (response.ok) return;
    } catch {
      // Bounded readiness polling only; no mutation request has been sent.
    }
    await sleep(250);
  }
  throw new Error('ephemeral production mutation Worker did not become healthy');
}

export async function invokeEphemeralWorker({
  payload,
  candidate,
  port = DEFAULT_PORT,
  spawnImpl = spawn,
  fetchImpl = globalThis.fetch,
}) {
  if (typeof fetchImpl !== 'function') fail('fetch support is required');
  const controlToken = randomBytes(32).toString('hex');
  const child = spawnImpl(
    'pnpm',
    [
      'wrangler', 'dev',
      '--config', 'wrangler.mutation-production-intake.jsonc',
      '--remote',
      '--port', String(port),
    ],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        MUTATION_CONTROL_TOKEN: controlToken,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );

  const stderr = [];
  child.stderr?.on('data', (chunk) => stderr.push(String(chunk)));

  const baseUrl = 'http://127.0.0.1:' + port;
  try {
    await waitForHealth(baseUrl, fetchImpl, child);
    const response = await fetchImpl(baseUrl + '/production-intake', {
      method: 'POST',
      headers: {
        authorization: 'Bearer ' + controlToken,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify({
        environment: 'production',
        candidate,
        ...payload,
      }),
    });

    let body;
    try {
      body = await response.json();
    } catch {
      throw new Error('production mutation Worker returned non-JSON');
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
    if (child.exitCode == null) child.kill('SIGTERM');
  }
}

export async function main(
  argv = process.argv.slice(2),
  {
    run = runSync,
    invokeWorker = invokeEphemeralWorker,
    readJson = (path) => JSON.parse(readFileSync(resolve(path), 'utf8')),
  } = {},
) {
  const options = parseArgs(argv);
  const input = readJson(options.file);
  const ownerApproval = options.ownerApprovalFile
    ? readJson(options.ownerApprovalFile)
    : null;
  const preflight = collectOperatorPreflight(run);

  const summary = {
    status: preflight.readiness.ok ? 'ready' : 'blocked',
    mode: options.apply ? 'apply' : 'observe',
    environment: 'production',
    candidate: preflight.candidate,
    schema: {
      required: REQUIRED_MUTATION_MIGRATIONS,
      active: REQUIRED_MUTATION_MIGRATIONS.filter((name) =>
        preflight.migrations.includes(name)),
    },
    readiness: preflight.readiness,
  };

  if (!preflight.readiness.ok) {
    console.log(JSON.stringify(summary, null, 2));
    process.exitCode = 1;
    return summary;
  }

  if (!options.apply) {
    console.log(JSON.stringify(summary, null, 2));
    return summary;
  }

  const result = await invokeWorker({
    candidate: preflight.candidate,
    payload: {
      mode: options.mode,
      sourceMode: options.sourceMode,
      ownerApproval,
      input,
    },
    port: options.port,
  });

  const output = {
    ...summary,
    status: 'complete',
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
    process.exitCode = 1;
  });
}
