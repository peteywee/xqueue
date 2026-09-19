import { createHash } from 'node:crypto';

import { resolveUniqueWallClock } from './schedule-slot.mjs';

export const INTAKE_FORMAT = 1;
export const INTAKE_SCHEMA_MIGRATION = '0007_continuous_queue_intake.sql';
export const DEFAULT_TARGET_ACCOUNT = 'x-primary';
export const PREMIUM_TEXT_LIMIT = 25000;

const CONTENT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const PILLARS = new Set(['A', 'B', 'C', 'D']);
const OP_STATUSES = new Set([
  'planned',
  'claimed',
  'needs_reconciliation',
  'stale',
  'complete',
]);

export function sha256Hex(value) {
  return createHash('sha256')
    .update(Buffer.from(String(value), 'utf8'))
    .digest('hex');
}

function requiredString(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label} is required`);
  }
  return value;
}

function canonicalInstant(value, label) {
  requiredString(value, label);
  const ms = Date.parse(value);
  if (!Number.isFinite(ms) || new Date(ms).toISOString() !== value) {
    throw new Error(`${label} must be canonical ISO-8601 UTC with milliseconds`);
  }
  return value;
}

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  return value;
}

function ymdParts(instant, timezone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(instant));

  const value = Object.fromEntries(
    parts.filter((part) => part.type !== 'literal')
      .map((part) => [part.type, part.value]),
  );
  return `${value.year}-${value.month}-${value.day}`;
}

function addDays(dateISO, days = 1) {
  const d = new Date(`${dateISO}T12:00:00.000Z`);
  if (!Number.isFinite(d.getTime())) throw new Error('invalid local date');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function dayOfWeek(dateISO) {
  return new Date(`${dateISO}T12:00:00.000Z`).getUTCDay();
}

function slotLabel(index) {
  if (index === 0) return 'lull';
  if (index === 1) return 'post-close';
  return `slot-${index + 1}`;
}

function normalizePolicy(policy) {
  if (!policy || typeof policy !== 'object' || Array.isArray(policy)) {
    throw new Error('schedule policy is required');
  }

  const version = positiveInteger(policy.version, 'policy version');
  const timezone = requiredString(policy.timezone, 'policy timezone');
  const slots = Array.isArray(policy.slots) ? [...policy.slots] : [];
  const daysOfWeek = Array.isArray(policy.daysOfWeek) ? [...policy.daysOfWeek] : [];

  if (slots.length === 0 || slots.some((slot) => !/^\d{2}:\d{2}$/.test(slot))) {
    throw new Error('policy slots must be HH:MM strings');
  }
  if (
    daysOfWeek.length === 0 ||
    daysOfWeek.some((day) => !Number.isSafeInteger(day) || day < 0 || day > 6)
  ) {
    throw new Error('policy daysOfWeek are invalid');
  }

  return Object.freeze({ version, timezone, slots, daysOfWeek });
}

function normalizeSourceMode(item, defaults) {
  const sourceMode = item.source_mode ?? defaults.sourceMode ?? 'owner-manual';
  if (!['owner-manual', 'automated'].includes(sourceMode)) {
    throw new Error('source_mode must be owner-manual or automated');
  }

  const ownerApprovalDigest =
    item.owner_approval_digest ?? defaults.ownerApprovalDigest ?? null;

  if (
    sourceMode === 'automated' &&
    (typeof ownerApprovalDigest !== 'string' || ownerApprovalDigest.length < 16)
  ) {
    throw new Error('automated intake requires owner_approval_digest');
  }

  return { sourceMode, ownerApprovalDigest };
}

function normalizeItem(raw, index, defaults) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`item ${index + 1} must be an object`);
  }

  const body = requiredString(raw.body, `item ${index + 1} body`);
  if (body.length > PREMIUM_TEXT_LIMIT) {
    throw new Error(
      `item ${index + 1} is too long: ${body.length} > ${PREMIUM_TEXT_LIMIT}`,
    );
  }

  const pillar = requiredString(raw.pillar, `item ${index + 1} pillar`);
  if (!PILLARS.has(pillar)) {
    throw new Error(`item ${index + 1} pillar must be A, B, C, or D`);
  }
  if (pillar === 'B' && !/not legal advice/i.test(body)) {
    throw new Error(
      `item ${index + 1} pillar B body must already include the approved legal disclaimer`,
    );
  }

  if (raw.figure !== null && raw.figure !== undefined) {
    throw new Error(
      `item ${index + 1} media intake is not active in #89; omit figure/media metadata`,
    );
  }

  const contentDigest = sha256Hex(body);
  const suppliedId = raw.content_id ?? raw.id ?? null;
  const contentId = suppliedId == null
    ? `CQ-${contentDigest.slice(0, 20).toUpperCase()}`
    : requiredString(suppliedId, `item ${index + 1} content_id`);

  if (!CONTENT_ID_RE.test(contentId)) {
    throw new Error(`item ${index + 1} content_id is invalid`);
  }

  const title =
    raw.title === undefined || raw.title === null
      ? ''
      : String(raw.title);

  const sourceRef =
    raw.source_ref === undefined || raw.source_ref === null
      ? null
      : String(raw.source_ref);

  const { sourceMode, ownerApprovalDigest } = normalizeSourceMode(raw, defaults);

  return Object.freeze({
    ordinal: index,
    content_id: contentId,
    pillar,
    title,
    body,
    publication_text: body,
    content_digest: contentDigest,
    source_ref: sourceRef,
    source_mode: sourceMode,
    owner_approval_digest: ownerApprovalDigest,
  });
}

