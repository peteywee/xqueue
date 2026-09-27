#!/usr/bin/env node

import { spawnSync } from 'node:child_process';

import { verifyCloudflareApiToken } from '../src/cloudflare-auth.mjs';

const TARGETS = Object.freeze({
  preview: Object.freeze({
    database: 'xqueue-preview',
    config: 'wrangler.preview.jsonc',
  }),
  production: Object.freeze({
    database: 'xqueue-production',
    config: 'wrangler.jsonc',
  }),
});

export function parseEnvironment(argv = []) {
  let environment = 'production';

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === '--environment') {
      environment = argv[index + 1];
      index += 1;
    } else if (arg.startsWith('--environment=')) {
      environment = arg.slice('--environment='.length);
    } else {
      throw new Error('unknown argument: ' + arg);
    }
  }

  if (!Object.hasOwn(TARGETS, environment)) {
    throw new Error('environment must be preview or production');
  }

  return environment;
}

function runD1ReadProbe(target) {
  const result = spawnSync(
    'pnpm',
    [
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
      'SELECT 1 AS ok;',
    ],
    {
      encoding: 'utf8',
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );

  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = [result.stderr, result.stdout]
      .filter(Boolean)
      .join('\n')
      .trim();
    throw new Error(
      'Cloudflare D1 read capability probe failed for ' +
        target.database +
        (detail ? ': ' + detail : ''),
    );
  }

  let payload;
  try {
    payload = JSON.parse(result.stdout);
  } catch {
    throw new Error('Cloudflare D1 read capability probe returned non-JSON');
  }

  const statements = Array.isArray(payload) ? payload : [payload];
  const first = statements[0];
  const row = Array.isArray(first?.results) ? first.results[0] : null;

  if (first?.success !== true || Number(row?.ok) !== 1) {
    throw new Error('Cloudflare D1 read capability probe did not return ok=1');
  }

  return {
    database: target.database,
    config: target.config,
    readable: true,
  };
}

export async function main(argv = process.argv.slice(2)) {
  const environment = parseEnvironment(argv);
  const target = TARGETS[environment];

  const auth = await verifyCloudflareApiToken();
  const d1 = runD1ReadProbe(target);

  console.log(
    JSON.stringify(
      {
        ok: true,
        environment,
        token_type: auth.tokenType,
        token_status: auth.status,
        expires_on: auth.expiresOn,
        account_id_present:
          typeof process.env.CLOUDFLARE_ACCOUNT_ID === 'string' &&
          process.env.CLOUDFLARE_ACCOUNT_ID.length > 0,
        d1,
      },
      null,
      2,
    ),
  );
}

if (import.meta.url === new URL(process.argv[1], 'file:').href) {
  main().catch((error) => {
    console.error('XQUEUE CLOUDFLARE AUTH PREFLIGHT: FAIL');
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
