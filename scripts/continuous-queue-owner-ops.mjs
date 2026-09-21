#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import {
  ACTIVE_ASSIGNMENTS_SQL,
  APPROVED_UNSCHEDULED_SQL,
  buildDynamicRuntimeSnapshot,
  CURRENT_MEDIA_SQL,
  RUNTIME_STATE_SQL,
} from '../cloudflare/src/dynamic-runtime-integrity.mjs';
import {
  classifyCancelReadback,
  classifyRebindReadback,
  classifyRevisionReadback,
  planAssignmentCancel,
  planAssignmentRebind,
  planContentRevision,
  projectOwnerRuntimeRows,
  renderCancelSql,
  renderOwnerMutationSuccessGuardSql,
  renderRebindSql,
  renderRevisionCreateSql,
} from '../src/continuous-queue-owner-ops.mjs';
import {
  nextRuntimeRevision,
  renderRuntimeRevisionInsertSql,
} from '../src/continuous-queue-runtime-write.mjs';

const PREVIEW_DB = 'xqueue-preview';
const PREVIEW_CONFIG = 'wrangler.preview.jsonc';
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

function positiveInteger(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) {
    throw new Error(label + ' must be a positive integer');
  }
  return number;
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

function query(sql) {
  return parseWranglerJson(runWrangler([
    'wrangler', 'd1', 'execute', PREVIEW_DB,
    '--config', PREVIEW_CONFIG, '--remote', '--yes', '--json', '--command', sql,
  ]));
}

