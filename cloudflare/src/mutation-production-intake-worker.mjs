import schedulePolicy from '../../config/schedule-policy.json' with { type: 'json' };

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

const COMMITTED_RUNTIME_SQL = `
SELECT generation,revision_digest,previous_revision_digest,source_operation_id,created_at
FROM queue_runtime_revisions
WHERE source_operation_id=?
LIMIT 1
`;

const BOOKMARK_RE = /^[A-Za-z0-9_-]{8,}$/;
const SHA40_RE = /^[a-f0-9]{40}$/;
const SHA256_RE = /^[a-f0-9]{64}$/;
const NONCE_RE = /^[A-Za-z0-9_-]{16,128}$/;
const MAX_CHECKPOINT_AGE_MS = 5 * 60 * 1000;
const MAX_CHECKPOINT_FUTURE_MS = 30 * 1000;

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

function requiredSecret(value, label) {
  const text = String(value ?? '');
  if (text.length < 32 || /\s/.test(text)) {
    throw new Error(label + ' must be a whitespace-free secret of at least 32 characters');
  }
  return text;
}

function requiredMode(value) {
  const mode = value ?? 'batch';
  if (!['single', 'batch'].includes(mode)) {
    throw new Error('mode must be single or batch');
  }
  return mode;
}

function requiredSourceMode(value) {
  if (value === undefined || value === null) return 'owner-manual';
  if (!['owner-manual', 'automated'].includes(value)) {
    throw new Error('sourceMode must be owner-manual or automated');
  }
  return value;
}

function canonicalInstant(value, label) {
  const text = String(value ?? '');
  const ms = Date.parse(text);
  if (!Number.isFinite(ms) || new Date(ms).toISOString() !== text) {
    throw new Error(label + ' must be canonical ISO-8601 UTC with milliseconds');
  }
  return { text, ms };
}

function hex(bytes) {
  return [...new Uint8Array(bytes)].map((value) => value.toString(16).padStart(2, '0')).join('');
}

async function sha256(value) {
  return hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
}

async function authenticated(request, env) {
  const expected = requiredSecret(env?.MUTATION_CONTROL_TOKEN, 'MUTATION_CONTROL_TOKEN');
  const header = request.headers.get('authorization') ?? '';
  if (!header.startsWith('Bearer ')) return false;
  const provided = header.slice('Bearer '.length);
  if (provided === '') return false;
  const [expectedDigest, providedDigest] = await Promise.all([
    sha256(expected),
    sha256(provided),
  ]);
  return expectedDigest === providedDigest;
}

function checkpointMessage(evidence) {
  return [
    'xqueue-production-checkpoint-v1',
    evidence.databaseId,
    evidence.candidateSha,
    evidence.batchDigest,
    evidence.bookmark,
    evidence.issuedAt,
    evidence.nonce,
  ].join('\n');
}

