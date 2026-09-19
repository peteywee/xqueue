#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadLibrary } from '../src/parse.mjs';
import { schedule } from '../src/schedule.mjs';
import {
  buildContinuousQueueShadow,
  renderShadowBackfillSql,
  shadowManifestJson,
  shadowManifestSha256,
} from '../src/continuous-queue-shadow.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const POLICY = join(ROOT, 'config', 'schedule-policy.json');
const CONTENT = join(ROOT, 'content');

function parseArgs(argv) {
  const options = {
    format: 'summary',
    recordedAt: null,
  };

  for (const arg of argv) {
    if (arg === '--json') options.format = 'json';
    else if (arg === '--sql') options.format = 'sql';
    else if (arg.startsWith('--recorded-at=')) {
      options.recordedAt = arg.slice('--recorded-at='.length);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }

  return options;
}

export function buildProductionShadow() {
  const policy = JSON.parse(readFileSync(POLICY, 'utf8'));
  const posts = loadLibrary(CONTENT);
  const queue = schedule(posts, {
    start: policy.campaignStart,
    slots: policy.slots,
    daysOfWeek: policy.daysOfWeek,
    timezone: policy.timezone,
    deferToEnd: policy.deferToEnd ?? [],
  });

  return buildContinuousQueueShadow(queue, {
    policyVersion: policy.version,
    targetAccount: 'PatrickCra94338',
  });
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const model = buildProductionShadow();

  if (options.format === 'json') {
    process.stdout.write(shadowManifestJson(model));
    return;
  }

  if (options.format === 'sql') {
    if (!options.recordedAt) {
      throw new Error('--sql requires --recorded-at=<canonical ISO UTC>');
    }
    process.stdout.write(
      renderShadowBackfillSql(model, { recordedAt: options.recordedAt }),
    );
    return;
  }

  console.log('Continuous queue shadow model:');
  console.log(`  content records      ${model.content.length}`);
  console.log(`  content revisions    ${model.revisions.length}`);
  console.log(`  active assignments   ${model.assignments.length}`);
  console.log(`  policy version       ${model.policy_version}`);
  console.log(`  target account       ${model.target_account}`);
  console.log(`  model sha256         ${shadowManifestSha256(model)}`);
  console.log(`  first assignment     ${model.assignments[0].assignment_id} @ ${model.assignments[0].resolved_at}`);
  console.log(`  last assignment      ${model.assignments.at(-1).assignment_id} @ ${model.assignments.at(-1).resolved_at}`);
  console.log('');
  console.log('This command is read-only. Use --json or --sql to emit deterministic artifacts.');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
