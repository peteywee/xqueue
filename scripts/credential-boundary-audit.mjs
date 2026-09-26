#!/usr/bin/env node

import { existsSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PRODUCTION_DB_ID = 'fc85026e-bfc8-435f-8bb0-c60e139178a3';
const STATUS_ENTRY = 'cloudflare/src/status-worker.mjs';
const PUBLISHER_ENTRY = 'cloudflare/src/publisher-worker.mjs';
const PRODUCTION_PUBLISHER = 'cloudflare/src/production-publisher.mjs';
const failures = [];

function gate(name, ok, detail = '') {
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + name.padEnd(58) + (detail ? '  ' + detail : ''));
  if (!ok) failures.push({ name, detail });
}

function read(relativePath) {
  return readFileSync(resolve(ROOT, relativePath), 'utf8');
}

function readJsonc(relativePath) {
  return JSON.parse(read(relativePath).replace(/^\s*\/\/.*$/gm, ''));
}

function localImports(source) {
  const imports = [];
  const patterns = [
    /\bimport\s+(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]/g,
    /\bexport\s+[^'"]*?\s+from\s+['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];

  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) imports.push(match[1]);
  }

  return imports;
}

function resolveLocal(fromRelative, specifier) {
  if (!specifier.startsWith('.')) return null;

  const absolute = resolve(dirname(resolve(ROOT, fromRelative)), specifier);
  const candidates = [
    absolute,
    absolute + '.mjs',
    absolute + '.js',
    resolve(absolute, 'index.mjs'),
    resolve(absolute, 'index.js'),
  ];
  const target = candidates.find((candidate) => existsSync(candidate));

  if (!target) {
    throw new Error('cannot resolve ' + specifier + ' from ' + fromRelative);
  }

  return relative(ROOT, target).replaceAll('\\', '/');
}

function collectGraph(entry) {
  const files = new Map();
  const packages = new Set();
  const pending = [entry];

  while (pending.length > 0) {
    const current = pending.pop();
    if (files.has(current)) continue;

    const source = read(current);
    files.set(current, source);

    for (const specifier of localImports(source)) {
      const local = resolveLocal(current, specifier);
      if (local) pending.push(local);
      else packages.add(specifier);
    }
  }

  return { files, packages };
}

function graphText(graph) {
  return [...graph.files.values()].join('\n');
}

const legacy = readJsonc('wrangler.jsonc');
const status = readJsonc('wrangler.status.jsonc');
const publisher = readJsonc('wrangler.publisher.jsonc');
const authority = readJsonc('wrangler.authority.jsonc');
const prep = readJsonc('wrangler.prep.jsonc');

const statusGraph = collectGraph(STATUS_ENTRY);
const publisherGraph = collectGraph(PUBLISHER_ENTRY);
const statusText = graphText(statusGraph);
const publisherEntryText = read(PUBLISHER_ENTRY);

gate(
  'legacy production descriptor remains unchanged for #46 activation',
  legacy.name === 'xqueue-production' &&
    legacy.main === 'cloudflare/src/worker.mjs' &&
    !Object.hasOwn(legacy, 'triggers'),
  legacy.name + ':' + legacy.main,
);

gate(
  'target status config is xqueue-production and has no scheduler',
  status.name === 'xqueue-production' &&
    status.main === STATUS_ENTRY &&
    Array.isArray(status.triggers?.crons) &&
    status.triggers.crons.length === 0,
  status.name + ':' + status.main + ':' + JSON.stringify(status.triggers?.crons ?? null),
);

gate(
  'inert publisher config is separate and has no scheduler',
  publisher.name === 'xqueue-publisher-production' &&
    publisher.main === PUBLISHER_ENTRY &&
    !Object.hasOwn(publisher, 'triggers'),
  publisher.name + ':' + publisher.main,
);

gate(
  'authority config targets publisher-only Worker with one cron',
  authority.name === publisher.name &&
    authority.main === PUBLISHER_ENTRY &&
    JSON.stringify(authority.triggers?.crons) === JSON.stringify(['*/15 * * * *']),
  authority.name + ':' + authority.main + ':' + JSON.stringify(authority.triggers?.crons ?? []),
);

