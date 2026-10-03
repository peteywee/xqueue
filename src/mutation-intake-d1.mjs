import { createHash } from 'node:crypto';

import { buildDynamicRuntimeSnapshot } from '../cloudflare/src/dynamic-runtime-integrity.mjs';
import { nextRuntimeRevision } from './continuous-queue-runtime-write.mjs';
import { verifyMutationCompletion } from './mutation-control-plane.mjs';

const SHA_RE = /^[a-f0-9]{64}$/;
const SHA40_RE = /^[a-f0-9]{40}$/;

function requiredString(value, label) {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(label + ' is required');
  return value;
}

function positiveInteger(value, label) {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 1) throw new Error(label + ' must be a positive integer');
  return n;
}

function nonNegativeInteger(value, label) {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 0) throw new Error(label + ' must be a non-negative integer');
  return n;
}

function canonicalInstant(value, label) {
  const text = requiredString(value, label);
  const ms = Date.parse(text);
  if (!Number.isFinite(ms) || new Date(ms).toISOString() !== text) {
    throw new Error(label + ' must be canonical ISO-8601 UTC with milliseconds');
  }
  return text;
}

function digest(value, label) {
  const text = String(value ?? '').toLowerCase();
  if (!SHA_RE.test(text)) throw new Error(label + ' must be sha256 hex');
  return text;
}

function sha40(value, label) {
  const text = String(value ?? '').toLowerCase();
  if (!SHA40_RE.test(text)) throw new Error(label + ' must be sha40 hex');
  return text;
}

function canonical(value) {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('non-finite evidence value');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (typeof value === 'object') {
    return '{' + Object.keys(value).sort().map((key) =>
      JSON.stringify(key) + ':' + canonical(value[key])
    ).join(',') + '}';
  }
  throw new Error('unsupported evidence value');
}

function sha256Canonical(value) {
  return createHash('sha256').update(Buffer.from(canonical(value), 'utf8')).digest('hex');
}

function ensureDb(db) {
  if (!db || typeof db.prepare !== 'function') throw new Error('D1 database binding is required');
  return db;
}

function stmt(db, sql, ...args) {
  return db.prepare(sql).bind(...args);
}

function completionReadbackError(readback, message, cause = null) {
  const error = new Error(message);
  error.readback = readback;
  if (cause !== null) error.cause = cause;
  return error;
}

async function completionReadFirst(db, sql, ...args) {
  try {
    return await stmt(db, sql, ...args).first();
  } catch (cause) {
    throw completionReadbackError(
      'unavailable',
      'mutation completion readback unavailable: ' +
        (cause instanceof Error ? cause.message : String(cause)),
      cause,
    );
  }
}

function assertStmt(db, predicateSql, predicateArgs, operationId, recordedAt) {
  return stmt(
    db,
    "INSERT INTO mutation_lane_events (generation,operation_id,event_type,actor_class,event_at,detail) " +
      "SELECT 1, ?, '__assert_fail__', 'automation', ?, NULL WHERE NOT (" + predicateSql + ")",
    operationId,
    recordedAt,
    ...predicateArgs,
  );
}

function validatePair(controlPlan, intakePlan) {
  requiredString(controlPlan?.operation_id, 'mutation operation id');
  requiredString(intakePlan?.operation_id, 'intake operation id');
  if (controlPlan.operation_kind !== 'intake') throw new Error('mutation plan is not intake');
  if (controlPlan.plan_context?.intake_operation_id !== intakePlan.operation_id) {
    throw new Error('intake operation identity does not match mutation plan');
  }
  if (controlPlan.plan_context?.intake_plan_digest !== intakePlan.plan_digest) {
    throw new Error('intake plan digest does not match mutation plan');
  }
  if (Number(intakePlan.expected_runtime_generation) !== Number(controlPlan.expected_runtime_generation)) {
    throw new Error('runtime generation fence mismatch');
  }
  if (intakePlan.expected_runtime_revision_digest !== controlPlan.expected_runtime_revision_digest) {
    throw new Error('runtime digest fence mismatch');
  }
}

