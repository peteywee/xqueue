import schedulePolicy from '../../config/schedule-policy.json' with { type: 'json' };

import {
  DEFAULT_TARGET_ACCOUNT,
  hashAssignmentRows,
  normalizeIntakeInput,
  planIntake,
} from '../../src/continuous-queue-intake.mjs';
import {
  createIntakeMutationControlPlan,
  intakeMutationOperationId,
} from '../../src/mutation-intake-adapter.mjs';
import { projectIntakeRuntimeRevision, readPublicationOccupancy } from '../../src/mutation-intake-d1.mjs';
import { createD1MutationTransport } from '../../src/mutation-control-transport.mjs';
import { runIntakeMutation } from '../../src/mutation-intake-runner.mjs';
import {
  evaluateProductionMutationPreflight,
  MAX_PRODUCTION_INTAKE_ITEMS,
  publicationAuthorityMismatch,
  runProductionIntakeMutation,
  validPublicationAuthorityEvidence,
} from '../../src/mutation-production-preflight.mjs';
import { verifyCloudflareApiToken } from '../../src/cloudflare-auth.mjs';
import {
  assertAuthenticatedOwnerApprovalForCandidate,
  ownerPublicKeyFingerprint,
} from '../../src/authoring/owner-approval.mjs';
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

const CONTENT_CONFLICT_SQL = `
SELECT c.content_id,c.intake_state,r.content_digest
FROM queue_content c
JOIN queue_content_revisions r
  ON r.content_id=c.content_id
 AND r.revision=c.current_revision
WHERE c.content_id=? OR r.content_digest=?
`;

const COMMITTED_RUNTIME_SQL = `
SELECT generation,revision_digest,previous_revision_digest,source_operation_id,created_at
FROM queue_runtime_revisions
WHERE source_operation_id=?
LIMIT 1
`;

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

