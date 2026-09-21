import { scheduledAt } from './post-time.mjs';

export function isResolved(state, postId) {
  return Boolean(
    state?.posted?.[postId] ||
    state?.skipped?.[postId] ||
    state?.deferred?.[postId]
  );
}

export function analyzeRuntime(
  queue,
  state,
  {
    now = new Date(),
    graceMinutes = 20,
  } = {},
) {
  if (!Array.isArray(queue)) {
    throw new Error('queue must be an array');
  }
  if (!Number.isFinite(graceMinutes) || graceMinutes < 0) {
    throw new Error('graceMinutes must be a non-negative finite number');
  }

  const nowMs = now.getTime();
  const cutoffMs = nowMs - graceMinutes * 60_000;

  const unresolved = queue.filter(
    (post) => !isResolved(state, post.id),
  );

  const due = unresolved.filter(
    (post) => scheduledAt(post).getTime() <= nowMs,
  );

  const overdue = unresolved.filter(
    (post) => scheduledAt(post).getTime() < cutoffMs,
  );

  const upcoming = unresolved
    .filter((post) => scheduledAt(post).getTime() > nowMs)
    .sort(
      (a, b) =>
        scheduledAt(a).getTime() - scheduledAt(b).getTime(),
    );

  return {
    ok: !state?.inflight && overdue.length === 0,
    postedCount: Object.keys(state?.posted ?? {}).length,
    skippedCount: Object.keys(state?.skipped ?? {}).length,
    deferredCount: Object.keys(state?.deferred ?? {}).length,
    unresolvedCount: unresolved.length,
    due,
    overdue,
    next: upcoming[0] ?? null,
    inflight: state?.inflight ?? null,
    graceMinutes,
  };
}