export function normalizeIntakeInput(
  raw,
  {
    mode = 'batch',
    sourceMode = 'owner-manual',
    ownerApprovalDigest = null,
  } = {},
) {
  let source;
  if (Array.isArray(raw)) source = raw;
  else if (raw?.items && Array.isArray(raw.items)) source = raw.items;
  else if (raw && typeof raw === 'object') source = [raw];
  else throw new Error('intake input must be an object, array, or {items:[...]}');

  if (source.length === 0) throw new Error('intake batch is empty');
  if (mode === 'single' && source.length !== 1) {
    throw new Error('single intake requires exactly one item');
  }

  const items = source.map((item, index) =>
    normalizeItem(item, index, { sourceMode, ownerApprovalDigest }),
  );

  const ids = new Set();
  const digests = new Map();
  for (const item of items) {
    if (ids.has(item.content_id)) {
      throw new Error(`duplicate content_id in batch: ${item.content_id}`);
    }
    ids.add(item.content_id);

    const priorId = digests.get(item.content_digest);
    if (priorId && priorId !== item.content_id) {
      throw new Error(
        `duplicate exact content under different identities: ${priorId}, ${item.content_id}`,
      );
    }
    digests.set(item.content_digest, item.content_id);
  }

  const manifest = {
    format: INTAKE_FORMAT,
    items: items.map((item) => ({
      content_id: item.content_id,
      pillar: item.pillar,
      title: item.title,
      body: item.body,
      source_ref: item.source_ref,
      source_mode: item.source_mode,
      owner_approval_digest: item.owner_approval_digest,
    })),
  };
  const batchDigest = sha256Hex(JSON.stringify(manifest));

  return Object.freeze({
    format: INTAKE_FORMAT,
    batch_digest: batchDigest,
    count: items.length,
    items,
  });
}

export function allocateAppendSlots({
  frontierResolvedAt,
  count,
  policy,
}) {
  const frontier = canonicalInstant(frontierResolvedAt, 'frontier resolved_at');
  positiveInteger(count, 'slot count');
  const cfg = normalizePolicy(policy);

  const slots = [];
  let date = ymdParts(frontier, cfg.timezone);
  let guard = 0;

  while (slots.length < count) {
    guard++;
    if (guard > 3700) throw new Error('unable to allocate append slots');

    if (cfg.daysOfWeek.includes(dayOfWeek(date))) {
      for (let index = 0; index < cfg.slots.length && slots.length < count; index++) {
        const time = cfg.slots[index];
        const resolvedAt = resolveUniqueWallClock({
          scheduledDate: date,
          scheduledTime: time,
          timezone: cfg.timezone,
        }).toISOString();

        if (resolvedAt <= frontier) continue;

        slots.push(Object.freeze({
          resolved_at: resolvedAt,
          scheduled_date: date,
          scheduled_time: time,
          timezone: cfg.timezone,
          slot_label: slotLabel(index),
        }));
      }
    }

    date = addDays(date);
  }

  return slots;
}

