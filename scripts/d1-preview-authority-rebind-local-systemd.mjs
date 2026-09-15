#!/usr/bin/env node

import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { evaluateMirrorSyncAuthority } from '../src/authority-ownership.mjs';
import { deriveSystemdDeploymentIdentity } from '../src/systemd-deployment-identity.mjs';
import { executePreviewLocalSystemdRebind } from '../src/d1-preview-authority-rebind.mjs';
import {
  compileWranglerD1Invocation,
  createWranglerD1MirrorTransport,
} from '../src/d1-mirror-wrangler-transport.mjs';

const EXPECTED_BRANCH = 'hardening/issue-59-d1-mirror-activation';
const CONFIRMATION_ARG = '--confirm-preview-local-systemd-rebind';
const PREVIEW_ENV = 'preview';
const PRODUCTION_ENV = 'production';
const TARGET_KEY = 'state.snapshot_json';
const AUTHORITY_SCHEMA_SQL = `SELECT name
FROM sqlite_master
WHERE type = 'table'
  AND name IN ('authority_events', 'authority_state')
ORDER BY name;`;

function actualProcessRunner(invocation) {
  return new Promise((resolvePromise) => {
    execFile(
      invocation.command,
      invocation.args,
      { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, windowsHide: true },
      (error, stdout, stderr) => {
        resolvePromise({
          exitCode: error ? (Number.isSafeInteger(error.code) ? error.code : 1) : 0,
          stdout: typeof stdout === 'string' ? stdout : '',
          stderr: typeof stderr === 'string' ? stderr : '',
        });
      },
    );
  });
}

function normalizeProcessResult(result, label) {
  if (!result || typeof result !== 'object') throw new Error(`${label} returned no structured process result`);
  const exitCode = result.exitCode ?? result.code;
  if (!Number.isSafeInteger(exitCode)) throw new Error(`${label} process result must include an integer exitCode`);
  return {
    exitCode,
    stdout: typeof result.stdout === 'string' ? result.stdout : '',
    stderr: typeof result.stderr === 'string' ? result.stderr : '',
  };
}

async function runChecked(runProcess, invocation, label) {
  const result = normalizeProcessResult(await runProcess(invocation), label);
  if (result.exitCode !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim();
    throw new Error(
      detail.length > 0
        ? `${label} failed: ${detail}`
        : `${label} failed with exit code ${result.exitCode}`,
    );
  }
  return result.stdout;
}

function parseSingleStatementRows(stdout, label) {
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error(`${label} did not return valid Wrangler JSON`);
  }
  const statements = Array.isArray(parsed) ? parsed : [parsed];
  if (statements.length !== 1) throw new Error(`${label} returned an unexpected statement count`);
  const [statement] = statements;
  if (!statement || typeof statement !== 'object' || statement.success !== true) {
    throw new Error(`${label} statement did not report success`);
  }
  if (!Array.isArray(statement.results)) throw new Error(`${label} statement results were missing`);
  return statement.results;
}

async function readAuthoritySchema({ env, runProcess }) {
  const invocation = compileWranglerD1Invocation({ env, sql: AUTHORITY_SCHEMA_SQL });
  const stdout = await runChecked(runProcess, invocation, `${env} authority schema read`);
  return parseSingleStatementRows(stdout, `${env} authority schema read`)
    .map((row) => row?.name)
    .filter((name) => typeof name === 'string');
}

function assertProductionSchemaAbsent(names) {
  if (names.length !== 0) {
    throw new Error(`production authority schema must remain absent: ${JSON.stringify(names)}`);
  }
}

function assertConfirmation(argv) {
  if (!Array.isArray(argv)) throw new TypeError('argv must be an array');
  const normalized = argv[0] === '--' ? argv.slice(1) : [...argv];
  if (normalized.length !== 1 || normalized[0] !== CONFIRMATION_ARG) {
    throw new Error(`explicit confirmation required: ${CONFIRMATION_ARG}`);
  }
}

function canonicalEventAt(now) {
  const value = typeof now === 'function' ? now() : now;
  if (Object.prototype.toString.call(value) !== '[object Date]' || !Number.isFinite(value.getTime())) {
    throw new TypeError('now must produce a valid Date');
  }
  return value.toISOString();
}

async function gitValue(runProcess, args, label) {
  return (await runChecked(runProcess, { command: 'git', args }, label)).trim();
}

function deploymentIdentity(envVars) {
  const value = envVars?.XQUEUE_DEPLOYMENT_ID;
  return typeof value === 'string' ? value.trim() : '';
}

function exactLocalAuthority(snapshot) {
  const evaluated = evaluateMirrorSyncAuthority({
    state: snapshot?.state,
    latestEvent: snapshot?.latestEvent,
  });
  if (!evaluated.allowed || evaluated.owner !== 'local-systemd') {
    throw new Error('preview authority rebind requires stable local-systemd authority');
  }
  return evaluated;
}

