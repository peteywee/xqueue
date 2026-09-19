import { createHash } from 'node:crypto';

export const PREVIEW_DB = 'xqueue-preview';
export const PREVIEW_CONFIG = 'wrangler.preview.jsonc';
export const PREVIEW_DB_ID = 'f5f9bea9-e88c-41ab-9407-70356079a638';

export const BASE_MIGRATIONS = Object.freeze([
  '0001_xqueue_runtime.sql',
  '0002_runtime_evidence.sql',
  '0003_publication_lease.sql',
  '0004_authority_ownership.sql',
  '0005_publication_state_generation.sql',
]);

export const SHADOW_MIGRATION = '0006_continuous_queue_shadow.sql';
export const KNOWN_POST_SHADOW_MIGRATIONS = Object.freeze([
  '0007_continuous_queue_intake.sql',
]);

export function sha256Json(value) {
  return createHash('sha256')
    .update(Buffer.from(JSON.stringify(value), 'utf8'))
    .digest('hex');
}

export function assertPreviewConfig(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error('preview config must be an object');
  }
  if (config.name !== PREVIEW_DB) {
    throw new Error(`preview Worker name must be ${PREVIEW_DB}`);
  }

  const databases = config.d1_databases;
  if (!Array.isArray(databases) || databases.length !== 1) {
    throw new Error('preview config must declare exactly one D1 database');
  }

  const [db] = databases;
  if (
    db.binding !== 'DB' ||
    db.database_name !== PREVIEW_DB ||
    db.database_id !== PREVIEW_DB_ID ||
    db.migrations_dir !== 'cloudflare/migrations'
  ) {
    throw new Error('preview D1 identity/config drifted from the pinned proof target');
  }

  const raw = JSON.stringify(config);
  if (/xqueue-production|fc85026e-bfc8-435f-8bb0-c60e139178a3/.test(raw)) {
    throw new Error('preview config contains a production D1 identity');
  }

  return true;
}

export function wranglerExecuteArgs({ sql = null, file = null } = {}) {
  if ((sql === null) === (file === null)) {
    throw new Error('provide exactly one of sql or file');
  }

  const args = [
    'wrangler',
    'd1',
    'execute',
    PREVIEW_DB,
    '--config',
    PREVIEW_CONFIG,
    '--remote',
    '--yes',
    '--json',
  ];

  if (sql !== null) args.push('--command', sql);
  else args.push('--file', file);

  return args;
}

export function wranglerMigrationsApplyArgs() {
  return [
    'wrangler',
    'd1',
    'migrations',
    'apply',
    PREVIEW_DB,
    '--config',
    PREVIEW_CONFIG,
    '--remote',
  ];
}

export function parseWranglerJson(stdout) {
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error('Wrangler D1 output is not valid JSON');
  }

  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error('Wrangler D1 output contained no statement results');
  }

  const results = [];
  for (const statement of parsed) {
    if (statement?.success !== true) {
      throw new Error('Wrangler D1 statement did not report success');
    }
    if (!Array.isArray(statement.results)) {
      throw new Error('Wrangler D1 statement results are missing');
    }
    results.push(statement.results);
  }

  return results;
}

export function flattenStatementRows(statementResults) {
  return statementResults.flatMap((rows) => rows);
}

export function migrationNames(rows) {
  if (!Array.isArray(rows)) throw new Error('migration rows must be an array');
  return rows.map((row) => row?.name).filter((name) => typeof name === 'string');
}

export function assertMigrationLedger(names, { shadowMayExist = true } = {}) {
  const expectedBase = [...BASE_MIGRATIONS];

  if (!Array.isArray(names)) throw new Error('migration names must be an array');
  if (new Set(names).size !== names.length) {
    throw new Error('preview migration ledger contains duplicate names');
  }

  const base = names.slice(0, expectedBase.length);
  if (JSON.stringify(base) !== JSON.stringify(expectedBase)) {
    throw new Error(
      `preview migration ledger is not the exact 0001-0005 baseline: ${JSON.stringify(names)}`,
    );
  }

  const tail = names.slice(expectedBase.length);
  const validTails = [
    [],
    [SHADOW_MIGRATION],
    [SHADOW_MIGRATION, ...KNOWN_POST_SHADOW_MIGRATIONS],
  ];

  if (!validTails.some((expected) => JSON.stringify(tail) === JSON.stringify(expected))) {
    throw new Error(
      `preview migration ledger has an unknown or reordered tail: ${JSON.stringify(names)}`,
    );
  }

  const hasShadow = tail.includes(SHADOW_MIGRATION);
  if (!shadowMayExist && hasShadow) {
    throw new Error('shadow migration is already applied unexpectedly');
  }

  return Object.freeze({
    hasShadow,
    postShadowMigrations: tail.filter((name) =>
      KNOWN_POST_SHADOW_MIGRATIONS.includes(name),
    ),
  });
}

