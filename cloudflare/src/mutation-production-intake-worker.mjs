import schedulePolicy from '../../config/schedule-policy.json' with { type: 'json' };

import {
  DEFAULT_TARGET_ACCOUNT,
  hashAssignmentRows,
  normalizeIntakeInput,
  planIntake,
  sha256Hex,
} from '../../src/continuous-queue-intake.mjs';
import {
  createIntakeMutationControlPlan,
  intakeMutationOperationId,
} from '../../src/mutation-intake-adapter.mjs';
import { projectIntakeRuntimeRevision } from '../../src/mutation-intake-d1.mjs';
import { createD1MutationTransport } from '../../src/mutation-control-transport.mjs';
import { runIntakeMutation } from '../../src/mutation-intake-runner.mjs';
import {
  evaluateProductionMutationPreflight,
  runProductionIntakeMutation,
} from '../../src/mutation-production-preflight.mjs';
import { verifyCloudflareApiToken } from '../../src/cloudflare-auth.mjs';
import { assertAuthenticatedOwnerApprovalForDigest } from '../../src/authoring/owner-approval.mjs';
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

export const MAX_PRODUCTION_INTAKE_ITEMS = 5;

const EXISTING_INTAKE_SQL =
  "SELECT operation_id,plan_digest,batch_digest,item_count,expected_frontier_generation," +
  "expected_frontier_resolved_at,proposed_frontier_resolved_at,baseline_assignment_hash," +
  "expected_runtime_generation,expected_runtime_revision_digest,resulting_runtime_generation," +
  "resulting_runtime_revision_digest,target_account,policy_version,status,created_at,updated_at " +
  "FROM queue_intake_operations WHERE batch_digest=? AND status IN ('claimed','complete') " +
  "ORDER BY created_at DESC LIMIT 1";

const EXISTING_INTAKE_ITEMS_SQL =
  'SELECT operation_id,ordinal,content_id,content_digest,pillar,title,source_ref,' +
  'resolved_at,scheduled_date,scheduled_time,timezone,slot_label ' +
  'FROM queue_intake_items WHERE operation_id=? ORDER BY ordinal';

const EXISTING_MUTATION_ITEMS_SQL =
  'SELECT item_key,expected_content_revision,expected_assignment_version,' +
  'resulting_content_revision,resulting_assignment_version,readback_status,readback_digest ' +
  'FROM mutation_operation_items WHERE operation_id=? ORDER BY item_key';

function rows(result) {
  return Array.isArray(result) ? result : (result?.results ?? []);
}

