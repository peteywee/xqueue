#!/usr/bin/env node

// build-cloudflare-queue-bundle.mjs — freeze the canonical production queue
// into a Worker-importable ES module.
//
// The bundle is regenerated IN-PROCESS from config/schedule-policy.json plus
// content/, using exactly the same loadLibrary + schedule call that
// scripts/build-production-queue.mjs performs. It deliberately never reads
// queue.json: queue.json is gitignored, generated, and may be absent.
//
// The canonical bytes are, byte for byte:
//     JSON.stringify(queue, null, 2) + "\n"     UTF-8
// which is exactly what build-production-queue.mjs writes to queue.json, and
// exactly what D1 runtime_metadata['queue.sha256'] is the SHA-256 of.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadLibrary } from '../src/parse.mjs';
import { schedule } from '../src/schedule.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const POLICY = join(ROOT, 'config', 'schedule-policy.json');
const CONTENT = join(ROOT, 'content');
const OUT_DIR = join(ROOT, 'cloudflare', 'generated');
const OUT_FILE = join(OUT_DIR, 'queue-bundle.mjs');

function fail(message) {
  console.error(`build-cloudflare-queue-bundle: ${message}`);
  process.exit(1);
}

if (!existsSync(POLICY)) {
  fail(`production schedule policy is missing: ${POLICY}`);
}

const policy = JSON.parse(readFileSync(POLICY, 'utf8'));
const posts = loadLibrary(CONTENT);

const scheduleOptions = {
  start: policy.campaignStart,
  slots: policy.slots,
  daysOfWeek: policy.daysOfWeek,
  timezone: policy.timezone,
  deferToEnd: policy.deferToEnd ?? [],
};

const queue = schedule(posts, scheduleOptions);

// THE canonical bytes.
const canonicalText = `${JSON.stringify(queue, null, 2)}\n`;
const sha256 = createHash('sha256').update(Buffer.from(canonicalText, 'utf8')).digest('hex');

const count = queue.length;
const uniqueIds = new Set(queue.map((post) => post.id));
const deferToEnd = policy.deferToEnd ?? [];
const tail = queue.slice(count - deferToEnd.length);

if (count !== policy.expectedPosts) {
  fail(`queue length ${count} does not match policy.expectedPosts ${policy.expectedPosts}`);
}

if (uniqueIds.size !== count) {
  fail(`queue contains duplicate post IDs: ${uniqueIds.size} unique of ${count}`);
}

if (deferToEnd.length > 0) {
  const tailIds = tail.map((post) => post.id);
  if (tailIds.join(',') !== deferToEnd.join(',')) {
    fail(
      `deferred tail ${JSON.stringify(tailIds)} is not exactly policy.deferToEnd ` +
        `${JSON.stringify(deferToEnd)} at the end of the queue`,
    );
  }
  for (const post of tail) {
    if (post.deferredToEnd !== true) {
      fail(`deferred tail post ${post.id} is not flagged deferredToEnd`);
    }
  }
}

const declaredDeferredTail = tail.map((post) => ({
  id: post.id,
  scheduledDate: post.scheduledDate,
  scheduledTime: post.scheduledTime,
  timezone: post.timezone,
}));

const generatedFrom = {
  policyVersion: policy.version,
  campaignStart: policy.campaignStart,
  timezone: policy.timezone,
  slots: policy.slots,
  daysOfWeek: policy.daysOfWeek,
  deferToEnd,
};

// JSON.stringify produces a safe JS string literal: post bodies containing
// backticks, ${, backslashes or newlines cannot break out of it. Template
// literals and String.raw are deliberately NOT used here.
const module = [
  '// GENERATED FILE — DO NOT HAND-EDIT.',
  '//',
  '// Produced by scripts/build-cloudflare-queue-bundle.mjs from',
  '// config/schedule-policy.json + content/. Regenerate with:',
  '//     node scripts/build-cloudflare-queue-bundle.mjs',
  '//',
  '// CANONICAL_QUEUE_JSON holds the exact canonical queue bytes:',
  '//     JSON.stringify(queue, null, 2) + "\\n"   , UTF-8',
  '// DECLARED_QUEUE_SHA256 is the SHA-256 of those bytes and must equal the',
  "// D1 runtime_metadata row 'queue.sha256'.",
  '',
  'export const BUNDLE_FORMAT = 1;',
  '',
  `export const CANONICAL_QUEUE_JSON = ${JSON.stringify(canonicalText)};`,
  '',
  `export const DECLARED_QUEUE_SHA256 = ${JSON.stringify(sha256)};`,
  '',
  `export const DECLARED_QUEUE_COUNT = ${count};`,
  '',
  `export const DECLARED_DEFERRED_TAIL = ${JSON.stringify(declaredDeferredTail, null, 2)};`,
  '',
  `export const GENERATED_FROM = ${JSON.stringify(generatedFrom, null, 2)};`,
  '',
].join('\n');

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(OUT_FILE, module);

console.log('Built Cloudflare queue bundle:');
console.log(`  output          ${OUT_FILE}`);
console.log(`  count           ${count}`);
console.log(`  unique IDs      ${uniqueIds.size}`);
console.log(`  canonical bytes ${Buffer.byteLength(canonicalText, 'utf8')}`);
console.log(`  sha256          ${sha256}`);
console.log('  deferred tail:');
for (const row of declaredDeferredTail) {
  console.log(`    ${row.id}  ${row.scheduledDate} ${row.scheduledTime} ${row.timezone}`);
}
