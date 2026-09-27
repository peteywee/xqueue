#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  ACTIVE_ASSIGNMENTS_SQL,
  APPROVED_UNSCHEDULED_SQL,
  buildDynamicRuntimeSnapshot,
  CURRENT_MEDIA_SQL,
  DEFERRED_ASSIGNMENTS_SQL,
  RUNTIME_STATE_SQL,
} from '../cloudflare/src/dynamic-runtime-integrity.mjs';
import {
  classifyReplacementReadback,
  planAutomaticReplacements,
  planOwnerPlacement,
  projectReplacementRuntimeRows,
  renderReplacementFrontierClaimSql,
  renderReplacementFrontierReleaseSql,
  renderReplacementItemSql,
  renderReplacementSuccessGuardSql,
} from '../src/continuous-queue-reschedule.mjs';
import {
  nextRuntimeRevision,
  renderRuntimeRevisionInsertSql,
} from '../src/continuous-queue-runtime-write.mjs';

const PREVIEW_DB = 'xqueue-preview';
const PREVIEW_CONFIG = 'wrangler.preview.jsonc';
const POLICY = JSON.parse(
  readFileSync(new URL('../config/schedule-policy.json', import.meta.url), 'utf8'),
);
const args = process.argv.slice(2);

function flag(name) {
  return args.includes('--' + name);
}

function opt(name, fallback = null) {
  const index = args.indexOf('--' + name);
  return index >= 0 && args[index + 1] !== undefined ? args[index + 1] : fallback;
}