async function all(db, sql, ...args) {
  const statement = args.length ? db.prepare(sql).bind(...args) : db.prepare(sql);
  return rows(await statement.all());
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

function rawIntakeItems(raw) {
  if (Array.isArray(raw)) return raw;
  if (raw?.items && Array.isArray(raw.items)) return raw.items;
  if (raw && typeof raw === 'object') return [raw];
  throw new Error('intake input must be an object, array, or {items:[...]}');
}

function authorizeAutomatedInput({
  raw,
  mode,
  ownerApproval,
  ownerApprovalDigest,
  ownerPublicKeyPem,
  verifyOwnerApproval,
}) {
  if (ownerApprovalDigest != null) {
    throw new Error('automated intake rejects caller-supplied ownerApprovalDigest');
  }
  if (typeof ownerPublicKeyPem !== 'string' || !ownerPublicKeyPem.trim()) {
    const error = new Error('owner approval public key is unavailable');
    error.authorityUnavailable = true;
    throw error;
  }

  const source = rawIntakeItems(raw);
  if (mode === 'single' && source.length !== 1) {
    throw new Error('single intake requires exactly one item');
  }
  if (source.length > 1 && ownerApproval != null) {
    throw new Error('batch automated intake requires signed owner_approval evidence per item');
  }

  return source.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error(`item ${index + 1} must be an object`);
    }
    if (item.owner_approval_digest != null || item.ownerApprovalDigest != null) {
      throw new Error(`item ${index + 1} rejects caller-supplied owner approval digest`);
    }
    if (item.source_mode != null && item.source_mode !== 'automated') {
      throw new Error(`item ${index + 1} source_mode cannot override automated authority`);
    }
    if (typeof item.body !== 'string' || item.body.length === 0) {
      throw new Error(`item ${index + 1} body is required`);
    }

    const contentHex = sha256Hex(item.body);
    const suppliedId = item.content_id ?? item.id ?? null;
    const candidateId = suppliedId == null
      ? `CQ-${contentHex.slice(0, 20).toUpperCase()}`
      : String(suppliedId);
    const approval = item.owner_approval ?? (source.length === 1 ? ownerApproval : null);
    if (!approval || typeof approval !== 'object' || Array.isArray(approval)) {
      throw new Error(`item ${index + 1} requires signed owner_approval evidence`);
    }

    verifyOwnerApproval(
      { candidateId, candidateDigest: `sha256:${contentHex}` },
      approval,
      ownerPublicKeyPem,
    );

    const trustedDigest = approval?.owner_proof?.payload_digest;
    if (typeof trustedDigest !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(trustedDigest)) {
      throw new Error(`item ${index + 1} verified owner approval lacks canonical payload digest`);
    }

    const {
      owner_approval: _ownerApproval,
      owner_approval_digest: _ownerApprovalDigest,
      ownerApprovalDigest: _ownerApprovalDigestCamel,
      ...rest
    } = item;
    return Object.freeze({
      ...rest,
      source_mode: 'automated',
      owner_approval_digest: trustedDigest,
    });
  });
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

function productionFault(
  faultClass,
  message,
  { httpStatus = 400, retryable = false, requiresReadback = false } = {},
) {
  const error = new Error(message);
  error.faultClass = faultClass;
  error.httpStatus = httpStatus;
  error.retryable = retryable;
  error.requiresReadback = requiresReadback;
  return error;
}

function faultDescriptor(error) {
  if (typeof error?.faultClass === 'string') {
    return {
      faultClass: error.faultClass,
      httpStatus: Number(error.httpStatus) || 500,
      retryable: error.retryable === true,
      requiresReadback: error.requiresReadback === true,
      message: error.message,
    };
  }

  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();

  if (
    lower.includes('content_id already exists') ||
    lower.includes('exact content digest already exists') ||
    lower.includes('frontier is blocked') ||
    lower.includes('duplicate')
  ) {
    return {
      faultClass: 'INTAKE_CONFLICT',
      httpStatus: 409,
      retryable: false,
      requiresReadback: false,
      message,
    };
  }

  if (
    lower.includes('network') ||
    lower.includes('fetch') ||
    lower.includes('temporarily unavailable') ||
    lower.includes('timeout')
  ) {
    return {
      faultClass: 'PRE_DISPATCH_TRANSIENT_UNAVAILABLE',
      httpStatus: 503,
      retryable: true,
      requiresReadback: false,
      message,
    };
  }

  return {
    faultClass: 'INTERNAL_ERROR',
    httpStatus: 500,
    retryable: false,
    requiresReadback: false,
    message,
  };
}

