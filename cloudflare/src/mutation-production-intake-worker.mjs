import {
  hashAssignmentRows,
  normalizeIntakeInput,
  planIntake,
} from '../../src/continuous-queue-intake.mjs';
import { createIntakeMutationControlPlan } from '../../src/mutation-intake-adapter.mjs';
import { projectIntakeRuntimeRevision } from '../../src/mutation-intake-d1.mjs';
import { createD1MutationTransport } from '../../src/mutation-control-transport.mjs';
import { runProductionIntakeMutation } from '../../src/mutation-production-preflight.mjs';
import { verifyDynamicRuntime } from './dynamic-runtime-integrity.mjs';

const FRONTIER_SQL = `
SELECT
  generation,
  resolved_at,
  pending_operation_id,
  last_completed_operation_id
FROM queue_intake_frontier
WHERE singleton_id = 1
LIMIT 1
`;

const BASELINE_ASSIGNMENTS_SQL = `
SELECT
  assignment_id,
  assignment_version,
  content_id,
  content_revision,
  content_digest,
  target_account,
  policy_version,
  resolved_at,
  scheduled_date,
  scheduled_time,
  timezone,
  slot_label,
  status,
  superseded_by_version,
  generation,
  created_at,
  updated_at
FROM queue_assignments
WHERE status = 'active'
ORDER BY target_account,resolved_at,content_id
`;

const CREATED_ITEM_SQL = `
SELECT
  c.content_id,
  c.current_revision AS content_revision,
  c.intake_state,
  r.content_digest,
  a.assignment_id,
  a.assignment_version,
  a.resolved_at,
  a.status,
  a.lifecycle_state
FROM queue_content c
JOIN queue_content_revisions r
  ON r.content_id = c.content_id
 AND r.revision = c.current_revision
JOIN queue_assignments a
  ON a.content_id = c.content_id
 AND a.status = 'active'
WHERE c.content_id = ?
ORDER BY a.assignment_version DESC
LIMIT 1
`;

function json(value, init = {}) {
  const headers = new Headers(init.headers);
  headers.set('content-type', 'application/json; charset=utf-8');
  return new Response(JSON.stringify(value, null, 2), { ...init, headers });
}

function rows(result) {
  return Array.isArray(result) ? result : (result?.results ?? []);
}

async function all(db, sql) {
  return rows(await db.prepare(sql).all());
}

async function first(db, sql, ...args) {
  const statement = args.length ? db.prepare(sql).bind(...args) : db.prepare(sql);
  return await statement.first();
}

function requiredObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(label + ' is required');
  }
  return value;
}

function requiredBookmark(value) {
  const bookmark = String(value ?? '');
  if (!/^[A-Za-z0-9_-]{8,}$/.test(bookmark)) {
    throw new Error('verified production recovery bookmark is required');
  }
  return bookmark;
}

function checkpointTransport(db, bookmark, createTransport) {
  const base = createTransport({ db });
  return Object.freeze({
    ...base,
    async captureCheckpoint() {
      return bookmark;
    },
  });
}

async function readConflicts(db, items) {
  const conflicts = [];
  for (const item of items) {
    const result = await db.prepare(
      'SELECT c.content_id,r.content_digest ' +
        'FROM queue_content c ' +
        'JOIN queue_content_revisions r ON r.content_id=c.content_id AND r.revision=c.current_revision ' +
        'WHERE c.content_id=? OR r.content_digest=?',
    ).bind(item.content_id, item.content_digest).all();
    conflicts.push(...rows(result));
  }
  return conflicts;
}

function exactCanonicalItem(created, planned) {
  return Boolean(
    created &&
    created.content_id === planned.content_id &&
    Number(created.content_revision) === 1 &&
    created.content_digest === planned.content_digest &&
    created.assignment_id === planned.assignment_id &&
    Number(created.assignment_version) === 1 &&
    created.status === 'active' &&
    created.lifecycle_state === 'scheduled' &&
    created.intake_state === 'scheduled'
  );
}