export function hashAssignmentRows(rows) {
  if (!Array.isArray(rows)) throw new Error('assignment rows must be an array');
  const canonical = [...rows].sort((a, b) =>
    JSON.stringify(a).localeCompare(JSON.stringify(b)),
  );
  return sha256Hex(JSON.stringify(canonical));
}

export function planIntake({
  normalized,
  frontier,
  policy,
  existingContent = [],
  existingDigests = [],
  baselineAssignmentHash,
  targetAccount = DEFAULT_TARGET_ACCOUNT,
}) {
  if (!normalized || normalized.format !== INTAKE_FORMAT) {
    throw new Error('normalized intake input is required');
  }
  if (!frontier || typeof frontier !== 'object') {
    throw new Error('frontier snapshot is required');
  }

  const frontierGeneration = positiveInteger(
    Number(frontier.generation),
    'frontier generation',
  );
  const frontierResolvedAt = canonicalInstant(
    frontier.resolved_at,
    'frontier resolved_at',
  );
  if (frontier.pending_operation_id) {
    throw new Error(
      `intake frontier is blocked by pending operation ${frontier.pending_operation_id}`,
    );
  }
  if (!/^[a-f0-9]{64}$/.test(String(baselineAssignmentHash ?? ''))) {
    throw new Error('baseline assignment hash is required');
  }
  requiredString(targetAccount, 'target account');

  const inputIds = new Set(normalized.items.map((item) => item.content_id));
  const inputDigests = new Set(normalized.items.map((item) => item.content_digest));

  for (const row of existingContent) {
    if (inputIds.has(row.content_id)) {
      throw new Error(`content_id already exists: ${row.content_id}`);
    }
  }
  for (const row of existingDigests) {
    if (inputDigests.has(row.content_digest)) {
      throw new Error(
        `exact content digest already exists under ${row.content_id}`,
      );
    }
  }

  const cfg = normalizePolicy(policy);
  const slots = allocateAppendSlots({
    frontierResolvedAt,
    count: normalized.count,
    policy: cfg,
  });

  const items = normalized.items.map((item, index) => Object.freeze({
    ...item,
    assignment_id: item.content_id,
    assignment_version: 1,
    content_revision: 1,
    target_account: targetAccount,
    policy_version: cfg.version,
    ...slots[index],
  }));

  const proposedFrontier = items.at(-1).resolved_at;
  const planMaterial = {
    format: INTAKE_FORMAT,
    batch_digest: normalized.batch_digest,
    expected_frontier_generation: frontierGeneration,
    expected_frontier_resolved_at: frontierResolvedAt,
    proposed_frontier_resolved_at: proposedFrontier,
    baseline_assignment_hash: baselineAssignmentHash,
    target_account: targetAccount,
    policy_version: cfg.version,
    items: items.map((item) => ({
      ordinal: item.ordinal,
      content_id: item.content_id,
      content_digest: item.content_digest,
      resolved_at: item.resolved_at,
      scheduled_date: item.scheduled_date,
      scheduled_time: item.scheduled_time,
      timezone: item.timezone,
      slot_label: item.slot_label,
    })),
  };
  const planDigest = sha256Hex(JSON.stringify(planMaterial));

  return Object.freeze({
    ...planMaterial,
    plan_digest: planDigest,
    operation_id: `intake-${planDigest.slice(0, 24)}`,
    count: items.length,
    items,
  });
}

function sqlString(value) {
  if (value === null || value === undefined) return 'NULL';
  return `'${String(value).replaceAll("'", "''")}'`;
}

function sqlInteger(value) {
  if (!Number.isSafeInteger(value)) throw new Error('invalid SQL integer');
  return String(value);
}

