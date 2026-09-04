#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PRODUCTION = Object.freeze({
  workerName: 'xqueue-production',
  databaseName: 'xqueue-production',
  databaseId: 'fc85026e-bfc8-435f-8bb0-c60e139178a3',
  cron: '*/15 * * * *',
});

export const PREVIEW = Object.freeze({
  workerName: 'xqueue-preview',
  databaseName: 'xqueue-preview',
  databaseId: 'f5f9bea9-e88c-41ab-9407-70356079a638',
});

export const WATCHDOG = Object.freeze({
  workerName: 'xqueue-watchdog',
  main: 'cloudflare/src/liveness-watchdog.mjs',
  databaseName: PRODUCTION.databaseName,
  databaseId: PRODUCTION.databaseId,
  cron: '7 * * * *',
});

function fail(message) {
  const error = new Error(message);
  error.code = 'XQUEUE_ENV_CONFIG_INVALID';
  throw error;
}

function requireObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
}

function requireSingleDb(config, label) {
  if (!Array.isArray(config.d1_databases) || config.d1_databases.length !== 1) {
    fail(`${label} must define exactly one D1 database binding`);
  }

  const db = config.d1_databases[0];
  requireObject(db, `${label}.d1_databases[0]`);

  if (db.binding !== 'DB') {
    fail(`${label} D1 binding must be named DB`);
  }

  if (Object.hasOwn(db, 'preview_database_id')) {
    fail(`${label} must not contain preview_database_id; environment identity must be unambiguous`);
  }

  return db;
}

function exactCrons(config) {
  const crons = config?.triggers?.crons;
  return Array.isArray(crons) ? crons : [];
}

function assertNoPublicationSecrets(config, label) {
  const serialized = JSON.stringify(config);
  for (const forbidden of [
    'XQUEUE_PUBLISH_AUTHORITY',
    'X_API_KEY',
    'X_API_SECRET',
    'X_ACCESS_TOKEN',
    'X_ACCESS_SECRET',
  ]) {
    if (serialized.includes(forbidden)) {
      fail(`${label} contains forbidden publication capability ${forbidden}`);
    }
  }
}

export function validateProductionConfig(config) {
  requireObject(config, 'production config');
  const db = requireSingleDb(config, 'production config');

  if (config.name !== PRODUCTION.workerName) {
    fail(`production worker name must be ${PRODUCTION.workerName}`);
  }

  if (db.database_name !== PRODUCTION.databaseName) {
    fail(`production DB name must be ${PRODUCTION.databaseName}`);
  }

  if (db.database_id !== PRODUCTION.databaseId) {
    fail('production DB id does not match the pinned production database');
  }

  const crons = exactCrons(config);
  if (crons.length !== 1 || crons[0] !== PRODUCTION.cron) {
    fail(`production config must define exactly one cron: ${PRODUCTION.cron}`);
  }

  const serialized = JSON.stringify(config);
  if (serialized.includes(PREVIEW.databaseId) || serialized.includes(PREVIEW.databaseName)) {
    fail('production config contains preview D1 identity');
  }

  return true;
}

export function validatePreviewConfig(config) {
  requireObject(config, 'preview config');
  const db = requireSingleDb(config, 'preview config');

  if (config.name !== PREVIEW.workerName) {
    fail(`preview worker name must be ${PREVIEW.workerName}`);
  }

  if (db.database_name !== PREVIEW.databaseName) {
    fail(`preview DB name must be ${PREVIEW.databaseName}`);
  }

  if (db.database_id !== PREVIEW.databaseId) {
    fail('preview DB id does not match the pinned preview database');
  }

  const crons = exactCrons(config);
  if (crons.length !== 0) {
    fail('preview config must not register publication cron triggers');
  }

  const serialized = JSON.stringify(config);
  if (serialized.includes(PRODUCTION.databaseId) || serialized.includes(PRODUCTION.databaseName)) {
    fail('preview config contains production D1 identity');
  }

  return true;
}

export function validateWatchdogConfig(config) {
  requireObject(config, 'watchdog config');
  const db = requireSingleDb(config, 'watchdog config');

  if (config.name !== WATCHDOG.workerName) {
    fail(`watchdog worker name must be ${WATCHDOG.workerName}`);
  }
  if (config.main !== WATCHDOG.main) {
    fail(`watchdog main must be ${WATCHDOG.main}`);
  }
  if (db.database_name !== WATCHDOG.databaseName || db.database_id !== WATCHDOG.databaseId) {
    fail('watchdog must read the pinned production D1 database');
  }

  const crons = exactCrons(config);
  if (crons.length !== 1 || crons[0] !== WATCHDOG.cron) {
    fail(`watchdog config must define exactly one cron: ${WATCHDOG.cron}`);
  }

  if (Array.isArray(config.r2_buckets) && config.r2_buckets.length > 0) {
    fail('watchdog config must not bind R2 publication media');
  }

  assertNoPublicationSecrets(config, 'watchdog config');

  const serialized = JSON.stringify(config);
  if (serialized.includes(PREVIEW.databaseId) || serialized.includes(PREVIEW.databaseName)) {
    fail('watchdog config contains preview D1 identity');
  }

  return true;
}

export function parseStrictJsonConfig(text, label = 'config') {
  try {
    return JSON.parse(text);
  } catch (error) {
    fail(`${label} must remain strict JSON-compatible JSONC: ${error.message}`);
  }
}

export function verifyRepositoryEnvironmentConfigs(root = process.cwd()) {
  const production = parseStrictJsonConfig(
    fs.readFileSync(path.join(root, 'wrangler.authority.jsonc'), 'utf8'),
    'wrangler.authority.jsonc',
  );
  const preview = parseStrictJsonConfig(
    fs.readFileSync(path.join(root, 'wrangler.jsonc'), 'utf8'),
    'wrangler.jsonc',
  );
  const watchdog = parseStrictJsonConfig(
    fs.readFileSync(path.join(root, 'wrangler.watchdog.jsonc'), 'utf8'),
    'wrangler.watchdog.jsonc',
  );

  validateProductionConfig(production);
  validatePreviewConfig(preview);
  validateWatchdogConfig(watchdog);

  return {
    ok: true,
    production: {
      worker: production.name,
      databaseId: production.d1_databases[0].database_id,
      cron: production.triggers.crons[0],
    },
    preview: {
      worker: preview.name,
      databaseId: preview.d1_databases[0].database_id,
      crons: preview.triggers.crons,
    },
    watchdog: {
      worker: watchdog.name,
      databaseId: watchdog.d1_databases[0].database_id,
      cron: watchdog.triggers.crons[0],
      publicationCapability: false,
    },
  };
}

const isCli = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (isCli) {
  try {
    const result = verifyRepositoryEnvironmentConfigs();
    console.log(JSON.stringify(result, null, 2));
    console.log('XQUEUE ENVIRONMENT CONFIG: PASS');
  } catch (error) {
    console.error(`XQUEUE ENVIRONMENT CONFIG: FAIL — ${error.message}`);
    process.exitCode = 1;
  }
}