export async function runProductionIntakeRequest(
  env,
  payload,
  {
    verifyRuntime = verifyDynamicRuntime,
    normalizeInput = normalizeIntakeInput,
    plan = planIntake,
    assignmentHash = hashAssignmentRows,
    createControlPlan = createIntakeMutationControlPlan,
    projectRevision = projectIntakeRuntimeRevision,
    createTransport = createD1MutationTransport,
    runMutation = runProductionIntakeMutation,
    now = () => new Date(),
  } = {},
) {
  const db = env?.DB;
  if (!db || typeof db.prepare !== 'function') {
    throw new Error('production mutation D1 binding is unavailable');
  }

  const environment = payload?.environment;
  const auth = requiredObject(payload?.auth, 'typed production auth evidence');
  const candidate = requiredObject(payload?.candidate, 'exact candidate evidence');
  const policy = requiredObject(payload?.policy, 'schedule policy');
  const input = requiredObject(payload?.input, 'intake input');
  const bookmark = requiredBookmark(payload?.bookmark);
  const mode = payload?.mode ?? 'single';
  if (mode !== 'single') {
    throw new Error('initial production intake activation is limited to mode=single');
  }

  const recordedAt = now().toISOString();
  const before = await verifyRuntime(env, {
    verifyMedia: false,
    includeSnapshot: true,
  });
  if (!before?.ok || !before.snapshot) {
    throw new Error('production runtime is not healthy before mutation');
  }

  const normalized = normalizeInput(input, {
    mode: 'single',
    sourceMode: payload?.sourceMode ?? 'owner-manual',
    ownerApprovalDigest: payload?.ownerApprovalDigest ?? null,
  });
  if (!Array.isArray(normalized?.items) || normalized.items.length !== 1) {
    throw new Error('initial production intake activation requires exactly one normalized item');
  }

  const [frontier, activeAssignments, conflicts] = await Promise.all([
    first(db, FRONTIER_SQL),
    all(db, BASELINE_ASSIGNMENTS_SQL),
    readConflicts(db, normalized.items),
  ]);
  if (!frontier) throw new Error('production intake frontier is missing');

  const runtimeState = Object.freeze({
    generation: Number(before.generation),
    revision_digest: before.revisionDigest,
  });

  const intakePlan = plan({
    normalized,
    frontier,
    policy,
    existingContent: conflicts,
    existingDigests: conflicts,
    baselineAssignmentHash: assignmentHash(activeAssignments),
    runtimeState,
  });

  const transport = checkpointTransport(db, bookmark, createTransport);
  const [haltState, laneState, observedRuntimeState] = await Promise.all([
    transport.readHaltState(),
    transport.readLaneState(),
    transport.readRuntimeState(),
  ]);

  const controlPlan = createControlPlan({
    intakePlan,
    haltState,
    laneState,
    runtimeState: observedRuntimeState,
  });

  const item = intakePlan.items[0];
  const planned = Object.freeze({
    operationId: controlPlan.operation_id,
    intakeOperationId: intakePlan.operation_id,
    contentId: item.content_id,
    contentDigest: item.content_digest,
    assignmentId: item.assignment_id,
  });

  const runtimeRevision = await projectRevision({
    intakePlan,
    controlPlan,
    currentRuntimeState: observedRuntimeState,
    assignments: before.snapshot.assignments,
    deferred: before.snapshot.deferred,
    approvedUnscheduled: before.snapshot.approvedUnscheduled,
    media: before.snapshot.media,
    recordedAt,
  });

  const mutation = await runMutation({
    environment,
    auth,
    candidate,
    intakePlan,
    controlPlan,
    runtimeRevision,
    transport,
    recordedAt,
  });

  if (!['applied', 'already_applied'].includes(mutation?.status)) {
    return Object.freeze({
      ok: false,
      publicationCapable: false,
      schedulerAuthority: false,
      planned,
      mutation,
      before: Object.freeze({
        generation: before.generation,
        revisionDigest: before.revisionDigest,
      }),
    });
  }

  if (mutation.operation_id !== controlPlan.operation_id) {
    throw new Error('production mutation operation readback does not match its plan');
  }

  const after = await verifyRuntime(env, {
    expectedGeneration: runtimeRevision.generation,
    expectedRevisionDigest: runtimeRevision.revision_digest,
    verifyMedia: false,
    includeSnapshot: false,
  });
  if (!after?.ok) {
    throw new Error('production runtime is not healthy after mutation');
  }

  const created = await first(db, CREATED_ITEM_SQL, item.content_id);
  if (!exactCanonicalItem(created, item)) {
    throw new Error('production mutation canonical readback is incomplete');
  }

  return Object.freeze({
    ok: true,
    publicationCapable: false,
    schedulerAuthority: false,
    planned,
    mutation: Object.freeze({
      status: mutation.status,
      phase: mutation.phase ?? null,
      recovered: mutation.recovered === true,
      operationId: mutation.operation_id,
      intakeOperationId: intakePlan.operation_id,
      contentId: item.content_id,
      evidence_digest: mutation.evidence_digest ?? null,
      observed: mutation.observed ?? null,
    }),
    productionPreflight: mutation.production_preflight ?? null,
    before: Object.freeze({
      generation: before.generation,
      revisionDigest: before.revisionDigest,
    }),
    after: Object.freeze({
      generation: after.generation,
      revisionDigest: after.revisionDigest,
    }),
    canonicalReadback: Object.freeze({
      contentId: created.content_id,
      contentRevision: Number(created.content_revision),
      contentDigest: created.content_digest,
      assignmentId: created.assignment_id,
      assignmentVersion: Number(created.assignment_version),
      resolvedAt: created.resolved_at,
      intakeState: created.intake_state,
      lifecycleState: created.lifecycle_state,
    }),
    recoveryCheckpointCaptured: true,
  });
}

