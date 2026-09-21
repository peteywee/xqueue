#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  classifyReconciliationReadback,
  planOwnerReconciliation,
  renderOwnerReconciliationSql,
} from '../src/d1-publication-reconciliation.mjs';

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

function flag(name) {
  return args.includes('--' + name);
}

function opt(name, fallback = null) {
  const index = args.indexOf('--' + name);
  return index >= 0 && args[index + 1] !== undefined ? args[index + 1] : fallback;
}

function sqlText(value) {
  return "'" + String(value).replaceAll("'", "''") + "'";
}

function target(environment) {
  const resolved = TARGETS[environment];
  if (!resolved) throw new Error('environment must be preview or production');
  return resolved;
}

function runWrangler(wranglerArgs, { capture = true } = {}) {
  const result = spawnSync('pnpm', wranglerArgs, {
    cwd: process.cwd(),
    env: process.env,
    encoding: 'utf8',
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
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

function executeSql(environment, sql) {
  const destination = target(environment);
  const dir = mkdtempSync(join(tmpdir(), 'xqueue-reconciliation-'));
  const file = join(dir, 'reconciliation.sql');

  try {
    writeFileSync(file, sql, 'utf8');
    runWrangler([
      'wrangler', 'd1', 'execute', destination.database,
      '--config', destination.config,
      '--remote', '--yes', '--file', file,
    ], { capture: true });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function readCandidate(environment, postId) {
  const state = query(
    environment,
    'SELECT post_id,status,tweet_id,attempt_id,generation,reconciled,' +
    'scheduled_at,last_error,failed_at,ledger_record_json ' +
    'FROM publication_state WHERE post_id=' + sqlText(postId) + ' LIMIT 1;',
  )[0] ?? null;

  if (!state) throw new Error('publication_state row is missing');
  if (state.status !== 'needs_reconciliation') {
    throw new Error('publication state is not awaiting reconciliation');
  }
  if (!state.attempt_id) throw new Error('ambiguous state is missing attempt identity');

  const fence = query(
    environment,
    'SELECT * FROM publication_fences WHERE attempt_id=' +
    sqlText(state.attempt_id) + ' LIMIT 1;',
  )[0] ?? null;
  if (!fence) throw new Error('immutable publication fence is missing');

  const snapshot = query(
    environment,
    "SELECT value FROM runtime_metadata WHERE key='state.snapshot_json' LIMIT 1;",
  )[0] ?? null;
  if (!snapshot?.value) throw new Error('runtime publication snapshot is missing');

  return { state, fence, snapshotRaw: snapshot.value };
}

function readback(environment, plan) {
  return {
    determination: query(
      environment,
      'SELECT * FROM publication_reconciliation_determinations WHERE determination_id=' +
      sqlText(plan.determination_id) + ' LIMIT 1;',
    )[0] ?? null,
    publicationState: query(
      environment,
      'SELECT post_id,status,tweet_id,attempt_id,generation,reconciled,' +
      'scheduled_at,last_error,failed_at,ledger_record_json ' +
      'FROM publication_state WHERE post_id=' + sqlText(plan.post_id) + ' LIMIT 1;',
    )[0] ?? null,
    snapshotRaw: query(
      environment,
      "SELECT value FROM runtime_metadata WHERE key='state.snapshot_json' LIMIT 1;",
    )[0]?.value ?? null,
    events: query(
      environment,
      'SELECT id,event_type,event_at,detail FROM publication_events WHERE post_id=' +
      sqlText(plan.post_id) + ' ORDER BY id;',
    ),
  };
}

async function main() {
  const environment = opt('environment', 'preview');
  target(environment);

  const postId = opt('post-id');
  const rawOutcome = opt('outcome');
  const reason = opt('reason');
  const tweetId = opt('tweet-id');

  if (!postId) throw new Error('--post-id is required');
  if (!reason) throw new Error('--reason is required');
  if (!['posted', 'not-posted'].includes(rawOutcome)) {
    throw new Error('--outcome must be posted or not-posted');
  }
  if (rawOutcome === 'posted' && !tweetId) {
    throw new Error('--tweet-id is required for posted reconciliation');
  }
  if (rawOutcome === 'not-posted' && tweetId) {
    throw new Error('--tweet-id is invalid for not-posted reconciliation');
  }

  const candidate = readCandidate(environment, postId);
  const plan = planOwnerReconciliation({
    publicationState: candidate.state,
    publicationFence: candidate.fence,
    snapshotRaw: candidate.snapshotRaw,
    outcome: rawOutcome === 'posted'
      ? 'confirmed_posted'
      : 'confirmed_not_posted',
    tweetId,
    reason,
    determinedAt: new Date().toISOString(),
  });

  if (!flag('apply')) {
    console.log(JSON.stringify({
      mode: 'dry-run',
      environment,
      database: target(environment).database,
      determination_id: plan.determination_id,
      post_id: plan.post_id,
      attempt_id: plan.attempt_id,
      expected_state_generation: plan.expected_state_generation,
      resulting_state_generation: plan.resulting_state_generation,
      outcome: plan.outcome,
      tweet_id: plan.tweet_id,
      reason: plan.reason,
      automatic_retry: false,
    }, null, 2));
    return;
  }

  if (
    environment === 'production' &&
    opt('confirm') !== 'xqueue-production-reconciliation'
  ) {
    throw new Error(
      'production reconciliation requires --confirm xqueue-production-reconciliation',
    );
  }

  executeSql(environment, renderOwnerReconciliationSql(plan));

  const observed = readback(environment, plan);
  const classification = classifyReconciliationReadback(plan, observed);
  if (classification !== 'complete') {
    throw new Error('reconciliation readback is ' + classification);
  }

  console.log(JSON.stringify({
    status: 'applied',
    environment,
    database: target(environment).database,
    determination_id: plan.determination_id,
    post_id: plan.post_id,
    outcome: plan.outcome,
    state_generation: plan.resulting_state_generation,
    automatic_retry: false,
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
