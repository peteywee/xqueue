#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  CANONICAL_QUEUE_JSON,
  DECLARED_QUEUE_SHA256,
} from '../cloudflare/generated/queue-bundle.mjs';
import { decodeBundledQueue } from '../cloudflare/src/queue-integrity.mjs';
import { evaluateCutoverReadiness } from '../src/cutover-readiness.mjs';
import { observeRuntime } from './tsal-runtime-evidence.mjs';
import { observeDeploymentAuthority } from './tsal-deployment-evidence.mjs';

const PRODUCTION_DB = 'xqueue-production';
const PRODUCTION_CONFIG = 'wrangler.jsonc';
const HEALTH_URL = 'https://xqueue-production.patrickcraven.workers.dev/health';
const OUTPUT =
  process.env.XQUEUE_CUTOVER_READINESS_EVIDENCE ??
  '/tmp/xqueue-production-cutover-readiness.json';

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    env: process.env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  if (result.error) {
    return { ok: false, stdout: '', error: result.error.message };
  }
  if (result.status !== 0) {
    return {
      ok: false,
      stdout: result.stdout ?? '',
      error: [result.stderr, result.stdout].filter(Boolean).join('\n').trim() ||
        command + ' exited ' + result.status,
    };
  }
  return { ok: true, stdout: result.stdout ?? '', error: null };
}

function parseWranglerRows(stdout) {
  const parsed = JSON.parse(stdout);
  if (!Array.isArray(parsed)) throw new Error('Wrangler output is not an array');

  const rows = [];
  for (const statement of parsed) {
    if (statement?.success !== true) {
      throw new Error('Wrangler statement did not report success');
    }
    if (Array.isArray(statement.results)) rows.push(...statement.results);
  }
  return rows;
}

