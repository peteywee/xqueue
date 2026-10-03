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
SELECT generation,resolved_at,pending_operation_id,last_completed_operation_id
FROM queue_intake_frontier
WHERE singleton_id=1
LIMIT 1
`;

const ACTIVE_ASSIGNMENTS_SQL = `
SELECT assignment_id,assignment_version,content_id,content_revision,content_digest,
target_account,policy_version,resolved_at,scheduled_date,scheduled_time,timezone,
slot_label,status,superseded_by_version,generation,created_at,updated_at
FROM queue_assignments
WHERE status='active'
ORDER BY target_account,resolved_at,content_id
`;

const CONTENT_INDEX_SQL = `
SELECT c.content_id,c.intake_state,r.content_digest
FROM queue_content c
JOIN queue_content_revisions r
  ON r.content_id=c.content_id
 AND r.revision=c.current_revision
`;

function rows(result) {
  return Array.isArray(result) ? result : (result?.results ?? []);
}

async function all(db, sql) {
  return rows(await db.prepare(sql).all());
}

async function first(db, sql) {
  return await db.prepare(sql).first();
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

function requiredMode(value) {
  const mode = value ?? 'batch';
  if (!['single', 'batch'].includes(mode)) {
    throw new Error('mode must be single or batch');
  }
  return mode;
}

function productionTransport(db, bookmark, createTransport) {
  const base = createTransport({ db });
  return Object.freeze({
    ...base,
    async captureCheckpoint() {
      return bookmark;
    },
  });
}

function json(value, init = {}) {
  const headers = new Headers(init.headers);
  headers.set('content-type', 'application/json; charset=utf-8');
  return new Response(JSON.stringify(value, null, 2), { ...init, headers });
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
    throw new Error('production D1 binding is unavailable');
  }
  if (payload?.environment !== 'production') {
    throw new Error('production intake requires environment=production');
  }

  const auth = requiredObject(payload?.auth, 'typed production auth evidence');
  const candidate = requiredObject(payload?.candidate, 'exact-main candidate evidence');
  const policy = requiredObject(payload?.policy, 'schedule policy');
  const input = payload?.input;
  if (input == null) throw new Error('intake input is required');
  const bookmark = requiredBookmark(payload?.bookmark);
  const mode = requiredMode(payload?.mode);
  const sourceMode = payload?.sourceMode === 'automated' ? 'automated' : 'owner-manual';
  const recordedAt = now().toISOString();

  const before = await verifyRuntime(env, {
    verifyMedia: false,
    includeSnapshot: true,
  });
  if (!before?.ok || !before.snapshot) {
    throw new Error('production runtime is not healthy before mutation');
  }

  const normalized = normalizeInput(input, {
    mode,
    sourceMode,
    ownerApprovalDigest: payload?.ownerApprovalDigest ?? null,
  });

  const [frontier, activeAssignments, contentIndex] = await Promise.all([
    first(db, FRONTIER_SQL),
    all(db, ACTIVE_ASSIGNMENTS_SQL),
    all(db, CONTENT_INDEX_SQL),
  ]);
  if (!frontier) throw new Error('production intake frontier is missing');

  const ids = new Set(normalized.items.map((item) => item.content_id));
  const digests = new Set(normalized.items.map((item) => item.content_digest));

  const intakePlan = plan({
    normalized,
    frontier,
    policy,
    existingContent: contentIndex.filter((row) => ids.has(row.content_id)),
    existingDigests: contentIndex.filter((row) => digests.has(row.content_digest)),
    baselineAssignmentHash: assignmentHash(activeAssignments),
    runtimeState: {
      generation: Number(before.generation),
      revision_digest: before.revisionDigest,
    },
  });

  const transport = productionTransport(db, bookmark, createTransport);
  const [haltState, laneState, runtimeState] = await Promise.all([
    transport.readHaltState(),
    transport.readLaneState(),
    transport.readRuntimeState(),
  ]);

  const controlPlan = createControlPlan({
    intakePlan,
    haltState,
    laneState,
    runtimeState,
  });

  const runtimeRevision = await projectRevision({
    intakePlan,
    controlPlan,
    currentRuntimeState: runtimeState,
    assignments: before.snapshot.assignments,
    deferred: before.snapshot.deferred,
    approvedUnscheduled: before.snapshot.approvedUnscheduled,
    media: before.snapshot.media,
    recordedAt,
  });

  const mutation = await runMutation({
    environment: 'production',
    auth,
    candidate,
    transport,
    intakePlan,
    controlPlan,
    runtimeRevision,
    recordedAt,
  });

  const planned = Object.freeze({
    operationId: controlPlan.operation_id,
    intakeOperationId: intakePlan.operation_id,
    itemCount: intakePlan.items.length,
    contentIds: Object.freeze(intakePlan.items.map((item) => item.content_id)),
    contentDigests: Object.freeze(intakePlan.items.map((item) => item.content_digest)),
  });

  if (!['applied', 'already_applied'].includes(mutation?.status)) {
    return Object.freeze({
      ok: false,
      publicationCapable: false,
      schedulerAuthority: false,
      planned,
      mutation,
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

  return Object.freeze({
    ok: true,
    publicationCapable: false,
    schedulerAuthority: false,
    recoveryCheckpointCaptured: true,
    planned,
    mutation,
    productionPreflight: mutation.production_preflight ?? null,
    before: Object.freeze({
      generation: before.generation,
      revisionDigest: before.revisionDigest,
    }),
    after: Object.freeze({
      generation: after.generation,
      revisionDigest: after.revisionDigest,
    }),
  });
}

export function createMutationProductionIntakeWorker(dependencies = {}) {
  return {
    async fetch(request, env) {
      const url = new URL(request.url);

      if (url.pathname === '/health') {
        return json({
          service: 'xqueue-mutation-production-intake',
          role: 'production-mutation-intake',
          environment: 'production',
          publicationCapable: false,
          schedulerAuthority: false,
          status: 'ok',
        });
      }

      if (url.pathname !== '/production-intake') {
        return json({ error: 'not_found' }, { status: 404 });
      }
      if (request.method !== 'POST') {
        return json({ error: 'method_not_allowed' }, { status: 405 });
      }

      try {
        const result = await runProductionIntakeRequest(
          env,
          await request.json(),
          dependencies,
        );
        return json({
          service: 'xqueue-mutation-production-intake',
          role: 'production-mutation-intake',
          environment: 'production',
          publicationCapable: false,
          schedulerAuthority: false,
          status: result.ok ? 'ok' : 'blocked',
          ...result,
        }, result.ok ? {} : { status: 409 });
      } catch (error) {
        return json({
          service: 'xqueue-mutation-production-intake',
          role: 'production-mutation-intake',
          environment: 'production',
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
