import { createHash } from 'node:crypto';

import { resolveUniqueWallClock } from './schedule-slot.mjs';

export const RESCHEDULE_FORMAT = 1;
export const RESCHEDULE_SCOPE = 'dynamic-preview-until-cutover';

const SHA_RE = /^[a-f0-9]{64}$/;

function sha256Hex(value) {
  return createHash('sha256').update(Buffer.from(String(value), 'utf8')).digest('hex');
}

function requiredString(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(label + ' is required');
  }
  return value;
}

function positiveInteger(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) {
    throw new Error(label + ' must be a positive integer');
  }
  return number;
}

function canonicalInstant(value, label) {
  requiredString(value, label);
  const ms = Date.parse(value);
  if (!Number.isFinite(ms) || new Date(ms).toISOString() !== value) {
    throw new Error(label + ' must be canonical ISO-8601 UTC with milliseconds');
  }
  return value;
}

function validDigest(value, label) {
  const digest = String(value ?? '').toLowerCase();
  if (!SHA_RE.test(digest)) throw new Error(label + ' must be sha256 hex');
  return digest;
}

function sqlString(value) {
  if (value === null || value === undefined) return 'NULL';
  return "'" + String(value).replaceAll("'", "''") + "'";
}

function sqlInteger(value) {
  const number = Number(value);
  if (!Number.isSafeInteger(number)) throw new Error('invalid SQL integer');
  return String(number);
}

function normalizeNow(now) {
  if (Object.prototype.toString.call(now) !== '[object Date]') {
    throw new Error('now must be a Date');
  }
  if (!Number.isFinite(now.getTime())) throw new Error('now must be valid');
  return now.toISOString();
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

  new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(new Date());
  return Object.freeze({ version, timezone, slots, daysOfWeek });
}

function normalizeFrontier(frontier) {
  if (!frontier || typeof frontier !== 'object') {
    throw new Error('scheduling frontier snapshot is required');
  }
  if (frontier.pending_operation_id != null) {
    throw new Error('scheduling frontier is already claimed by ' + frontier.pending_operation_id);
  }
  return Object.freeze({
    generation: positiveInteger(frontier.generation, 'frontier generation'),
    resolved_at: canonicalInstant(frontier.resolved_at, 'frontier resolved_at'),
  });
}

function normalizeRuntime(runtimeState) {
  if (!runtimeState || typeof runtimeState !== 'object') {
    throw new Error('runtime revision snapshot is required');
  }
  return Object.freeze({
    generation: positiveInteger(runtimeState.generation, 'runtime generation'),
    revision_digest: validDigest(runtimeState.revision_digest, 'runtime revision digest'),
  });
}

function normalizeDeferral(row) {
  if (!row || typeof row !== 'object') throw new Error('deferral row is required');
  if (row.assignment_status !== 'active') throw new Error('deferred assignment is not active');
  if (row.lifecycle_state !== 'deferred') throw new Error('assignment is not deferred');
  if (row.deferral_state !== 'pending_replacement') {
    throw new Error('deferral is not pending replacement');
  }
  if (row.publication_status !== 'scheduled') {
    throw new Error('publication state must remain scheduled before replacement');
  }
  if (row.publication_attempt_id != null) {
    throw new Error('publication attempt is already bound');
  }

  const normalized = {
    assignment_id: requiredString(row.assignment_id, 'assignment_id'),
    assignment_version: positiveInteger(row.assignment_version, 'assignment version'),
    assignment_generation: positiveInteger(row.assignment_generation, 'assignment generation'),
    deferral_generation: positiveInteger(row.deferral_generation, 'deferral generation'),
    publication_generation: positiveInteger(row.publication_generation, 'publication generation'),
    content_id: requiredString(row.content_id, 'content_id'),
    content_revision: positiveInteger(row.content_revision, 'content revision'),
    content_digest: validDigest(row.content_digest, 'content digest'),
    target_account: requiredString(row.target_account, 'target account'),
    prior_policy_version: positiveInteger(row.policy_version, 'prior policy version'),
    prior_resolved_at: canonicalInstant(row.prior_resolved_at, 'prior resolved_at'),
    prior_scheduled_date: requiredString(row.prior_scheduled_date, 'prior scheduled_date'),
    prior_scheduled_time: requiredString(row.prior_scheduled_time, 'prior scheduled_time'),
    prior_timezone: requiredString(row.prior_timezone, 'prior timezone'),
    prior_slot_label: row.prior_slot_label ?? null,
    pillar: requiredString(row.pillar, 'pillar'),
    intake_state: requiredString(row.intake_state, 'intake_state'),
    title: String(row.title ?? ''),
    body: requiredString(row.body, 'body'),
    publication_text: requiredString(row.publication_text, 'publication_text'),
    revision_content_digest: validDigest(row.revision_content_digest, 'revision content digest'),
    figure: row.figure == null ? null : positiveInteger(row.figure, 'figure'),
    source_ref: row.source_ref ?? null,
  };

  if (normalized.revision_content_digest !== normalized.content_digest) {
    throw new Error('deferred assignment content digest does not match revision');
  }
  return Object.freeze(normalized);
}