async function readContentConflicts(db, items) {
  const groups = await Promise.all(
    items.map((item) =>
      all(db, CONTENT_CONFLICT_SQL, item.content_id, item.content_digest)),
  );
  const seen = new Set();
  const conflicts = [];
  for (const row of groups.flat()) {
    const key = `${row.content_id}\u0000${row.content_digest}`;
    if (seen.has(key)) continue;
    seen.add(key);
    conflicts.push(row);
  }
  return conflicts;
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

function assertSourceModeConsistency(raw, sourceMode) {
  const source = rawIntakeItems(raw);
  for (let index = 0; index < source.length; index += 1) {
    const item = source[index];
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    if (item.source_mode != null && item.source_mode !== sourceMode) {
      const error = new Error(
        `item ${index + 1} source_mode cannot override top-level ${sourceMode} authority`,
      );
      error.authorizationModeMismatch = true;
      throw error;
    }
  }
}

function authorizeAutomatedInput({
  raw,
  mode,
  ownerApproval,
  approvedCandidate,
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
  if (source.length > 1 && (ownerApproval != null || approvedCandidate != null)) {
    throw new Error(
      'batch automated intake requires signed owner_approval and approved_candidate evidence per item',
    );
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
    if (typeof item.content_id !== 'string' || !item.content_id.trim()) {
      throw new Error(`item ${index + 1} automated intake requires explicit content_id`);
    }
    if (typeof item.title !== 'string') {
      throw new Error(`item ${index + 1} automated intake requires explicit title`);
    }
    if (typeof item.source_ref !== 'string' || !item.source_ref.trim()) {
      throw new Error(`item ${index + 1} automated intake requires explicit source_ref`);
    }

    if (
      (item.owner_approval != null || item.approved_candidate != null) &&
      (ownerApproval != null || approvedCandidate != null)
    ) {
      throw new Error(
        `item ${index + 1} carries approval evidence; do not also supply top-level ` +
        'ownerApproval or approvedCandidate',
      );
    }
    const approval = item.owner_approval ?? (source.length === 1 ? ownerApproval : null);
    if (!approval || typeof approval !== 'object' || Array.isArray(approval)) {
      throw new Error(`item ${index + 1} requires signed owner_approval evidence`);
    }
    const candidate =
      item.approved_candidate ?? (source.length === 1 ? approvedCandidate : null);
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
      throw new Error(`item ${index + 1} requires approved_candidate evidence`);
    }
    if (candidate.artifact_kind !== 'post') {
      throw new Error(`item ${index + 1} approved_candidate must be a post`);
    }
    if (candidate.figure != null) {
      throw new Error(`item ${index + 1} approved_candidate media is not active`);
    }
    if (!Array.isArray(candidate.source_refs) || candidate.source_refs.length !== 1) {
      throw new Error(
        `item ${index + 1} approved_candidate must have exactly one source_ref`,
      );
    }
    if (
      candidate.candidate_id !== item.content_id ||
      candidate.title !== item.title ||
      candidate.body !== item.body ||
      candidate.pillar !== item.pillar ||
      candidate.source_refs[0] !== item.source_ref
    ) {
      throw new Error(
        `item ${index + 1} intake fields do not match approved_candidate`,
      );
    }

    verifyOwnerApproval(candidate, approval, ownerPublicKeyPem);

    const trustedDigest = approval?.owner_proof?.payload_digest;
    if (typeof trustedDigest !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(trustedDigest)) {
      throw new Error(`item ${index + 1} verified owner approval lacks canonical payload digest`);
    }

    const {
      owner_approval: _ownerApproval,
      approved_candidate: _approvedCandidate,
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

// The operator CLI sends a fresh random challenge to /identity before any
// credential-bearing request. Only the Worker it launched holds the per-launch
// MUTATION_CONTROL_TOKEN, so a valid proof shows the listener is that Worker
// without disclosing the token, and binds the reported bindings to it.
const IDENTITY_CHALLENGE_RE = /^[0-9a-f]{64}$/;

export async function identityProof(token, challenge, bindings) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(token),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const message = 'xqueue-mutation-production-intake/identity\n' + challenge + '\n' +
    JSON.stringify(bindings);
  return hex(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message)));
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

// verifyDynamicRuntime reports read failures and read races as results, not
// exceptions. Nothing has been dispatched yet, so transient reads are
// retryable, a race is a replan, and only integrity failures are conflicts.
const TRANSIENT_RUNTIME_READ_REASONS = new Set([
  'dynamic_d1_unavailable',
  'dynamic_snapshot_unavailable',
]);
const RACED_RUNTIME_READ_REASONS = new Set(['dynamic_snapshot_changed_during_read']);

function preDispatchRuntimeFault(before) {
  const reason = typeof before?.reason === 'string' ? before.reason : 'dynamic_snapshot_missing';
  if (TRANSIENT_RUNTIME_READ_REASONS.has(reason)) {
    return productionFault(
      'PRE_DISPATCH_STATE_UNAVAILABLE',
      'production runtime read unavailable before mutation: ' + reason,
      { httpStatus: 503, retryable: true },
    );
  }
  if (RACED_RUNTIME_READ_REASONS.has(reason)) {
    return productionFault(
      'PRE_DISPATCH_REPLAN_REQUIRED',
      'production runtime changed during the pre-mutation read: ' + reason,
      { httpStatus: 409, retryable: true },
    );
  }
  return productionFault(
    'PRE_DISPATCH_STATE_CONFLICT',
    'production runtime is not healthy before mutation: ' + reason,
    { httpStatus: 409 },
  );
}

// The Worker's Cloudflare credential is MUTATION_D1_API_TOKEN, deliberately not
// CLOUDFLARE_API_TOKEN: wrangler authenticates the ephemeral launch with
// CLOUDFLARE_API_TOKEN, which needs Workers script edit rights. Keeping the
// names apart means the launch credential is never bound into the mutation
// plane, which holds only a D1 + Time Travel scoped token.
async function trustedProductionAuth(env, verifyAuth, fetchImpl) {
  try {
    const verified = await verifyAuth({
      // Never undefined: verifyCloudflareApiToken would default to
      // process.env.CLOUDFLARE_API_TOKEN, the launch credential.
      token: env?.MUTATION_D1_API_TOKEN ?? '',
      accountId: env?.CLOUDFLARE_ACCOUNT_ID,
      fetchImpl,
      label: 'MUTATION_D1_API_TOKEN',
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
    apiToken: env?.MUTATION_D1_API_TOKEN,
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
  // Only an applied operation is resumable. This is decided from the row
  // already read, before any further D1 read can fail and make a
  // non-resumable operation look like a retryable outage. A never-dispatched
  // operation ('none') never reached production, so it needs reconciliation
  // but no production readback.
  if (!['VERIFYING', 'COMPLETE'].includes(operation.state) || operation.effect_state !== 'applied') {
    throw productionFault(
      'IDEMPOTENCY_STATE_REQUIRES_RECONCILIATION',
      'existing mutation operation is not in an exact recoverable applied state',
      { httpStatus: 409, requiresReadback: operation.effect_state !== 'none' },
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

  if (!runtimeRevision) {
    throw productionFault(
      'IDEMPOTENCY_STATE_REQUIRES_RECONCILIATION',
      'existing applied mutation operation has no committed runtime revision',
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

// The operation identity the CLI checks against its offline plan, built once
// for both the fresh and the replay paths.
function plannedIdentity(operationId, intakePlan) {
  return Object.freeze({
    operationId,
    intakeOperationId: intakePlan.operation_id,
    itemCount: intakePlan.items.length,
    contentIds: Object.freeze(intakePlan.items.map((item) => item.content_id)),
    contentDigests: Object.freeze(intakePlan.items.map((item) => item.content_digest)),
  });
}

function committedEvidence(verified) {
  return {
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
  };
}

// Replays an operation that already exists. Only an applied operation is
// resumable, and that is checked first. Every stop is raised as a fault; the
// caller turns each into readback when the operation is past dispatch.
async function replayExistingOperation({
  env,
  db,
  transport,
  trustedAuth,
  candidate,
  expectedPublicationAuthority,
  normalized,
  operationId,
  existingOperation,
  recordedAt,
  verifyRuntime,
  resumeMutation,
}) {
  // Read-only. A non-resumable operation stops here, before any safety read or
  // preflight could advertise it as retryable or fixable.
  const replay = await loadReplayState(db, normalized, existingOperation);

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

  const replayAuthorityMismatch = publicationAuthorityMismatch(
    replayPreflight.observed.publicationAuthority,
    expectedPublicationAuthority,
  );
  if (replayAuthorityMismatch) {
    throw productionFault(
      'PRE_DISPATCH_REPLAN_REQUIRED',
      replayAuthorityMismatch,
      { httpStatus: 409, retryable: true },
    );
  }

  const mutation = await resumeMutation({
    intakePlan: replay.intakePlan,
    controlPlan: replay.controlPlan,
    runtimeRevision: replay.runtimeRevision,
    transport,
    recordedAt,
  });

  if (!['applied', 'already_applied'].includes(mutation?.status)) {
    throw productionFault(
      'POST_DISPATCH_READBACK_AMBIGUOUS',
      'production applied-operation resume did not produce exact completion (status ' +
        String(mutation?.status) + ', phase ' + String(mutation?.phase) + ', class ' +
        String(mutation?.fault_class ?? mutation?.error_class ?? 'unknown') + ')',
      { httpStatus: 409, requiresReadback: true },
    );
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
    planned: plannedIdentity(operationId, replay.intakePlan),
    mutation,
    ...committedEvidence(verified),
  });
}

// Pure request authorization and identity: no D1, network, or clock. The
// Worker and the operator CLI share it so observe mode reports the same
// operation identity that apply will claim.
export function authorizeProductionIntakeInput(
  payload,
  {
    ownerPublicKeyPem,
    verifyOwnerApproval = assertAuthenticatedOwnerApprovalForCandidate,
    normalizeInput = normalizeIntakeInput,
    deriveOperationId = intakeMutationOperationId,
  } = {},
) {
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
    assertSourceModeConsistency(input, sourceMode);
    const authorizedInput = sourceMode === 'automated'
      ? authorizeAutomatedInput({
          raw: input,
          mode,
          ownerApproval: payload?.ownerApproval ?? null,
          approvedCandidate: payload?.approvedCandidate ?? null,
          ownerApprovalDigest: payload?.ownerApprovalDigest ?? null,
          ownerPublicKeyPem,
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
      sourceMode === 'automated' || error?.authorizationModeMismatch === true
        ? 'INVALID_OWNER_APPROVAL'
        : 'INVALID_INTAKE',
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

  const operationId = deriveOperationId({
    batchDigest: normalized.batch_digest,
    targetAccount: DEFAULT_TARGET_ACCOUNT,
    contentIds: normalized.items.map((item) => item.content_id),
  });

  return Object.freeze({ mode, sourceMode, normalized, operationId });
}

export async function runProductionIntakeRequest(
  env,
  payload,
  {
    verifyRuntime = verifyDynamicRuntime,
    verifyAuth = verifyCloudflareApiToken,
    verifyOwnerApproval = assertAuthenticatedOwnerApprovalForCandidate,
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
  const expectedPublicationAuthority = payload?.expectedPublicationAuthority;
  if (!validPublicationAuthorityEvidence(expectedPublicationAuthority)) {
    throw productionFault(
      'INVALID_PUBLICATION_AUTHORITY_EVIDENCE',
      'production intake requires the operator-verified publication authority ' +
        '(generation, candidate_sha, deployment_id)',
      { httpStatus: 400 },
    );
  }
  const { normalized, operationId } = authorizeProductionIntakeInput(payload, {
    ownerPublicKeyPem: env?.OWNER_APPROVAL_PUBLIC_KEY_PEM,
    verifyOwnerApproval,
    normalizeInput,
    deriveOperationId,
  });

  const recordedAt = now().toISOString();
  const trustedAuth = await trustedProductionAuth(env, verifyAuth, fetchImpl);
  const transport = productionTransport(env, db, createTransport, fetchImpl);

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
    // The runner's own rule (and the re-plan trigger's): any effect state but
    // 'none' is past dispatch, and an unknown state fails closed. Past
    // dispatch, every way the replay can stop requires readback, so the rule is
    // applied once here rather than at each step.
    const pastDispatch = existingOperation.effect_state !== 'none';
    try {
      return await replayExistingOperation({
        env,
        db,
        transport,
        trustedAuth,
        candidate,
        expectedPublicationAuthority,
        normalized,
        operationId,
        existingOperation,
        recordedAt,
        verifyRuntime,
        resumeMutation,
      });
    } catch (error) {
      if (!pastDispatch || error?.faultClass === 'POST_DISPATCH_READBACK_AMBIGUOUS') throw error;
      throw productionFault(
        'POST_DISPATCH_READBACK_AMBIGUOUS',
        'replay of ' + existingOperation.effect_state + ' operation stopped: ' +
          (error instanceof Error ? error.message : String(error)),
        { httpStatus: 409, requiresReadback: true },
      );
    }
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
    throw preDispatchRuntimeFault(before);
  }

  let frontier;
  let activeAssignments;
  let contentIndex;
  try {
    [frontier, activeAssignments, contentIndex] = await Promise.all([
      first(db, FRONTIER_SQL),
      all(db, ACTIVE_ASSIGNMENTS_SQL),
      readContentConflicts(db, normalized.items),
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

  let occupied;
  try {
    occupied = await readPublicationOccupancy({ db, intakePlan });
  } catch (error) {
    throw productionFault(
      'PRE_DISPATCH_STATE_UNAVAILABLE',
      error instanceof Error ? error.message : String(error),
      { httpStatus: 503, retryable: true },
    );
  }
  if (occupied.length > 0) {
    throw productionFault(
      'PRE_DISPATCH_STATE_CONFLICT',
      'planned intake collides with existing publication_state rows: ' +
        occupied.slice(0, 8).map((row) => row.post_id + '@' + row.scheduled_at).join(','),
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

  // The guarded runner reports every known outcome as a result. An exception
  // means an unexpected failure at an unknown point, possibly after the
  // atomic apply committed, so it always requires readback.
  let mutation;
  try {
    mutation = await runMutation({
      environment: 'production',
      auth: trustedAuth,
      candidate,
      transport,
      expectedPublicationAuthority,
      intakePlan,
      controlPlan,
      runtimeRevision,
      recordedAt,
    });
  } catch (error) {
    throw productionFault(
      'POST_DISPATCH_READBACK_AMBIGUOUS',
      'guarded mutation runner failed unexpectedly: ' +
        (error instanceof Error ? error.message : String(error)),
      { httpStatus: 409, requiresReadback: true },
    );
  }

  const planned = plannedIdentity(controlPlan.operation_id, intakePlan);

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
    ...committedEvidence(verified),
    before: Object.freeze({
      generation: before.generation,
      revisionDigest: before.revisionDigest,
    }),
  });
}

// The values wrangler actually bound, so the operator CLI can prove they equal
// the committed descriptor before it sends any credential-bearing request.
// wrangler dev lets same-named process.env or .env entries override vars.
function boundTrustRoot(env) {
  let ownerApprovalKeyFingerprint = null;
  try {
    if (typeof env?.OWNER_APPROVAL_PUBLIC_KEY_PEM === 'string') {
      ownerApprovalKeyFingerprint = ownerPublicKeyFingerprint(env.OWNER_APPROVAL_PUBLIC_KEY_PEM);
    }
  } catch {
    ownerApprovalKeyFingerprint = null;
  }
  return Object.freeze({
    accountId: typeof env?.CLOUDFLARE_ACCOUNT_ID === 'string' ? env.CLOUDFLARE_ACCOUNT_ID : null,
    productionDatabaseId:
      typeof env?.XQUEUE_PRODUCTION_DATABASE_ID === 'string' ? env.XQUEUE_PRODUCTION_DATABASE_ID : null,
    ownerApprovalKeyFingerprint,
    // Names only, never values, so the operator can refuse a Worker that bound
    // anything beyond its descriptor (for example X credentials).
    bindingNames: Object.freeze(Object.keys(env ?? {}).sort()),
    // Presence only, never values: a wrangler switch in the operator shell can
    // stop secrets from loading while the vars still look correct.
    secretsBound: Object.freeze({
      MUTATION_D1_API_TOKEN:
        typeof env?.MUTATION_D1_API_TOKEN === 'string' && env.MUTATION_D1_API_TOKEN.length > 0,
      MUTATION_CONTROL_TOKEN:
        typeof env?.MUTATION_CONTROL_TOKEN === 'string' && env.MUTATION_CONTROL_TOKEN.length > 0,
    }),
  });
}

const WORKER_IDENTITY = Object.freeze({
  service: 'xqueue-mutation-production-intake',
  role: 'production-mutation-intake',
  environment: 'production',
  publicationCapable: false,
  schedulerAuthority: false,
});

// Refusals carry the Worker identity so the operator can tell a definitive
// Worker answer, which never reached D1, from a failure outside the Worker.
function refusal(httpStatus, faultClass) {
  return json({
    ...WORKER_IDENTITY,
    status: 'error',
    faultClass,
    retryable: false,
    requiresReadback: false,
    error: faultClass.toLowerCase(),
  }, { status: httpStatus });
}

export function createMutationProductionIntakeWorker(dependencies = {}) {
  return {
    async fetch(request, env) {
      const url = new URL(request.url);

      if (url.pathname === '/health') {
        // Readiness only. Bindings are reported by /identity, bound to a proof
        // that the responder holds this launch's control token.
        return json({ ...WORKER_IDENTITY, status: 'ok' });
      }

      if (url.pathname === '/identity') {
        if (request.method !== 'GET') return refusal(405, 'METHOD_NOT_ALLOWED');
        const challenge = url.searchParams.get('challenge') ?? '';
        if (!IDENTITY_CHALLENGE_RE.test(challenge)) return refusal(400, 'INVALID_CHALLENGE');
        let token;
        try {
          token = requiredSecret(env?.MUTATION_CONTROL_TOKEN, 'MUTATION_CONTROL_TOKEN');
        } catch {
          return refusal(503, 'CONTROL_TOKEN_UNAVAILABLE');
        }
        const bindings = boundTrustRoot(env);
        return json({
          ...WORKER_IDENTITY,
          status: 'ok',
          challenge,
          bindings,
          challengeResponse: await identityProof(token, challenge, bindings),
        });
      }

      if (url.pathname !== '/production-intake') return refusal(404, 'NOT_FOUND');
      if (request.method !== 'POST') return refusal(405, 'METHOD_NOT_ALLOWED');

      let isAuthenticated = false;
      try {
        isAuthenticated = await authenticated(request, env);
      } catch {
        isAuthenticated = false;
      }
      if (!isAuthenticated) return refusal(401, 'UNAUTHORIZED');

      let payload;
      try {
        payload = await request.json();
      } catch {
        return json({
          ...WORKER_IDENTITY,
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
          const retryableRunnerRead =
            !postDispatch &&
            ['initial_readback', 'preflight_read', 'checkpoint'].includes(phase) &&
            result.mutation?.decision?.outcome === 'AUTO_RETRY';
          const transientPreDispatch =
            !postDispatch &&
            (
              (
                result.mutation?.fault_class === 'PRE_DISPATCH_STATE_UNAVAILABLE' &&
                result.mutation?.retryable === true
              ) ||
              retryableRunnerRead
            );
          // An authority change since operator verification needs a fresh
          // preflight and is retryable on every path, fresh or replay.
          const replanRequired =
            !postDispatch &&
            result.mutation?.fault_class === 'PRE_DISPATCH_REPLAN_REQUIRED' &&
            result.mutation?.retryable === true;
          return json({
            ...WORKER_IDENTITY,
            status: 'blocked',
            faultClass: postDispatch
              ? 'POST_DISPATCH_RECONCILIATION_REQUIRED'
              : (
                  result.mutation?.fault_class ??
                  result.mutation?.error_class ??
                  'MUTATION_BLOCKED'
                ),
            retryable:
              transientPreDispatch ||
              replanRequired ||
              (!postDispatch && result.mutation?.decision?.outcome === 'AUTO_RETRY'),
            requiresReadback: postDispatch,
            ...result,
          }, { status: transientPreDispatch ? 503 : 409 });
        }

        return json({
          ...WORKER_IDENTITY,
          status: 'ok',
          retryable: false,
          requiresReadback: false,
          ...result,
        });
      } catch (error) {
        const fault = faultDescriptor(error);
        return json({
          ...WORKER_IDENTITY,
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