export function renderOperationCreateSql(plan, recordedAt) {
  canonicalInstant(recordedAt, 'recordedAt');

  const lines = [
    'INSERT OR IGNORE INTO queue_intake_operations (',
    '  operation_id, plan_digest, batch_digest, item_count,',
    '  expected_frontier_generation, expected_frontier_resolved_at,',
    '  proposed_frontier_resolved_at, baseline_assignment_hash,',
    '  status, created_at, updated_at',
    ') VALUES (',
    [
      sqlString(plan.operation_id),
      sqlString(plan.plan_digest),
      sqlString(plan.batch_digest),
      sqlInteger(plan.count),
      sqlInteger(plan.expected_frontier_generation),
      sqlString(plan.expected_frontier_resolved_at),
      sqlString(plan.proposed_frontier_resolved_at),
      sqlString(plan.baseline_assignment_hash),
      sqlString('planned'),
      sqlString(recordedAt),
      sqlString(recordedAt),
    ].join(', '),
    ');',
    '',
  ];

  for (const item of plan.items) {
    lines.push(
      'INSERT OR IGNORE INTO queue_intake_items ' +
      '(operation_id, ordinal, content_id, content_digest, pillar, title, source_ref, ' +
      'resolved_at, scheduled_date, scheduled_time, timezone, slot_label) VALUES (' +
      [
        sqlString(plan.operation_id),
        sqlInteger(item.ordinal),
        sqlString(item.content_id),
        sqlString(item.content_digest),
        sqlString(item.pillar),
        sqlString(item.title),
        sqlString(item.source_ref),
        sqlString(item.resolved_at),
        sqlString(item.scheduled_date),
        sqlString(item.scheduled_time),
        sqlString(item.timezone),
        sqlString(item.slot_label),
      ].join(', ') +
      ');',
    );
  }

  return `${lines.join('\n')}\n`;
}

export function renderFrontierClaimSql(plan, recordedAt) {
  canonicalInstant(recordedAt, 'recordedAt');
  return (
    'UPDATE queue_intake_frontier SET ' +
    `generation = generation + 1, resolved_at = ${sqlString(plan.proposed_frontier_resolved_at)}, ` +
    `pending_operation_id = ${sqlString(plan.operation_id)}, updated_at = ${sqlString(recordedAt)} ` +
    'WHERE singleton_id = 1 ' +
    `AND generation = ${sqlInteger(plan.expected_frontier_generation)} ` +
    `AND resolved_at = ${sqlString(plan.expected_frontier_resolved_at)} ` +
    'AND pending_operation_id IS NULL;\n'
  );
}

export function renderOperationStatusSql(operationId, status, recordedAt) {
  requiredString(operationId, 'operationId');
  if (!OP_STATUSES.has(status)) throw new Error('invalid operation status');
  canonicalInstant(recordedAt, 'recordedAt');
  return (
    'UPDATE queue_intake_operations SET ' +
    `status = ${sqlString(status)}, updated_at = ${sqlString(recordedAt)} ` +
    `WHERE operation_id = ${sqlString(operationId)};\n`
  );
}

export function renderFrontierReleaseSql(plan, recordedAt) {
  canonicalInstant(recordedAt, 'recordedAt');
  return (
    'UPDATE queue_intake_frontier SET ' +
    'pending_operation_id = NULL, ' +
    `last_completed_operation_id = ${sqlString(plan.operation_id)}, ` +
    `updated_at = ${sqlString(recordedAt)} ` +
    'WHERE singleton_id = 1 ' +
    `AND generation = ${sqlInteger(plan.expected_frontier_generation + 1)} ` +
    `AND resolved_at = ${sqlString(plan.proposed_frontier_resolved_at)} ` +
    `AND pending_operation_id = ${sqlString(plan.operation_id)};\n`
  );
}