function ymdParts(instant, timezone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(instant));
  const value = Object.fromEntries(
    parts.filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]),
  );
  return value.year + '-' + value.month + '-' + value.day;
}

function addDays(dateISO, days = 1) {
  const date = new Date(dateISO + 'T12:00:00.000Z');
  if (!Number.isFinite(date.getTime())) throw new Error('invalid local date');
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function dayOfWeek(dateISO) {
  return new Date(dateISO + 'T12:00:00.000Z').getUTCDay();
}

function slotLabel(index) {
  if (index === 0) return 'lull';
  if (index === 1) return 'post-close';
  return 'slot-' + (index + 1);
}

function occupiedKey(targetAccount, resolvedAt) {
  return targetAccount + '\u0000' + resolvedAt;
}

function occupiedSet(rows) {
  if (!Array.isArray(rows)) throw new Error('occupied assignments must be an array');
  const set = new Set();
  for (const row of rows) {
    if (row?.status && row.status !== 'active') continue;
    if (row?.lifecycle_state && row.lifecycle_state !== 'scheduled') continue;
    set.add(occupiedKey(
      requiredString(row.target_account, 'occupied target account'),
      canonicalInstant(row.resolved_at, 'occupied resolved_at'),
    ));
  }
  return set;
}

function allocateAutomaticSlots({
  frontierResolvedAt,
  deferrals,
  policy,
  occupiedAssignments,
  now,
}) {
  const frontier = canonicalInstant(frontierResolvedAt, 'frontier resolved_at');
  const nowIso = normalizeNow(now);
  const cfg = normalizePolicy(policy);
  const occupied = occupiedSet(occupiedAssignments);
  const assigned = new Set();
  const slots = [];

  let date = ymdParts(frontier > nowIso ? frontier : nowIso, cfg.timezone);
  let guard = 0;

  while (slots.length < deferrals.length) {
    guard += 1;
    if (guard > 3700) throw new Error('unable to allocate replacement slots');

    if (cfg.daysOfWeek.includes(dayOfWeek(date))) {
      for (let index = 0; index < cfg.slots.length && slots.length < deferrals.length; index++) {
        const scheduledTime = cfg.slots[index];
        const resolvedAt = resolveUniqueWallClock({
          scheduledDate: date,
          scheduledTime,
          timezone: cfg.timezone,
        }).toISOString();

        if (resolvedAt <= frontier || resolvedAt <= nowIso) continue;

        const targetAccount = deferrals[slots.length].target_account;
        const key = occupiedKey(targetAccount, resolvedAt);
        if (occupied.has(key) || assigned.has(key)) continue;

        assigned.add(key);
        slots.push(Object.freeze({
          resolved_at: resolvedAt,
          scheduled_date: date,
          scheduled_time: scheduledTime,
          timezone: cfg.timezone,
          slot_label: slotLabel(index),
        }));
      }
    }
    date = addDays(date);
  }

  return slots;
}

function validateOwnerSlot({
  scheduledDate,
  scheduledTime,
  timezone,
  targetAccount,
  policy,
  occupiedAssignments,
  now,
}) {
  const cfg = normalizePolicy(policy);
  const date = requiredString(scheduledDate, 'owner scheduled date');
  const time = requiredString(scheduledTime, 'owner scheduled time');
  const zone = timezone == null ? cfg.timezone : requiredString(timezone, 'owner timezone');

  if (zone !== cfg.timezone) {
    throw new Error('owner placement timezone must match the active schedule policy');
  }
  if (!cfg.daysOfWeek.includes(dayOfWeek(date))) {
    throw new Error('owner placement date is not policy-valid');
  }
  const index = cfg.slots.indexOf(time);
  if (index < 0) throw new Error('owner placement time is not a policy slot');

  const resolvedAt = resolveUniqueWallClock({
    scheduledDate: date,
    scheduledTime: time,
    timezone: zone,
  }).toISOString();

  if (resolvedAt <= normalizeNow(now)) {
    throw new Error('owner placement must be in the future');
  }

  const occupied = occupiedSet(occupiedAssignments);
  if (occupied.has(occupiedKey(targetAccount, resolvedAt))) {
    throw new Error('owner placement slot is already occupied');
  }

  return Object.freeze({
    resolved_at: resolvedAt,
    scheduled_date: date,
    scheduled_time: time,
    timezone: zone,
    slot_label: slotLabel(index),
  });
}

function orderedDeferrals(rows) {
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error('at least one pending deferral is required');
  }
  return rows.map(normalizeDeferral).sort((a, b) =>
    a.prior_resolved_at.localeCompare(b.prior_resolved_at) ||
    a.content_id.localeCompare(b.content_id),
  );
}