gate(
  'prep config keeps combined Worker scheduled but publication-disabled',
  prep.name === 'xqueue-production' &&
    prep.main === 'cloudflare/src/worker.mjs' &&
    JSON.stringify(prep.triggers?.crons) === JSON.stringify(['*/15 * * * *']) &&
    prep.vars?.XQUEUE_PUBLISH_AUTHORITY === 'disabled',
  prep.name + ':' + prep.main + ':' + String(prep.vars?.XQUEUE_PUBLISH_AUTHORITY ?? 'missing'),
);

const productionConfigs = [legacy, status, publisher, authority, prep];
gate(
  'all production topology configs bind the same canonical D1',
  productionConfigs.every(
    (config) =>
      config.d1_databases?.length === 1 &&
      config.d1_databases[0].database_name === 'xqueue-production' &&
      config.d1_databases[0].database_id === PRODUCTION_DB_ID,
  ),
  'xqueue-production D1',
);

gate(
  'status and publisher share the same R2 media truth',
  status.r2_buckets?.[0]?.bucket_name === 'xqueue-media' &&
    publisher.r2_buckets?.[0]?.bucket_name === status.r2_buckets?.[0]?.bucket_name &&
    authority.r2_buckets?.[0]?.bucket_name === status.r2_buckets?.[0]?.bucket_name &&
    prep.r2_buckets?.[0]?.bucket_name === status.r2_buckets?.[0]?.bucket_name,
  status.r2_buckets?.[0]?.bucket_name ?? 'missing',
);

gate(
  'status config has no service binding to publisher',
  status.services === undefined &&
    !JSON.stringify(status).includes('xqueue-publisher-production'),
  'no status-to-publisher binding',
);

gate(
  'status entrypoint has no scheduled handler',
  !/\basync\s+scheduled\s*\(/.test(read(STATUS_ENTRY)) &&
    !/\bscheduled\s*\(/.test(read(STATUS_ENTRY)),
  STATUS_ENTRY,
);

gate(
  'publisher entrypoint has no HTTP fetch handler',
  !/\basync\s+fetch\s*\(/.test(publisherEntryText) &&
    !/\bfetch\s*\(/.test(publisherEntryText),
  PUBLISHER_ENTRY,
);

gate(
  'status module graph cannot reach production publisher',
  !statusGraph.files.has(PRODUCTION_PUBLISHER) &&
    !statusGraph.files.has(PUBLISHER_ENTRY),
  [...statusGraph.files.keys()].join(', '),
);

gate(
  'publisher module graph reaches the sole production publisher',
  publisherGraph.files.has(PRODUCTION_PUBLISHER),
  [...publisherGraph.files.keys()].join(', '),
);

const credentialRe =
  /\b(X_API_KEY|X_API_SECRET|X_ACCESS_TOKEN|X_ACCESS_SECRET|consumer_key|consumer_secret|oauth_token|bearer_token)\b/i;
const publishRe =
  /\b(createPostViaClient|uploadMediaBytesViaClient|@xdevplatform\/xdk|api\.x\.com|api\.twitter\.com|upload\.twitter\.com)\b/i;

gate(
  'status graph contains no X credential references',
  !credentialRe.test(statusText),
  'no X write credential names',
);

gate(
  'status graph contains no X publish transport or SDK',
  !publishRe.test(statusText) &&
    ![...statusGraph.packages].some((name) => name.startsWith('@xdevplatform')),
  'no X SDK/transport',
);

gate(
  'publisher graph contains the X publication implementation',
  publishRe.test(graphText(publisherGraph)) ||
    [...publisherGraph.packages].some((name) => name === '@xdevplatform/xdk'),
  'publisher-only capability present',
);

const configText = productionConfigs.map((value) => JSON.stringify(value)).join('\n');
const nonPrepConfigText = [legacy, status, publisher, authority]
  .map((value) => JSON.stringify(value))
  .join('\n');
gate(
  'Wrangler configs contain no X credentials; prep carries only disabled authority sentinel',
  !credentialRe.test(configText) &&
    !/XQUEUE_PUBLISH_AUTHORITY/.test(nonPrepConfigText) &&
    prep.vars?.XQUEUE_PUBLISH_AUTHORITY === 'disabled',
  'secrets remain external bindings; prep authority is disabled',
);

if (failures.length > 0) {
  console.error();
  for (const failure of failures) {
    console.error('BROKEN: ' + failure.name + ' — ' + failure.detail);
  }
  process.exitCode = 1;
} else {
  console.log();
  console.log('=== CREDENTIAL BOUNDARY: STRUCTURALLY SEPARATED ===');
}