function readProduction(sql) {
  const result = run('pnpm', [
    'wrangler',
    'd1',
    'execute',
    PRODUCTION_DB,
    '--config',
    PRODUCTION_CONFIG,
    '--remote',
    '--yes',
    '--json',
    '--command',
    sql,
  ]);

  if (!result.ok) return { rows: null, error: result.error };

  try {
    return { rows: parseWranglerRows(result.stdout), error: null };
  } catch (error) {
    return {
      rows: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function audit(script) {
  const result = run(process.execPath, [script]);
  return {
    ok: result.ok,
    error: result.error,
  };
}

function first(rows) {
  return Array.isArray(rows) ? rows[0] ?? null : null;
}

async function main() {
  const queue = decodeBundledQueue();
  const nowMs = Date.now();

  const [
    runtimeObservation,
    controlPlane,
  ] = await Promise.all([
    observeRuntime({ url: HEALTH_URL }),
    observeDeploymentAuthority({
      accountId: process.env.CLOUDFLARE_ACCOUNT_ID ?? '',
      token: process.env.CLOUDFLARE_API_TOKEN ?? '',
      healthUrl: HEALTH_URL,
    }),
  ]);

  const migrations = readProduction(
    'SELECT name FROM d1_migrations ORDER BY id;',
  );
  const metadata = readProduction(
    "SELECT key,value FROM runtime_metadata WHERE key IN ('queue.sha256','queue.count') ORDER BY key;",
  );
  const unresolved = readProduction(
    "SELECT COUNT(*) AS count FROM publication_state WHERE status IN ('prepared','publishing','needs_reconciliation');",
  );
  const activeLease = readProduction(
    'SELECT COUNT(*) AS count FROM publication_leases ' +
    'WHERE owner_token IS NOT NULL AND expires_at_ms > ' + String(nowMs) + ';',
  );
  const halt = readProduction(
    'SELECT halted,generation,reason,actor_class,updated_at ' +
    'FROM publication_halt_state WHERE singleton_id=1;',
  );

  const metadataMap = Object.create(null);
  if (Array.isArray(metadata.rows)) {
    for (const row of metadata.rows) metadataMap[row.key] = row.value;
  }

  const d1Errors = [
    migrations.error,
    metadata.error,
    unresolved.error,
    activeLease.error,
    halt.error,
  ].filter(Boolean);

  const authorityAudit = audit('scripts/authority-boundary-audit.mjs');
  const credentialAudit = audit('scripts/credential-boundary-audit.mjs');

  const d1 = {
    queueSha256: metadataMap['queue.sha256'] ?? null,
    queueCount: metadataMap['queue.count'] ?? null,
    migrationNames: Array.isArray(migrations.rows)
      ? migrations.rows.map((row) => row.name)
      : null,
    unresolvedAttemptCount: first(unresolved.rows)?.count ?? null,
    activeLeaseCount: first(activeLease.rows)?.count ?? null,
    haltState: first(halt.rows),
    observationErrors: d1Errors,
  };

  const result = evaluateCutoverReadiness({
    queue,
    canonicalQueueText: CANONICAL_QUEUE_JSON,
    declaredQueueSha256: DECLARED_QUEUE_SHA256,
    health: runtimeObservation.health,
    d1,
    controlPlane,
    authorityBoundaryIntact: authorityAudit.ok,
    credentialBoundaryIntact: credentialAudit.ok,
  });

  const authoritySummary = result.observed.cloudflareAuthority;
  const sanitizeError = (value) => {
    if (typeof value !== 'string') return value;
    const accountId = process.env.CLOUDFLARE_ACCOUNT_ID ?? '';
    return accountId ? value.replaceAll(accountId, '***') : value;
  };
  const sanitizedD1Errors = d1Errors.map(sanitizeError);
  const sanitizedControlPlaneErrors =
    (controlPlane.observationErrors ?? []).map(sanitizeError);

  const evidence = {
    format: 1,
    issue: 46,
    candidateSha: process.env.GITHUB_SHA ?? null,
    producedAt: new Date().toISOString(),
    environment: 'production',
    mode: 'read-only-precutover',
    ready: result.ready,
    checks: result.checks,
    blockers: result.blockers,
    observed: result.observed,
    observations: {
      runtimeError: sanitizeError(runtimeObservation.observationError),
      runtimeStatus: runtimeObservation.health?.status ?? null,
      dynamicRuntimeReason:
        runtimeObservation.health?.dynamicRuntimeReadiness?.reason ?? null,
      authorityReadinessReason:
        runtimeObservation.health?.authorityReadiness?.reason ?? null,
      authority: authoritySummary,
      d1Errors: sanitizedD1Errors,
      migrationNames: d1.migrationNames,
      haltState: d1.haltState,
      controlPlaneErrors: sanitizedControlPlaneErrors,
      controlPlane: controlPlane.cloudflare ?? null,
      authorityBoundaryError: authorityAudit.error,
      credentialBoundaryError: credentialAudit.error,
    },
    safety: {
      productionD1Mutation: false,
      publicationAuthorityChanged: false,
      xWrite: false,
      ownerHaltChanged: false,
    },
  };

  writeFileSync(resolve(OUTPUT), JSON.stringify(evidence, null, 2) + '\n', 'utf8');

  console.log('XQUEUE #46 PRE-CUTOVER READINESS: ' + (result.ready ? 'PASS' : 'BLOCKED'));
  console.log('  committed UTC rows  ' + result.observed.committedUtcCount + '/' + result.observed.queueCount);
  console.log('  blockers            ' + (result.blockers.map((row) => row.id).join(', ') || 'none'));
  console.log('  authority state     ' + result.observed.cloudflareAuthorityState);
  console.log('  authority flag      ' + String(authoritySummary.authorityFlag));
  console.log('  authorized          ' + String(authoritySummary.authorized));
  console.log('  live publication    ' + String(authoritySummary.livePublication));
  console.log('  scheduler authority ' + String(authoritySummary.schedulerAuthority));
  console.log('  dynamic reason      ' + (runtimeObservation.health?.dynamicRuntimeReadiness?.reason ?? 'none'));
  console.log('  readiness reason    ' + (runtimeObservation.health?.authorityReadiness?.reason ?? 'none'));
  console.log('  migration tail      ' + ((d1.migrationNames ?? []).slice(-8).join(',') || 'unavailable'));
  console.log('  halt state          ' + (d1.haltState ? JSON.stringify(d1.haltState) : 'unavailable'));
  console.log('  D1 read errors      ' + (sanitizedD1Errors.join(' | ') || 'none'));
  console.log('  control-plane errors ' + (sanitizedControlPlaneErrors.join(' | ') || 'none'));
  console.log('  evidence            ' + resolve(OUTPUT));

  if (!result.ready) process.exitCode = 2;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