export function renderItemApplySql(plan, item, recordedAt) {
  canonicalInstant(recordedAt, 'recordedAt');
  const contentEventDetail = JSON.stringify({
    operationId: plan.operation_id,
    batchDigest: plan.batch_digest,
    contentDigest: item.content_digest,
  });
  const assignmentEventDetail = JSON.stringify({
    operationId: plan.operation_id,
    batchDigest: plan.batch_digest,
    contentDigest: item.content_digest,
    policyVersion: item.policy_version,
    resolvedAt: item.resolved_at,
  });

  return [
    'INSERT OR IGNORE INTO queue_content ' +
      '(content_id, pillar, current_revision, status, generation, created_at, updated_at, intake_state) VALUES (' +
      [
        sqlString(item.content_id),
        sqlString(item.pillar),
        '1',
        sqlString('active'),
        '1',
        sqlString(recordedAt),
        sqlString(recordedAt),
        sqlString('approved_unscheduled'),
      ].join(', ') +
      ');',
    'INSERT OR IGNORE INTO queue_content_revisions ' +
      '(content_id, revision, title, body, publication_text, content_digest, figure, source_ref, created_at) VALUES (' +
      [
        sqlString(item.content_id),
        '1',
        sqlString(item.title),
        sqlString(item.body),
        sqlString(item.publication_text),
        sqlString(item.content_digest),
        'NULL',
        sqlString(item.source_ref),
        sqlString(recordedAt),
      ].join(', ') +
      ');',
    'INSERT INTO queue_content_events (content_id, revision, event_type, event_at, detail) ' +
      'SELECT ' +
      [
        sqlString(item.content_id),
        '1',
        sqlString('intake_accepted'),
        sqlString(recordedAt),
        sqlString(contentEventDetail),
      ].join(', ') +
      ' WHERE NOT EXISTS (' +
      'SELECT 1 FROM queue_content_events WHERE content_id = ' +
      sqlString(item.content_id) +
      ' AND revision = 1 AND event_type = ' +
      sqlString('intake_accepted') +
      ' AND detail = ' +
      sqlString(contentEventDetail) +
      ');',
    'INSERT OR IGNORE INTO queue_assignments ' +
      '(assignment_id, assignment_version, content_id, content_revision, content_digest, ' +
      'target_account, policy_version, resolved_at, scheduled_date, scheduled_time, timezone, ' +
      'slot_label, status, superseded_by_version, generation, created_at, updated_at) VALUES (' +
      [
        sqlString(item.assignment_id),
        '1',
        sqlString(item.content_id),
        '1',
        sqlString(item.content_digest),
        sqlString(item.target_account),
        sqlInteger(item.policy_version),
        sqlString(item.resolved_at),
        sqlString(item.scheduled_date),
        sqlString(item.scheduled_time),
        sqlString(item.timezone),
        sqlString(item.slot_label),
        sqlString('active'),
        'NULL',
        '1',
        sqlString(recordedAt),
        sqlString(recordedAt),
      ].join(', ') +
      ');',
    'INSERT INTO queue_assignment_events ' +
      '(assignment_id, assignment_version, event_type, event_at, detail) ' +
      'SELECT ' +
      [
        sqlString(item.assignment_id),
        '1',
        sqlString('intake_assigned'),
        sqlString(recordedAt),
        sqlString(assignmentEventDetail),
      ].join(', ') +
      ' WHERE NOT EXISTS (' +
      'SELECT 1 FROM queue_assignment_events WHERE assignment_id = ' +
      sqlString(item.assignment_id) +
      ' AND assignment_version = 1 AND event_type = ' +
      sqlString('intake_assigned') +
      ' AND detail = ' +
      sqlString(assignmentEventDetail) +
      ');',
    'UPDATE queue_content SET intake_state = ' +
      sqlString('scheduled') +
      ', updated_at = ' +
      sqlString(recordedAt) +
      ' WHERE content_id = ' +
      sqlString(item.content_id) +
      ' AND EXISTS (' +
      'SELECT 1 FROM queue_assignments WHERE assignment_id = ' +
      sqlString(item.assignment_id) +
      ' AND assignment_version = 1 AND content_id = ' +
      sqlString(item.content_id) +
      ' AND content_digest = ' +
      sqlString(item.content_digest) +
      ' AND resolved_at = ' +
      sqlString(item.resolved_at) +
      " AND status = 'active');",
    '',
  ].join('\n');
}