function projectedAssignment(item) {
  return Object.freeze({
    assignment_id: item.assignment_id,
    assignment_version: 1,
    content_id: item.content_id,
    content_revision: 1,
    content_digest: item.content_digest,
    target_account: item.target_account,
    policy_version: item.policy_version,
    resolved_at: item.resolved_at,
    scheduled_date: item.scheduled_date,
    scheduled_time: item.scheduled_time,
    timezone: item.timezone,
    slot_label: item.slot_label ?? null,
    status: 'active',
    lifecycle_state: 'scheduled',
    superseded_by_version: null,
    assignment_generation: 1,
    pillar: item.pillar,
    intake_state: 'scheduled',
    title: item.title,
    body: item.body,
    publication_text: item.publication_text,
    revision_content_digest: item.content_digest,
    figure: null,
    source_ref: item.source_ref ?? null,
  });
}

export async function projectIntakeRuntimeRevision({
  intakePlan,
  controlPlan,
  currentRuntimeState,
  assignments = [],
  deferred = [],
  approvedUnscheduled = [],
  media = [],
  recordedAt,
}) {
  validatePair(controlPlan, intakePlan);
  canonicalInstant(recordedAt, 'recordedAt');

  if (
    Number(currentRuntimeState?.generation) !== Number(controlPlan.expected_runtime_generation) ||
    currentRuntimeState?.revision_digest !== controlPlan.expected_runtime_revision_digest
  ) {
    throw new Error('current runtime state does not match mutation fence');
  }

  const snapshot = await buildDynamicRuntimeSnapshot({
    assignments: [...assignments, ...intakePlan.items.map(projectedAssignment)],
    deferred,
    approvedUnscheduled,
    media,
  });

  return nextRuntimeRevision({
    currentState: currentRuntimeState,
    snapshot,
    sourceOperationId: controlPlan.operation_id,
    recordedAt,
  });
}

