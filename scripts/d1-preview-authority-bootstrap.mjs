#!/usr/bin/env node

import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { evaluateMirrorSyncAuthority } from '../src/authority-ownership.mjs';
import { executeInitialPreviewAuthorityBootstrap } from '../src/d1-preview-authority-bootstrap.mjs';
import {
  compileWranglerD1Invocation,
  createWranglerD1MirrorTransport,
} from '../src/d1-mirror-wrangler-transport.mjs';

const EXPECTED_BRANCH = 'hardening/issue-59-d1-mirror-activation';
const CONFIRMATION_ARG = '--confirm-preview-owner-none-bootstrap';
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

function processFailureDetail(result) {
  const stderr = result.stderr.trim();
  const stdout = result.stdout.trim();
  return [stderr, stdout].filter((value) => value.length > 0).join('\n');
}

async function runChecked(runProcess, invocation, label) {
  const result = normalizeProcessResult(await runProcess(invocation), label);
  if (result.exitCode !== 0) {
    const detail = processFailureDetail(result);
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
  if (statements.length !== 1) {
    throw new Error(`${label} returned an unexpected statement count`);
  }

  const [statement] = statements;
  if (!statement || typeof statement !== 'object' || statement.success !== true) {
    throw new Error(`${label} statement did not report success`);
  }
  if (!Array.isArray(statement.results)) {
    throw new Error(`${label} statement results were missing`);
  }

  return statement.results;
}

async function readAuthoritySchema({ env, runProcess }) {
  const invocation = compileWranglerD1Invocation({
    env,
    sql: AUTHORITY_SCHEMA_SQL,
  });
  const stdout = await runChecked(
    runProcess,
    invocation,
    `${env} authority schema read`,
  );
  const rows = parseSingleStatementRows(stdout, `${env} authority schema read`);
  return rows.map((row) => row?.name).filter((name) => typeof name === 'string');
}

function assertPreviewSchema(names) {
  const exact = [...names].sort();
  if (
    exact.length !== 2 ||
    exact[0] !== 'authority_events' ||
    exact[1] !== 'authority_state'
  ) {
    throw new Error(
      `preview authority schema is not exact: ${JSON.stringify(exact)}`,
    );
  }
}

function assertProductionSchemaAbsent(names) {
  if (names.length !== 0) {
    throw new Error(
      `production authority schema must remain absent: ${JSON.stringify(names)}`,
    );
  }
}

function assertUninitializedAuthority(authority) {
  if (authority.state !== null || authority.latestEvent !== null) {
    throw new Error('preview authority bootstrap requires empty authority tables');
  }
}

function assertExactSeededAuthority({
  authority,
  candidateSha,
  transitionId,
  eventAt,
}) {
  const state = authority.state;
  const event = authority.latestEvent;
  const sha = candidateSha.toLowerCase();

  const stateOk = state &&
    state.singleton_id === 1 &&
    state.owner === 'none' &&
    state.generation === 1 &&
    state.transition_state === 'stable' &&
    state.transition_id === transitionId &&
    (state.previous_owner ?? null) === null &&
    typeof state.candidate_sha === 'string' &&
    state.candidate_sha.toLowerCase() === sha &&
    (state.deployment_id ?? null) === null &&
    state.transitioned_at === eventAt &&
    state.updated_at === eventAt;

  const eventOk = event &&
    event.generation === 1 &&
    event.transition_id === transitionId &&
    (event.previous_owner ?? null) === null &&
    event.next_owner === 'none' &&
    event.transition_state === 'stable' &&
    typeof event.candidate_sha === 'string' &&
    event.candidate_sha.toLowerCase() === sha &&
    (event.deployment_id ?? null) === null &&
    event.event_at === eventAt;

  if (!stateOk || !eventOk) {
    throw new Error('preview authority independent readback did not match exact bootstrap evidence');
  }
}

async function gitValue(runProcess, args, label) {
  return (await runChecked(
    runProcess,
    { command: 'git', args },
    label,
  )).trim();
}

function canonicalEventAt(now) {
  const value = typeof now === 'function' ? now() : now;
  if (Object.prototype.toString.call(value) !== '[object Date]' || !Number.isFinite(value.getTime())) {
    throw new TypeError('now must produce a valid Date');
  }
  return value.toISOString();
}

function assertConfirmation(argv) {
  const normalized = Array.isArray(argv) && argv[0] === '--' ? argv.slice(1) : argv;
  if (!Array.isArray(normalized) || normalized.length !== 1 || normalized[0] !== CONFIRMATION_ARG) {
    throw new Error(
      `explicit confirmation required: ${CONFIRMATION_ARG}`,
    );
  }
}

export async function runPreviewAuthorityBootstrap({
  argv = [],
  runProcess = actualProcessRunner,
  now = () => new Date(),
} = {}) {
  if (typeof runProcess !== 'function') {
    throw new TypeError('runProcess must be a function');
  }

  assertConfirmation(argv);

  const branch = await gitValue(
    runProcess,
    ['branch', '--show-current'],
    'git branch check',
  );
  if (branch !== EXPECTED_BRANCH) {
    throw new Error(`preview authority bootstrap requires branch ${EXPECTED_BRANCH}`);
  }

  const candidateSha = await gitValue(
    runProcess,
    ['rev-parse', 'HEAD'],
    'git head check',
  );
  if (!/^[0-9a-f]{40}$/i.test(candidateSha)) {
    throw new Error('git HEAD is not a 40-hex commit SHA');
  }

  const treeStatus = await gitValue(
    runProcess,
    ['status', '--porcelain', '--untracked-files=all'],
    'git worktree check',
  );
  if (treeStatus.length !== 0) {
    throw new Error('preview authority bootstrap requires a clean worktree');
  }

  const eventAt = canonicalEventAt(now);
  const transitionId = `preview-bootstrap-none-${candidateSha.toLowerCase()}`;
  const transport = createWranglerD1MirrorTransport({ runProcess });

  const productionSchemaBefore = await readAuthoritySchema({
    env: PRODUCTION_ENV,
    runProcess,
  });
  assertProductionSchemaAbsent(productionSchemaBefore);

  const previewSchemaBefore = await readAuthoritySchema({
    env: PREVIEW_ENV,
    runProcess,
  });
  assertPreviewSchema(previewSchemaBefore);

  const authorityBefore = await transport.readAuthority({ env: PREVIEW_ENV });
  assertUninitializedAuthority(authorityBefore);

  const mirrorBefore = await transport.readMirror({
    env: PREVIEW_ENV,
    key: TARGET_KEY,
  });

  const bootstrap = await executeInitialPreviewAuthorityBootstrap({
    candidateSha,
    transitionId,
    eventAt,
    runProcess,
  });

  if (!bootstrap.ok) {
    return {
      ...bootstrap,
      candidateSha: candidateSha.toLowerCase(),
      transitionId,
      eventAt,
    };
  }

  const authorityAfter = await transport.readAuthority({ env: PREVIEW_ENV });
  assertExactSeededAuthority({
    authority: authorityAfter,
    candidateSha,
    transitionId,
    eventAt,
  });

  const authorityEvaluation = evaluateMirrorSyncAuthority({
    state: authorityAfter.state,
    latestEvent: authorityAfter.latestEvent,
  });
  if (authorityEvaluation.allowed) {
    throw new Error('owner=none bootstrap unexpectedly granted mirror-sync authority');
  }

  const mirrorAfter = await transport.readMirror({
    env: PREVIEW_ENV,
    key: TARGET_KEY,
  });
  if (mirrorAfter !== mirrorBefore) {
    throw new Error('preview mirror changed during authority bootstrap');
  }

  const productionSchemaAfter = await readAuthoritySchema({
    env: PRODUCTION_ENV,
    runProcess,
  });
  assertProductionSchemaAbsent(productionSchemaAfter);

  return {
    ok: true,
    status: 'confirmed_seeded_unowned',
    env: PREVIEW_ENV,
    candidateSha: candidateSha.toLowerCase(),
    transitionId,
    eventAt,
    owner: 'none',
    generation: 1,
    deploymentId: null,
    mirrorUnchanged: true,
    productionAuthoritySchemaAbsent: true,
    mirrorSyncAllowed: false,
    mirrorSyncRefusalReason: authorityEvaluation.reason,
  };
}

function isDirectExecution() {
  if (!process.argv[1]) return false;
  return resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

if (isDirectExecution()) {
  try {
    const result = await runPreviewAuthorityBootstrap({
      argv: process.argv.slice(2),
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (!result.ok) {
      process.exitCode = 1;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`XQUEUE PREVIEW AUTHORITY BOOTSTRAP: FAIL\n${message}\n`);
    process.exitCode = 1;
  }
}