function equal(actual, expected) {
  return actual === expected ||
    (actual === null && expected === undefined) ||
    (actual === undefined && expected === null);
}

function fieldsMatch(actual, expected, fields) {
  return fields.every((field) => equal(actual?.[field], expected?.[field]));
}

export function classifyItemReadback(item, readback) {
  const content = readback?.content ?? null;
  const revision = readback?.revision ?? null;
  const assignment = readback?.assignment ?? null;

  if (!content && !revision && !assignment) return 'missing';

  const contentExact = fieldsMatch(content, {
    content_id: item.content_id,
    pillar: item.pillar,
    current_revision: 1,
    status: 'active',
  }, ['content_id', 'pillar', 'current_revision', 'status']);

  const revisionExact = fieldsMatch(revision, {
    content_id: item.content_id,
    revision: 1,
    title: item.title,
    body: item.body,
    publication_text: item.publication_text,
    content_digest: item.content_digest,
    figure: null,
    source_ref: item.source_ref,
  }, [
    'content_id',
    'revision',
    'title',
    'body',
    'publication_text',
    'content_digest',
    'figure',
    'source_ref',
  ]);

  const assignmentExact = fieldsMatch(assignment, {
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
    slot_label: item.slot_label,
    status: 'active',
    superseded_by_version: null,
  }, [
    'assignment_id',
    'assignment_version',
    'content_id',
    'content_revision',
    'content_digest',
    'target_account',
    'policy_version',
    'resolved_at',
    'scheduled_date',
    'scheduled_time',
    'timezone',
    'slot_label',
    'status',
    'superseded_by_version',
  ]);

  if (
    contentExact &&
    revisionExact &&
    !assignment &&
    content?.intake_state === 'approved_unscheduled'
  ) {
    return 'approved_unscheduled';
  }

  if (
    contentExact &&
    revisionExact &&
    assignmentExact &&
    content?.intake_state === 'scheduled'
  ) {
    return 'complete';
  }

  return 'conflict';
}

export function assertOperationMatchesPlan(operation, plan) {
  if (!operation) throw new Error('intake operation is missing');
  const expected = {
    operation_id: plan.operation_id,
    plan_digest: plan.plan_digest,
    batch_digest: plan.batch_digest,
    item_count: plan.count,
    expected_frontier_generation: plan.expected_frontier_generation,
    expected_frontier_resolved_at: plan.expected_frontier_resolved_at,
    proposed_frontier_resolved_at: plan.proposed_frontier_resolved_at,
    baseline_assignment_hash: plan.baseline_assignment_hash,
  };
  for (const [key, value] of Object.entries(expected)) {
    if (!equal(operation[key], value)) {
      throw new Error(`intake operation ${key} mismatch`);
    }
  }
  return true;
}

export function verifyReplayInput(normalized, operationItems) {
  if (!Array.isArray(operationItems) || operationItems.length !== normalized.count) {
    throw new Error('completed intake operation item count mismatch');
  }

  const ordered = [...operationItems].sort(
    (a, b) => Number(a.ordinal) - Number(b.ordinal),
  );
  for (let i = 0; i < normalized.items.length; i++) {
    const input = normalized.items[i];
    const stored = ordered[i];
    for (const key of ['content_id', 'content_digest', 'pillar', 'title', 'source_ref']) {
      if (!equal(stored?.[key], input[key])) {
        throw new Error(`completed replay item ${i + 1} ${key} mismatch`);
      }
    }
  }
  return true;
}