export async function readIntakeMutationCompletion({ db, controlPlan, intakePlan }) {
  const d1 = ensureDb(db);
  validatePair(controlPlan, intakePlan);

  const operation = await completionReadFirst(
    d1,
    'SELECT operation_id,plan_digest,state,effect_state,resulting_runtime_generation,resulting_runtime_revision_digest ' +
      'FROM mutation_operations WHERE operation_id=?',
    controlPlan.operation_id,
  );

  const operationState = operation?.state;
  if (
    !operation ||
    operation.plan_digest !== controlPlan.plan_digest ||
    !['VERIFYING', 'COMPLETE'].includes(operationState) ||
    operation.effect_state !== 'applied'
  ) {
    throw completionReadbackError('contradictory', 'mutation operation readback is not exact applied state');
  }

  const intakeOperation = await completionReadFirst(
    d1,
    'SELECT operation_id,plan_digest,status,resulting_runtime_generation,resulting_runtime_revision_digest ' +
      'FROM queue_intake_operations WHERE operation_id=?',
    intakePlan.operation_id,
  );

  const expectedIntakeStatus = operationState === 'COMPLETE' ? 'complete' : 'claimed';
  if (
    !intakeOperation ||
    intakeOperation.plan_digest !== intakePlan.plan_digest ||
    intakeOperation.status !== expectedIntakeStatus
  ) {
    throw completionReadbackError('contradictory', 'intake operation readback does not match mutation state');
  }

  const runtime = await completionReadFirst(
    d1,
    'SELECT generation,revision_digest,source_operation_id FROM queue_runtime_revisions WHERE source_operation_id=?',
    controlPlan.operation_id,
  );

  if (
    !runtime ||
    Number(runtime.generation) !== Number(operation.resulting_runtime_generation) ||
    runtime.revision_digest !== operation.resulting_runtime_revision_digest ||
    Number(runtime.generation) !== Number(intakeOperation.resulting_runtime_generation) ||
    runtime.revision_digest !== intakeOperation.resulting_runtime_revision_digest
  ) {
    throw completionReadbackError('contradictory', 'runtime completion readback does not match operation evidence');
  }

  const items = [];
  for (const expected of controlPlan.items) {
    const intakeItem = intakePlan.items.find((item) => item.content_id === expected.item_key);
    if (!intakeItem) throw completionReadbackError('contradictory', 'intake item missing for mutation item ' + expected.item_key);

    const row = await completionReadFirst(
      d1,
      'SELECT c.current_revision AS content_revision,c.intake_state,' +
        'r.content_digest AS revision_digest,a.assignment_version,' +
        'a.content_revision AS assignment_content_revision,a.content_digest AS assignment_digest,' +
        'a.target_account,a.policy_version,a.resolved_at,a.status,a.lifecycle_state ' +
        'FROM queue_content c ' +
        'JOIN queue_content_revisions r ON r.content_id=c.content_id AND r.revision=c.current_revision ' +
        'JOIN queue_assignments a ON a.content_id=c.content_id AND a.assignment_id=? ' +
        'WHERE c.content_id=? ORDER BY a.assignment_version DESC LIMIT 1',
      intakeItem.assignment_id,
      intakeItem.content_id,
    );

    const exact = Boolean(
      row &&
      Number(row.content_revision) === Number(expected.resulting_content_revision) &&
      row.intake_state === 'scheduled' &&
      row.revision_digest === intakeItem.content_digest &&
      Number(row.assignment_version) === Number(expected.resulting_assignment_version) &&
      Number(row.assignment_content_revision) === Number(expected.resulting_content_revision) &&
      row.assignment_digest === intakeItem.content_digest &&
      row.target_account === intakeItem.target_account &&
      Number(row.policy_version) === Number(intakeItem.policy_version) &&
      row.resolved_at === intakeItem.resolved_at &&
      row.status === 'active' &&
      row.lifecycle_state === 'scheduled'
    );

    items.push(Object.freeze({
      item_key: expected.item_key,
      readback_status: exact ? 'applied' : (row ? 'conflict' : 'not_applied'),
      resulting_content_revision: row ? Number(row.content_revision) : null,
      resulting_assignment_version: row ? Number(row.assignment_version) : null,
    }));
  }

  return Object.freeze({
    operation_id: operation.operation_id,
    runtime_generation: Number(runtime.generation),
    runtime_revision_digest: runtime.revision_digest,
    items: Object.freeze(items),
  });
}

export function intakeCompletionEvidence(controlPlan, observed) {
  const verification = verifyMutationCompletion(controlPlan, observed);
  if (!verification.ok) {
    throw new Error('completion readback is not exact: ' + verification.reason);
  }

  const evidence = Object.freeze({
    operation_id: observed.operation_id,
    runtime_generation: Number(observed.runtime_generation),
    runtime_revision_digest: digest(observed.runtime_revision_digest, 'runtime revision digest'),
    items: Object.freeze(observed.items.map((item) => Object.freeze({ ...item }))),
  });

  return Object.freeze({
    observed: evidence,
    evidence_digest: sha256Canonical(evidence),
  });
}

