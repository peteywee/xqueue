import {
  hashAssignmentRows,
  normalizeIntakeInput,
  planIntake,
} from '../../src/continuous-queue-intake.mjs';
import { createIntakeMutationControlPlan } from '../../src/mutation-intake-adapter.mjs';
import { projectIntakeRuntimeRevision } from '../../src/mutation-intake-d1.mjs';
import { runIntakeMutation } from '../../src/mutation-intake-runner.mjs';
import { createD1MutationTransport } from '../../src/mutation-control-transport.mjs';
import { verifyPreviewIntakeEvidence } from '../../src/mutation-preview-evidence.mjs';
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

function requiredBookmark(value) {
  const bookmark = String(value ?? '');
  if (!/^[A-Za-z0-9_-]{8,}$/.test(bookmark)) {
    throw new Error('verified preview recovery bookmark is required');
  }
  return bookmark;
}

function requiredFixture(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('preview fixture is required');
  }
  return value;
}

function requiredPolicy(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('schedule policy is required');
  }
  return value;
}

async function readConflicts(db, item) {
  const result = await db.prepare(
    'SELECT c.content_id,r.content_digest ' +
      'FROM queue_content c ' +
      'JOIN queue_content_revisions r ON r.content_id=c.content_id AND r.revision=c.current_revision ' +
      'WHERE c.content_id=? OR r.content_digest=?',
  ).bind(item.content_id, item.content_digest).all();
  return rows(result);
}

function previewTransport(db, bookmark, createTransport) {
  const base = createTransport({ db });
  return Object.freeze({
    ...base,
    async captureCheckpoint() {
      return bookmark;
    },
  });
}

export async function runPreviewIntakeRehearsal(
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
    runMutation = runIntakeMutation,
    now = () => new Date(),
  } = {},
) {
  const db = env?.DB;
  if (!db || typeof db.prepare !== 'function') {
    throw new Error('preview D1 binding is unavailable');
  }

  const bookmark = requiredBookmark(payload?.bookmark);
  const policy = requiredPolicy(payload?.policy);
  const fixture = requiredFixture(payload?.fixture);
  const recordedAt = now().toISOString();

  const before = await verifyRuntime(env, {
    verifyMedia: false,
    includeSnapshot: true,
  });
  if (!before?.ok || !before.snapshot) {
    throw new Error('preview runtime is not healthy before mutation');
  }

  const normalized = normalizeInput(fixture, {
    mode: 'single',
    sourceMode: 'owner-manual',
  });
  const item = normalized.items[0];

  const [frontier, activeAssignments, conflicts] = await Promise.all([
    first(db, FRONTIER_SQL),
    all(db, BASELINE_ASSIGNMENTS_SQL),
    readConflicts(db, item),
  ]);

  if (!frontier) throw new Error('preview intake frontier is missing');
  if (conflicts.length > 0) {
    throw new Error('preview fixture conflicts with existing canonical content');
  }

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

  const transport = previewTransport(db, bookmark, createTransport);
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
    intakePlan,
    controlPlan,
    runtimeRevision,
    transport,
    recordedAt,
  });

  if (!['applied', 'already_applied'].includes(mutation?.status)) {
    return Object.freeze({
      ok: false,
      mutation,
      before: Object.freeze({
        generation: before.generation,
        revisionDigest: before.revisionDigest,
      }),
      planned: Object.freeze({
        operationId: controlPlan.operation_id,
        intakeOperationId: intakePlan.operation_id,
        contentId: item.content_id,
      }),
    });
  }

  const after = await verifyRuntime(env, {
    expectedGeneration: runtimeRevision.generation,
    expectedRevisionDigest: runtimeRevision.revision_digest,
    verifyMedia: false,
    includeSnapshot: false,
  });
  if (!after?.ok) {
    throw new Error('preview runtime is not healthy after mutation');
  }

  const created = await first(db, CREATED_ITEM_SQL, item.content_id);
  if (
    !created ||
    created.content_id !== item.content_id ||
    created.content_digest !== item.content_digest ||
    Number(created.content_revision) !== 1 ||
    created.assignment_id !== intakePlan.items[0].assignment_id ||
    Number(created.assignment_version) !== 1 ||
    created.status !== 'active' ||
    created.lifecycle_state !== 'scheduled' ||
    created.intake_state !== 'scheduled'
  ) {
    throw new Error('preview mutation canonical readback is incomplete');
  }

  const evidence = Object.freeze({
    ok: true,
    publicationCapable: false,
    schedulerAuthority: false,
    mutation: Object.freeze({
      status: mutation.status,
      phase: mutation.phase ?? null,
      recovered: mutation.recovered === true,
      operationId: mutation.operation_id,
      intakeOperationId: intakePlan.operation_id,
      contentId: item.content_id,
      evidence_digest: mutation.evidence_digest,
      observed: mutation.observed,
    }),
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
  if (mutation.operation_id !== controlPlan.operation_id) {
    throw new Error('preview mutation operation readback does not match its plan');
  }
  verifyPreviewIntakeEvidence(evidence);
  return evidence;
}

export function createMutationPreviewRehearsalWorker(dependencies = {}) {
  return {
    async fetch(request, env) {
      const url = new URL(request.url);

      if (url.pathname === '/health') {
        return json({
          service: 'xqueue-mutation-preview-rehearsal',
          status: 'ok',
          role: 'preview-mutation-proof',
          publicationCapable: false,
          schedulerAuthority: false,
        });
      }

      if (url.pathname !== '/mutation-intake-proof') {
        return json({ error: 'not_found' }, { status: 404 });
      }
      if (request.method !== 'POST') {
        return json({ error: 'method_not_allowed' }, { status: 405 });
      }

      try {
        const payload = await request.json();
        const result = await runPreviewIntakeRehearsal(
          env,
          payload,
          dependencies,
        );
        return json({
          service: 'xqueue-mutation-preview-rehearsal',
          role: 'preview-mutation-proof',
          publicationCapable: false,
          schedulerAuthority: false,
          status: result.ok ? 'ok' : 'blocked',
          ...result,
        }, result.ok ? {} : { status: 409 });
      } catch (error) {
        return json({
          service: 'xqueue-mutation-preview-rehearsal',
          role: 'preview-mutation-proof',
          publicationCapable: false,
          schedulerAuthority: false,
          status: 'error',
          error: error instanceof Error ? error.message : String(error),
        }, { status: 503 });
      }
    },
  };
}

export default createMutationPreviewRehearsalWorker();
