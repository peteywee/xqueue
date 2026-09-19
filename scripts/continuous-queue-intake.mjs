#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import {
  classifyItemReadback,
  executeIntakePlan,
  hashAssignmentRows,
  INTAKE_SCHEMA_MIGRATION,
  normalizeIntakeInput,
  planIntake,
  renderFrontierClaimSql,
  renderFrontierReleaseSql,
  renderItemApplySql,
  renderOperationCreateSql,
  renderOperationRuntimeResultSql,
  renderOperationStatusSql,
  verifyReplayInput,
} from '../src/continuous-queue-intake.mjs';
import {
  ACTIVE_ASSIGNMENTS_SQL,
  APPROVED_UNSCHEDULED_SQL,
  buildDynamicRuntimeSnapshot,
  CURRENT_MEDIA_SQL,
  RUNTIME_STATE_SQL,
} from '../cloudflare/src/dynamic-runtime-integrity.mjs';
import {
  nextRuntimeRevision,
  renderRuntimeRevisionInsertSql,
} from '../src/continuous-queue-runtime-write.mjs';

const PREVIEW_DB = 'xqueue-preview';
const PREVIEW_CONFIG = 'wrangler.preview.jsonc';
const POLICY_FILE = resolve('config/schedule-policy.json');
const RUNTIME_SCHEMA_MIGRATION = '0008_dynamic_runtime_integrity.sql';

const args = process.argv.slice(2);

function flag(name) {
  return args.includes(`--${name}`);
}

function opt(name, fallback = null) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}

function sqlString(value) {
  if (value === null || value === undefined) return 'NULL';
  return `'${String(value).replaceAll("'", "''")}'`;
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
      `pnpm ${wranglerArgs.join(' ')} failed with exit ${result.status}${detail ? `: ${detail}` : ''}`,
    );
  }

  return result.stdout ?? '';
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
  const stdout = runWrangler([
    'wrangler',
    'd1',
    'execute',
    PREVIEW_DB,
    '--config',
    PREVIEW_CONFIG,
    '--remote',
    '--yes',
    '--json',
    '--command',
    sql,
  ]);
  return parseWranglerJson(stdout);
}

function executeCommand(sql) {
  query(sql);
}