export function prepareIntakeAtomicApply({
  db,
  controlPlan,
  intakePlan,
  runtimeRevision,
  checkpointEvidence,
  publicationSafetyFence = null,
  recordedAt,
}) {
  const d1 = ensureDb(db);
  validatePair(controlPlan, intakePlan);
  canonicalInstant(recordedAt, 'recordedAt');

  if (checkpointEvidence?.operation_id !== controlPlan.operation_id) {
    throw new Error('checkpoint operation mismatch');
  }
  if (Number(checkpointEvidence?.expected_lane_generation) !== Number(controlPlan.expected_lane_generation)) {
    throw new Error('checkpoint lane generation mismatch');
  }
  requiredString(checkpointEvidence?.checkpoint_bookmark, 'checkpoint bookmark');
  canonicalInstant(checkpointEvidence?.checkpoint_verified_at, 'checkpoint verified_at');

  const expectedRuntime = positiveInteger(controlPlan.expected_runtime_generation, 'expected runtime generation');
  const expectedRuntimeDigest = digest(controlPlan.expected_runtime_revision_digest, 'expected runtime digest');
  if (
    Number(runtimeRevision?.generation) !== expectedRuntime + 1 ||
    runtimeRevision?.previous_revision_digest !== expectedRuntimeDigest ||
    runtimeRevision?.source_operation_id !== controlPlan.operation_id
  ) {
    throw new Error('projected runtime revision does not match mutation fence');
  }
  const resultDigest = digest(runtimeRevision.revision_digest, 'result runtime digest');
  const expectedLane = positiveInteger(controlPlan.expected_lane_generation, 'expected lane generation');
  const claimedLane = expectedLane + 1;

  const statements = [];

  let laneClaimSql =
    "UPDATE mutation_lane_state SET generation=generation+1,active_operation_id=?,actor_class='automation',updated_at=? " +
    "WHERE singleton_id=1 AND generation=? AND active_operation_id IS NULL " +
    "AND EXISTS (SELECT 1 FROM mutation_lane_halt_state WHERE singleton_id=1 AND halted=0 AND generation=?) " +
    "AND EXISTS (SELECT 1 FROM queue_runtime_revisions WHERE generation=? AND revision_digest=? " +
    "AND generation=(SELECT MAX(generation) FROM queue_runtime_revisions))";
  const laneClaimArgs = [
    controlPlan.operation_id,
    recordedAt,
    expectedLane,
    controlPlan.expected_halt_generation,
    expectedRuntime,
    expectedRuntimeDigest,
  ];

  if (publicationSafetyFence !== null) {
    const authorityGeneration = positiveInteger(
      publicationSafetyFence.authority_generation,
      'publication authority generation',
    );
    const authorityCandidateSha = sha40(
      publicationSafetyFence.candidate_sha,
      'publication authority candidate sha',
    );
    const deploymentId = requiredString(
      publicationSafetyFence.deployment_id,
      'publication authority deployment id',
    );
    const publicationLeaseGeneration = positiveInteger(
      publicationSafetyFence.publication_lease_generation,
      'publication lease generation',
    );
    const publicationEventCursor = nonNegativeInteger(
      publicationSafetyFence.publication_event_cursor,
      'publication event cursor',
    );
    laneClaimSql +=
      " AND EXISTS (SELECT 1 FROM authority_state WHERE singleton_id=1 AND owner='cloudflare' " +
      "AND generation=? AND transition_state='stable' AND lower(candidate_sha)=? AND deployment_id=?) " +
      "AND EXISTS (SELECT 1 FROM publication_leases WHERE lease_name='publisher' AND generation=?) " +
      "AND (SELECT COALESCE(MAX(id),0) FROM publication_events)=? " +
      "AND NOT EXISTS (SELECT 1 FROM publication_state WHERE status IN ('prepared','publishing','needs_reconciliation')) " +
      "AND NOT EXISTS (SELECT 1 FROM publication_leases WHERE owner_token IS NOT NULL " +
      "AND expires_at_ms > CAST(strftime('%s','now') AS INTEGER) * 1000) " +
      "AND EXISTS (SELECT 1 FROM runtime_metadata WHERE key='state.snapshot_json' " +
      "AND json_extract(value, '$.inflight') IS NULL)";
    laneClaimArgs.push(
      authorityGeneration,
      authorityCandidateSha,
      deploymentId,
      publicationLeaseGeneration,
      publicationEventCursor,
    );
  }

  statements.push(stmt(d1, laneClaimSql, ...laneClaimArgs));

  statements.push(assertStmt(
    d1,
    'EXISTS (SELECT 1 FROM mutation_lane_state WHERE singleton_id=1 AND generation=? AND active_operation_id=?)',
    [claimedLane, controlPlan.operation_id],
    controlPlan.operation_id,
    recordedAt,
  ));

  statements.push(stmt(
    d1,
    "INSERT INTO mutation_operations (" +
      "operation_id,operation_kind,operation_digest,plan_digest,state,outcome,expected_halt_generation,lane_generation," +
      "expected_runtime_generation,expected_runtime_revision_digest,checkpoint_bookmark,checkpoint_verified_at," +
      "retry_plan_count,retry_read_count,retry_operation_count,max_plan_retries,max_read_retries,max_operation_retries," +
      "effect_state,created_at,updated_at) VALUES (?,?,?,?, 'EXECUTING',NULL,?,?,?,?,?, ?,0,0,0,?,?,?,'dispatched',?,?)",
    controlPlan.operation_id,
    controlPlan.operation_kind,
    controlPlan.operation_digest,
    controlPlan.plan_digest,
    controlPlan.expected_halt_generation,
    claimedLane,
    expectedRuntime,
    expectedRuntimeDigest,
    checkpointEvidence.checkpoint_bookmark,
    checkpointEvidence.checkpoint_verified_at,
    controlPlan.retry_budgets.plan,
    controlPlan.retry_budgets.read,
    controlPlan.retry_budgets.operation,
    recordedAt,
    recordedAt,
  ));

  for (const item of controlPlan.items) {
    statements.push(stmt(
      d1,
      'INSERT INTO mutation_operation_items (' +
        'operation_id,item_key,expected_content_revision,expected_assignment_version,' +
        'resulting_content_revision,resulting_assignment_version,readback_status) VALUES (?,?,?,?,?,?,\'pending\')',
      controlPlan.operation_id,
      item.item_key,
      item.expected_content_revision,
      item.expected_assignment_version,
      item.resulting_content_revision,
      item.resulting_assignment_version,
    ));
  }

  statements.push(stmt(
    d1,
    "INSERT INTO queue_intake_operations (" +
      "operation_id,plan_digest,batch_digest,item_count,expected_frontier_generation,expected_frontier_resolved_at," +
      "proposed_frontier_resolved_at,baseline_assignment_hash,expected_runtime_generation,expected_runtime_revision_digest," +
      "target_account,policy_version,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'claimed',?,?)",
    intakePlan.operation_id,
    intakePlan.plan_digest,
    intakePlan.batch_digest,
    intakePlan.count,
    intakePlan.expected_frontier_generation,
    intakePlan.expected_frontier_resolved_at,
    intakePlan.proposed_frontier_resolved_at,
    intakePlan.baseline_assignment_hash,
    intakePlan.expected_runtime_generation,
    intakePlan.expected_runtime_revision_digest,
    intakePlan.target_account,
    intakePlan.policy_version,
    recordedAt,
    recordedAt,
  ));

  for (const item of intakePlan.items) {
    statements.push(stmt(
      d1,
      'INSERT INTO queue_intake_items (' +
        'operation_id,ordinal,content_id,content_digest,pillar,title,source_ref,resolved_at,scheduled_date,scheduled_time,timezone,slot_label' +
        ') VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
      intakePlan.operation_id,
      item.ordinal,
      item.content_id,
      item.content_digest,
      item.pillar,
      item.title,
      item.source_ref,
      item.resolved_at,
      item.scheduled_date,
      item.scheduled_time,
      item.timezone,
      item.slot_label,
    ));
  }

  statements.push(stmt(
    d1,
    'UPDATE queue_intake_frontier SET generation=generation+1,resolved_at=?,pending_operation_id=?,updated_at=? ' +
      'WHERE singleton_id=1 AND generation=? AND resolved_at=? AND pending_operation_id IS NULL',
    intakePlan.proposed_frontier_resolved_at,
    intakePlan.operation_id,
    recordedAt,
    intakePlan.expected_frontier_generation,
    intakePlan.expected_frontier_resolved_at,
  ));

  statements.push(assertStmt(
    d1,
    'EXISTS (SELECT 1 FROM queue_intake_frontier WHERE singleton_id=1 AND generation=? AND resolved_at=? AND pending_operation_id=?)',
    [
      Number(intakePlan.expected_frontier_generation) + 1,
      intakePlan.proposed_frontier_resolved_at,
      intakePlan.operation_id,
    ],
    controlPlan.operation_id,
    recordedAt,
  ));

  for (const item of intakePlan.items) {
    const contentEventDetail = JSON.stringify({
      operationId: intakePlan.operation_id,
      batchDigest: intakePlan.batch_digest,
      contentDigest: item.content_digest,
    });
    const assignmentEventDetail = JSON.stringify({
      operationId: intakePlan.operation_id,
      batchDigest: intakePlan.batch_digest,
      contentDigest: item.content_digest,
      policyVersion: item.policy_version,
      resolvedAt: item.resolved_at,
    });

    statements.push(stmt(
      d1,
      "INSERT INTO queue_content (content_id,pillar,current_revision,status,generation,created_at,updated_at,intake_state) " +
        "VALUES (?,?,1,'active',1,?,?,'approved_unscheduled')",
      item.content_id,
      item.pillar,
      recordedAt,
      recordedAt,
    ));
    statements.push(stmt(
      d1,
      'INSERT INTO queue_content_revisions (content_id,revision,title,body,publication_text,content_digest,figure,source_ref,created_at) ' +
        'VALUES (?,1,?,?,?,?,NULL,?,?)',
      item.content_id,
      item.title,
      item.body,
      item.publication_text,
      item.content_digest,
      item.source_ref,
      recordedAt,
    ));
    statements.push(stmt(
      d1,
      "INSERT INTO queue_content_events (content_id,revision,event_type,event_at,detail) VALUES (?,1,'intake_accepted',?,?)",
      item.content_id,
      recordedAt,
      contentEventDetail,
    ));
    statements.push(stmt(
      d1,
      "INSERT INTO queue_assignments (" +
        "assignment_id,assignment_version,content_id,content_revision,content_digest,target_account,policy_version,resolved_at," +
        "scheduled_date,scheduled_time,timezone,slot_label,status,superseded_by_version,generation,created_at,updated_at,lifecycle_state" +
        ") VALUES (?,1,?,1,?,?,?,?,?,?,?,?,'active',NULL,1,?,?,'scheduled')",
      item.assignment_id,
      item.content_id,
      item.content_digest,
      item.target_account,
      item.policy_version,
      item.resolved_at,
      item.scheduled_date,
      item.scheduled_time,
      item.timezone,
      item.slot_label,
      recordedAt,
      recordedAt,
    ));
    statements.push(stmt(
      d1,
      "INSERT INTO queue_assignment_events (assignment_id,assignment_version,event_type,event_at,detail) " +
        "VALUES (?,1,'intake_assigned',?,?)",
      item.assignment_id,
      recordedAt,
      assignmentEventDetail,
    ));
    statements.push(stmt(
      d1,
      "UPDATE queue_content SET intake_state='scheduled',updated_at=? WHERE content_id=? AND current_revision=1",
      recordedAt,
      item.content_id,
    ));
  }

  statements.push(stmt(
    d1,
    'INSERT INTO queue_runtime_revisions (' +
      'generation,revision_digest,active_assignment_count,approved_unscheduled_count,media_required_count,media_ready_count,' +
      'previous_revision_digest,source_operation_id,created_at) ' +
      'SELECT ?,?,?,?,?,?,?,?,? WHERE ' +
      '(SELECT generation FROM queue_runtime_revisions ORDER BY generation DESC LIMIT 1)=? AND ' +
      '(SELECT revision_digest FROM queue_runtime_revisions ORDER BY generation DESC LIMIT 1)=? AND ' +
      'EXISTS (SELECT 1 FROM mutation_lane_state WHERE singleton_id=1 AND generation=? AND active_operation_id=?) AND ' +
      'EXISTS (SELECT 1 FROM queue_intake_frontier WHERE singleton_id=1 AND generation=? AND pending_operation_id=?)',
    runtimeRevision.generation,
    resultDigest,
    runtimeRevision.active_assignment_count,
    runtimeRevision.approved_unscheduled_count,
    runtimeRevision.media_required_count,
    runtimeRevision.media_ready_count,
    runtimeRevision.previous_revision_digest,
    runtimeRevision.source_operation_id,
    runtimeRevision.created_at,
    expectedRuntime,
    expectedRuntimeDigest,
    claimedLane,
    controlPlan.operation_id,
    Number(intakePlan.expected_frontier_generation) + 1,
    intakePlan.operation_id,
  ));

  statements.push(assertStmt(
    d1,
    'EXISTS (SELECT 1 FROM queue_runtime_revisions WHERE generation=? AND revision_digest=? AND source_operation_id=?)',
    [runtimeRevision.generation, resultDigest, controlPlan.operation_id],
    controlPlan.operation_id,
    recordedAt,
  ));

  statements.push(stmt(
    d1,
    'UPDATE queue_intake_operations SET resulting_runtime_generation=?,resulting_runtime_revision_digest=?,updated_at=? ' +
      'WHERE operation_id=? AND status=\'claimed\'',
    runtimeRevision.generation,
    resultDigest,
    recordedAt,
    intakePlan.operation_id,
  ));

  statements.push(stmt(
    d1,
    "UPDATE mutation_operations SET state='VERIFYING',effect_state='applied'," +
      'resulting_runtime_generation=?,resulting_runtime_revision_digest=?,updated_at=? ' +
      "WHERE operation_id=? AND state='EXECUTING' AND lane_generation=?",
    runtimeRevision.generation,
    resultDigest,
    recordedAt,
    controlPlan.operation_id,
    claimedLane,
  ));

  return Object.freeze({
    statements: Object.freeze(statements),
    claimed_lane_generation: claimedLane,
    runtime_generation: runtimeRevision.generation,
    runtime_revision_digest: resultDigest,
  });
}

