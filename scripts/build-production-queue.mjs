#!/usr/bin/env node

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadLibrary } from '../src/parse.mjs';
import { schedule, stats } from '../src/schedule.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const POLICY = join(ROOT, 'config', 'schedule-policy.json');
const CONTENT = join(ROOT, 'content');
const QUEUE = join(ROOT, 'queue.json');

if (!existsSync(POLICY)) {
  throw new Error(`Production schedule policy is missing: ${POLICY}`);
}

const policy = JSON.parse(readFileSync(POLICY, 'utf8'));
const posts = loadLibrary(CONTENT);
const queue = schedule(posts, {
  start: policy.campaignStart,
  slots: policy.slots,
  daysOfWeek: policy.daysOfWeek,
  timezone: policy.timezone,
  deferToEnd: policy.deferToEnd ?? [],
});

writeFileSync(QUEUE, `${JSON.stringify(queue, null, 2)}\n`);

const summary = stats(queue);
console.log(
  `Built production queue: ${summary.posts} posts across ${summary.postingDays} posting days.`,
);
console.log(`${summary.first} -> ${summary.last}`);
if (policy.deferToEnd?.length) {
  console.log(`Deferred to rotation tail: ${policy.deferToEnd.join(', ')}`);
}