function executeFile(sql) {
  const dir = mkdtempSync(join(tmpdir(), 'xqueue-intake-'));
  const file = join(dir, 'operation.sql');
  try {
    writeFileSync(file, sql, 'utf8');
    runWrangler([
      'wrangler',
      'd1',
      'execute',
      PREVIEW_DB,
      '--config',
      PREVIEW_CONFIG,
      '--remote',
      '--yes',
      '--file',
      file,
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function readFrontier() {
  const [row] = query(
    'SELECT singleton_id,generation,resolved_at,pending_operation_id,last_completed_operation_id,updated_at ' +
    'FROM queue_intake_frontier WHERE singleton_id = 1;',
  );
  if (!row) throw new Error('queue intake frontier is missing');
  return row;
}

function readOperation(operationId) {
  const [row] = query(
    'SELECT operation_id,plan_digest,batch_digest,item_count,expected_frontier_generation,' +
    'expected_frontier_resolved_at,proposed_frontier_resolved_at,baseline_assignment_hash,' +
    'expected_runtime_generation,expected_runtime_revision_digest,' +
    'resulting_runtime_generation,resulting_runtime_revision_digest,' +
    'target_account,policy_version,status,created_at,updated_at ' +
    `FROM queue_intake_operations WHERE operation_id = ${sqlString(operationId)};`,
  );
  return row ?? null;
}

function readOperationItems(operationId) {
  return query(
    'SELECT operation_id,ordinal,content_id,content_digest,pillar,title,source_ref,' +
    'resolved_at,scheduled_date,scheduled_time,timezone,slot_label ' +
    `FROM queue_intake_items WHERE operation_id = ${sqlString(operationId)} ORDER BY ordinal;`,
  );
}

function findCompletedBatch(batchDigest) {
  const [row] = query(
    'SELECT operation_id,plan_digest,batch_digest,item_count,expected_frontier_generation,' +
    'expected_frontier_resolved_at,proposed_frontier_resolved_at,baseline_assignment_hash,' +
    'expected_runtime_generation,expected_runtime_revision_digest,' +
    'resulting_runtime_generation,resulting_runtime_revision_digest,' +
    'target_account,policy_version,status,created_at,updated_at ' +
    'FROM queue_intake_operations ' +
    `WHERE batch_digest = ${sqlString(batchDigest)} AND status = 'complete' ` +
    'ORDER BY created_at DESC LIMIT 1;',
  );
  return row ?? null;
}

function readItem(item) {
  const [content] = query(
    'SELECT content_id,pillar,current_revision,status,generation,intake_state ' +
    `FROM queue_content WHERE content_id = ${sqlString(item.content_id)};`,
  );
  const [revision] = query(
    'SELECT content_id,revision,title,body,publication_text,content_digest,figure,source_ref ' +
    `FROM queue_content_revisions WHERE content_id = ${sqlString(item.content_id)} AND revision = 1;`,
  );
  const [assignment] = query(
    'SELECT assignment_id,assignment_version,content_id,content_revision,content_digest,' +
    'target_account,policy_version,resolved_at,scheduled_date,scheduled_time,timezone,' +
    'slot_label,status,superseded_by_version,generation ' +
    `FROM queue_assignments WHERE assignment_id = ${sqlString(item.content_id)} AND assignment_version = 1;`,
  );
  return {
    content: content ?? null,
    revision: revision ?? null,
    assignment: assignment ?? null,
  };
}

function activeAssignments() {
  return query(
    'SELECT assignment_id,assignment_version,content_id,content_revision,content_digest,' +
    'target_account,policy_version,resolved_at,scheduled_date,scheduled_time,timezone,' +
    'slot_label,status,superseded_by_version,generation,created_at,updated_at ' +
    "FROM queue_assignments WHERE status = 'active' ORDER BY target_account,resolved_at,content_id;",
  );
}

function contentIndex() {
  return query(
    'SELECT c.content_id,c.intake_state,r.content_digest ' +
    'FROM queue_content c JOIN queue_content_revisions r ' +
    'ON r.content_id = c.content_id AND r.revision = c.current_revision;',
  );
}

function runtimeState() {
  const [row] = query(RUNTIME_STATE_SQL);
  return row ?? null;
}

function runtimeRevisionForOperation(operationId) {
  const [row] = query(
    'SELECT generation,revision_digest,active_assignment_count,' +
    'approved_unscheduled_count,media_required_count,media_ready_count,' +
    'previous_revision_digest,source_operation_id,created_at ' +
    'FROM queue_runtime_revisions ' +
    `WHERE source_operation_id = ${sqlString(operationId)};`,
  );
  return row ?? null;
}

async function dynamicRuntimeSnapshot() {
  return buildDynamicRuntimeSnapshot({
    assignments: query(ACTIVE_ASSIGNMENTS_SQL),
    approvedUnscheduled: query(APPROVED_UNSCHEDULED_SQL),
    media: query(CURRENT_MEDIA_SQL),
  });
}

function verifyCompletedReplay(normalized, operation) {
  const storedItems = readOperationItems(operation.operation_id);
  verifyReplayInput(normalized, storedItems);

  for (let index = 0; index < normalized.items.length; index++) {
    const input = normalized.items[index];
    const stored = storedItems[index];
    const expected = {
      ...input,
      assignment_id: input.content_id,
      assignment_version: 1,
      content_revision: 1,
      target_account: operation.target_account,
      policy_version: Number(operation.policy_version),
      resolved_at: stored.resolved_at,
      scheduled_date: stored.scheduled_date,
      scheduled_time: stored.scheduled_time,
      timezone: stored.timezone,
      slot_label: stored.slot_label,
    };
    const state = classifyItemReadback(expected, readItem(expected));
    if (state !== 'complete') {
      throw new Error(
        `completed batch ${operation.operation_id} readback is ${state} for ${input.content_id}`,
      );
    }
  }

  return {
    status: 'already_applied',
    operation_id: operation.operation_id,
    batch_digest: operation.batch_digest,
    count: Number(operation.item_count),
    frontier_resolved_at: operation.proposed_frontier_resolved_at,
  };
}

function transport() {
  return {
    readFrontier: async () => readFrontier(),
    readOperation: async (operationId) => readOperation(operationId),
    createOperation: async (plan, recordedAt) =>
      executeFile(renderOperationCreateSql(plan, recordedAt)),
    claimFrontier: async (plan, recordedAt) =>
      executeCommand(renderFrontierClaimSql(plan, recordedAt)),
    markOperation: async (operationId, status, recordedAt) =>
      executeCommand(renderOperationStatusSql(operationId, status, recordedAt)),
    readItem: async (item) => readItem(item),
    putItem: async (plan, item, recordedAt) =>
      executeFile(renderItemApplySql(plan, item, recordedAt)),
    hashAssignmentsExcluding: async (contentIds) => {
      const excluded = new Set(contentIds);
      return hashAssignmentRows(
        activeAssignments().filter((row) => !excluded.has(row.content_id)),
      );
    },
    readRuntimeState: async () => runtimeState(),
    readRuntimeRevisionForOperation: async (operationId) =>
      runtimeRevisionForOperation(operationId),
    commitRuntimeRevision: async (plan, recordedAt) => {
      const current = runtimeState();
      if (
        !current ||
        Number(current.generation) !== plan.expected_runtime_generation ||
        current.revision_digest !== plan.expected_runtime_revision_digest
      ) {
        throw new Error('runtime revision changed before commit');
      }

      const snapshot = await dynamicRuntimeSnapshot();
      const revision = nextRuntimeRevision({
        currentState: current,
        snapshot,
        sourceOperationId: plan.operation_id,
        recordedAt,
      });

      executeCommand(renderRuntimeRevisionInsertSql(revision));

      const readback = runtimeRevisionForOperation(plan.operation_id);
      if (!readback) {
        throw new Error('runtime revision insert was not readable after commit');
      }
      return readback;
    },
    recordRuntimeResult: async (operationId, runtimeRevision, recordedAt) =>
      executeCommand(
        renderOperationRuntimeResultSql(
          operationId,
          runtimeRevision,
          recordedAt,
        ),
      ),
    releaseFrontier: async (plan, recordedAt) =>
      executeCommand(renderFrontierReleaseSql(plan, recordedAt)),
  };
}

function requireSchema() {
  const rows = query('SELECT name FROM d1_migrations ORDER BY id;');
  const names = rows.map((row) => row.name);
  for (const required of [INTAKE_SCHEMA_MIGRATION, RUNTIME_SCHEMA_MIGRATION]) {
    if (!names.includes(required)) {
      throw new Error(
        `preview intake schema is not active; apply ${required} to xqueue-preview first`,
      );
    }
  }
}

function printPlan(plan) {
  console.log(JSON.stringify({
    mode: 'dry-run',
    environment: 'preview',
    operation_id: plan.operation_id,
    plan_digest: plan.plan_digest,
    batch_digest: plan.batch_digest,
    expected_frontier: {
      generation: plan.expected_frontier_generation,
      resolved_at: plan.expected_frontier_resolved_at,
    },
    proposed_frontier: plan.proposed_frontier_resolved_at,
    expected_runtime_revision: plan.expected_runtime_generation == null
      ? null
      : {
          generation: plan.expected_runtime_generation,
          digest: plan.expected_runtime_revision_digest,
        },
    items: plan.items.map((item) => ({
      ordinal: item.ordinal,
      content_id: item.content_id,
      content_digest: item.content_digest,
      resolved_at: item.resolved_at,
      scheduled_date: item.scheduled_date,
      scheduled_time: item.scheduled_time,
      timezone: item.timezone,
      slot_label: item.slot_label,
    })),
  }, null, 2));
}

async function main() {
  const mode = opt('mode', 'batch');
  const file = opt('file');
  const environment = opt('env', 'preview');
  const apply = flag('apply');
  const sourceMode = flag('automated') ? 'automated' : 'owner-manual';
  const ownerApprovalDigest = opt('approval-digest');

  if (!['single', 'batch'].includes(mode)) {
    throw new Error('--mode must be single or batch');
  }
  if (!file) throw new Error('intake requires --file <json>');
  if (environment !== 'preview') {
    throw new Error('production intake is not activated; #89 is hard-pinned to preview');
  }

  requireSchema();

  const raw = JSON.parse(readFileSync(resolve(file), 'utf8'));
  const policy = JSON.parse(readFileSync(POLICY_FILE, 'utf8'));
  const normalized = normalizeIntakeInput(raw, {
    mode,
    sourceMode,
    ownerApprovalDigest,
  });

  const complete = findCompletedBatch(normalized.batch_digest);
  if (complete) {
    const result = verifyCompletedReplay(normalized, complete);
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  const frontier = readFrontier();
  const currentRuntimeState = runtimeState();
  const allContent = contentIndex();
  const ids = new Set(normalized.items.map((item) => item.content_id));
  const digests = new Set(normalized.items.map((item) => item.content_digest));
  const assignments = activeAssignments();

  const plan = planIntake({
    normalized,
    frontier,
    policy,
    existingContent: allContent.filter((row) => ids.has(row.content_id)),
    existingDigests: allContent.filter((row) => digests.has(row.content_digest)),
    baselineAssignmentHash: hashAssignmentRows(assignments),
    runtimeState: currentRuntimeState,
  });

  if (!apply) {
    printPlan(plan);
    return;
  }

  if (
    plan.expected_runtime_generation == null ||
    plan.expected_runtime_revision_digest == null
  ) {
    throw new Error(
      'preview runtime revision is not initialized; bootstrap #90 dynamic runtime evidence first',
    );
  }

  const result = await executeIntakePlan({
    plan,
    transport: transport(),
  });
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