export function prepareIntakeAtomicFinalize({
  db,
  controlPlan,
  intakePlan,
  runtimeRevision,
  completionEvidence,
  recordedAt,
}) {
  const d1 = ensureDb(db);
  validatePair(controlPlan, intakePlan);
  canonicalInstant(recordedAt, 'recordedAt');

  if (completionEvidence?.observed?.operation_id !== controlPlan.operation_id) {
    throw new Error('completion evidence operation mismatch');
  }
  const evidenceDigest = digest(completionEvidence?.evidence_digest, 'completion evidence digest');
  const claimedLane = positiveInteger(controlPlan.expected_lane_generation, 'expected lane generation') + 1;

  const statements = [];

  statements.push(assertStmt(
    d1,
    'EXISTS (SELECT 1 FROM queue_runtime_revisions WHERE generation=? AND revision_digest=? AND source_operation_id=?)',
    [runtimeRevision.generation, runtimeRevision.revision_digest, controlPlan.operation_id],
    controlPlan.operation_id,
    recordedAt,
  ));

  statements.push(assertStmt(
    d1,
    "EXISTS (SELECT 1 FROM queue_intake_operations WHERE operation_id=? AND plan_digest=? AND status='claimed' " +
      'AND resulting_runtime_generation=? AND resulting_runtime_revision_digest=?)',
    [
      intakePlan.operation_id,
      intakePlan.plan_digest,
      runtimeRevision.generation,
      runtimeRevision.revision_digest,
    ],
    controlPlan.operation_id,
    recordedAt,
  ));

  for (const expected of controlPlan.items) {
    const intakeItem = intakePlan.items.find((item) => item.content_id === expected.item_key);
    if (!intakeItem) throw new Error('intake item missing for mutation item ' + expected.item_key);

    statements.push(assertStmt(
      d1,
      "EXISTS (SELECT 1 FROM queue_content c " +
        'JOIN queue_content_revisions r ON r.content_id=c.content_id AND r.revision=c.current_revision ' +
        'JOIN queue_assignments a ON a.content_id=c.content_id AND a.assignment_id=? ' +
        "WHERE c.content_id=? AND c.current_revision=? AND c.intake_state='scheduled' " +
        'AND r.content_digest=? AND a.assignment_version=? AND a.content_revision=? AND a.content_digest=? ' +
        "AND a.target_account=? AND a.policy_version=? AND a.resolved_at=? AND a.status='active' " +
        "AND a.lifecycle_state='scheduled')",
      [
        intakeItem.assignment_id,
        intakeItem.content_id,
        expected.resulting_content_revision,
        intakeItem.content_digest,
        expected.resulting_assignment_version,
        expected.resulting_content_revision,
        intakeItem.content_digest,
        intakeItem.target_account,
        intakeItem.policy_version,
        intakeItem.resolved_at,
      ],
      controlPlan.operation_id,
      recordedAt,
    ));
  }

  for (const item of completionEvidence.observed.items) {
    const itemDigest = sha256Canonical(item);
    statements.push(stmt(
      d1,
      "UPDATE mutation_operation_items SET readback_status='applied',resulting_content_revision=?," +
        'resulting_assignment_version=?,readback_digest=? WHERE operation_id=? AND item_key=?',
      item.resulting_content_revision,
      item.resulting_assignment_version,
      itemDigest,
      controlPlan.operation_id,
      item.item_key,
    ));
  }

  statements.push(stmt(
    d1,
    "UPDATE mutation_operations SET state='COMPLETE',outcome='AUTO_RESOLVE',evidence_digest=?,completed_at=?,updated_at=? " +
      "WHERE operation_id=? AND state='VERIFYING' AND effect_state='applied' AND lane_generation=? " +
      'AND resulting_runtime_generation=? AND resulting_runtime_revision_digest=?',
    evidenceDigest,
    recordedAt,
    recordedAt,
    controlPlan.operation_id,
    claimedLane,
    runtimeRevision.generation,
    runtimeRevision.revision_digest,
  ));

  statements.push(assertStmt(
    d1,
    "EXISTS (SELECT 1 FROM mutation_operations WHERE operation_id=? AND state='COMPLETE' AND evidence_digest=?)",
    [controlPlan.operation_id, evidenceDigest],
    controlPlan.operation_id,
    recordedAt,
  ));

  statements.push(stmt(
    d1,
    "UPDATE queue_intake_operations SET status='complete',updated_at=? WHERE operation_id=? AND status='claimed'",
    recordedAt,
    intakePlan.operation_id,
  ));

  statements.push(stmt(
    d1,
    'UPDATE queue_intake_frontier SET pending_operation_id=NULL,last_completed_operation_id=?,updated_at=? ' +
      'WHERE singleton_id=1 AND generation=? AND resolved_at=? AND pending_operation_id=?',
    intakePlan.operation_id,
    recordedAt,
    Number(intakePlan.expected_frontier_generation) + 1,
    intakePlan.proposed_frontier_resolved_at,
    intakePlan.operation_id,
  ));

  statements.push(assertStmt(
    d1,
    'EXISTS (SELECT 1 FROM queue_intake_frontier WHERE singleton_id=1 AND generation=? AND resolved_at=? ' +
      'AND pending_operation_id IS NULL AND last_completed_operation_id=?)',
    [
      Number(intakePlan.expected_frontier_generation) + 1,
      intakePlan.proposed_frontier_resolved_at,
      intakePlan.operation_id,
    ],
    controlPlan.operation_id,
    recordedAt,
  ));

  statements.push(stmt(
    d1,
    "UPDATE mutation_lane_state SET active_operation_id=NULL,actor_class='automation',updated_at=? " +
      'WHERE singleton_id=1 AND generation=? AND active_operation_id=?',
    recordedAt,
    claimedLane,
    controlPlan.operation_id,
  ));

  statements.push(assertStmt(
    d1,
    'EXISTS (SELECT 1 FROM mutation_lane_state WHERE singleton_id=1 AND generation=? AND active_operation_id IS NULL)',
    [claimedLane],
    controlPlan.operation_id,
    recordedAt,
  ));

  return Object.freeze({ statements: Object.freeze(statements), evidence_digest: evidenceDigest });
}