export async function runPreviewLocalSystemdAuthorityRebind({
  argv = [],
  runProcess = actualProcessRunner,
  now = () => new Date(),
  envVars = process.env,
  deriveDeploymentIdentity = deriveSystemdDeploymentIdentity,
  transportFactory = createWranglerD1MirrorTransport,
  executeRebind = executePreviewLocalSystemdRebind,
} = {}) {
  if (typeof runProcess !== 'function') throw new TypeError('runProcess must be a function');
  if (typeof deriveDeploymentIdentity !== 'function') throw new TypeError('deriveDeploymentIdentity must be a function');
  if (typeof transportFactory !== 'function') throw new TypeError('transportFactory must be a function');
  if (typeof executeRebind !== 'function') throw new TypeError('executeRebind must be a function');

  assertConfirmation(argv);
  const explicitDeploymentId = deploymentIdentity(envVars);
  if (explicitDeploymentId.length === 0) throw new Error('XQUEUE_DEPLOYMENT_ID is required');

  const branch = await gitValue(runProcess, ['branch', '--show-current'], 'git branch check');
  if (branch !== EXPECTED_BRANCH) throw new Error(`preview authority rebind requires branch ${EXPECTED_BRANCH}`);
  const candidateSha = await gitValue(runProcess, ['rev-parse', 'HEAD'], 'git head check');
  if (!/^[0-9a-f]{40}$/i.test(candidateSha)) throw new Error('git HEAD is not a 40-hex commit SHA');
  const treeStatus = await gitValue(runProcess, ['status', '--porcelain', '--untracked-files=all'], 'git worktree check');
  if (treeStatus.length !== 0) throw new Error('preview authority rebind requires a clean worktree');

  const liveSystemdIdentity = await deriveDeploymentIdentity({ runProcess });
  if (!liveSystemdIdentity || typeof liveSystemdIdentity.deploymentId !== 'string' || liveSystemdIdentity.deploymentId.length === 0) {
    throw new Error('live systemd deployment identity is unavailable');
  }
  if (explicitDeploymentId !== liveSystemdIdentity.deploymentId) {
    throw new Error('XQUEUE_DEPLOYMENT_ID does not match the loaded xqueue.service identity');
  }
  const deploymentId = liveSystemdIdentity.deploymentId;

  const productionSchemaBefore = await readAuthoritySchema({ env: PRODUCTION_ENV, runProcess });
  assertProductionSchemaAbsent(productionSchemaBefore);

  const transport = transportFactory({ runProcess });
  const authorityBeforeSnapshot = await transport.readAuthority({ env: PREVIEW_ENV });
  const authorityBefore = exactLocalAuthority(authorityBeforeSnapshot);
  if (authorityBefore.deploymentId !== deploymentId) {
    throw new Error('current preview authority is bound to a different systemd deployment identity');
  }
  if (authorityBefore.candidateSha === candidateSha.toLowerCase()) {
    throw new Error('preview authority is already bound to the current candidate');
  }

  const mirrorBefore = await transport.readMirror({ env: PREVIEW_ENV, key: TARGET_KEY });
  const eventAt = canonicalEventAt(now);
  const transitionId = `preview-local-rebind-${candidateSha.toLowerCase()}`;

  const transition = await executeRebind({
    expectedGeneration: authorityBefore.generation,
    expectedCandidateSha: authorityBefore.candidateSha,
    candidateSha,
    deploymentId,
    transitionId,
    eventAt,
    runProcess,
  });
  if (!transition.ok) {
    return {
      ...transition,
      candidateSha: candidateSha.toLowerCase(),
      deploymentId,
      transitionId,
      eventAt,
    };
  }

  const authorityAfterSnapshot = await transport.readAuthority({ env: PREVIEW_ENV });
  const authorityAfter = exactLocalAuthority(authorityAfterSnapshot);
  if (
    authorityAfter.generation !== authorityBefore.generation + 1 ||
    authorityAfter.transitionId !== transitionId ||
    authorityAfter.candidateSha !== candidateSha.toLowerCase() ||
    authorityAfter.deploymentId !== deploymentId
  ) {
    throw new Error('preview authority independent readback did not match exact same-owner rebind evidence');
  }

  const mirrorAfter = await transport.readMirror({ env: PREVIEW_ENV, key: TARGET_KEY });
  if (mirrorAfter !== mirrorBefore) throw new Error('preview mirror changed during authority rebind');

  const productionSchemaAfter = await readAuthoritySchema({ env: PRODUCTION_ENV, runProcess });
  assertProductionSchemaAbsent(productionSchemaAfter);

  return {
    ok: true,
    status: 'confirmed_local_systemd_rebound',
    env: PREVIEW_ENV,
    owner: 'local-systemd',
    generation: authorityAfter.generation,
    previousCandidateSha: authorityBefore.candidateSha,
    candidateSha: candidateSha.toLowerCase(),
    deploymentId,
    systemdUnit: liveSystemdIdentity.unit ?? null,
    systemdUnitHash: liveSystemdIdentity.unitHash ?? null,
    transitionId,
    eventAt,
    mirrorUnchanged: true,
    productionAuthoritySchemaAbsent: true,
  };
}

function isDirectExecution() {
  if (!process.argv[1]) return false;
  return resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

if (isDirectExecution()) {
  try {
    const result = await runPreviewLocalSystemdAuthorityRebind({ argv: process.argv.slice(2) });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (!result.ok) process.exitCode = 1;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`XQUEUE PREVIEW LOCAL AUTHORITY REBIND: FAIL\n${message}\n`);
    process.exitCode = 1;
  }
}