function executeTransaction(sql) {
  const dir = mkdtempSync(join(tmpdir(), 'xqueue-owner-op-'));
  const file = join(dir, 'operation.sql');
  try {
    writeFileSync(file, 'BEGIN IMMEDIATE;\n' + sql + '\nCOMMIT;\n', 'utf8');
    runWrangler([
      'wrangler', 'd1', 'execute', PREVIEW_DB,
      '--config', PREVIEW_CONFIG, '--remote', '--yes', '--file', file,
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function requirePreviewSchema() {
  const names = query('SELECT name FROM d1_migrations ORDER BY id;').map((row) => row.name);
  for (const required of [
    '0006_continuous_queue_shadow.sql',
    '0007_continuous_queue_intake.sql',
    '0008_dynamic_runtime_integrity.sql',
  ]) {
    if (!names.includes(required)) throw new Error('preview owner operations require ' + required);
  }
}

function readContent(contentId) {
  const rows = query(
    'SELECT content_id,pillar,current_revision,status,generation,intake_state,created_at,updated_at ' +
    'FROM queue_content WHERE content_id=' + sqlString(contentId) + ';',
  );
  if (!rows[0]) throw new Error('unknown content_id: ' + contentId);
  return rows[0];
}

function readRevision(contentId, revision) {
  const rows = query(
    'SELECT content_id,revision,title,body,publication_text,content_digest,figure,source_ref,created_at ' +
    'FROM queue_content_revisions WHERE content_id=' + sqlString(contentId) +
    ' AND revision=' + positiveInteger(revision, 'revision') + ';',
  );
  return rows[0] || null;
}

function readLatestRevision(contentId) {
  const rows = query(
    'SELECT content_id,revision,title,body,publication_text,content_digest,figure,source_ref,created_at ' +
    'FROM queue_content_revisions WHERE content_id=' + sqlString(contentId) +
    ' ORDER BY revision DESC LIMIT 1;',
  );
  if (!rows[0]) throw new Error('content revision history is missing');
  return rows[0];
}

function readActiveAssignment(contentId) {
  const rows = query(
    'SELECT assignment_id,assignment_version,content_id,content_revision,content_digest,' +
    'target_account,policy_version,resolved_at,scheduled_date,scheduled_time,timezone,' +
    'slot_label,status,superseded_by_version,generation,created_at,updated_at ' +
    'FROM queue_assignments WHERE content_id=' + sqlString(contentId) +
    " AND status='active' LIMIT 1;",
  );
  if (!rows[0]) throw new Error('no active assignment for ' + contentId);
  return rows[0];
}

function readPublicationState(contentId) {
  const rows = query(
    'SELECT post_id,status,scheduled_at,attempt_id,generation,skip_reason,skipped_at,updated_at ' +
    'FROM publication_state WHERE post_id=' + sqlString(contentId) + ' LIMIT 1;',
  );
  return rows[0] || null;
}

function readRuntimeState() {
  const rows = query(RUNTIME_STATE_SQL);
  if (!rows[0]) throw new Error('dynamic runtime revision is not initialized');
  return rows[0];
}

function readRuntimeRows() {
  return {
    assignments: query(ACTIVE_ASSIGNMENTS_SQL),
    approvedUnscheduled: query(APPROVED_UNSCHEDULED_SQL),
    media: query(CURRENT_MEDIA_SQL),
  };
}

function readTargetMedia(contentId, revision, figure) {
  if (figure == null) return null;
  const rows = query(
    'SELECT content_id,content_revision,media_ordinal,figure,logical_media_id,r2_key,' +
    'extension,mime_type,byte_size,sha256,status,generation,created_at,updated_at ' +
    'FROM queue_media_objects WHERE content_id=' + sqlString(contentId) +
    ' AND content_revision=' + positiveInteger(revision, 'revision') +
    " AND status='ready' ORDER BY media_ordinal;",
  );
  if (rows.length !== 1) {
    throw new Error(
      'target revision ' + contentId + ' v' + revision +
      ' requires exactly one ready media row; found ' + rows.length,
    );
  }
  if (Number(rows[0].figure) !== Number(figure)) {
    throw new Error('target revision media figure does not match revision');
  }
  return rows[0];
}

function readRebindReadback(plan) {
  const prior = query(
    'SELECT * FROM queue_assignments WHERE assignment_id=' + sqlString(plan.assignment_id) +
    ' AND assignment_version=' + plan.from_assignment_version + ';',
  )[0] || null;
  const active = query(
    'SELECT * FROM queue_assignments WHERE assignment_id=' + sqlString(plan.assignment_id) +
    ' AND assignment_version=' + plan.to_assignment_version + ';',
  )[0] || null;
  return { priorAssignment: prior, activeAssignment: active, content: readContent(plan.content_id) };
}

function readCancelReadback(plan) {
  const assignment = query(
    'SELECT * FROM queue_assignments WHERE assignment_id=' + sqlString(plan.assignment_id) +
    ' AND assignment_version=' + plan.assignment_version + ';',
  )[0] || null;
  return {
    assignment,
    content: readContent(plan.content_id),
    publicationState: readPublicationState(plan.content_id),
  };
}

function readRevisionReadback(plan) {
  return {
    revision: readRevision(plan.content_id, plan.to_revision),
    assignment: readActiveAssignment(plan.content_id),
    content: readContent(plan.content_id),
  };
}

function printPlan(plan, extra = {}) {
  console.log(JSON.stringify({
    mode: 'dry-run',
    environment: 'preview',
    kind: plan.kind,
    operation_id: plan.operation_id,
    payload_digest: plan.payload_digest,
    content_id: plan.content_id,
    reason: plan.reason,
    ...extra,
  }, null, 2));
}

async function applyRuntimeChangingOperation(options) {
  const { plan, mutationSql, targetRevision = null, targetMedia = null, recordedAt } = options;
  const currentState = readRuntimeState();
  if (
    Number(currentState.generation) !== Number(plan.expected_runtime_generation) ||
    currentState.revision_digest !== plan.expected_runtime_revision_digest
  ) {
    throw new Error('runtime revision changed after owner plan was built');
  }

  const beforeRows = readRuntimeRows();
  const projectedRows = projectOwnerRuntimeRows(plan, beforeRows, {
    targetRevision,
    targetMedia,
  });
  const projectedSnapshot = await buildDynamicRuntimeSnapshot(projectedRows);
  const runtimeRevision = nextRuntimeRevision({
    currentState,
    snapshot: projectedSnapshot,
    sourceOperationId: plan.operation_id,
    recordedAt,
  });

  const runtimeSql = renderRuntimeRevisionInsertSql(runtimeRevision, {
    additionalGuardSql: renderOwnerMutationSuccessGuardSql(plan),
  });
  executeTransaction(mutationSql + '\n' + runtimeSql);

  const stored = query(
    'SELECT generation,revision_digest,active_assignment_count,approved_unscheduled_count,' +
    'media_required_count,media_ready_count,previous_revision_digest,source_operation_id,created_at ' +
    'FROM queue_runtime_revisions WHERE source_operation_id=' +
    sqlString(plan.operation_id) + ' LIMIT 1;',
  )[0];

  if (
    !stored ||
    Number(stored.generation) !== runtimeRevision.generation ||
    stored.revision_digest !== runtimeRevision.revision_digest
  ) {
    throw new Error('owner mutation did not commit its exact runtime revision');
  }

  const observed = await buildDynamicRuntimeSnapshot(readRuntimeRows());
  if (observed.revision_digest !== stored.revision_digest) {
    throw new Error('remote runtime readback does not match promoted revision');
  }
  return stored;
}

async function main() {
  if (opt('env', 'preview') !== 'preview') {
    throw new Error('owner operations are hard-pinned to preview until dynamic cutover');
  }

  const action = opt('action');
  if (!['revise', 'rebind', 'cancel'].includes(action)) {
    throw new Error('--action must be revise, rebind, or cancel');
  }

  const contentId = opt('content-id');
  const reason = opt('reason');
  if (!contentId) throw new Error('--content-id is required');
  if (!reason?.trim()) throw new Error('--reason is required');

  requirePreviewSchema();
  const apply = flag('apply');
  const content = readContent(contentId);
  const activeAssignment = readActiveAssignment(contentId);
  const publicationState = readPublicationState(contentId);

  if (action === 'revise') {
    const currentRevision = readRevision(contentId, content.current_revision);
    const latestRevision = readLatestRevision(contentId);
    if (!currentRevision) throw new Error('current content revision is missing');

    const bodyFile = opt('body-file');
    const body = bodyFile ? readFileSync(resolve(bodyFile), 'utf8') : undefined;
    const title = opt('title', undefined);
    const sourceRef = opt('source-ref', undefined);
    const figureValue = opt('figure');
    const figure = flag('clear-figure')
      ? null
      : (figureValue == null ? undefined : positiveInteger(figureValue, 'figure'));

    const plan = planContentRevision({
      content,
      currentRevision,
      latestRevision,
      activeAssignment,
      publicationState,
      title,
      body,
      figure,
      sourceRef,
      reason,
    });

    if (!apply) {
      printPlan(plan, {
        from_revision: plan.from_revision,
        to_revision: plan.to_revision,
        to_content_digest: plan.to_content_digest,
        assignment_remains_bound_to_revision: plan.bound_content_revision,
      });
      return;
    }

    const recordedAt = new Date().toISOString();
    executeTransaction(renderRevisionCreateSql(plan, { recordedAt }));
    const state = classifyRevisionReadback(plan, readRevisionReadback(plan));
    if (state !== 'complete') throw new Error('revision readback is ' + state);

    console.log(JSON.stringify({
      status: 'applied',
      environment: 'preview',
      kind: 'revise',
      operation_id: plan.operation_id,
      content_id: plan.content_id,
      created_revision: plan.to_revision,
      assignment_rebound: false,
    }, null, 2));
    return;
  }

  const runtimeState = readRuntimeState();

  if (action === 'rebind') {
    const revisionNumber = positiveInteger(opt('revision'), '--revision');
    const targetRevision = readRevision(contentId, revisionNumber);
    if (!targetRevision) {
      throw new Error('revision ' + contentId + ' v' + revisionNumber + ' does not exist');
    }
    const targetMedia = readTargetMedia(contentId, revisionNumber, targetRevision.figure);

    const plan = planAssignmentRebind({
      content,
      activeAssignment,
      targetRevision,
      targetMedia,
      publicationState,
      runtimeState,
      reason,
    });

    if (!apply) {
      printPlan(plan, {
        from_assignment_version: plan.from_assignment_version,
        to_assignment_version: plan.to_assignment_version,
        from_content_revision: plan.from_content_revision,
        to_content_revision: plan.to_content_revision,
        scheduled_at_unchanged: plan.resolved_at,
        expected_runtime_generation: plan.expected_runtime_generation,
      });
      return;
    }

    const recordedAt = new Date().toISOString();
    const runtimeRevision = await applyRuntimeChangingOperation({
      plan,
      mutationSql: renderRebindSql(plan, { recordedAt }),
      targetRevision,
      targetMedia,
      recordedAt,
    });
    const state = classifyRebindReadback(plan, readRebindReadback(plan));
    if (state !== 'complete') throw new Error('rebind readback is ' + state);

    console.log(JSON.stringify({
      status: 'applied',
      environment: 'preview',
      kind: 'rebind',
      operation_id: plan.operation_id,
      content_id: plan.content_id,
      assignment_version: plan.to_assignment_version,
      content_revision: plan.to_content_revision,
      runtime_generation: Number(runtimeRevision.generation),
      runtime_revision_digest: runtimeRevision.revision_digest,
    }, null, 2));
    return;
  }

  const plan = planAssignmentCancel({
    content,
    activeAssignment,
    publicationState,
    runtimeState,
    reason,
  });

  if (!apply) {
    printPlan(plan, {
      assignment_version: plan.assignment_version,
      content_revision: plan.content_revision,
      expected_runtime_generation: plan.expected_runtime_generation,
      publication_state_will_skip: plan.publication_state_generation != null,
    });
    return;
  }

  const recordedAt = new Date().toISOString();
  const runtimeRevision = await applyRuntimeChangingOperation({
    plan,
    mutationSql: renderCancelSql(plan, { recordedAt }),
    recordedAt,
  });
  const state = classifyCancelReadback(plan, readCancelReadback(plan));
  if (state !== 'complete') throw new Error('cancel readback is ' + state);

  console.log(JSON.stringify({
    status: 'applied',
    environment: 'preview',
    kind: 'cancel',
    operation_id: plan.operation_id,
    content_id: plan.content_id,
    runtime_generation: Number(runtimeRevision.generation),
    runtime_revision_digest: runtimeRevision.revision_digest,
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
