#!/usr/bin/env node
// Mechanical proof of XQueue deployment and publication-authority boundaries.
// #45 adds target status/publisher roles without activating them; wrangler.jsonc
// remains the legacy production descriptor until the separately evidenced #46 cutover.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const results = [];
const PRODUCTION_DB_ID = 'fc85026e-bfc8-435f-8bb0-c60e139178a3';
const PREVIEW_DB_ID = 'f5f9bea9-e88c-41ab-9407-70356079a638';

function gate(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(
    (ok ? 'PASS' : 'FAIL') +
      '  ' +
      name.padEnd(58) +
      (detail ? '  ' + detail : ''),
  );
}

function walk(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

function readAll(paths) {
  return paths.map((path) => ({
    path: relative(ROOT, path),
    text: readFileSync(path, 'utf8'),
  }));
}

function findMatches(files, re, exempt = () => false) {
  const hits = [];
  for (const { path, text } of files) {
    if (exempt(path)) continue;
    text.split('\n').forEach((line, index) => {
      re.lastIndex = 0;
      if (re.test(line)) hits.push(path + ':' + (index + 1));
    });
  }
  return hits;
}

function readJsonc(path) {
  const raw = readFileSync(join(ROOT, path), 'utf8');
  return {
    raw,
    value: JSON.parse(raw.replace(/^\s*\/\/.*$/gm, '')),
  };
}

const cloudflareFiles = readAll(walk(join(ROOT, 'cloudflare')));
const workerFiles = cloudflareFiles.filter((file) =>
  file.path.startsWith('cloudflare/src/'),
);

const legacyWorkerPath = 'cloudflare/src/worker.mjs';
const statusWorkerPath = 'cloudflare/src/status-worker.mjs';
const publisherWorkerPath = 'cloudflare/src/publisher-worker.mjs';
const productionPublisherPath = 'cloudflare/src/production-publisher.mjs';
const publicationLedgerPath = 'cloudflare/src/publication-ledger.mjs';
const publicationHaltPath = 'cloudflare/src/publication-halt.mjs';
const schedulerLivenessPath = 'cloudflare/src/scheduler-liveness.mjs';

const defaultConfig = readJsonc('wrangler.jsonc');
const statusConfig = readJsonc('wrangler.status.jsonc');
const publisherConfig = readJsonc('wrangler.publisher.jsonc');
const authorityConfig = readJsonc('wrangler.authority.jsonc');
const prepConfig = readJsonc('wrangler.prep.jsonc');
const previewConfig = readJsonc('wrangler.preview.jsonc');

const defaultDeclaresTriggers = Object.hasOwn(defaultConfig.value, 'triggers');
const statusDeclaresTriggers = Object.hasOwn(statusConfig.value, 'triggers');
const publisherDeclaresTriggers = Object.hasOwn(publisherConfig.value, 'triggers');
const previewDeclaresTriggers = Object.hasOwn(previewConfig.value, 'triggers');
const authorityCrons = authorityConfig.value.triggers?.crons ?? [];
const prepCrons = prepConfig.value.triggers?.crons ?? [];

gate(
  'legacy production descriptor remains inert until #46',
  defaultConfig.value.name === 'xqueue-production' &&
    defaultConfig.value.main === legacyWorkerPath &&
    defaultDeclaresTriggers === false,
  defaultConfig.value.name + ':' + defaultConfig.value.main,
);

gate(
  'target status config is scheduler-free',
  statusConfig.value.name === 'xqueue-production' &&
    statusConfig.value.main === statusWorkerPath &&
    statusDeclaresTriggers === false,
  statusConfig.value.name + ':' + statusConfig.value.main,
);

gate(
  'inert publisher config is a separate scheduler-free Worker',
  publisherConfig.value.name === 'xqueue-publisher-production' &&
    publisherConfig.value.main === publisherWorkerPath &&
    publisherDeclaresTriggers === false,
  publisherConfig.value.name + ':' + publisherConfig.value.main,
);

gate(
  'authority config targets publisher-only Worker with exact cron',
  authorityConfig.value.name === 'xqueue-publisher-production' &&
    authorityConfig.value.main === publisherWorkerPath &&
    Array.isArray(authorityCrons) &&
    authorityCrons.length === 1 &&
    authorityCrons[0] === '*/15 * * * *',
  JSON.stringify(authorityCrons),
);

gate(
  'production prep config is exact-cron but authority-disabled',
  prepConfig.value.name === 'xqueue-production' &&
    prepConfig.value.main === legacyWorkerPath &&
    Array.isArray(prepCrons) &&
    prepCrons.length === 1 &&
    prepCrons[0] === '*/15 * * * *' &&
    prepConfig.value.vars?.XQUEUE_PUBLISH_AUTHORITY === 'disabled',
  prepConfig.value.name + ':' + JSON.stringify(prepCrons),
);

gate(
  'preview config cannot declare scheduler authority',
  previewDeclaresTriggers === false,
  previewDeclaresTriggers ? 'triggers declared' : 'triggers omitted',
);

const productionConfigs = [
  defaultConfig,
  statusConfig,
  publisherConfig,
  authorityConfig,
  prepConfig,
];
const productionD1Exact = productionConfigs.every(({ value }) => {
  const db = value.d1_databases?.[0];
  return (
    value.d1_databases?.length === 1 &&
    db?.database_id === PRODUCTION_DB_ID &&
    db?.database_name === 'xqueue-production' &&
    db?.preview_database_id === undefined
  );
});

gate(
  'all production topology configs bind exact production D1',
  productionD1Exact,
  'xqueue-production:' + PRODUCTION_DB_ID,
);

const previewDb = previewConfig.value.d1_databases?.[0];
gate(
  'preview D1 remains isolated from production topology',
  previewConfig.value.name === 'xqueue-preview' &&
    previewDb?.database_id === PREVIEW_DB_ID &&
    previewDb?.database_name === 'xqueue-preview' &&
    !previewConfig.raw.includes(PRODUCTION_DB_ID) &&
    productionConfigs.every(({ raw }) => !raw.includes(PREVIEW_DB_ID)),
  previewConfig.value.name + ':' + (previewDb?.database_id ?? 'missing'),
);

const allConfigRaw = [
  defaultConfig.raw,
  statusConfig.raw,
  publisherConfig.raw,
  authorityConfig.raw,
  prepConfig.raw,
  previewConfig.raw,
].join('\n');

const nonPrepConfigRaw = [
  defaultConfig.raw,
  statusConfig.raw,
  publisherConfig.raw,
  authorityConfig.raw,
  previewConfig.raw,
].join('\n');

gate(
  'publication authority is hard-coded only as disabled in prep config',
  !/XQUEUE_PUBLISH_AUTHORITY/.test(nonPrepConfigRaw) &&
    prepConfig.value.vars?.XQUEUE_PUBLISH_AUTHORITY === 'disabled' &&
    !/XQUEUE_PUBLISH_AUTHORITY\s*["']?\s*[:=]\s*["']enabled["']/i.test(prepConfig.raw),
  prepConfig.value.vars?.XQUEUE_PUBLISH_AUTHORITY ?? 'missing',
);

const publisher = workerFiles.find(
  (file) => file.path === productionPublisherPath,
);
const publisherText = publisher?.text ?? '';

gate(
  'production publisher retains runtime authority check',
  /publicationAuthorityEnabled/.test(publisherText),
  productionPublisherPath,
);

const CREDENTIAL_RE =
  /\b(X_API_KEY|X_API_SECRET|X_ACCESS_TOKEN|X_ACCESS_SECRET|consumer_key|consumer_secret|oauth_token|bearer_token)\b/i;

const credentialHitsOutsidePublisher = findMatches(
  workerFiles,
  CREDENTIAL_RE,
  (path) => path === productionPublisherPath,
);
const credentialConfigHits = findMatches(
  [
    { path: 'wrangler.jsonc', text: defaultConfig.raw },
    { path: 'wrangler.status.jsonc', text: statusConfig.raw },
    { path: 'wrangler.publisher.jsonc', text: publisherConfig.raw },
    { path: 'wrangler.authority.jsonc', text: authorityConfig.raw },
    { path: 'wrangler.prep.jsonc', text: prepConfig.raw },
    { path: 'wrangler.preview.jsonc', text: previewConfig.raw },
  ],
  CREDENTIAL_RE,
);

gate(
  'X credential references are confined to production publisher',
  credentialHitsOutsidePublisher.length === 0 &&
    credentialConfigHits.length === 0,
  [...credentialHitsOutsidePublisher, ...credentialConfigHits].join(' ') ||
    'confined',
);

const PUBLISH_RE =
  /\b(createPostViaClient|uploadMediaBytesViaClient|createPost|uploadMedia|api\.x\.com|api\.twitter\.com|upload\.twitter\.com|@xdevplatform)\b/i;
const publishHitsOutsidePublisher = findMatches(
  workerFiles,
  PUBLISH_RE,
  (path) => path === productionPublisherPath,
);
const publisherHasCreate = /createPostViaClient/.test(publisherText);

gate(
  'X transport surface is confined to production publisher',
  publishHitsOutsidePublisher.length === 0 && publisherHasCreate,
  publishHitsOutsidePublisher.join(' ') || productionPublisherPath,
);

const statusWorker =
  workerFiles.find((file) => file.path === statusWorkerPath)?.text ?? '';
const publisherWorker =
  workerFiles.find((file) => file.path === publisherWorkerPath)?.text ?? '';

gate(
  'status Worker has no scheduled or publisher import',
  !/\bscheduled\s*\(/.test(statusWorker) &&
    !/production-publisher|publisher-worker|@xdevplatform/.test(statusWorker) &&
    !CREDENTIAL_RE.test(statusWorker),
  statusWorkerPath,
);

gate(
  'publisher Worker exposes scheduled handler and no fetch route',
  /\bscheduled\s*\(/.test(publisherWorker) &&
    /production-publisher/.test(publisherWorker) &&
    !/\bfetch\s*\(/.test(publisherWorker),
  publisherWorkerPath,
);

gate(
  'status config has no service binding to publisher',
  statusConfig.value.services === undefined &&
    !statusConfig.raw.includes('xqueue-publisher-production'),
  'no status-to-publisher binding',
);

const LEDGER_TABLES = ['publication_state', 'publication_events', 'runtime_metadata'];
const FENCE_TABLES = ['publication_fences'];
const HALT_TABLES = ['publication_halt_state', 'publication_halt_events'];
const LEASE_TABLES = ['publication_leases', 'publication_lease_events'];
const ALLOWED_TABLES = new Set([
  ...LEDGER_TABLES,
  ...FENCE_TABLES,
  ...HALT_TABLES,
  ...LEASE_TABLES,
]);

const WRITE_STATEMENT_RE =
  /\b(?:INSERT\s+INTO|REPLACE\s+INTO|DELETE\s+FROM|UPDATE|DROP\s+TABLE|ALTER\s+TABLE|CREATE\s+TABLE)\s+([A-Za-z_][A-Za-z0-9_]*)/gi;

const writeTargets = [];
for (const { path, text } of workerFiles) {
  for (const match of text.matchAll(WRITE_STATEMENT_RE)) {
    const table = match[1].toLowerCase();
    if (table === 'set') continue;
    const line = text.slice(0, match.index).split('\n').length;
    writeTargets.push({ where: path + ':' + line, path, table });
  }
}

const ledgerWritesOutsideAllowedModules = writeTargets.filter((write) => {
  if (['publication_state', 'publication_events'].includes(write.table)) {
    return write.path !== publicationLedgerPath;
  }
  if (write.table === 'runtime_metadata') {
    return ![publicationLedgerPath, schedulerLivenessPath].includes(write.path);
  }
  if (FENCE_TABLES.includes(write.table)) {
    return write.path !== publicationLedgerPath;
  }
  return false;
});
const unknownWrites = writeTargets.filter(
  (write) => !ALLOWED_TABLES.has(write.table),
);
const leaseWritesOutsideLeaseModule = writeTargets.filter(
  (write) =>
    LEASE_TABLES.includes(write.table) &&
    write.path !== 'cloudflare/src/publication-lease.mjs',
);
const haltWritesOutsideHaltModule = writeTargets.filter(
  (write) =>
    HALT_TABLES.includes(write.table) &&
    write.path !== publicationHaltPath,
);

gate(
  'ledger/fence/heartbeat writes remain confined',
  ledgerWritesOutsideAllowedModules.length === 0,
  ledgerWritesOutsideAllowedModules.map((write) => write.where).join(' ') ||
    'confined',
);
gate(
  'lease writes remain confined to publication-lease.mjs',
  leaseWritesOutsideLeaseModule.length === 0,
  leaseWritesOutsideLeaseModule.map((write) => write.where).join(' ') ||
    'confined',
);
gate(
  'halt writes remain confined to publication-halt.mjs',
  haltWritesOutsideHaltModule.length === 0,
  haltWritesOutsideHaltModule.map((write) => write.where).join(' ') ||
    'confined',
);
gate(
  'Worker D1 writes target only declared safety tables',
  unknownWrites.length === 0,
  unknownWrites
    .map((write) => write.where + '(' + write.table + ')')
    .join(' ') || 'declared tables only',
);

const runtimeOwnerClearHits = findMatches(
  workerFiles,
  /\bSET\s+halted\s*=\s*0\b|\bactor_class\s*=\s*['"]owner['"]\b/i,
);
gate(
  'Worker runtime contains no owner-clear halt capability',
  runtimeOwnerClearHits.length === 0,
  runtimeOwnerClearHits.join(' ') || 'absent',
);

const R2_MUTATE_RE = /\bMEDIA\s*\.\s*(put|delete)\s*\(/i;
const r2MutateHits = findMatches(workerFiles, R2_MUTATE_RE);
gate(
  'no R2 mutation in cloudflare/src/',
  r2MutateHits.length === 0,
  r2MutateHits.join(' ') || 'none',
);

const unit = readFileSync(join(ROOT, 'deploy/systemd/xqueue.service'), 'utf8');
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
gate(
  'systemd rollback unit still runs post:live',
  /ExecStart=.*post:live/.test(unit),
  'deploy/systemd/xqueue.service',
);
gate(
  'package.json still defines post:live',
  pkg.scripts?.['post:live'] === 'node src/cli.mjs post --live',
  pkg.scripts?.['post:live'] ?? 'MISSING',
);

const tracked = execFileSync('git', ['ls-files'], {
  cwd: ROOT,
  encoding: 'utf8',
}).split('\n');
const mustNotTrack = ['queue.json', 'state.json', '.env', 'media-manifest.json'];
const leaked = mustNotTrack.filter((name) => tracked.includes(name));
gate(
  'generated/secret artifacts are untracked',
  leaked.length === 0,
  leaked.join(' ') || 'none',
);

const trackedMedia = tracked.filter(
  (path) => path.startsWith('media/') && path !== 'media/.gitkeep',
);
gate(
  'no media binaries tracked',
  trackedMedia.length === 0,
  trackedMedia.join(' ') || 'none',
);

const failures = results.filter((result) => !result.ok);
console.log();
console.log(
  '=== AUTHORITY BOUNDARY: ' +
    (failures.length === 0 ? 'INTACT' : 'BROKEN') +
    ' ===',
);
console.log(results.length - failures.length + '/' + results.length + ' gates passed.');

if (failures.length) {
  console.error();
  for (const failure of failures) {
    console.error(
      'BROKEN: ' + failure.name + ' — ' + failure.detail,
    );
  }
  process.exit(1);
}
