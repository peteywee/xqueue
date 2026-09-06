#!/usr/bin/env node
// authority-boundary-audit.mjs — mechanical proof of the Cloudflare authority boundary.
//
// Ordinary deployment and scheduler-authority mutation are separate authority classes.
// wrangler.jsonc is preview-only and MUST NOT declare triggers. wrangler.authority.jsonc is the
// only tracked production config and the only config allowed to declare the production cron.
// Production publication still requires the exact runtime authority flag before any public side
// effect can occur.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const results = [];

function gate(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(54)}${detail ? `  ${detail}` : ''}`);
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
    text.split('\n').forEach((line, i) => {
      re.lastIndex = 0;
      if (re.test(line)) hits.push(`${path}:${i + 1}`);
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
const workerFiles = cloudflareFiles.filter((file) => file.path.startsWith('cloudflare/src/'));
const productionPublisherPath = 'cloudflare/src/production-publisher.mjs';
const publicationLedgerPath = 'cloudflare/src/publication-ledger.mjs';
const schedulerLivenessPath = 'cloudflare/src/scheduler-liveness.mjs';

const defaultConfig = readJsonc('wrangler.jsonc');
const authorityConfig = readJsonc('wrangler.authority.jsonc');

// --------------------------------------------------------------- 1. schedules / environments

const defaultDeclaresTriggers = Object.prototype.hasOwnProperty.call(
  defaultConfig.value,
  'triggers',
);
const authorityCrons = authorityConfig.value.triggers?.crons ?? [];

gate(
  'default deploy cannot mutate scheduler authority',
  defaultDeclaresTriggers === false,
  defaultDeclaresTriggers ? 'triggers declared — destructive replacement risk' : 'triggers omitted',
);

gate(
  'authority config pins exactly the 15-minute cron',
  Array.isArray(authorityCrons) &&
    authorityCrons.length === 1 &&
    authorityCrons[0] === '*/15 * * * *',
  JSON.stringify(authorityCrons),
);

const previewDbId = defaultConfig.value.d1_databases?.[0]?.database_id;
const productionDbId = authorityConfig.value.d1_databases?.[0]?.database_id;
const environmentIdentityIsolated =
  defaultConfig.value.name === 'xqueue-preview' &&
  authorityConfig.value.name === 'xqueue-production' &&
  defaultConfig.value.main === authorityConfig.value.main &&
  previewDbId &&
  productionDbId &&
  previewDbId !== productionDbId &&
  defaultConfig.value.d1_databases?.[0]?.preview_database_id === undefined &&
  authorityConfig.value.d1_databases?.[0]?.preview_database_id === undefined;

gate(
  'preview and production Worker/D1 identities are isolated',
  Boolean(environmentIdentityIsolated),
  `${defaultConfig.value.name ?? 'missing'}:${previewDbId ?? 'missing'} -> ${authorityConfig.value.name ?? 'missing'}:${productionDbId ?? 'missing'}`,
);

gate(
  'production authority config carries no preview D1 identity',
  !authorityConfig.raw.includes('f5f9bea9-e88c-41ab-9407-70356079a638') &&
    !/preview_database_id/.test(authorityConfig.raw),
  'production-only D1 binding',
);

gate(
  'preview config carries no production D1 identity',
  !defaultConfig.raw.includes('fc85026e-bfc8-435f-8bb0-c60e139178a3'),
  'preview-only D1 binding',
);

// --------------------------------------------------------- 2. runtime authority

const publisher = workerFiles.find((file) => file.path === productionPublisherPath);
const publisherText = publisher?.text ?? '';

const exactAuthorityImport = /publicationAuthorityEnabled/.test(publisherText);
const authorityHardcodedInConfig =
  /XQUEUE_PUBLISH_AUTHORITY/.test(defaultConfig.raw) ||
  /XQUEUE_PUBLISH_AUTHORITY/.test(authorityConfig.raw);

gate(
  'production publisher is guarded by runtime authority check',
  exactAuthorityImport,
  productionPublisherPath,
);

gate(
  'authority flag is not hard-coded in Wrangler config',
  !authorityHardcodedInConfig,
  authorityHardcodedInConfig ? 'found' : 'absent',
);

// ---------------------------------------------------------- 3. X credentials

const CREDENTIAL_RE =
  /\b(X_API_KEY|X_API_SECRET|X_ACCESS_TOKEN|X_ACCESS_SECRET|consumer_key|consumer_secret|oauth_token|bearer_token)\b/i;

const credentialHitsOutsidePublisher = findMatches(
  workerFiles,
  CREDENTIAL_RE,
  (path) => path === productionPublisherPath,
);
const credentialConfigHits = [
  ...findMatches([{ path: 'wrangler.jsonc', text: defaultConfig.raw }], CREDENTIAL_RE),
  ...findMatches([{ path: 'wrangler.authority.jsonc', text: authorityConfig.raw }], CREDENTIAL_RE),
];

gate(
  'X credential surface is confined to production publisher',
  credentialHitsOutsidePublisher.length === 0 && credentialConfigHits.length === 0,
  [...credentialHitsOutsidePublisher, ...credentialConfigHits].join(' ') || 'confined',
);

// ---------------------------------------------------- 4. X publication surface

const PUBLISH_RE =
  /\b(createPostViaClient|uploadMediaBytesViaClient|createPost|uploadMedia|api\.x\.com|api\.twitter\.com|upload\.twitter\.com|@xdevplatform)\b/i;

const publishHitsOutsidePublisher = findMatches(
  workerFiles,
  PUBLISH_RE,
  (path) => path === productionPublisherPath,
);
const publisherHasCreate = /createPostViaClient/.test(publisherText);

gate(
  'X publication surface is confined to production publisher',
  publishHitsOutsidePublisher.length === 0 && publisherHasCreate,
  publishHitsOutsidePublisher.join(' ') || productionPublisherPath,
);

// --------------------------------------------------------- 5. D1 writes

const LEDGER_TABLES = ['publication_state', 'publication_events', 'runtime_metadata'];
const LEASE_TABLES = ['publication_leases', 'publication_lease_events'];
const ALLOWED_TABLES = new Set([...LEDGER_TABLES, ...LEASE_TABLES]);

const WRITE_STATEMENT_RE =
  /\b(?:INSERT\s+INTO|REPLACE\s+INTO|DELETE\s+FROM|UPDATE|DROP\s+TABLE|ALTER\s+TABLE|CREATE\s+TABLE)\s+([A-Za-z_][A-Za-z0-9_]*)/gi;

const writeTargets = [];
for (const { path, text } of workerFiles) {
  for (const match of text.matchAll(WRITE_STATEMENT_RE)) {
    const table = match[1].toLowerCase();
    if (table === 'set') continue;
    const line = text.slice(0, match.index).split('\n').length;
    writeTargets.push({ where: `${path}:${line}`, path, table });
  }
}

const ledgerWritesOutsideAllowedModules = writeTargets.filter((write) => {
  if (['publication_state', 'publication_events'].includes(write.table)) {
    return write.path !== publicationLedgerPath;
  }
  if (write.table === 'runtime_metadata') {
    return ![publicationLedgerPath, schedulerLivenessPath].includes(write.path);
  }
  return false;
});
const unknownWrites = writeTargets.filter((write) => !ALLOWED_TABLES.has(write.table));
const leaseWritesOutsideLeaseModule = writeTargets.filter(
  (write) => LEASE_TABLES.includes(write.table) &&
    write.path !== 'cloudflare/src/publication-lease.mjs',
);

gate(
  'ledger/heartbeat writes are confined to approved modules',
  ledgerWritesOutsideAllowedModules.length === 0,
  ledgerWritesOutsideAllowedModules.map((write) => write.where).join(' ') || `${publicationLedgerPath}, ${schedulerLivenessPath}`,
);

gate(
  'lease writes remain confined to publication-lease.mjs',
  leaseWritesOutsideLeaseModule.length === 0,
  leaseWritesOutsideLeaseModule.map((write) => write.where).join(' ') || 'confined',
);

gate(
  'Worker D1 writes target only declared ledger/lease tables',
  unknownWrites.length === 0,
  unknownWrites.map((write) => `${write.where}(${write.table})`).join(' ') || 'declared tables only',
);

// --------------------------------------------------------- 6. R2 remains immutable

const R2_MUTATE_RE = /\bMEDIA\s*\.\s*(put|delete)\s*\(/i;
const r2MutateHits = findMatches(workerFiles, R2_MUTATE_RE);

gate(
  'no R2 mutation in cloudflare/src/',
  r2MutateHits.length === 0,
  r2MutateHits.join(' ') || 'none',
);

// ----------------------------------------------------- 7. rollback publisher retained

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

// ----------------------------------------------------- 8. secret/runtime artifacts

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

// ---------------------------------------------------------------- verdict

const failures = results.filter((result) => !result.ok);

console.log();
console.log(`=== AUTHORITY BOUNDARY: ${failures.length === 0 ? 'INTACT' : 'BROKEN'} ===`);
console.log(`${results.length - failures.length}/${results.length} gates passed.`);

if (failures.length) {
  console.error();
  for (const failure of failures) {
    console.error(`BROKEN: ${failure.name} — ${failure.detail}`);
  }
  process.exit(1);
}
