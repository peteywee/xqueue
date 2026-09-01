import { createHash, randomUUID } from 'node:crypto';

export function hashContent(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export function beginPublication(state, post, text, cost, now = new Date()) {
  if (state.inflight) {
    throw new Error(`Publication already in flight for ${state.inflight.postId}`);
  }

  state.inflight = {
    attemptId: randomUUID(),
    postId: post.id,
    title: post.title,
    contentHash: hashContent(text),
    cost,
    startedAt: now.toISOString(),
    status: 'prepared',
  };

  return state.inflight;
}

export function markPublishing(state, now = new Date()) {
  if (!state.inflight) {
    throw new Error('No publication is in flight');
  }

  state.inflight.status = 'publishing';
  state.inflight.publishStartedAt = now.toISOString();
}

export function markNeedsReconciliation(state, error, now = new Date()) {
  if (!state.inflight) {
    throw new Error('No publication is in flight');
  }

  state.inflight.status = 'needs_reconciliation';
  state.inflight.failedAt = now.toISOString();
  state.inflight.lastError =
    error instanceof Error ? error.message : String(error);
}

export function clearPreparedPublication(state) {
  if (!state.inflight) return;

  if (state.inflight.status !== 'prepared') {
    throw new Error(
      `Cannot automatically clear inflight status ${state.inflight.status}`,
    );
  }

  state.inflight = null;
}

export function finishPublication(state, tweetId, now = new Date()) {
  if (!state.inflight) {
    throw new Error('No publication is in flight');
  }
  if (!tweetId || typeof tweetId !== 'string') {
    throw new Error('A remote tweet ID is required to finish publication');
  }

  const attempt = state.inflight;

  state.posted[attempt.postId] = {
    tweetId,
    at: now.toISOString(),
    cost: attempt.cost,
    contentHash: attempt.contentHash,
    attemptId: attempt.attemptId,
  };

  state.spend = +(
    (state.spend ?? 0) + (attempt.cost ?? 0)
  ).toFixed(4);

  state.inflight = null;
}

export function reconcileAsPosted(state, tweetId, now = new Date()) {
  if (!state.inflight) {
    throw new Error('No publication requires reconciliation');
  }
  if (!['publishing', 'needs_reconciliation'].includes(state.inflight.status)) {
    throw new Error(`Inflight publication is ${state.inflight.status}, not ambiguous`);
  }

  const postId = state.inflight.postId;
  finishPublication(state, tweetId, now);
  state.posted[postId].reconciled = true;
}

export function reconcileAsNotPosted(state) {
  if (!state.inflight) {
    throw new Error('No publication requires reconciliation');
  }
  if (!['publishing', 'needs_reconciliation'].includes(state.inflight.status)) {
    throw new Error(`Inflight publication is ${state.inflight.status}, not ambiguous`);
  }

  state.inflight = null;
}
