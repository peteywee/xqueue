#!/usr/bin/env node

import { spawnSync } from 'node:child_process';

import {
  renderOwnerClearPublicationHaltSql,
  renderOwnerSetPublicationHaltSql,
  renderPublicationHaltStatusSql,
} from '../src/publication-halt-owner.mjs';

const TARGETS = Object.freeze({
  preview: {
    database: 'xqueue-preview',
    config: 'wrangler.preview.jsonc',
  },
  production: {
    database: 'xqueue-production',
    config: 'wrangler.jsonc',
  },
});

export function parseArgs(argv) {
  const options = {
    action: 'status',
    environment: 'preview',
    expectedGeneration: null,
    reason: null,
    apply: false,
    confirm: null,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];

    if (arg === '--action') {
      options.action = next;
      index += 1;
    } else if (arg === '--environment') {
      options.environment = next;
      index += 1;
    } else if (arg === '--expected-generation') {
      options.expectedGeneration = Number(next);
      index += 1;
    } else if (arg === '--reason') {
      options.reason = next;
      index += 1;
    } else if (arg === '--apply') {
      options.apply = true;
    } else if (arg === '--confirm') {
      options.confirm = next;
      index += 1;
    } else {
      throw new Error('unknown argument: ' + arg);
    }
  }

  if (!['status', 'set', 'clear'].includes(options.action)) {
    throw new Error('action must be status, set, or clear');
  }
  if (!Object.hasOwn(TARGETS, options.environment)) {
    throw new Error('environment must be preview or production');
  }

  return options;
}


export function validateOwnerAction(options) {
  if (options.action === 'status') return options;

  if (!options.apply) {
    throw new Error('owner halt mutation is dry-run by default; pass --apply to mutate');
  }
  if (!Number.isSafeInteger(options.expectedGeneration) || options.expectedGeneration < 1) {
    throw new Error('--expected-generation is required for owner halt mutation');
  }
  if (typeof options.reason !== 'string' || options.reason.trim().length === 0) {
    throw new Error('--reason is required for owner halt mutation');
  }
  if (options.environment === 'production') {
    const expectedConfirm =
      options.action === 'set'
        ? 'xqueue-production-owner-set'
        : 'xqueue-production-owner-clear';
    if (options.confirm !== expectedConfirm) {
      throw new Error(
        'production owner ' + options.action +
        ' requires --confirm ' + expectedConfirm,
      );
    }
  }

  return options;
}

export function buildWranglerArgs({ environment, sql }) {
  const target = TARGETS[environment];
  if (!target) throw new Error('unknown halt-control environment');

  return [
    'wrangler',
    'd1',
    'execute',
    target.database,
    '--config',
    target.config,
    '--remote',
    '--yes',
    '--json',
    '--command',
    sql,
  ];
}

function runWrangler(args) {
  const result = spawnSync('pnpm', args, {
    encoding: 'utf8',
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = [result.stderr, result.stdout].filter(Boolean).join('\n').trim();
    throw new Error('wrangler halt control failed' + (detail ? ': ' + detail : ''));
  }

  return result.stdout ?? '';
}

function parseOwnerTransitionResult(
  stdout,
  { label, halted, expectedGeneration, reason },
) {
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error(label + ' D1 output is not valid JSON');
  }

  if (!Array.isArray(parsed) || parsed.length < 3) {
    throw new Error(label + ' D1 output is incomplete');
  }
  if (parsed.some((statement) => statement?.success !== true)) {
    throw new Error(label + ' D1 statement did not report success');
  }

  const rows = parsed.flatMap((statement) =>
    Array.isArray(statement?.results) ? statement.results : [],
  );
  const changes = rows.find((row) => Object.hasOwn(row ?? {}, 'direct_changes'));
  const state = rows.find((row) =>
    Object.hasOwn(row ?? {}, 'halted') &&
    Object.hasOwn(row ?? {}, 'generation'),
  );
  const expectedNextGeneration = Number(expectedGeneration) + 1;
  const expectedReason = String(reason).trim();

  if (Number(changes?.direct_changes) !== 1) {
    throw new Error(label + ' compare-and-set did not change exactly one row');
  }
  if (
    !state ||
    Number(state.singleton_id) !== 1 ||
    Number(state.halted) !== halted ||
    Number(state.generation) !== expectedNextGeneration ||
    state.actor_class !== 'owner' ||
    state.reason !== expectedReason
  ) {
    throw new Error(label + ' readback is not exact');
  }

  return state;
}

export function parseOwnerSetResult(stdout, expected = {}) {
  return parseOwnerTransitionResult(stdout, {
    label: 'owner set',
    halted: 1,
    ...expected,
  });
}

export function parseOwnerClearResult(stdout, expected = {}) {
  return parseOwnerTransitionResult(stdout, {
    label: 'owner clear',
    halted: 0,
    ...expected,
  });
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);

  if (options.action === 'status') {
    const stdout = runWrangler(buildWranglerArgs({
      environment: options.environment,
      sql: renderPublicationHaltStatusSql(),
    }));
    process.stdout.write(stdout);
    return;
  }

  validateOwnerAction(options);

  const render =
    options.action === 'set'
      ? renderOwnerSetPublicationHaltSql
      : renderOwnerClearPublicationHaltSql;
  const parseResult =
    options.action === 'set'
      ? parseOwnerSetResult
      : parseOwnerClearResult;

  const sql = render({
    expectedGeneration: options.expectedGeneration,
    reason: options.reason,
    at: new Date().toISOString(),
  });

  const stdout = runWrangler(buildWranglerArgs({
    environment: options.environment,
    sql,
  }));
  parseResult(stdout, {
    expectedGeneration: options.expectedGeneration,
    reason: options.reason,
  });
  process.stdout.write(stdout);
}

if (import.meta.url === new URL(process.argv[1], 'file:').href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
