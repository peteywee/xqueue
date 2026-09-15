#!/usr/bin/env node

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { compileD1MirrorSyncPlan } from '../src/d1-mirror-sync-plan.mjs';
import { executeD1MirrorSyncPlan } from '../src/d1-mirror-sync-executor.mjs';
import { createWranglerD1MirrorTransport } from '../src/d1-mirror-wrangler-transport.mjs';
import { readState } from '../src/state-store.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const STATE = join(ROOT, 'state.json');
const ENVIRONMENTS = new Set(['production', 'preview']);
const PRODUCTION_SYNC_ACTIVATED = false;
const SHA40_RE = /^[0-9a-f]{40}$/i;

function actualProcessRunner(invocation) {
  return new Promise((resolvePromise) => {
    execFile(
      invocation.command,
      invocation.args,
      {
        encoding: 'utf8',
        maxBuffer: 4 * 1024 * 1024,
        windowsHide: true,
      },
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
  if (!result || typeof result !== 'object') {
    throw new Error(`${label} returned no structured process result`);
  }

  const exitCode = result.exitCode ?? result.code;
  if (!Number.isSafeInteger(exitCode)) {
    throw new Error(`${label} process result must include an integer exitCode`);
  }

  return {
    exitCode,
    stdout: typeof result.stdout === 'string' ? result.stdout : '',
    stderr: typeof result.stderr === 'string' ? result.stderr : '',
  };
}

async function runChecked(runProcess, invocation, label) {
  const result = normalizeProcessResult(await runProcess(invocation), label);
  if (result.exitCode !== 0) {
    const stderr = result.stderr.trim();
    const stdout = result.stdout.trim();
    const detail = stderr || stdout;
    throw new Error(
      detail.length > 0
        ? `${label} failed: ${detail}`
        : `${label} failed with exit code ${result.exitCode}`,
    );
  }
  return result.stdout;
}

function fail(reason, extra = {}) {
  return {
    ok: false,
    status: 'refused',
    reason,
    ...extra,
  };
}

function normalizedArgs(argv) {
  if (!Array.isArray(argv)) throw new TypeError('argv must be an array');
  return argv[0] === '--' ? argv.slice(1) : [...argv];
}

function parseEnvironment(argv) {
  const args = normalizedArgs(argv);

  if (args.length === 2 && args[0] === '--env' && ENVIRONMENTS.has(args[1])) {
    return args[1];
  }

  if (args.length === 1 && args[0].startsWith('--env=')) {
    const env = args[0].slice('--env='.length);
    if (ENVIRONMENTS.has(env)) return env;
  }

  throw new Error('explicit environment required: --env preview|production');
}

async function gitValue(runProcess, args, label) {
  return (await runChecked(
    runProcess,
    { command: 'git', args },
    label,
  )).trim();
}

function readRequiredLocalState() {
  if (!existsSync(STATE)) {
    throw new Error('state.json is missing');
  }
  return readState(STATE);
}

function deploymentIdentity(envVars) {
  const raw = envVars?.XQUEUE_DEPLOYMENT_ID;
  return typeof raw === 'string' ? raw.trim() : '';
}

export async function runD1MirrorSync({
  argv = [],
  runProcess = actualProcessRunner,
  readLocalState = readRequiredLocalState,
  transportFactory = createWranglerD1MirrorTransport,
  envVars = process.env,
} = {}) {
  if (typeof runProcess !== 'function') {
    throw new TypeError('runProcess must be a function');
  }
  if (typeof readLocalState !== 'function') {
    throw new TypeError('readLocalState must be a function');
  }
  if (typeof transportFactory !== 'function') {
    throw new TypeError('transportFactory must be a function');
  }

  const env = parseEnvironment(argv);

  if (env === 'production' && !PRODUCTION_SYNC_ACTIVATED) {
    return fail('production_sync_not_activated', {
      env,
      writeAttempted: false,
    });
  }

  const candidateSha = await gitValue(
    runProcess,
    ['rev-parse', 'HEAD'],
    'git head check',
  );
  if (!SHA40_RE.test(candidateSha)) {
    return fail('git_head_invalid', { env, writeAttempted: false });
  }

  const treeStatus = await gitValue(
    runProcess,
    ['status', '--porcelain', '--untracked-files=all'],
    'git worktree check',
  );
  if (treeStatus.length !== 0) {
    return fail('worktree_not_clean', {
      env,
      candidateSha: candidateSha.toLowerCase(),
      writeAttempted: false,
    });
  }

  let localState;
  try {
    localState = readLocalState();
  } catch (error) {
    return fail('local_state_invalid', {
      env,
      candidateSha: candidateSha.toLowerCase(),
      detail: error instanceof Error ? error.message : String(error),
      writeAttempted: false,
    });
  }

  const transport = transportFactory({ runProcess });

  let authoritySnapshot;
  try {
    authoritySnapshot = await transport.readAuthority({ env });
  } catch (error) {
    return fail('authority_read_failed', {
      env,
      candidateSha: candidateSha.toLowerCase(),
      detail: error instanceof Error ? error.message : String(error),
      writeAttempted: false,
    });
  }

  const authorityGate = compileD1MirrorSyncPlan({
    env,
    localState,
    authorityState: authoritySnapshot?.state,
    latestAuthorityEvent: authoritySnapshot?.latestEvent,
    currentMirrorText: null,
  });

  if (!authorityGate.ok) {
    return fail(authorityGate.reason, {
      env,
      candidateSha: candidateSha.toLowerCase(),
      authority: authorityGate.authority ?? null,
      writeAttempted: false,
    });
  }

  if (authorityGate.authority.candidateSha !== candidateSha.toLowerCase()) {
    return fail('authority_candidate_not_current_head', {
      env,
      candidateSha: candidateSha.toLowerCase(),
      authorityCandidateSha: authorityGate.authority.candidateSha,
      writeAttempted: false,
    });
  }

  const localDeploymentId = deploymentIdentity(envVars);
  if (localDeploymentId.length === 0) {
    return fail('local_deployment_identity_missing', {
      env,
      candidateSha: candidateSha.toLowerCase(),
      authorityDeploymentId: authorityGate.authority.deploymentId,
      writeAttempted: false,
    });
  }

  if (localDeploymentId !== authorityGate.authority.deploymentId) {
    return fail('local_deployment_identity_mismatch', {
      env,
      candidateSha: candidateSha.toLowerCase(),
      authorityDeploymentId: authorityGate.authority.deploymentId,
      localDeploymentId,
      writeAttempted: false,
    });
  }

  let currentMirrorText;
  try {
    currentMirrorText = await transport.readMirror({
      env,
      key: authorityGate.targetKey,
    });
  } catch (error) {
    return fail('mirror_read_failed_before', {
      env,
      candidateSha: candidateSha.toLowerCase(),
      detail: error instanceof Error ? error.message : String(error),
      writeAttempted: false,
    });
  }

  const plan = compileD1MirrorSyncPlan({
    env,
    localState,
    authorityState: authoritySnapshot?.state,
    latestAuthorityEvent: authoritySnapshot?.latestEvent,
    currentMirrorText,
  });

  if (!plan.ok) {
    return fail(plan.reason, {
      env,
      candidateSha: candidateSha.toLowerCase(),
      authority: plan.authority ?? null,
      writeAttempted: false,
    });
  }

  const result = await executeD1MirrorSyncPlan({
    plan,
    transport,
  });

  return {
    ...result,
    candidateSha: candidateSha.toLowerCase(),
    planOperation: plan.operation,
    before: plan.before,
    local: plan.local,
  };
}

function isDirectExecution() {
  if (!process.argv[1]) return false;
  return resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

if (isDirectExecution()) {
  try {
    const result = await runD1MirrorSync({
      argv: process.argv.slice(2),
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (!result.ok) process.exitCode = 1;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`XQUEUE D1 MIRROR SYNC: FAIL\n${message}\n`);
    process.exitCode = 1;
  }
}