async function trustedProductionAuth(env, verifyAuth, fetchImpl) {
  try {
    const verified = await verifyAuth({
      token: env?.CLOUDFLARE_API_TOKEN,
      accountId: env?.CLOUDFLARE_ACCOUNT_ID,
      fetchImpl,
    });
    return Object.freeze({
      ok: true,
      environment: 'production',
      tokenType: verified.tokenType,
      status: verified.status,
      d1Readable: true,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const transient = /request failed|network|fetch|timeout/i.test(message);
    throw productionFault(
      'PRODUCTION_AUTH_NOT_VERIFIED',
      message,
      { httpStatus: transient ? 503 : 409, retryable: transient },
    );
  }
}

function productionTransport(env, db, createTransport, fetchImpl) {
  return createTransport({
    db,
    fetchImpl,
    accountId: env?.CLOUDFLARE_ACCOUNT_ID,
    databaseId: env?.XQUEUE_PRODUCTION_DATABASE_ID,
    apiToken: env?.CLOUDFLARE_API_TOKEN,
  });
}

async function loadReplayState(db, normalized, operation) {
  const operationId = operation?.operation_id;
  if (!operationId) {
    throw productionFault(
      'IDEMPOTENCY_READBACK_CONFLICT',
      'existing mutation operation identity is missing',
      { httpStatus: 409, requiresReadback: true },
    );
  }

  const intakeOperation = await first(
    db,
    EXISTING_INTAKE_SQL,
    normalized.batch_digest,
  );
  if (!intakeOperation) {
    throw productionFault(
      'IDEMPOTENCY_READBACK_CONFLICT',
      'existing mutation operation has no matching intake operation',
      { httpStatus: 409, requiresReadback: true },
    );
  }

  const [storedItems, mutationItems, runtimeRevision] = await Promise.all([
    all(db, EXISTING_INTAKE_ITEMS_SQL, intakeOperation.operation_id),
    all(db, EXISTING_MUTATION_ITEMS_SQL, operationId),
    first(db, COMMITTED_RUNTIME_SQL, operationId),
  ]);

  if (
    Number(intakeOperation.item_count) !== normalized.items.length ||
    storedItems.length !== normalized.items.length ||
    mutationItems.length !== normalized.items.length
  ) {
    throw productionFault(
      'IDEMPOTENCY_READBACK_CONFLICT',
      'existing intake operation item count does not match replay input',
      { httpStatus: 409, requiresReadback: true },
    );
  }

  for (const inputItem of normalized.items) {
    const stored = storedItems.find((item) => item.content_id === inputItem.content_id);
    if (!stored || stored.content_digest !== inputItem.content_digest) {
      throw productionFault(
        'IDEMPOTENCY_KEY_CONFLICT',
        'existing intake operation does not match replay content identity',
        { httpStatus: 409 },
      );
    }
  }

  if (
    !['VERIFYING', 'COMPLETE'].includes(operation.state) ||
    operation.effect_state !== 'applied' ||
    !runtimeRevision
  ) {
    throw productionFault(
      'IDEMPOTENCY_STATE_REQUIRES_RECONCILIATION',
      'existing mutation operation is not in an exact recoverable applied state',
      { httpStatus: 409, requiresReadback: true },
    );
  }

  const laneGeneration = Number(operation.lane_generation);
  if (!Number.isSafeInteger(laneGeneration) || laneGeneration < 2) {
    throw productionFault(
      'IDEMPOTENCY_READBACK_CONFLICT',
      'existing mutation lane generation is invalid',
      { httpStatus: 409, requiresReadback: true },
    );
  }

  const intakePlan = Object.freeze({
    operation_id: intakeOperation.operation_id,
    plan_digest: intakeOperation.plan_digest,
    batch_digest: intakeOperation.batch_digest,
    count: Number(intakeOperation.item_count),
    expected_frontier_generation: Number(intakeOperation.expected_frontier_generation),
    expected_frontier_resolved_at: intakeOperation.expected_frontier_resolved_at,
    proposed_frontier_resolved_at: intakeOperation.proposed_frontier_resolved_at,
    baseline_assignment_hash: intakeOperation.baseline_assignment_hash,
    expected_runtime_generation: Number(intakeOperation.expected_runtime_generation),
    expected_runtime_revision_digest: intakeOperation.expected_runtime_revision_digest,
    target_account: intakeOperation.target_account,
    policy_version: Number(intakeOperation.policy_version),
    items: Object.freeze(storedItems.map((item) => Object.freeze({
      ordinal: Number(item.ordinal),
      content_id: item.content_id,
      content_digest: item.content_digest,
      pillar: item.pillar,
      title: item.title,
      source_ref: item.source_ref,
      assignment_id: item.content_id,
      assignment_version: 1,
      content_revision: 1,
      target_account: intakeOperation.target_account,
      policy_version: Number(intakeOperation.policy_version),
      resolved_at: item.resolved_at,
      scheduled_date: item.scheduled_date,
      scheduled_time: item.scheduled_time,
      timezone: item.timezone,
      slot_label: item.slot_label,
    }))),
  });

  const controlPlan = Object.freeze({
    operation_id: operation.operation_id,
    operation_kind: operation.operation_kind,
    operation_digest: operation.operation_digest,
    plan_digest: operation.plan_digest,
    plan_context: Object.freeze({
      intake_plan_digest: intakeOperation.plan_digest,
      intake_operation_id: intakeOperation.operation_id,
      expected_frontier_generation: Number(intakeOperation.expected_frontier_generation),
      expected_frontier_resolved_at: intakeOperation.expected_frontier_resolved_at,
      proposed_frontier_resolved_at: intakeOperation.proposed_frontier_resolved_at,
      baseline_assignment_hash: intakeOperation.baseline_assignment_hash,
      policy_version: Number(intakeOperation.policy_version),
    }),
    expected_halt_generation: Number(operation.expected_halt_generation),
    expected_lane_generation: laneGeneration - 1,
    expected_runtime_generation: Number(operation.expected_runtime_generation),
    expected_runtime_revision_digest: operation.expected_runtime_revision_digest,
    retry_budgets: Object.freeze({
      plan: Number(operation.max_plan_retries),
      read: Number(operation.max_read_retries),
      operation: Number(operation.max_operation_retries),
    }),
    items: Object.freeze(mutationItems.map((item) => Object.freeze({
      item_key: item.item_key,
      expected_content_revision:
        item.expected_content_revision == null ? null : Number(item.expected_content_revision),
      expected_assignment_version:
        item.expected_assignment_version == null ? null : Number(item.expected_assignment_version),
      resulting_content_revision:
        item.resulting_content_revision == null ? null : Number(item.resulting_content_revision),
      resulting_assignment_version:
        item.resulting_assignment_version == null ? null : Number(item.resulting_assignment_version),
    }))),
  });

  return Object.freeze({
    intakePlan,
    controlPlan,
    runtimeRevision: Object.freeze({
      generation: Number(runtimeRevision.generation),
      revision_digest: runtimeRevision.revision_digest,
      previous_revision_digest: runtimeRevision.previous_revision_digest,
      source_operation_id: runtimeRevision.source_operation_id,
      created_at: runtimeRevision.created_at,
    }),
  });
}

async function verifyCommittedResult({
  db,
  verifyRuntime,
  mutation,
  controlPlan,
  runtimeRevision,
}) {
  if (mutation.operation_id !== controlPlan.operation_id) {
    throw productionFault(
      'POST_DISPATCH_READBACK_AMBIGUOUS',
      'production mutation operation readback does not match its plan',
      { httpStatus: 409, requiresReadback: true },
    );
  }

  let committedRuntime;
  try {
    committedRuntime = await first(
      db,
      COMMITTED_RUNTIME_SQL,
      controlPlan.operation_id,
    );
  } catch (error) {
    if (error?.faultClass === 'POST_DISPATCH_READBACK_AMBIGUOUS') throw error;
    throw productionFault(
      'POST_DISPATCH_READBACK_AMBIGUOUS',
      'production committed runtime revision readback failed: ' +
        (error instanceof Error ? error.message : String(error)),
      { httpStatus: 409, requiresReadback: true },
    );
  }
  if (
    !committedRuntime ||
    Number(committedRuntime.generation) !== Number(runtimeRevision.generation) ||
    committedRuntime.revision_digest !== runtimeRevision.revision_digest ||
    committedRuntime.previous_revision_digest !== runtimeRevision.previous_revision_digest ||
    committedRuntime.source_operation_id !== controlPlan.operation_id
  ) {
    throw productionFault(
      'POST_DISPATCH_READBACK_AMBIGUOUS',
      'production committed runtime revision readback is not exact',
      { httpStatus: 409, requiresReadback: true },
    );
  }

  let after;
  try {
    after = await verifyRuntime(null, {
      verifyMedia: false,
      includeSnapshot: false,
    });
  } catch (error) {
    if (error?.faultClass === 'POST_DISPATCH_READBACK_AMBIGUOUS') throw error;
    throw productionFault(
      'POST_DISPATCH_READBACK_AMBIGUOUS',
      'production runtime head readback failed: ' +
        (error instanceof Error ? error.message : String(error)),
      { httpStatus: 409, requiresReadback: true },
    );
  }
  if (!after?.ok || Number(after.generation) < Number(runtimeRevision.generation)) {
    throw productionFault(
      'POST_DISPATCH_READBACK_AMBIGUOUS',
      'production runtime head is not healthy after mutation',
      { httpStatus: 409, requiresReadback: true },
    );
  }

  return Object.freeze({
    committedRuntime,
    after,
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
    verifyAuth = verifyCloudflareApiToken,
    verifyOwnerApproval = assertAuthenticatedOwnerApprovalForDigest,
    normalizeInput = normalizeIntakeInput,
    plan = planIntake,
    assignmentHash = hashAssignmentRows,
    deriveOperationId = intakeMutationOperationId,
    createControlPlan = createIntakeMutationControlPlan,
    projectRevision = projectIntakeRuntimeRevision,
    createTransport = createD1MutationTransport,
    runMutation = runProductionIntakeMutation,
    resumeMutation = runIntakeMutation,
    fetchImpl = globalThis.fetch,
    now = () => new Date(),
  } = {},
) {
  const db = env?.DB;
  if (!db || typeof db.prepare !== 'function') {
    throw productionFault(
      'PRODUCTION_D1_UNAVAILABLE',
      'production D1 binding is unavailable',
      { httpStatus: 503, retryable: true },
    );
  }
  if (payload?.environment !== 'production') {
    throw productionFault(
      'ENVIRONMENT_NOT_PRODUCTION',
      'production intake requires environment=production',
      { httpStatus: 400 },
    );
  }

  let candidate;
  try {
    candidate = requiredObject(payload?.candidate, 'exact-main candidate evidence');
  } catch (error) {
    throw productionFault(
      'INVALID_CANDIDATE',
      error instanceof Error ? error.message : String(error),
      { httpStatus: 400 },
    );
  }
  const input = payload?.input;
  if (input == null) {
    throw productionFault('INVALID_INTAKE', 'intake input is required', { httpStatus: 400 });
  }

  let mode;
  let sourceMode;
  let normalized;
  try {
    mode = requiredMode(payload?.mode);
    sourceMode = requiredSourceMode(payload?.sourceMode);
    const authorizedInput = sourceMode === 'automated'
      ? authorizeAutomatedInput({
          raw: input,
          mode,
          ownerApproval: payload?.ownerApproval ?? null,
          ownerApprovalDigest: payload?.ownerApprovalDigest ?? null,
          ownerPublicKeyPem: env?.OWNER_APPROVAL_PUBLIC_KEY_PEM,
          verifyOwnerApproval,
        })
      : input;
    normalized = normalizeInput(authorizedInput, {
      mode,
      sourceMode,
      ownerApprovalDigest:
        sourceMode === 'automated' ? null : (payload?.ownerApprovalDigest ?? null),
    });
  } catch (error) {
    if (error?.authorityUnavailable === true) {
      throw productionFault(
        'OWNER_APPROVAL_AUTHORITY_UNAVAILABLE',
        error.message,
        { httpStatus: 503 },
      );
    }
    throw productionFault(
      sourceMode === 'automated' ? 'INVALID_OWNER_APPROVAL' : 'INVALID_INTAKE',
      error instanceof Error ? error.message : String(error),
      { httpStatus: 400 },
    );
  }

  if (normalized.count > MAX_PRODUCTION_INTAKE_ITEMS) {
    throw productionFault(
      'PRODUCTION_BATCH_LIMIT_EXCEEDED',
      'production intake is limited to ' + MAX_PRODUCTION_INTAKE_ITEMS + ' items per mutation',
      { httpStatus: 413 },
    );
  }

  const recordedAt = now().toISOString();
  const trustedAuth = await trustedProductionAuth(env, verifyAuth, fetchImpl);
  const transport = productionTransport(env, db, createTransport, fetchImpl);
  const operationId = deriveOperationId({
    batchDigest: normalized.batch_digest,
    targetAccount: DEFAULT_TARGET_ACCOUNT,
    contentIds: normalized.items.map((item) => item.content_id),
  });

  let existingOperation;
  try {
    existingOperation = await transport.readOperation(operationId);
  } catch (error) {
    throw productionFault(
      'PRE_DISPATCH_STATE_UNAVAILABLE',
      error instanceof Error ? error.message : String(error),
      { httpStatus: 503, retryable: true },
    );
  }

  if (existingOperation) {
    let replaySafety;
    try {
      replaySafety = await transport.readPublicationSafety();
    } catch (error) {
      throw productionFault(
        'PRE_DISPATCH_STATE_UNAVAILABLE',
        error instanceof Error ? error.message : String(error),
        { httpStatus: 503, retryable: true },
      );
    }

    const replayPreflight = evaluateProductionMutationPreflight({
      environment: 'production',
      auth: trustedAuth,
      candidate,
      safety: replaySafety,
    });
    if (!replayPreflight.ok) {
      throw productionFault(
        'PRE_DISPATCH_STATE_CONFLICT',
        'production replay preflight blocked: ' +
          replayPreflight.blockers.map((item) => item.id).join(','),
        { httpStatus: 409 },
      );
    }

    const appliedReplay = existingOperation.effect_state === 'applied';
    let replay;
    try {
      replay = await loadReplayState(db, normalized, existingOperation);
    } catch (error) {
      if (appliedReplay) {
        throw productionFault(
          'POST_DISPATCH_READBACK_AMBIGUOUS',
          'production replay state readback failed: ' +
            (error instanceof Error ? error.message : String(error)),
          { httpStatus: 409, requiresReadback: true },
        );
      }
      throw error;
    }

    let mutation;
    try {
      mutation = await resumeMutation({
        intakePlan: replay.intakePlan,
        controlPlan: replay.controlPlan,
        runtimeRevision: replay.runtimeRevision,
        transport,
        recordedAt,
      });
    } catch (error) {
      if (appliedReplay) {
        throw productionFault(
          'POST_DISPATCH_READBACK_AMBIGUOUS',
          'production applied-operation resume readback failed: ' +
            (error instanceof Error ? error.message : String(error)),
          { httpStatus: 409, requiresReadback: true },
        );
      }
      throw error;
    }

    if (!['applied', 'already_applied'].includes(mutation?.status)) {
      if (appliedReplay) {
        throw productionFault(
          'POST_DISPATCH_READBACK_AMBIGUOUS',
          'production applied-operation resume did not produce exact completion',
          { httpStatus: 409, requiresReadback: true },
        );
      }
      return Object.freeze({
        ok: false,
        publicationCapable: false,
        schedulerAuthority: false,
        replay: true,
        productionPreflight: replayPreflight,
        planned: Object.freeze({
          operationId,
          intakeOperationId: replay.intakePlan.operation_id,
          itemCount: replay.intakePlan.items.length,
          contentIds: Object.freeze(replay.intakePlan.items.map((item) => item.content_id)),
          contentDigests: Object.freeze(replay.intakePlan.items.map((item) => item.content_digest)),
        }),
        mutation,
      });
    }

    const verified = await verifyCommittedResult({
      db,
      verifyRuntime: async (_unused, options) => verifyRuntime(env, options),
      mutation,
      controlPlan: replay.controlPlan,
      runtimeRevision: replay.runtimeRevision,
    });

    return Object.freeze({
      ok: true,
      replay: true,
      publicationCapable: false,
      schedulerAuthority: false,
      productionPreflight: replayPreflight,
      recoveryCheckpointCaptured:
        typeof existingOperation.checkpoint_bookmark === 'string' &&
        existingOperation.checkpoint_bookmark.length >= 8,
      planned: Object.freeze({
        operationId,
        intakeOperationId: replay.intakePlan.operation_id,
        itemCount: replay.intakePlan.items.length,
        contentIds: Object.freeze(replay.intakePlan.items.map((item) => item.content_id)),
        contentDigests: Object.freeze(replay.intakePlan.items.map((item) => item.content_digest)),
      }),
      mutation,
      committedRuntimeRevision: Object.freeze({
        generation: Number(verified.committedRuntime.generation),
        revisionDigest: verified.committedRuntime.revision_digest,
        previousRevisionDigest: verified.committedRuntime.previous_revision_digest,
        sourceOperationId: verified.committedRuntime.source_operation_id,
      }),
      after: Object.freeze({
        generation: verified.after.generation,
        revisionDigest: verified.after.revisionDigest,
      }),
    });
  }

  let before;
  try {
    before = await verifyRuntime(env, {
      verifyMedia: false,
      includeSnapshot: true,
    });
  } catch (error) {
    throw productionFault(
      'PRE_DISPATCH_STATE_UNAVAILABLE',
      error instanceof Error ? error.message : String(error),
      { httpStatus: 503, retryable: true },
    );
  }
  if (!before?.ok || !before.snapshot) {
    throw productionFault(
      'PRE_DISPATCH_STATE_CONFLICT',
      'production runtime is not healthy before mutation',
      { httpStatus: 409 },
    );
  }

  let frontier;
  let activeAssignments;
  let contentIndex;
  try {
    [frontier, activeAssignments, contentIndex] = await Promise.all([
      first(db, FRONTIER_SQL),
      all(db, ACTIVE_ASSIGNMENTS_SQL),
      all(db, CONTENT_INDEX_SQL),
    ]);
  } catch (error) {
    throw productionFault(
      'PRE_DISPATCH_STATE_UNAVAILABLE',
      error instanceof Error ? error.message : String(error),
      { httpStatus: 503, retryable: true },
    );
  }
  if (!frontier) {
    throw productionFault(
      'PRE_DISPATCH_STATE_CONFLICT',
      'production intake frontier is missing',
      { httpStatus: 409 },
    );
  }

  const ids = new Set(normalized.items.map((item) => item.content_id));
  const digests = new Set(normalized.items.map((item) => item.content_digest));

  let intakePlan;
  try {
    intakePlan = plan({
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
  } catch (error) {
    throw productionFault(
      'INTAKE_CONFLICT',
      error instanceof Error ? error.message : String(error),
      { httpStatus: 409 },
    );
  }

  let haltState;
  let laneState;
  let runtimeState;
  try {
    [haltState, laneState, runtimeState] = await Promise.all([
      transport.readHaltState(),
      transport.readLaneState(),
      transport.readRuntimeState(),
    ]);
  } catch (error) {
    throw productionFault(
      'PRE_DISPATCH_STATE_UNAVAILABLE',
      error instanceof Error ? error.message : String(error),
      { httpStatus: 503, retryable: true },
    );
  }

  let controlPlan;
  try {
    controlPlan = createControlPlan({
      intakePlan,
      haltState,
      laneState,
      runtimeState,
    });
  } catch (error) {
    throw productionFault(
      'PRE_DISPATCH_REPLAN_REQUIRED',
      error instanceof Error ? error.message : String(error),
      { httpStatus: 409, retryable: true },
    );
  }
  if (controlPlan.operation_id !== operationId) {
    throw productionFault(
      'OPERATION_IDENTITY_MISMATCH',
      'derived production mutation identity does not match planned mutation identity',
      { httpStatus: 409 },
    );
  }

  let runtimeRevision;
  try {
    runtimeRevision = await projectRevision({
      intakePlan,
      controlPlan,
      currentRuntimeState: runtimeState,
      assignments: before.snapshot.assignments,
      deferred: before.snapshot.deferred,
      approvedUnscheduled: before.snapshot.approvedUnscheduled,
      media: before.snapshot.media,
      recordedAt,
    });
  } catch (error) {
    throw productionFault(
      'PRE_DISPATCH_REPLAN_REQUIRED',
      error instanceof Error ? error.message : String(error),
      { httpStatus: 409, retryable: true },
    );
  }

  const mutation = await runMutation({
    environment: 'production',
    auth: trustedAuth,
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
      replay: false,
      planned,
      mutation,
    });
  }

  const verified = await verifyCommittedResult({
    db,
    verifyRuntime: async (_unused, options) => verifyRuntime(env, options),
    mutation,
    controlPlan,
    runtimeRevision,
  });

  return Object.freeze({
    ok: true,
    replay: false,
    publicationCapable: false,
    schedulerAuthority: false,
    recoveryCheckpointCaptured: true,
    planned,
    mutation,
    productionPreflight: mutation.production_preflight ?? null,
    committedRuntimeRevision: Object.freeze({
      generation: Number(verified.committedRuntime.generation),
      revisionDigest: verified.committedRuntime.revision_digest,
      previousRevisionDigest: verified.committedRuntime.previous_revision_digest,
      sourceOperationId: verified.committedRuntime.source_operation_id,
    }),
    before: Object.freeze({
      generation: before.generation,
      revisionDigest: before.revisionDigest,
    }),
    after: Object.freeze({
      generation: verified.after.generation,
      revisionDigest: verified.after.revisionDigest,
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

      let payload;
      try {
        payload = await request.json();
      } catch {
        return json({
          service: 'xqueue-mutation-production-intake',
          status: 'error',
          faultClass: 'INVALID_JSON',
          retryable: false,
          requiresReadback: false,
          error: 'request body must be valid JSON',
        }, { status: 400 });
      }

      try {
        const result = await runProductionIntakeRequest(
          env,
          payload,
          dependencies,
        );
        if (!result.ok) {
          const phase = result.mutation?.phase ?? 'unknown';
          const postDispatch = [
            'apply',
            'completion_readback',
            'complete_readback',
            'existing_operation',
            'finalize',
            'finalize_readback',
          ].includes(phase);
          const transientPreDispatch =
            !postDispatch &&
            result.mutation?.fault_class === 'PRE_DISPATCH_STATE_UNAVAILABLE' &&
            result.mutation?.retryable === true;
          return json({
            service: 'xqueue-mutation-production-intake',
            role: 'production-mutation-intake',
            environment: 'production',
            publicationCapable: false,
            schedulerAuthority: false,
            status: 'blocked',
            faultClass: postDispatch
              ? 'POST_DISPATCH_RECONCILIATION_REQUIRED'
              : (result.mutation?.fault_class ?? 'MUTATION_BLOCKED'),
            retryable:
              transientPreDispatch ||
              (!postDispatch && result.mutation?.decision?.outcome === 'AUTO_RETRY'),
            requiresReadback: postDispatch,
            ...result,
          }, { status: transientPreDispatch ? 503 : 409 });
        }

        return json({
          service: 'xqueue-mutation-production-intake',
          role: 'production-mutation-intake',
          environment: 'production',
          publicationCapable: false,
          schedulerAuthority: false,
          status: 'ok',
          retryable: false,
          requiresReadback: false,
          ...result,
        });
      } catch (error) {
        const fault = faultDescriptor(error);
        return json({
          service: 'xqueue-mutation-production-intake',
          role: 'production-mutation-intake',
          environment: 'production',
          publicationCapable: false,
          schedulerAuthority: false,
          status: 'error',
          faultClass: fault.faultClass,
          retryable: fault.retryable,
          requiresReadback: fault.requiresReadback,
          error: fault.message,
        }, { status: fault.httpStatus });
      }
    },
  };
}

export default createMutationProductionIntakeWorker();