export function createMutationProductionIntakeWorker(dependencies = {}) {
  return {
    async fetch(request, env) {
      const url = new URL(request.url);

      if (url.pathname === '/health') {
        return json({
          service: 'xqueue-mutation-production-intake',
          role: 'production-intake-mutation',
          status: 'ok',
          activation: env?.XQUEUE_MUTATION_ACTIVATION === 'enabled' ? 'enabled' : 'disabled',
          publicationCapable: false,
          schedulerAuthority: false,
        });
      }

      if (url.pathname !== '/mutation-intake') {
        return json({ error: 'not_found' }, { status: 404 });
      }
      if (request.method !== 'POST') {
        return json({ error: 'method_not_allowed' }, { status: 405 });
      }
      if (env?.XQUEUE_MUTATION_ACTIVATION !== 'enabled') {
        return json({
          service: 'xqueue-mutation-production-intake',
          role: 'production-intake-mutation',
          status: 'blocked',
          reason: 'production mutation activation is disabled',
          publicationCapable: false,
          schedulerAuthority: false,
        }, { status: 503 });
      }

      try {
        const payload = await request.json();
        const result = await runProductionIntakeRequest(env, payload, dependencies);
        return json({
          service: 'xqueue-mutation-production-intake',
          role: 'production-intake-mutation',
          publicationCapable: false,
          schedulerAuthority: false,
          status: result.ok ? 'ok' : 'blocked',
          evidence: result,
        }, result.ok ? {} : { status: 409 });
      } catch (error) {
        return json({
          service: 'xqueue-mutation-production-intake',
          role: 'production-intake-mutation',
          publicationCapable: false,
          schedulerAuthority: false,
          status: 'error',
          error: error instanceof Error ? error.message : String(error),
        }, { status: 503 });
      }
    },
  };
}

export default createMutationProductionIntakeWorker();
