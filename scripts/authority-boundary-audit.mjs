#!/usr/bin/env node
// authority-boundary-audit.mjs — mechanical proof of publication/monitoring boundaries.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  validatePreviewConfig,
  validateProductionConfig,
  validateWatchdogConfig,
} from './verify-environment-config.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const results = [];

function gate(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(60)}${detail ? `  ${detail}` : ''}`);
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
  return { raw, value: JSON.parse(raw.replace(/^\s*\/\/.*$/gm, '')) };
}

function validationResult(fn, value) {
  try {
    fn(value);
    return { ok: true, detail: 'exact environment identity' };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
}

const cloudflareFiles = readAll(walk(join(ROOT, 'cloudflare')));
const workerFiles = cloudflareFiles.filter((file) => file.path.startsWith('cloudflare/src/'));
const productionPublisherPath = 'cloudflare/src/production-publisher.mjs';
const publicationLedgerPath = 'cloudflare/src/publication-ledger.mjs';
const schedulerLivenessPath = 'cloudflare/src/scheduler-liveness.mjs';
const watchdogPath = 'cloudflare/src/liveness-watchdog.mjs';

const defaultConfig = readJsonc('wrangler.jsonc');
const authorityConfig = readJsonc('wrangler.authority.jsonc');
const watchdogConfig = readJsonc('wrangler.watchdog.jsonc');

const previewValidation = validationResult(validatePreviewConfig, defaultConfig.value);
const productionValidation = validationResult(validateProductionConfig, authorityConfig.value);
const watchdogValidation = validationResult(validateWatchdogConfig, watchdogConfig.value);

gate('default Wrangler config is preview-safe and inert', previewValidation.ok, previewValidation.detail);
gate('authority Wrangler config is production-only and exact', productionValidation.ok, productionValidation.detail);
gate('watchdog Wrangler config has no publication capability', watchdogValidation.ok, watchdogValidation.detail);

gate(
  'preview and production Worker identities are distinct',
  defaultConfig.value.name !== authorityConfig.value.name,
  `${defaultConfig.value.name} != ${authorityConfig.value.name}`,
);
gate(
  'watchdog and publication Worker identities are distinct',
  watchdogConfig.value.name !== authorityConfig.value.name,
  `${watchdogConfig.value.name} != ${authorityConfig.value.name}`,
);
gate(
  'preview and production D1 identities are distinct',
  defaultConfig.value.d1_databases?.[0]?.database_id !== authorityConfig.value.d1_databases?.[0]?.database_id,
  `${defaultConfig.value.d1_databases?.[0]?.database_id} != ${authorityConfig.value.d1_databases?.[0]?.database_id}`,
);

const publisher = workerFiles.find((file) => file.path === productionPublisherPath);
const publisherText = publisher?.text ?? '';
const watchdog = workerFiles.find((file) => file.path === watchdogPath);
const watchdogText = watchdog?.text ?? '';

const authorityHardcodedInConfig = [defaultConfig, authorityConfig, watchdogConfig]
  .some((config) => /XQUEUE_PUBLISH_AUTHORITY/.test(config.raw));

gate(
  'production publisher is guarded by runtime authority check',
  /publicationAuthorityEnabled/.test(publisherText),
  productionPublisherPath,
);
gate(
  'authority flag is not hard-coded in Wrangler config',
  !authorityHardcodedInConfig,
  authorityHardcodedInConfig ? 'found' : 'absent',
);

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
  ...findMatches([{ path: 'wrangler.watchdog.jsonc', text: watchdogConfig.raw }], CREDENTIAL_RE),
];
gate(
  'X credential surface is confined to production publisher',
  credentialHitsOutsidePublisher.length === 0 && credentialConfigHits.length === 0,
  [...credentialHitsOutsidePublisher, ...credentialConfigHits].join(' ') || 'confined',
);

const PUBLISH_RE =
  /\b(createPostViaClient|uploadMediaBytesViaClient|createPost|uploadMedia|api\.x\.com|api\.twitter\.com|upload\.twitter\.com|@xdevplatform)\b/i;
const publishHitsOutsidePublisher = findMatches(
  workerFiles,
  PUBLISH_RE,
  (path) => path === productionPublisherPath,
);
gate(
  'X publication surface is confined to production publisher',
  publishHitsOutsidePublisher.length === 0 && /createPostViaClient/.test(publisherText),
  publishHitsOutsidePublisher.join(' ') || productionPublisherPath,
);
gate(
  'watchdog source does not import publication machinery',
  !/production-publisher|publication-ledger|publication-lease|authority-config/.test(watchdogText),
  watchdogPath,
);
gate(
  'watchdog source has no media binding access',
  !/env\.MEDIA|\.MEDIA\b/.test(watchdogText),
  watchdogPath,
);

const PUBLICATION_TABLES = ['publication_state', 'publication_events'];
const LEASE_TABLES = ['publication_leases', 'publication_lease_events'];
const ALLOWED_TABLES = new Set([...PUBLICATION_TABLES, ...LEASE_TABLES, 'runtime_metadata']);
const APPROVED_METADATA_WRITERS = new Set([
  publicationLedgerPath,
  schedulerLivenessPath,
  watchdogPath,
]);
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

const publicationWritesOutsideLedger = writeTargets.filter(
  (write) => PUBLICATION_TABLES.includes(write.table) && write.path !== publicationLedgerPath,
);
const metadataWritesOutsideApproved = writeTargets.filter(
  (write) => write.table === 'runtime_metadata' && !APPROVED_METADATA_WRITERS.has(write.path),
);
const leaseWritesOutsideLeaseModule = writeTargets.filter(
  (write) => LEASE_TABLES.includes(write.table) && write.path !== 'cloudflare/src/publication-lease.mjs',
);
const unknownWrites = writeTargets.filter((write) => !ALLOWED_TABLES.has(write.table));

gate(
  'publication state/event writes are confined to publication-ledger.mjs',
  publicationWritesOutsideLedger.length === 0,
  publicationWritesOutsideLedger.map((write) => write.where).join(' ') || publicationLedgerPath,
);
gate(
  'runtime metadata writes are confined to approved evidence modules',
  metadataWritesOutsideApproved.length === 0,
  metadataWritesOutsideApproved.map((write) => write.where).join(' ') || [...APPROVED_METADATA_WRITERS].join(', '),
);
gate(
  'lease writes remain confined to publication-lease.mjs',
  leaseWritesOutsideLeaseModule.length === 0,
  leaseWritesOutsideLeaseModule.map((write) => write.where).join(' ') || 'confined',
);
gate(
  'Worker D1 writes target only declared ledger/lease/metadata tables',
  unknownWrites.length === 0,
  unknownWrites.map((write) => `${write.where}(${write.table})`).join(' ') || 'declared tables only',
);

const R2_MUTATE_RE = /\bMEDIA\s*\.\s*(put|delete)\s*\(/i;
const r2MutateHits = findMatches(workerFiles, R2_MUTATE_RE);
gate('no R2 mutation in cloudflare/src/', r2MutateHits.length === 0, r2MutateHits.join(' ') || 'none');

const unit = readFileSync(join(ROOT, 'deploy/systemd/xqueue.service'), 'utf8');
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
gate('systemd rollback unit still runs post:live', /ExecStart=.*post:live/.test(unit), 'deploy/systemd/xqueue.service');
gate('package.json still defines post:live', pkg.scripts?.['post:live'] === 'node src/cli.mjs post --live', pkg.scripts?.['post:live'] ?? 'MISSING');

const tracked = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' }).split('\n');
const mustNotTrack = ['queue.json', 'state.json', '.env', 'media-manifest.json'];
const leaked = mustNotTrack.filter((name) => tracked.includes(name));
gate('generated/secret artifacts are untracked', leaked.length === 0, leaked.join(' ') || 'none');

const trackedMedia = tracked.filter((path) => path.startsWith('media/') && path !== 'media/.gitkeep');
gate('no media binaries tracked', trackedMedia.length === 0, trackedMedia.join(' ') || 'none');

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