function sqlString(value) {
  if (value === null || value === undefined) return 'NULL';
  return "'" + String(value).replaceAll("'", "''") + "'";
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

function query(sql) {
  return parseWranglerJson(runWrangler([
    'wrangler', 'd1', 'execute', PREVIEW_DB,
    '--config', PREVIEW_CONFIG, '--remote', '--yes', '--json', '--command', sql,
  ]));
}

function executeTransaction(sql) {
  const dir = mkdtempSync(join(tmpdir(), 'xqueue-reschedule-'));
  const file = join(dir, 'reschedule.sql');
  try {
    writeFileSync(file, sql, 'utf8');
    runWrangler([
      'wrangler', 'd1', 'execute', PREVIEW_DB,
      '--config', PREVIEW_CONFIG, '--remote', '--yes', '--file', file,
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function readFrontier() {
  const row = query(
    'SELECT singleton_id,generation,resolved_at,pending_operation_id,' +
    'last_completed_operation_id,updated_at ' +
    'FROM queue_intake_frontier WHERE singleton_id=1;',
  )[0];
  if (!row) throw new Error('scheduling frontier is missing');
  return row;
}

function readRuntimeState() {
  const row = query(RUNTIME_STATE_SQL)[0];
  if (!row) throw new Error('dynamic runtime revision is missing');
  return row;
}

function readOccupiedAssignments() {
  return query(
    'SELECT target_account,resolved_at,status,lifecycle_state ' +
    "FROM queue_assignments WHERE status='active' AND lifecycle_state='scheduled' " +
    'ORDER BY target_account,resolved_at;',
  );
}

function readPendingDeferrals() {
  return query(
    'SELECT ' +
    'a.assignment_id,a.assignment_version,a.content_id,a.content_revision,a.content_digest,' +
    'a.target_account,a.policy_version,a.generation AS assignment_generation,' +
    'a.status AS assignment_status,a.lifecycle_state,' +
    'd.generation AS deferral_generation,d.state AS deferral_state,d.prior_resolved_at,' +
    'd.prior_scheduled_date,d.prior_scheduled_time,d.prior_timezone,d.prior_slot_label,' +
    'p.status AS publication_status,p.generation AS publication_generation,' +
    'p.attempt_id AS publication_attempt_id,' +
    'c.pillar,c.intake_state,r.title,r.body,r.publication_text,' +
    'r.content_digest AS revision_content_digest,r.figure,r.source_ref ' +
    'FROM queue_assignments a ' +
    'JOIN queue_deferrals d ON d.content_id=a.content_id ' +
    'AND d.assignment_id=a.assignment_id AND d.assignment_version=a.assignment_version ' +
    'JOIN publication_state p ON p.post_id=a.content_id ' +
    'JOIN queue_content c ON c.content_id=a.content_id ' +
    'JOIN queue_content_revisions r ON r.content_id=a.content_id AND r.revision=a.content_revision ' +
    "WHERE a.status='active' AND a.lifecycle_state='deferred' " +
    "AND d.state='pending_replacement' " +
    'ORDER BY d.prior_resolved_at,a.content_id;',
  );
}

function runtimeRows() {
  return {
    assignments: query(ACTIVE_ASSIGNMENTS_SQL),
    deferred: query(DEFERRED_ASSIGNMENTS_SQL),
    approvedUnscheduled: query(APPROVED_UNSCHEDULED_SQL),
    media: query(CURRENT_MEDIA_SQL),
  };
}

function readReplacementItem(item) {
  const oldRow = query(
    'SELECT status,superseded_by_version FROM queue_assignments WHERE assignment_id=' +
    sqlString(item.assignment_id) + ' AND assignment_version=' + item.assignment_version + ';',
  )[0];
  const newRow = query(
    'SELECT status,lifecycle_state,assignment_version,content_digest,policy_version,resolved_at ' +
    'FROM queue_assignments WHERE assignment_id=' + sqlString(item.assignment_id) +
    ' AND assignment_version=' + item.to_assignment_version + ';',
  )[0];
  const deferral = query(
    'SELECT state,replacement_assignment_version FROM queue_deferrals WHERE content_id=' +
    sqlString(item.content_id) + ';',
  )[0];
  const publication = query(
    'SELECT status,scheduled_at FROM publication_state WHERE post_id=' +
    sqlString(item.content_id) + ';',
  )[0];

  return {
    content_id: item.content_id,
    old_status: oldRow?.status,
    old_superseded_by_version: oldRow?.superseded_by_version,
    new_status: newRow?.status,
    new_lifecycle_state: newRow?.lifecycle_state,
    new_assignment_version: newRow?.assignment_version,
    new_content_digest: newRow?.content_digest,
    new_policy_version: newRow?.policy_version,
    new_resolved_at: newRow?.resolved_at,
    deferral_state: deferral?.state,
    replacement_assignment_version: deferral?.replacement_assignment_version,
    publication_status: publication?.status,
    publication_scheduled_at: publication?.scheduled_at,
  };
}

function printPlan(plan) {
  console.log(JSON.stringify({
    mode: 'dry-run',
    environment: 'preview',
    operation_id: plan.operation_id,
    plan_digest: plan.plan_digest,
    replacement_mode: plan.mode,
    expected_frontier_generation: plan.expected_frontier_generation,
    expected_frontier_resolved_at: plan.expected_frontier_resolved_at,
    proposed_frontier_resolved_at: plan.proposed_frontier_resolved_at,
    count: plan.count,
    items: plan.items.map((item) => ({
      content_id: item.content_id,
      from_assignment_version: item.assignment_version,
      to_assignment_version: item.to_assignment_version,
      prior_resolved_at: item.prior_resolved_at,
      resolved_at: item.resolved_at,
      scheduled_date: item.scheduled_date,
      scheduled_time: item.scheduled_time,
      timezone: item.timezone,
      slot_label: item.slot_label,
      policy_version: item.policy_version,
    })),
  }, null, 2));
}

async function main() {
  if (opt('env', 'preview') !== 'preview') {
    throw new Error('replacement scheduling is hard-pinned to preview until dynamic cutover');
  }

  const mode = opt('mode', 'automatic');
  if (!['automatic', 'owner'].includes(mode)) {
    throw new Error('--mode must be automatic or owner');
  }

  const deferrals = readPendingDeferrals();
  if (deferrals.length === 0) {
    console.log(JSON.stringify({
      status: 'nothing_to_replace',
      environment: 'preview',
      mode,
    }, null, 2));
    return;
  }

  const frontier = readFrontier();
  const runtimeState = readRuntimeState();
  const occupiedAssignments = readOccupiedAssignments();
  const reason = opt(
    'reason',
    mode === 'automatic'
      ? 'automatic_deferred_replacement'
      : null,
  );

  let plan;
  if (mode === 'automatic') {
    plan = planAutomaticReplacements({
      deferrals,
      frontier,
      runtimeState,
      policy: POLICY,
      occupiedAssignments,
      now: new Date(),
      reason,
    });
  } else {
    const contentId = opt('content-id');
    const scheduledDate = opt('date');
    const scheduledTime = opt('time');
    if (!contentId) throw new Error('--content-id is required for owner placement');
    if (!scheduledDate) throw new Error('--date is required for owner placement');
    if (!scheduledTime) throw new Error('--time is required for owner placement');
    if (!reason) throw new Error('--reason is required for owner placement');

    const deferral = deferrals.find((row) => row.content_id === contentId);
    if (!deferral) throw new Error('content is not pending replacement: ' + contentId);

    plan = planOwnerPlacement({
      deferral,
      frontier,
      runtimeState,
      policy: POLICY,
      occupiedAssignments,
      scheduledDate,
      scheduledTime,
      timezone: opt('timezone', null),
      now: new Date(),
      reason,
    });
  }

  if (!flag('apply')) {
    printPlan(plan);
    return;
  }

  const recordedAt = new Date().toISOString();
  const beforeRows = runtimeRows();
  const projectedRows = projectReplacementRuntimeRows(plan, beforeRows);
  const snapshot = await buildDynamicRuntimeSnapshot(projectedRows);
  const revision = nextRuntimeRevision({
    currentState: runtimeState,
    snapshot,
    sourceOperationId: plan.operation_id,
    recordedAt,
  });

  const sql = [
    'BEGIN IMMEDIATE;',
    renderReplacementFrontierClaimSql(plan, recordedAt),
    ...plan.items.map((item) => renderReplacementItemSql(plan, item, recordedAt)),
    renderRuntimeRevisionInsertSql(revision, {
      additionalGuardSql: renderReplacementSuccessGuardSql(plan),
    }),
    renderReplacementFrontierReleaseSql(plan, recordedAt),
    'COMMIT;',
  ].join('\n');

  executeTransaction(sql);

  const runtimeRevision = query(
    'SELECT * FROM queue_runtime_revisions WHERE source_operation_id=' +
    sqlString(plan.operation_id) + ' LIMIT 1;',
  )[0] ?? null;
  const observed = {
    frontier: readFrontier(),
    runtimeRevision,
    items: plan.items.map(readReplacementItem),
  };
  const status = classifyReplacementReadback(plan, observed);
  if (status !== 'complete') {
    throw new Error('replacement scheduling readback is ' + status);
  }

  const verified = await buildDynamicRuntimeSnapshot(runtimeRows());
  if (verified.revision_digest !== runtimeRevision.revision_digest) {
    throw new Error('replacement runtime readback does not match canonical revision');
  }

  console.log(JSON.stringify({
    status: 'applied',
    environment: 'preview',
    operation_id: plan.operation_id,
    replacement_mode: plan.mode,
    count: plan.count,
    frontier_generation: Number(observed.frontier.generation),
    frontier_resolved_at: observed.frontier.resolved_at,
    runtime_generation: Number(runtimeRevision.generation),
    runtime_revision_digest: runtimeRevision.revision_digest,
    items: plan.items.map((item) => ({
      content_id: item.content_id,
      assignment_version: item.to_assignment_version,
      resolved_at: item.resolved_at,
    })),
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