export async function verifyProductionCheckpointEvidence(
  env,
  evidence,
  {
    candidateSha,
    batchDigest,
    now = new Date(),
  } = {},
) {
  const item = requiredObject(evidence, 'signed production checkpoint evidence');
  const databaseId = String(env?.XQUEUE_PRODUCTION_DATABASE_ID ?? '').toLowerCase();
  if (!/^[a-f0-9]{32}$/.test(databaseId)) {
    throw new Error('XQUEUE_PRODUCTION_DATABASE_ID is invalid');
  }

  const bookmark = String(item.bookmark ?? '');
  if (!BOOKMARK_RE.test(bookmark)) {
    throw new Error('production checkpoint bookmark is invalid');
  }

  const signedDatabaseId = String(item.databaseId ?? '').toLowerCase();
  const signedCandidateSha = String(item.candidateSha ?? '').toLowerCase();
  const signedBatchDigest = String(item.batchDigest ?? '').toLowerCase();
  const expectedCandidateSha = String(candidateSha ?? '').toLowerCase();
  const expectedBatchDigest = String(batchDigest ?? '').toLowerCase();

  if (signedDatabaseId !== databaseId) {
    throw new Error('production checkpoint database binding mismatch');
  }
  if (!SHA40_RE.test(signedCandidateSha) || signedCandidateSha !== expectedCandidateSha) {
    throw new Error('production checkpoint candidate binding mismatch');
  }
  if (!SHA256_RE.test(signedBatchDigest) || signedBatchDigest !== expectedBatchDigest) {
    throw new Error('production checkpoint batch binding mismatch');
  }
  if (!NONCE_RE.test(String(item.nonce ?? ''))) {
    throw new Error('production checkpoint nonce is invalid');
  }

  const issued = canonicalInstant(item.issuedAt, 'production checkpoint issuedAt');
  const nowMs = (now instanceof Date ? now : new Date(now)).getTime();
  if (!Number.isFinite(nowMs)) throw new Error('checkpoint verification time is invalid');
  if (nowMs - issued.ms > MAX_CHECKPOINT_AGE_MS || issued.ms - nowMs > MAX_CHECKPOINT_FUTURE_MS) {
    throw new Error('production checkpoint evidence is stale');
  }

  const signature = String(item.signature ?? '').toLowerCase();
  if (!SHA256_RE.test(signature)) {
    throw new Error('production checkpoint signature is invalid');
  }

  const keyText = requiredSecret(
    env?.MUTATION_CHECKPOINT_HMAC_KEY,
    'MUTATION_CHECKPOINT_HMAC_KEY',
  );
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(keyText),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const expectedSignature = hex(await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(checkpointMessage({
      databaseId: signedDatabaseId,
      candidateSha: signedCandidateSha,
      batchDigest: signedBatchDigest,
      bookmark,
      issuedAt: issued.text,
      nonce: item.nonce,
    })),
  ));

  if (signature !== expectedSignature) {
    throw new Error('production checkpoint signature mismatch');
  }

  return Object.freeze({
    bookmark,
    databaseId: signedDatabaseId,
    candidateSha: signedCandidateSha,
    batchDigest: signedBatchDigest,
    issuedAt: issued.text,
    nonce: item.nonce,
  });
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
    verifyCheckpoint = verifyProductionCheckpointEvidence,
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
  const input = payload?.input;
  if (input == null) throw new Error('intake input is required');
  const mode = requiredMode(payload?.mode);
  const sourceMode = requiredSourceMode(payload?.sourceMode);
  const recordedAt = now().toISOString();

  const normalized = normalizeInput(input, {
    mode,
    sourceMode,
    ownerApprovalDigest: payload?.ownerApprovalDigest ?? null,
  });

  const checkpoint = await verifyCheckpoint(
    env,
    payload?.checkpoint,
    {
      candidateSha: candidate.headSha ?? candidate.head_sha,
      batchDigest: normalized.batch_digest,
      now: new Date(recordedAt),
    },
  );

  const before = await verifyRuntime(env, {
    verifyMedia: false,
    includeSnapshot: true,
  });
  if (!before?.ok || !before.snapshot) {
    throw new Error('production runtime is not healthy before mutation');
  }

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
    policy: schedulePolicy,
    existingContent: contentIndex.filter((row) => ids.has(row.content_id)),
    existingDigests: contentIndex.filter((row) => digests.has(row.content_digest)),
    baselineAssignmentHash: assignmentHash(activeAssignments),
    runtimeState: {
      generation: Number(before.generation),
      revision_digest: before.revisionDigest,
    },
  });

  const transport = productionTransport(db, checkpoint.bookmark, createTransport);
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

  const committedRuntime = await first(
    db,
    COMMITTED_RUNTIME_SQL,
    controlPlan.operation_id,
  );
  if (
    !committedRuntime ||
    Number(committedRuntime.generation) !== Number(runtimeRevision.generation) ||
    committedRuntime.revision_digest !== runtimeRevision.revision_digest ||
    committedRuntime.previous_revision_digest !== runtimeRevision.previous_revision_digest ||
    committedRuntime.source_operation_id !== controlPlan.operation_id
  ) {
    throw new Error('production committed runtime revision readback is not exact');
  }

  const after = await verifyRuntime(env, {
    verifyMedia: false,
    includeSnapshot: false,
  });
  if (!after?.ok || Number(after.generation) < Number(runtimeRevision.generation)) {
    throw new Error('production runtime head is not healthy after mutation');
  }

  return Object.freeze({
    ok: true,
    publicationCapable: false,
    schedulerAuthority: false,
    recoveryCheckpointCaptured: true,
    checkpoint: Object.freeze({
      databaseId: checkpoint.databaseId ?? null,
      candidateSha: checkpoint.candidateSha ?? null,
      batchDigest: checkpoint.batchDigest ?? null,
      issuedAt: checkpoint.issuedAt ?? null,
      nonce: checkpoint.nonce ?? null,
    }),
    planned,
    mutation,
    productionPreflight: mutation.production_preflight ?? null,
    committedRuntimeRevision: Object.freeze({
      generation: Number(committedRuntime.generation),
      revisionDigest: committedRuntime.revision_digest,
      previousRevisionDigest: committedRuntime.previous_revision_digest,
      sourceOperationId: committedRuntime.source_operation_id,
    }),
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

      let isAuthenticated = false;
      try {
        isAuthenticated = await authenticated(request, env);
      } catch {
        isAuthenticated = false;
      }
      if (!isAuthenticated) {
        return json({ error: 'unauthorized' }, { status: 401 });
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
