#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  applicationTableNames,
  backupEvidence,
  buildLogicalBackup,
} from '../src/d1-logical-backup.mjs';

const TARGETS = Object.freeze({
  preview: {
    database: 'xqueue-preview',
    config: 'wrangler.preview.jsonc',
  },
  production: {
    database: 'xqueue-production',
    config: 'wrangler.status.jsonc',
  },
});

const args = process.argv.slice(2);

function opt(name, fallback = null) {
  const index = args.indexOf('--' + name);
  return index >= 0 && args[index + 1] !== undefined ? args[index + 1] : fallback;
}

function target(environment) {
  const resolved = TARGETS[environment];
  if (!resolved) throw new Error('environment must be preview or production');
  return resolved;
}

function quotedIdentifier(name) {
  return '"' + String(name).replaceAll('"', '""') + '"';
}

function runWrangler(wranglerArgs) {
  const result = spawnSync('pnpm', wranglerArgs, {
    cwd: process.cwd(),
    env: process.env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = [result.stderr, result.stdout].filter(Boolean).join('\n').trim();
    throw new Error(
      'pnpm ' + wranglerArgs.join(' ') + ' failed with exit ' + result.status +
      (detail ? ': ' + detail : ''),
    );
  }
  return result.stdout || '';
}

function parseWranglerJson(stdout) {
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error('Wrangler D1 output is not valid JSON');
  }

  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error('Wrangler D1 output contained no statement results');
  }

  const rows = [];
  for (const statement of parsed) {
    if (statement?.success !== true) {
      throw new Error('Wrangler D1 statement did not report success');
    }
    if (Array.isArray(statement.results)) rows.push(...statement.results);
  }
  return rows;
}

function query(environment, sql) {
  const destination = target(environment);
  return parseWranglerJson(runWrangler([
    'wrangler', 'd1', 'execute', destination.database,
    '--config', destination.config,
    '--remote', '--yes', '--json', '--command', sql,
  ]));
}

async function main() {
  const environment = opt('environment', 'preview');
  const destination = target(environment);

  if (
    environment === 'production' &&
    opt('confirm') !== 'xqueue-production-backup'
  ) {
    throw new Error(
      'production backup requires --confirm xqueue-production-backup',
    );
  }

  const output = resolve(
    opt('output', '/tmp/xqueue-d1-logical-backup.json'),
  );
  const evidenceOutput = resolve(
    opt('evidence', '/tmp/xqueue-d1-logical-backup-evidence.json'),
  );

  const schemaRows = query(
    environment,
    "SELECT type,name,tbl_name,sql FROM sqlite_schema " +
    "WHERE sql IS NOT NULL AND type IN ('table','index','trigger','view') " +
    "ORDER BY type,name;",
  );

  const rowsByTable = {};
  for (const name of applicationTableNames(schemaRows)) {
    rowsByTable[name] = query(
      environment,
      'SELECT * FROM ' + quotedIdentifier(name) + ';',
    );
  }

  const migrations = query(
    environment,
    'SELECT id,name,applied_at FROM d1_migrations ORDER BY id;',
  );

  const backup = buildLogicalBackup({
    environment,
    database: destination.database,
    schemaRows,
    rowsByTable,
    migrations,
    createdAt: new Date().toISOString(),
  });

  writeFileSync(output, JSON.stringify(backup, null, 2) + '\n', 'utf8');
  writeFileSync(
    evidenceOutput,
    JSON.stringify(backupEvidence(backup), null, 2) + '\n',
    'utf8',
  );

  console.log('XQUEUE D1 LOGICAL BACKUP: PASS');
  console.log('  environment  ' + environment);
  console.log('  database     ' + destination.database);
  console.log('  backup id    ' + backup.backupId);
  console.log('  backup hash  ' + backup.backupHash);
  console.log('  tables       ' + Object.keys(backup.tables).length);
  console.log('  output       ' + output);
  console.log('  evidence     ' + evidenceOutput);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