function buildPlan({ mode, deferrals, slots, frontier, runtime, policy, reason }) {
  const cfg = normalizePolicy(policy);
  const items = deferrals.map((row, index) => Object.freeze({
    ...row,
    to_assignment_version: row.assignment_version + 1,
    policy_version: cfg.version,
    ...slots[index],
  }));

  const proposedFrontier = items.reduce(
    (max, item) => item.resolved_at > max ? item.resolved_at : max,
    frontier.resolved_at,
  );

  const planMaterial = {
    format: RESCHEDULE_FORMAT,
    mode,
    expected_frontier_generation: frontier.generation,
    expected_frontier_resolved_at: frontier.resolved_at,
    proposed_frontier_resolved_at: proposedFrontier,
    expected_runtime_generation: runtime.generation,
    expected_runtime_revision_digest: runtime.revision_digest,
    policy_version: cfg.version,
    reason,
    items: items.map((item) => ({
      assignment_id: item.assignment_id,
      from_assignment_version: item.assignment_version,
      to_assignment_version: item.to_assignment_version,
      expected_assignment_generation: item.assignment_generation,
      expected_deferral_generation: item.deferral_generation,
      expected_publication_generation: item.publication_generation,
      content_id: item.content_id,
      content_revision: item.content_revision,
      content_digest: item.content_digest,
      target_account: item.target_account,
      prior_resolved_at: item.prior_resolved_at,
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
    scope: RESCHEDULE_SCOPE,
    plan_digest: planDigest,
    operation_id: 'reschedule-' + mode + '-' + planDigest.slice(0, 24),
    count: items.length,
    items: Object.freeze(items),
  });
}

export function planAutomaticReplacements({
  deferrals,
  frontier,
  runtimeState,
  policy,
  occupiedAssignments = [],
  now = new Date(),
  reason = 'automatic_deferred_replacement',
}) {
  const ordered = orderedDeferrals(deferrals);
  const normalizedFrontier = normalizeFrontier(frontier);
  const runtime = normalizeRuntime(runtimeState);
  const slots = allocateAutomaticSlots({
    frontierResolvedAt: normalizedFrontier.resolved_at,
    deferrals: ordered,
    policy,
    occupiedAssignments,
    now,
  });

  return buildPlan({
    mode: 'automatic',
    deferrals: ordered,
    slots,
    frontier: normalizedFrontier,
    runtime,
    policy,
    reason: requiredString(reason, 'replacement reason'),
  });
}

export function planOwnerPlacement({
  deferral,
  frontier,
  runtimeState,
  policy,
  occupiedAssignments = [],
  scheduledDate,
  scheduledTime,
  timezone = null,
  now = new Date(),
  reason,
}) {
  const [normalized] = orderedDeferrals([deferral]);
  const normalizedFrontier = normalizeFrontier(frontier);
  const runtime = normalizeRuntime(runtimeState);
  const slot = validateOwnerSlot({
    scheduledDate,
    scheduledTime,
    timezone,
    targetAccount: normalized.target_account,
    policy,
    occupiedAssignments,
    now,
  });

  return buildPlan({
    mode: 'owner',
    deferrals: [normalized],
    slots: [slot],
    frontier: normalizedFrontier,
    runtime,
    policy,
    reason: requiredString(reason, 'owner placement reason'),
  });
}

function currentRuntimeGuard(plan) {
  return (
    'EXISTS (SELECT 1 FROM queue_runtime_revisions rr ' +
    'WHERE rr.generation=' + sqlInteger(plan.expected_runtime_generation) + ' ' +
    'AND rr.revision_digest=' + sqlString(plan.expected_runtime_revision_digest) + ' ' +
    'AND rr.generation=(SELECT MAX(generation) FROM queue_runtime_revisions))'
  );
}

function itemPrecondition(item) {
  return [
    'EXISTS (SELECT 1 FROM queue_assignments a WHERE ' +
      'a.assignment_id=' + sqlString(item.assignment_id) + ' ' +
      'AND a.assignment_version=' + sqlInteger(item.assignment_version) + ' ' +
      'AND a.content_id=' + sqlString(item.content_id) + ' ' +
      'AND a.content_revision=' + sqlInteger(item.content_revision) + ' ' +
      'AND a.content_digest=' + sqlString(item.content_digest) + ' ' +
      'AND a.target_account=' + sqlString(item.target_account) + ' ' +
      'AND a.generation=' + sqlInteger(item.assignment_generation) + ' ' +
      "AND a.status='active' AND a.lifecycle_state='deferred')",
    'EXISTS (SELECT 1 FROM queue_deferrals d WHERE ' +
      'd.content_id=' + sqlString(item.content_id) + ' ' +
      'AND d.assignment_id=' + sqlString(item.assignment_id) + ' ' +
      'AND d.assignment_version=' + sqlInteger(item.assignment_version) + ' ' +
      'AND d.content_revision=' + sqlInteger(item.content_revision) + ' ' +
      'AND d.content_digest=' + sqlString(item.content_digest) + ' ' +
      'AND d.generation=' + sqlInteger(item.deferral_generation) + ' ' +
      "AND d.state='pending_replacement' AND d.replacement_assignment_version IS NULL)",
    'EXISTS (SELECT 1 FROM publication_state p WHERE ' +
      'p.post_id=' + sqlString(item.content_id) + ' ' +
      'AND p.generation=' + sqlInteger(item.publication_generation) + ' ' +
      "AND p.status='scheduled' AND p.attempt_id IS NULL)",
    'EXISTS (SELECT 1 FROM queue_content c JOIN queue_content_revisions r ' +
      'ON r.content_id=c.content_id AND r.revision=c.current_revision WHERE ' +
      'c.content_id=' + sqlString(item.content_id) + " AND c.status='active' " +
      'AND c.current_revision=' + sqlInteger(item.content_revision) + ' ' +
      'AND r.content_digest=' + sqlString(item.content_digest) + ')',
    'NOT EXISTS (SELECT 1 FROM queue_assignments occupied WHERE ' +
      "occupied.status='active' AND occupied.lifecycle_state='scheduled' " +
      'AND occupied.target_account=' + sqlString(item.target_account) + ' ' +
      'AND occupied.resolved_at=' + sqlString(item.resolved_at) + ')',
  ];
}

export function renderReplacementFrontierClaimSql(plan, recordedAt) {
  canonicalInstant(recordedAt, 'recordedAt');
  const guards = [currentRuntimeGuard(plan), ...plan.items.flatMap(itemPrecondition)];

  return (
    'UPDATE queue_intake_frontier SET ' +
    'generation=generation+1, ' +
    'resolved_at=' + sqlString(plan.proposed_frontier_resolved_at) + ', ' +
    'pending_operation_id=' + sqlString(plan.operation_id) + ', ' +
    'updated_at=' + sqlString(recordedAt) + ' ' +
    'WHERE singleton_id=1 ' +
    'AND generation=' + sqlInteger(plan.expected_frontier_generation) + ' ' +
    'AND resolved_at=' + sqlString(plan.expected_frontier_resolved_at) + ' ' +
    'AND pending_operation_id IS NULL AND ' +
    guards.join(' AND ') +
    ';\n'
  );
}

function frontierOwned(plan) {
  return (
    'EXISTS (SELECT 1 FROM queue_intake_frontier f WHERE f.singleton_id=1 ' +
    'AND f.generation=' + sqlInteger(plan.expected_frontier_generation + 1) + ' ' +
    'AND f.resolved_at=' + sqlString(plan.proposed_frontier_resolved_at) + ' ' +
    'AND f.pending_operation_id=' + sqlString(plan.operation_id) + ')'
  );
}

export function renderReplacementItemSql(plan, item, recordedAt) {
  canonicalInstant(recordedAt, 'recordedAt');
  const eventType = plan.mode === 'owner'
    ? 'owner_replacement_assigned'
    : 'replacement_assigned';
  const supersedeDetail = JSON.stringify({
    operationId: plan.operation_id,
    mode: plan.mode,
    reason: plan.reason,
    fromAssignmentVersion: item.assignment_version,
    toAssignmentVersion: item.to_assignment_version,
    priorResolvedAt: item.prior_resolved_at,
    replacementResolvedAt: item.resolved_at,
    contentDigest: item.content_digest,
  });
  const replacementDetail = JSON.stringify({
    operationId: plan.operation_id,
    mode: plan.mode,
    reason: plan.reason,
    assignmentVersion: item.to_assignment_version,
    policyVersion: item.policy_version,
    resolvedAt: item.resolved_at,
    contentDigest: item.content_digest,
  });

  return [
    'UPDATE queue_assignments SET status=' + sqlString('superseded') + ', ' +
      'superseded_by_version=' + sqlInteger(item.to_assignment_version) + ', ' +
      'generation=generation+1, updated_at=' + sqlString(recordedAt) + ' ' +
      'WHERE assignment_id=' + sqlString(item.assignment_id) + ' ' +
      'AND assignment_version=' + sqlInteger(item.assignment_version) + ' ' +
      'AND content_id=' + sqlString(item.content_id) + ' ' +
      'AND content_digest=' + sqlString(item.content_digest) + ' ' +
      'AND generation=' + sqlInteger(item.assignment_generation) + ' ' +
      "AND status='active' AND lifecycle_state='deferred' AND " +
      frontierOwned(plan) + ';',

    'INSERT OR ABORT INTO queue_assignments (' +
      'assignment_id,assignment_version,content_id,content_revision,content_digest,' +
      'target_account,policy_version,resolved_at,scheduled_date,scheduled_time,timezone,' +
      'slot_label,status,superseded_by_version,generation,created_at,updated_at,lifecycle_state' +
      ') SELECT ' +
      [
        sqlString(item.assignment_id),
        sqlInteger(item.to_assignment_version),
        sqlString(item.content_id),
        sqlInteger(item.content_revision),
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
        sqlString('scheduled'),
      ].join(',') +
      ' WHERE EXISTS (SELECT 1 FROM queue_assignments prior WHERE ' +
      'prior.assignment_id=' + sqlString(item.assignment_id) + ' ' +
      'AND prior.assignment_version=' + sqlInteger(item.assignment_version) + ' ' +
      "AND prior.status='superseded' " +
      'AND prior.superseded_by_version=' + sqlInteger(item.to_assignment_version) + ' ' +
      'AND prior.generation=' + sqlInteger(item.assignment_generation + 1) + ' ' +
      'AND prior.updated_at=' + sqlString(recordedAt) + ') ' +
      'AND ' + frontierOwned(plan) + ';',

    'UPDATE queue_deferrals SET state=' + sqlString('replaced') + ', ' +
      'replacement_assignment_version=' + sqlInteger(item.to_assignment_version) + ', ' +
      'generation=generation+1 ' +
      'WHERE content_id=' + sqlString(item.content_id) + ' ' +
      'AND assignment_id=' + sqlString(item.assignment_id) + ' ' +
      'AND assignment_version=' + sqlInteger(item.assignment_version) + ' ' +
      'AND generation=' + sqlInteger(item.deferral_generation) + ' ' +
      "AND state='pending_replacement' " +
      'AND EXISTS (SELECT 1 FROM queue_assignments replacement WHERE ' +
      'replacement.assignment_id=' + sqlString(item.assignment_id) + ' ' +
      'AND replacement.assignment_version=' + sqlInteger(item.to_assignment_version) + ' ' +
      "AND replacement.status='active' AND replacement.lifecycle_state='scheduled') " +
      'AND ' + frontierOwned(plan) + ';',

    'UPDATE publication_state SET ' +
      'scheduled_at=' + sqlString(item.resolved_at) + ', ' +
      'updated_at=' + sqlString(recordedAt) + ', generation=generation+1 ' +
      'WHERE post_id=' + sqlString(item.content_id) + ' ' +
      'AND generation=' + sqlInteger(item.publication_generation) + ' ' +
      "AND status='scheduled' AND attempt_id IS NULL " +
      'AND EXISTS (SELECT 1 FROM queue_deferrals d WHERE ' +
      'd.content_id=' + sqlString(item.content_id) + ' ' +
      "AND d.state='replaced' " +
      'AND d.replacement_assignment_version=' + sqlInteger(item.to_assignment_version) + ') ' +
      'AND ' + frontierOwned(plan) + ';',

    'INSERT INTO queue_assignment_events ' +
      '(assignment_id,assignment_version,event_type,event_at,detail) SELECT ' +
      [
        sqlString(item.assignment_id),
        sqlInteger(item.assignment_version),
        sqlString('replacement_superseded'),
        sqlString(recordedAt),
        sqlString(supersedeDetail),
      ].join(',') +
      ' WHERE EXISTS (SELECT 1 FROM queue_assignments a WHERE ' +
      'a.assignment_id=' + sqlString(item.assignment_id) + ' ' +
      'AND a.assignment_version=' + sqlInteger(item.assignment_version) + ' ' +
      "AND a.status='superseded' " +
      'AND a.superseded_by_version=' + sqlInteger(item.to_assignment_version) + ') ' +
      'AND ' + frontierOwned(plan) + ' ' +
      'AND NOT EXISTS (SELECT 1 FROM queue_assignment_events e WHERE ' +
      'e.assignment_id=' + sqlString(item.assignment_id) + ' ' +
      'AND e.assignment_version=' + sqlInteger(item.assignment_version) + ' ' +
      "AND e.event_type='replacement_superseded' AND e.detail=" + sqlString(supersedeDetail) + ');',

    'INSERT INTO queue_assignment_events ' +
      '(assignment_id,assignment_version,event_type,event_at,detail) SELECT ' +
      [
        sqlString(item.assignment_id),
        sqlInteger(item.to_assignment_version),
        sqlString(eventType),
        sqlString(recordedAt),
        sqlString(replacementDetail),
      ].join(',') +
      ' WHERE EXISTS (SELECT 1 FROM queue_assignments a WHERE ' +
      'a.assignment_id=' + sqlString(item.assignment_id) + ' ' +
      'AND a.assignment_version=' + sqlInteger(item.to_assignment_version) + ' ' +
      "AND a.status='active' AND a.lifecycle_state='scheduled') " +
      'AND ' + frontierOwned(plan) + ' ' +
      'AND NOT EXISTS (SELECT 1 FROM queue_assignment_events e WHERE ' +
      'e.assignment_id=' + sqlString(item.assignment_id) + ' ' +
      'AND e.assignment_version=' + sqlInteger(item.to_assignment_version) + ' ' +
      'AND e.event_type=' + sqlString(eventType) + ' AND e.detail=' + sqlString(replacementDetail) + ');',

    'INSERT INTO queue_deferral_events ' +
      '(content_id,assignment_id,assignment_version,event_type,event_at,detail) SELECT ' +
      [
        sqlString(item.content_id),
        sqlString(item.assignment_id),
        sqlInteger(item.assignment_version),
        sqlString(plan.mode === 'owner' ? 'owner_replaced' : 'replaced'),
        sqlString(recordedAt),
        sqlString(replacementDetail),
      ].join(',') +
      ' WHERE EXISTS (SELECT 1 FROM queue_deferrals d WHERE ' +
      'd.content_id=' + sqlString(item.content_id) + ' ' +
      "AND d.state='replaced' " +
      'AND d.replacement_assignment_version=' + sqlInteger(item.to_assignment_version) + ') ' +
      'AND ' + frontierOwned(plan) + ' ' +
      'AND NOT EXISTS (SELECT 1 FROM queue_deferral_events e WHERE ' +
      'e.content_id=' + sqlString(item.content_id) + ' ' +
      'AND e.assignment_version=' + sqlInteger(item.assignment_version) + ' ' +
      'AND e.event_type=' + sqlString(plan.mode === 'owner' ? 'owner_replaced' : 'replaced') + ' ' +
      'AND e.detail=' + sqlString(replacementDetail) + ');',
  ].join('\n') + '\n';
}

export function renderReplacementSuccessGuardSql(plan) {
  const clauses = [frontierOwned(plan)];

  for (const item of plan.items) {
    clauses.push(
      'EXISTS (SELECT 1 FROM queue_assignments old WHERE ' +
        'old.assignment_id=' + sqlString(item.assignment_id) + ' ' +
        'AND old.assignment_version=' + sqlInteger(item.assignment_version) + ' ' +
        "AND old.status='superseded' " +
        'AND old.superseded_by_version=' + sqlInteger(item.to_assignment_version) + ')',
      'EXISTS (SELECT 1 FROM queue_assignments current WHERE ' +
        'current.assignment_id=' + sqlString(item.assignment_id) + ' ' +
        'AND current.assignment_version=' + sqlInteger(item.to_assignment_version) + ' ' +
        'AND current.content_digest=' + sqlString(item.content_digest) + ' ' +
        'AND current.policy_version=' + sqlInteger(item.policy_version) + ' ' +
        'AND current.resolved_at=' + sqlString(item.resolved_at) + ' ' +
        "AND current.status='active' AND current.lifecycle_state='scheduled')",
      'EXISTS (SELECT 1 FROM queue_deferrals d WHERE ' +
        'd.content_id=' + sqlString(item.content_id) + " AND d.state='replaced' " +
        'AND d.replacement_assignment_version=' + sqlInteger(item.to_assignment_version) + ' ' +
        'AND d.generation=' + sqlInteger(item.deferral_generation + 1) + ')',
      'EXISTS (SELECT 1 FROM publication_state p WHERE ' +
        'p.post_id=' + sqlString(item.content_id) + ' ' +
        "AND p.status='scheduled' AND p.attempt_id IS NULL " +
        'AND p.scheduled_at=' + sqlString(item.resolved_at) + ' ' +
        'AND p.generation=' + sqlInteger(item.publication_generation + 1) + ')',
    );
  }

  return clauses.join(' AND ');
}

export function renderReplacementFrontierReleaseSql(plan, recordedAt) {
  canonicalInstant(recordedAt, 'recordedAt');
  return (
    'UPDATE queue_intake_frontier SET pending_operation_id=NULL, ' +
    'last_completed_operation_id=' + sqlString(plan.operation_id) + ', ' +
    'updated_at=' + sqlString(recordedAt) + ' ' +
    'WHERE singleton_id=1 ' +
    'AND generation=' + sqlInteger(plan.expected_frontier_generation + 1) + ' ' +
    'AND resolved_at=' + sqlString(plan.proposed_frontier_resolved_at) + ' ' +
    'AND pending_operation_id=' + sqlString(plan.operation_id) + ' ' +
    'AND ' + renderReplacementSuccessGuardSql(plan) +
    ';\n'
  );
}

export function projectReplacementRuntimeRows(plan, rows) {
  if (!rows || !Array.isArray(rows.assignments) ||
      !Array.isArray(rows.deferred) ||
      !Array.isArray(rows.approvedUnscheduled) || !Array.isArray(rows.media)) {
    throw new Error('runtime rows are required');
  }

  const assignments = rows.assignments.map((row) => ({ ...row }));
  const replacedContent = new Set(plan.items.map((item) => item.content_id));
  const deferred = rows.deferred
    .filter((row) => !replacedContent.has(row.content_id))
    .map((row) => ({ ...row }));
  const keys = new Set(assignments.map((row) =>
    occupiedKey(row.target_account, row.resolved_at),
  ));

  for (const item of plan.items) {
    const key = occupiedKey(item.target_account, item.resolved_at);
    if (keys.has(key)) {
      throw new Error('replacement runtime projection collides at ' + item.resolved_at);
    }
    keys.add(key);

    assignments.push({
      assignment_id: item.assignment_id,
      assignment_version: item.to_assignment_version,
      content_id: item.content_id,
      content_revision: item.content_revision,
      content_digest: item.content_digest,
      target_account: item.target_account,
      policy_version: item.policy_version,
      resolved_at: item.resolved_at,
      scheduled_date: item.scheduled_date,
      scheduled_time: item.scheduled_time,
      timezone: item.timezone,
      slot_label: item.slot_label,
      status: 'active',
      lifecycle_state: 'scheduled',
      superseded_by_version: null,
      assignment_generation: 1,
      pillar: item.pillar,
      intake_state: item.intake_state,
      title: item.title,
      body: item.body,
      publication_text: item.publication_text,
      revision_content_digest: item.revision_content_digest,
      figure: item.figure,
      source_ref: item.source_ref,
    });
  }

  return {
    assignments,
    deferred,
    approvedUnscheduled: rows.approvedUnscheduled.map((row) => ({ ...row })),
    media: rows.media.map((row) => ({ ...row })),
  };
}

export function classifyReplacementReadback(plan, readback) {
  if (!readback || typeof readback !== 'object') return 'missing';

  const frontier = readback.frontier;
  const runtime = readback.runtimeRevision;
  const items = Array.isArray(readback.items) ? readback.items : [];

  if (
    !frontier ||
    Number(frontier.generation) !== plan.expected_frontier_generation + 1 ||
    frontier.resolved_at !== plan.proposed_frontier_resolved_at ||
    frontier.pending_operation_id != null ||
    frontier.last_completed_operation_id !== plan.operation_id
  ) {
    return 'conflict';
  }

  if (
    !runtime ||
    runtime.source_operation_id !== plan.operation_id ||
    Number(runtime.generation) !== plan.expected_runtime_generation + 1
  ) {
    return 'conflict';
  }

  for (const planned of plan.items) {
    const observed = items.find((item) => item.content_id === planned.content_id);
    if (
      !observed ||
      observed.old_status !== 'superseded' ||
      Number(observed.old_superseded_by_version) !== planned.to_assignment_version ||
      observed.new_status !== 'active' ||
      observed.new_lifecycle_state !== 'scheduled' ||
      Number(observed.new_assignment_version) !== planned.to_assignment_version ||
      observed.new_content_digest !== planned.content_digest ||
      Number(observed.new_policy_version) !== planned.policy_version ||
      observed.new_resolved_at !== planned.resolved_at ||
      observed.deferral_state !== 'replaced' ||
      Number(observed.replacement_assignment_version) !== planned.to_assignment_version ||
      observed.publication_status !== 'scheduled' ||
      observed.publication_scheduled_at !== planned.resolved_at
    ) {
      return 'conflict';
    }
  }

  return 'complete';
}

export function classifyAssignmentIdentityFence(expected, current) {
  if (!expected || typeof expected !== 'object') {
    return Object.freeze({ ok: false, reason: 'expected_assignment_missing' });
  }
  if (!current || typeof current !== 'object') {
    return Object.freeze({ ok: false, reason: 'current_assignment_missing' });
  }

  const exact =
    current.status === 'active' &&
    current.lifecycle_state === 'scheduled' &&
    current.assignment_id === expected.assignment_id &&
    Number(current.assignment_version) === Number(expected.assignment_version) &&
    current.content_id === expected.content_id &&
    Number(current.policy_version) === Number(expected.policy_version) &&
    current.content_digest === expected.content_digest;

  return exact
    ? Object.freeze({ ok: true, reason: null })
    : Object.freeze({ ok: false, reason: 'stale_assignment_identity' });
}
