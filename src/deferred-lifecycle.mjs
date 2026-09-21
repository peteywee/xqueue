import { scheduledAt } from './post-time.mjs';

export const DEFAULT_MISSED_REASON = 'missed_slot_grace_expired';

function validNow(now) {
  if (Object.prototype.toString.call(now) !== '[object Date]' || !Number.isFinite(now.getTime())) {
    throw new Error('now must be a valid Date');
  }
  return now;
}

function validGrace(graceMinutes) {
  if (!Number.isFinite(graceMinutes) || graceMinutes < 0) {
    throw new Error('graceMinutes must be a non-negative finite number');
  }
  return graceMinutes;
}

export function isMissedResolvedAt(resolvedAt, {
  now = new Date(),
  graceMinutes = 20,
} = {}) {
  validNow(now);
  validGrace(graceMinutes);

  const resolvedMs = Date.parse(resolvedAt);
  if (!Number.isFinite(resolvedMs) || new Date(resolvedMs).toISOString() !== resolvedAt) {
    throw new Error('resolvedAt must be canonical ISO-8601 UTC with milliseconds');
  }

  return now.getTime() > resolvedMs + graceMinutes * 60_000;
}

export function isMissedPost(post, options = {}) {
  return isMissedResolvedAt(scheduledAt(post).toISOString(), options);
}

export function deferMissedStaticAssignments(
  queue,
  state,
  {
    now = new Date(),
    graceMinutes = 20,
    policyVersion = 1,
    reason = DEFAULT_MISSED_REASON,
  } = {},
) {
  if (!Array.isArray(queue)) throw new Error('queue must be an array');
  if (!state || typeof state !== 'object' || Array.isArray(state)) {
    throw new Error('state must be an object');
  }
  validNow(now);
  validGrace(graceMinutes);
  if (!Number.isSafeInteger(policyVersion) || policyVersion < 1) {
    throw new Error('policyVersion must be a positive integer');
  }
  if (typeof reason !== 'string' || reason.trim().length === 0) {
    throw new Error('deferral reason is required');
  }

  state.deferred ??= {};
  const deferred = [];

  for (const post of queue) {
    const id = post?.id;
    if (typeof id !== 'string' || id.length === 0) {
      throw new Error('queue post id is required');
    }

    if (state.posted?.[id] || state.skipped?.[id] || state.deferred[id]) continue;

    if (state.inflight?.postId === id) {
      // Especially needs_reconciliation: automation must never transform an
      // unresolved publication outcome into scheduling lifecycle state.
      continue;
    }

    const resolvedAt = scheduledAt(post).toISOString();
    if (!isMissedResolvedAt(resolvedAt, { now, graceMinutes })) continue;

    const record = {
      at: now.toISOString(),
      reason: reason.trim(),
      assignmentId: id,
      assignmentVersion: 1,
      policyVersion,
      resolvedAt,
      scheduledDate: post.scheduledDate,
      scheduledTime: post.scheduledTime,
      timezone: post.timezone,
      slot: post.slot ?? null,
    };

    state.deferred[id] = record;
    deferred.push({ postId: id, ...record });
  }

  return Object.freeze({
    state,
    deferred: Object.freeze(deferred),
  });
}
