import { createHash } from 'node:crypto';

const SHA_RE = /^[a-f0-9]{64}$/;

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
function digest(value, label) {
  const v = String(value ?? '').toLowerCase();
  if (!SHA_RE.test(v)) throw new Error(label + ' must be sha256 hex');
  return v;
}
function instant(value, label) {
  const v = requiredString(value, label);
  const ms = Date.parse(v);
  if (!Number.isFinite(ms) || new Date(ms).toISOString() !== v) throw new Error(label + ' must be canonical ISO-8601 UTC with milliseconds');
  return v;
}
function canonical(value) {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  return '{' + Object.keys(value).sort().map((k) => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
}
function sha256(value) {
  return createHash('sha256').update(Buffer.from(canonical(value), 'utf8')).digest('hex');
}
function spec(name, sql, args = []) {
  return Object.freeze({ name, sql, args: Object.freeze([...args]) });
}

export function intakeItemReadbackDigest(item) {
  return sha256({
    content_id: item.content_id,
    content_revision: 1,
    content_digest: item.content_digest,
    assignment_id: item.assignment_id,
    assignment_version: 1,
    target_account: item.target_account,
    policy_version: item.policy_version,
    resolved_at: item.resolved_at,
    scheduled_date: item.scheduled_date,
    scheduled_time: item.scheduled_time,
    timezone: item.timezone,
    slot_label: item.slot_label ?? null,
  });
}

export function atomicIntakeEvidenceDigest({ intakePlan, controlPlan, checkpoint, runtimeRevision }) {
  return sha256({
    operation_id: controlPlan.operation_id,
    plan_digest: controlPlan.plan_digest,
    intake_operation_id: intakePlan.operation_id,
    intake_plan_digest: intakePlan.plan_digest,
    checkpoint_bookmark: checkpoint.checkpoint_bookmark,
    checkpoint_verified_at: checkpoint.checkpoint_verified_at,
    claimed_lane_generation: Number(controlPlan.expected_lane_generation) + 1,
    runtime_generation: runtimeRevision.generation,
    runtime_revision_digest: runtimeRevision.revision_digest,
    items: intakePlan.items.map((item) => ({ item_key: item.content_id, readback_digest: intakeItemReadbackDigest(item) })),
  });
}

export function buildAtomicIntakeStatementSpecs({
  intakePlan,
  controlPlan,
  checkpoint,
  runtimeRevision,
  recordedAt,
}) {
  if (!intakePlan || !controlPlan || !checkpoint || !runtimeRevision) throw new Error('atomic intake inputs are required');
  if (controlPlan.operation_kind !== 'intake') throw new Error('control plan must be intake');
  if (controlPlan.plan_context?.intake_operation_id !== intakePlan.operation_id) throw new Error('control/intake operation mismatch');
  if (controlPlan.plan_context?.intake_plan_digest !== intakePlan.plan_digest) throw new Error('control/intake plan digest mismatch');
  if (checkpoint.operation_id !== controlPlan.operation_id) throw new Error('checkpoint operation mismatch');
  const at = instant(recordedAt, 'recordedAt');
  const evidence = atomicIntakeEvidenceDigest({ intakePlan, controlPlan, checkpoint, runtimeRevision });
  const expectedLane = positiveInteger(controlPlan.expected_lane_generation, 'expected lane generation');
  const claimedLane = expectedLane + 1;
  if (positiveInteger(checkpoint.expected_lane_generation, 'checkpoint expected lane generation') !== expectedLane) throw new Error('checkpoint lane generation mismatch');
  const bookmark = requiredString(checkpoint.checkpoint_bookmark, 'checkpoint bookmark');
  const checkpointAt = instant(checkpoint.checkpoint_verified_at, 'checkpoint verified at');
  const runtimeGeneration = positiveInteger(runtimeRevision.generation, 'runtime generation');
  if (runtimeGeneration !== positiveInteger(controlPlan.expected_runtime_generation, 'expected runtime generation') + 1) throw new Error('runtime generation is not the planned successor');
  const runtimeDigest = digest(runtimeRevision.revision_digest, 'runtime revision digest');
  const previousDigest = digest(runtimeRevision.previous_revision_digest, 'runtime previous digest');
  if (previousDigest !== controlPlan.expected_runtime_revision_digest) throw new Error('runtime predecessor digest mismatch');
  if (runtimeRevision.source_operation_id !== intakePlan.operation_id) throw new Error('runtime source must be intake operation id');
  if (!Array.isArray(intakePlan.items) || intakePlan.items.length !== controlPlan.items.length || intakePlan.items.length === 0) throw new Error('intake/control item count mismatch');

  const out = [];
  out.push(spec('create-control-operation',
    `INSERT INTO mutation_operations (` +
    `operation_id,operation_kind,operation_digest,plan_digest,state,outcome,expected_halt_generation,` +
    `expected_runtime_generation,expected_runtime_revision_digest,max_plan_retries,max_read_retries,max_operation_retries,` +
    `effect_state,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [controlPlan.operation_id,'intake',controlPlan.operation_digest,controlPlan.plan_digest,'PLANNED',null,
      controlPlan.expected_halt_generation,controlPlan.expected_runtime_generation,controlPlan.expected_runtime_revision_digest,
      nonNegativeInteger(controlPlan.retry_budgets.plan,'plan retry budget'),nonNegativeInteger(controlPlan.retry_budgets.read,'read retry budget'),
      nonNegativeInteger(controlPlan.retry_budgets.operation,'operation retry budget'),'none',at,at]));

  for (const item of controlPlan.items) {
    out.push(spec(`create-control-item:${item.item_key}`,
      `INSERT INTO mutation_operation_items (` +
      `operation_id,item_key,expected_content_revision,expected_assignment_version,resulting_content_revision,resulting_assignment_version,readback_status)` +
      ` VALUES (?,?,?,?,?,?,?)`,
      [controlPlan.operation_id,item.item_key,item.expected_content_revision,item.expected_assignment_version,
        item.resulting_content_revision,item.resulting_assignment_version,'pending']));
  }

  out.push(spec('create-intake-operation',
    `INSERT INTO queue_intake_operations (` +
    `operation_id,plan_digest,batch_digest,item_count,expected_frontier_generation,expected_frontier_resolved_at,` +
    `proposed_frontier_resolved_at,baseline_assignment_hash,expected_runtime_generation,expected_runtime_revision_digest,` +
    `target_account,policy_version,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [intakePlan.operation_id,intakePlan.plan_digest,intakePlan.batch_digest,intakePlan.count,intakePlan.expected_frontier_generation,
      intakePlan.expected_frontier_resolved_at,intakePlan.proposed_frontier_resolved_at,intakePlan.baseline_assignment_hash,
      intakePlan.expected_runtime_generation,intakePlan.expected_runtime_revision_digest,intakePlan.target_account,intakePlan.policy_version,
      'planned',at,at]));

  for (const item of intakePlan.items) {
    out.push(spec(`create-intake-item:${item.content_id}`,
      `INSERT INTO queue_intake_items (` +
      `operation_id,ordinal,content_id,content_digest,pillar,title,source_ref,resolved_at,scheduled_date,scheduled_time,timezone,slot_label)` +
      ` VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [intakePlan.operation_id,item.ordinal,item.content_id,item.content_digest,item.pillar,item.title,item.source_ref,
        item.resolved_at,item.scheduled_date,item.scheduled_time,item.timezone,item.slot_label]));
  }

  out.push(spec('claim-mutation-lane',
    `UPDATE mutation_lane_state SET generation=generation+1,active_operation_id=?,actor_class='automation',updated_at=? ` +
    `WHERE singleton_id=1 AND generation=? AND active_operation_id IS NULL ` +
    `AND EXISTS (SELECT 1 FROM mutation_lane_halt_state WHERE singleton_id=1 AND halted=0 AND generation=?) ` +
    `AND EXISTS (SELECT 1 FROM queue_runtime_revisions WHERE generation=? AND revision_digest=? ` +
    `AND generation=(SELECT MAX(generation) FROM queue_runtime_revisions))`,
    [controlPlan.operation_id,at,expectedLane,controlPlan.expected_halt_generation,controlPlan.expected_runtime_generation,controlPlan.expected_runtime_revision_digest]));

  out.push(spec('bind-checkpoint-and-dispatch',
    `UPDATE mutation_operations SET lane_generation=?,checkpoint_bookmark=?,checkpoint_verified_at=?,state=` +
    `CASE WHEN EXISTS (SELECT 1 FROM mutation_lane_state WHERE singleton_id=1 AND generation=? AND active_operation_id=?) ` +
    `THEN 'EXECUTING' ELSE NULL END,effect_state='dispatched',updated_at=? WHERE operation_id=?`,
    [claimedLane,bookmark,checkpointAt,claimedLane,controlPlan.operation_id,at,controlPlan.operation_id]));

  out.push(spec('claim-intake-frontier',
    `UPDATE queue_intake_frontier SET generation=generation+1,resolved_at=?,pending_operation_id=?,updated_at=? ` +
    `WHERE singleton_id=1 AND generation=? AND resolved_at=? AND pending_operation_id IS NULL`,
    [intakePlan.proposed_frontier_resolved_at,intakePlan.operation_id,at,intakePlan.expected_frontier_generation,intakePlan.expected_frontier_resolved_at]));
  out.push(spec('mark-intake-claimed',
    `UPDATE queue_intake_operations SET status=CASE WHEN EXISTS (` +
    `SELECT 1 FROM queue_intake_frontier WHERE singleton_id=1 AND generation=? AND resolved_at=? AND pending_operation_id=?` +
    `) THEN 'claimed' ELSE NULL END,updated_at=? WHERE operation_id=?`,
    [intakePlan.expected_frontier_generation+1,intakePlan.proposed_frontier_resolved_at,intakePlan.operation_id,at,intakePlan.operation_id]));

  for (const item of intakePlan.items) {
    const contentDetail = JSON.stringify({operationId:intakePlan.operation_id,batchDigest:intakePlan.batch_digest,contentDigest:item.content_digest});
    const assignmentDetail = JSON.stringify({operationId:intakePlan.operation_id,batchDigest:intakePlan.batch_digest,contentDigest:item.content_digest,policyVersion:item.policy_version,resolvedAt:item.resolved_at});
    out.push(spec(`insert-content:${item.content_id}`,
      `INSERT INTO queue_content (content_id,pillar,current_revision,status,generation,created_at,updated_at,intake_state) VALUES (?,?,?,?,?,?,?,?)`,
      [item.content_id,item.pillar,1,'active',1,at,at,'approved_unscheduled']));
    out.push(spec(`insert-revision:${item.content_id}`,
      `INSERT INTO queue_content_revisions (content_id,revision,title,body,publication_text,content_digest,figure,source_ref,created_at) VALUES (?,?,?,?,?,?,?,?,?)`,
      [item.content_id,1,item.title,item.body,item.publication_text,item.content_digest,null,item.source_ref,at]));
    out.push(spec(`content-event:${item.content_id}`,
      `INSERT INTO queue_content_events (content_id,revision,event_type,event_at,detail) VALUES (?,?,?,?,?)`,
      [item.content_id,1,'intake_accepted',at,contentDetail]));
    out.push(spec(`insert-assignment:${item.content_id}`,
      `INSERT INTO queue_assignments (` +
      `assignment_id,assignment_version,content_id,content_revision,content_digest,target_account,policy_version,resolved_at,` +
      `scheduled_date,scheduled_time,timezone,slot_label,status,superseded_by_version,generation,created_at,updated_at)` +
      ` VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [item.assignment_id,1,item.content_id,1,item.content_digest,item.target_account,item.policy_version,item.resolved_at,
        item.scheduled_date,item.scheduled_time,item.timezone,item.slot_label,'active',null,1,at,at]));
    out.push(spec(`assignment-event:${item.content_id}`,
      `INSERT INTO queue_assignment_events (assignment_id,assignment_version,event_type,event_at,detail) VALUES (?,?,?,?,?)`,
      [item.assignment_id,1,'intake_assigned',at,assignmentDetail]));
    out.push(spec(`mark-content-scheduled:${item.content_id}`,
      `UPDATE queue_content SET intake_state='scheduled',updated_at=? WHERE content_id=?`,[at,item.content_id]));
  }

  out.push(spec('insert-runtime-revision',
    `INSERT INTO queue_runtime_revisions (` +
    `generation,revision_digest,active_assignment_count,approved_unscheduled_count,media_required_count,media_ready_count,` +
    `previous_revision_digest,source_operation_id,created_at)` +
    ` SELECT ?,?,?,?,?,?,?,?,? WHERE EXISTS (` +
    `SELECT 1 FROM queue_runtime_revisions WHERE generation=? AND revision_digest=? AND generation=(SELECT MAX(generation) FROM queue_runtime_revisions)` +
    `) AND EXISTS (SELECT 1 FROM queue_intake_frontier WHERE singleton_id=1 AND generation=? AND pending_operation_id=?)`,
    [runtimeGeneration,runtimeDigest,runtimeRevision.active_assignment_count,runtimeRevision.approved_unscheduled_count,
      runtimeRevision.media_required_count,runtimeRevision.media_ready_count,previousDigest,intakePlan.operation_id,at,
      controlPlan.expected_runtime_generation,controlPlan.expected_runtime_revision_digest,intakePlan.expected_frontier_generation+1,intakePlan.operation_id]));

  for (const item of intakePlan.items) {
    const readbackDigest = intakeItemReadbackDigest(item);
    out.push(spec(`prove-item:${item.content_id}`,
      `UPDATE mutation_operation_items SET readback_status=CASE WHEN EXISTS (` +
      `SELECT 1 FROM queue_content c JOIN queue_content_revisions r ON r.content_id=c.content_id AND r.revision=1 ` +
      `JOIN queue_assignments a ON a.content_id=c.content_id AND a.content_revision=1 ` +
      `WHERE c.content_id=? AND c.pillar=? AND c.current_revision=1 AND c.status='active' AND c.intake_state='scheduled' ` +
      `AND r.title=? AND r.body=? AND r.publication_text=? AND r.content_digest=? AND r.figure IS NULL AND r.source_ref IS ? ` +
      `AND a.assignment_id=? AND a.assignment_version=1 AND a.content_digest=? AND a.target_account=? AND a.policy_version=? ` +
      `AND a.resolved_at=? AND a.scheduled_date=? AND a.scheduled_time=? AND a.timezone=? AND a.slot_label IS ? ` +
      `AND a.status='active' AND a.superseded_by_version IS NULL` +
      `) THEN 'applied' ELSE 'conflict' END,readback_digest=CASE WHEN EXISTS (` +
      `SELECT 1 FROM queue_content_revisions r JOIN queue_assignments a ON a.content_id=r.content_id AND a.content_revision=r.revision ` +
      `WHERE r.content_id=? AND r.revision=1 AND r.content_digest=? AND a.assignment_id=? AND a.assignment_version=1 AND a.resolved_at=? AND a.status='active'` +
      `) THEN ? ELSE NULL END WHERE operation_id=? AND item_key=?`,
      [item.content_id,item.pillar,item.title,item.body,item.publication_text,item.content_digest,item.source_ref,
        item.assignment_id,item.content_digest,item.target_account,item.policy_version,item.resolved_at,item.scheduled_date,item.scheduled_time,
        item.timezone,item.slot_label,item.content_id,item.content_digest,item.assignment_id,item.resolved_at,readbackDigest,controlPlan.operation_id,item.content_id]));
  }

  out.push(spec('complete-control-operation',
    `UPDATE mutation_operations SET state='COMPLETE',outcome='AUTO_RESOLVE',effect_state='applied',` +
    `resulting_runtime_generation=(SELECT generation FROM queue_runtime_revisions WHERE source_operation_id=?),` +
    `resulting_runtime_revision_digest=(SELECT revision_digest FROM queue_runtime_revisions WHERE source_operation_id=?),` +
    `evidence_digest=?,completed_at=?,updated_at=? WHERE operation_id=?`,
    [intakePlan.operation_id,intakePlan.operation_id,evidence,at,at,controlPlan.operation_id]));
  out.push(spec('complete-intake-operation',
    `UPDATE queue_intake_operations SET status='complete',resulting_runtime_generation=?,resulting_runtime_revision_digest=?,updated_at=? WHERE operation_id=?`,
    [runtimeGeneration,runtimeDigest,at,intakePlan.operation_id]));
  out.push(spec('release-frontier',
    `UPDATE queue_intake_frontier SET pending_operation_id=NULL,last_completed_operation_id=?,updated_at=? ` +
    `WHERE singleton_id=1 AND generation=? AND resolved_at=? AND pending_operation_id=?`,
    [intakePlan.operation_id,at,intakePlan.expected_frontier_generation+1,intakePlan.proposed_frontier_resolved_at,intakePlan.operation_id]));
  out.push(spec('release-mutation-lane',
    `UPDATE mutation_lane_state SET active_operation_id=NULL,actor_class='automation',updated_at=? ` +
    `WHERE singleton_id=1 AND generation=? AND active_operation_id=? AND EXISTS (` +
    `SELECT 1 FROM mutation_operations WHERE operation_id=? AND state='COMPLETE' AND effect_state='applied'` +
    `)`,[at,claimedLane,controlPlan.operation_id,controlPlan.operation_id]));
  out.push(spec('final-release-guard',
    `UPDATE mutation_operations SET updated_at=CASE WHEN ` +
    `EXISTS (SELECT 1 FROM mutation_lane_state WHERE singleton_id=1 AND generation=? AND active_operation_id IS NULL) AND ` +
    `EXISTS (SELECT 1 FROM queue_intake_frontier WHERE singleton_id=1 AND generation=? AND pending_operation_id IS NULL AND last_completed_operation_id=?) ` +
    `THEN ? ELSE NULL END WHERE operation_id=?`,
    [claimedLane,intakePlan.expected_frontier_generation+1,intakePlan.operation_id,at,controlPlan.operation_id]));
  return Object.freeze(out);
}

export function prepareAtomicIntakeBatch(db, inputs) {
  if (!db || typeof db.prepare !== 'function') throw new Error('D1 database binding is required');
  return buildAtomicIntakeStatementSpecs(inputs).map((entry) => {
    const prepared = db.prepare(entry.sql);
    return entry.args.length ? prepared.bind(...entry.args) : prepared;
  });
}

export async function readAtomicIntakeCompletion(transport, controlPlan) {
  if (!transport || typeof transport.readOperation !== 'function' || typeof transport.readOperationItems !== 'function') {
    throw new Error('mutation transport readback surface is required');
  }
  const operation = await transport.readOperation(controlPlan.operation_id);
  if (!operation) return Object.freeze({ observed: null, operation: null, items: Object.freeze([]) });
  const items = await transport.readOperationItems(controlPlan.operation_id);
  const observed = Object.freeze({
    operation_id: operation.operation_id,
    runtime_generation: operation.resulting_runtime_generation,
    runtime_revision_digest: operation.resulting_runtime_revision_digest,
    items: Object.freeze((items ?? []).map((item) => Object.freeze({
      item_key: item.item_key,
      readback_status: item.readback_status,
      resulting_content_revision: item.resulting_content_revision,
      resulting_assignment_version: item.resulting_assignment_version,
    }))),
  });
  return Object.freeze({ observed, operation, items: Object.freeze(items ?? []) });
}

export async function executeAtomicIntakeMutation({
  transport,
  db,
  inputs,
  verifyCompletion,
}) {
  if (!transport || typeof transport.batch !== 'function') throw new Error('mutation transport is required');
  if (typeof verifyCompletion !== 'function') throw new Error('verifyCompletion is required');

  const before = await readAtomicIntakeCompletion(transport, inputs.controlPlan);
  if (before.operation) {
    const verified = before.observed ? verifyCompletion(before.observed) : { ok: false };
    return Object.freeze(verified?.ok
      ? { status: 'already_applied', observed: before.observed }
      : { status: 'requires_reconciliation', observed: before.observed, error: null });
  }

  const statements = prepareAtomicIntakeBatch(db, inputs);
  let batchError = null;
  try {
    await transport.batch(statements);
  } catch (error) {
    batchError = error;
  }

  const after = await readAtomicIntakeCompletion(transport, inputs.controlPlan);
  const verified = after.observed ? verifyCompletion(after.observed) : { ok: false };
  if (verified?.ok) {
    return Object.freeze({
      status: batchError ? 'applied_after_ambiguous_response' : 'applied',
      observed: after.observed,
    });
  }
  return Object.freeze({
    status: 'requires_reconciliation',
    observed: after.observed,
    error: batchError,
  });
}
