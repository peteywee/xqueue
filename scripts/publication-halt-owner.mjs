#!/usr/bin/env node

import { spawnSync } from 'node:child_process';

import {
  renderOwnerClearPublicationHaltSql,
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

  if (!['status', 'clear'].includes(options.action)) {
    throw new Error('action must be status or clear');
  }
  if (!Object.hasOwn(TARGETS, options.environment)) {
    throw new Error('environment must be preview or production');
  }

  return options;
}


export function validateOwnerAction(options) {
  if (options.action === 'status') return options;

  if (!options.apply) {
    throw new Error('owner clear is dry-run by default; pass --apply to mutate');
  }
  if (!Number.isSafeInteger(options.expectedGeneration) || options.expectedGeneration < 1) {
    throw new Error('--expected-generation is required for owner clear');
  }
  if (typeof options.reason !== 'string' || options.reason.trim().length === 0) {
    throw new Error('--reason is required for owner clear');
  }
  if (
    options.environment === 'production' &&
    options.confirm !== 'xqueue-production-owner-clear'
  ) {
    throw new Error(
      'production owner clear requires --confirm xqueue-production-owner-clear',
    );
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

  process.stdout.write(result.stdout ?? '');
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);

  if (options.action === 'status') {
    runWrangler(buildWranglerArgs({
      environment: options.environment,
      sql: renderPublicationHaltStatusSql(),
    }));
    return;
  }

  validateOwnerAction(options);

  const sql = renderOwnerClearPublicationHaltSql({
    expectedGeneration: options.expectedGeneration,
    reason: options.reason,
    at: new Date().toISOString(),
  });

  runWrangler(buildWranglerArgs({
    environment: options.environment,
    sql,
  }));
}

if (import.meta.url === new URL(process.argv[1], 'file:').href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