export async function executeIntakePlan({
  plan,
  transport,
  recordedAt = new Date().toISOString(),
}) {
  canonicalInstant(recordedAt, 'recordedAt');
  if (!transport || typeof transport !== 'object') {
    throw new Error('intake transport is required');
  }

  let operation = await transport.readOperation(plan.operation_id);

  if (!operation) {
    try {
      await transport.createOperation(plan, recordedAt);
    } catch {
      // A lost response is not permission to repeat. Read back first.
    }
    operation = await transport.readOperation(plan.operation_id);
    if (!operation) {
      throw new Error('intake operation creation is ambiguous; rerun for readback');
    }
  }

  assertOperationMatchesPlan(operation, plan);

  if (operation.status === 'stale') {
    throw new Error('intake plan is stale; perform a fresh dry run');
  }
  if (operation.status === 'complete') {
    return Object.freeze({ status: 'already_applied', operation_id: plan.operation_id });
  }

  let frontier = await transport.readFrontier();

  if (frontier.pending_operation_id !== plan.operation_id) {
    const matchesExpected =
      Number(frontier.generation) === plan.expected_frontier_generation &&
      frontier.resolved_at === plan.expected_frontier_resolved_at &&
      frontier.pending_operation_id == null;

    if (!matchesExpected) {
      await transport.markOperation(plan.operation_id, 'stale', recordedAt);
      throw new Error('intake frontier changed after dry run; plan is stale');
    }

    try {
      await transport.claimFrontier(plan, recordedAt);
    } catch {
      // Ambiguous CAS: inspect the durable frontier before deciding.
    }

    frontier = await transport.readFrontier();
    const claimed =
      Number(frontier.generation) === plan.expected_frontier_generation + 1 &&
      frontier.resolved_at === plan.proposed_frontier_resolved_at &&
      frontier.pending_operation_id === plan.operation_id;

    if (!claimed) {
      const stillExpected =
        Number(frontier.generation) === plan.expected_frontier_generation &&
        frontier.resolved_at === plan.expected_frontier_resolved_at &&
        frontier.pending_operation_id == null;

      if (stillExpected) {
        await transport.markOperation(plan.operation_id, 'stale', recordedAt);
        throw new Error('intake frontier CAS did not apply; plan is stale');
      }

      await transport.markOperation(
        plan.operation_id,
        'needs_reconciliation',
        recordedAt,
      );
      throw new Error('intake frontier CAS outcome requires reconciliation');
    }
  }

  await transport.markOperation(plan.operation_id, 'claimed', recordedAt);

  for (const item of plan.items) {
    let state = classifyItemReadback(item, await transport.readItem(item));

    if (state === 'complete') continue;
    if (state === 'conflict') {
      await transport.markOperation(
        plan.operation_id,
        'needs_reconciliation',
        recordedAt,
      );
      throw new Error(`intake readback conflict for ${item.content_id}`);
    }

    // Missing or approved_unscheduled is a reconciled state, so one idempotent
    // completion attempt is allowed. A failed response is always followed by
    // readback before any future retry.
    try {
      await transport.putItem(plan, item, recordedAt);
    } catch {
      // Intentionally continue to exact readback.
    }

    state = classifyItemReadback(item, await transport.readItem(item));
    if (state !== 'complete') {
      await transport.markOperation(
        plan.operation_id,
        'needs_reconciliation',
        recordedAt,
      );
      throw new Error(
        `intake item ${item.content_id} is ${state}; exact replay may resume after readback`,
      );
    }
  }

  const afterHash = await transport.hashAssignmentsExcluding(
    plan.items.map((item) => item.content_id),
  );
  if (afterHash !== plan.baseline_assignment_hash) {
    await transport.markOperation(
      plan.operation_id,
      'needs_reconciliation',
      recordedAt,
    );
    throw new Error('pre-existing assignment set changed during intake');
  }

  await transport.markOperation(plan.operation_id, 'complete', recordedAt);

  try {
    await transport.releaseFrontier(plan, recordedAt);
  } catch {
    // Release is also reconciled by readback.
  }

  frontier = await transport.readFrontier();
  if (
    Number(frontier.generation) !== plan.expected_frontier_generation + 1 ||
    frontier.resolved_at !== plan.proposed_frontier_resolved_at ||
    frontier.pending_operation_id != null ||
    frontier.last_completed_operation_id !== plan.operation_id
  ) {
    throw new Error(
      'intake data is complete but frontier release requires exact replay reconciliation',
    );
  }

  return Object.freeze({
    status: 'applied',
    operation_id: plan.operation_id,
    batch_digest: plan.batch_digest,
    count: plan.count,
    frontier_generation: Number(frontier.generation),
    frontier_resolved_at: frontier.resolved_at,
  });
}
