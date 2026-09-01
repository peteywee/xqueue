import test from 'node:test';
import assert from 'node:assert/strict';

import { emptyState, normalizeState } from '../src/state-store.mjs';
import { analyzeRuntime, isResolved } from '../src/runtime-health.mjs';

function queued(overrides = {}) {
  return {
    id: 'A1',
    scheduledDate: '2026-09-01',
    scheduledTime: '14:30',
    timezone: 'America/Chicago',
    ...overrides,
  };
}

test('legacy state normalizes with an empty skipped map', () => {
  const state = normalizeState({ posted: {}, spend: 0, inflight: null });
  assert.deepEqual(state.skipped, {});
});

test('posted and skipped posts are both resolved', () => {
  const state = emptyState();
  state.posted.A1 = { tweetId: '1', at: '2026-09-01T19:31:00.000Z' };
  state.skipped.B1 = { at: '2026-09-01T19:31:00.000Z', reason: 'missed cutover window' };

  assert.equal(isResolved(state, 'A1'), true);
  assert.equal(isResolved(state, 'B1'), true);
  assert.equal(isResolved(state, 'C1'), false);
});

test('runtime health fails for unresolved posts beyond grace', () => {
  const state = emptyState();
  const report = analyzeRuntime(
    [queued()],
    {
      ...state,
    },
    {
      now: new Date('2026-09-01T20:00:00.000Z'),
      graceMinutes: 20,
    },
  );

  assert.equal(report.ok, false);
  assert.equal(report.due.length, 1);
  assert.equal(report.overdue.length, 1);
  assert.equal(report.overdue[0].id, 'A1');
});

test('a due post inside the grace window is not stale yet', () => {
  const report = analyzeRuntime(
    [queued()],
    emptyState(),
    {
      now: new Date('2026-09-01T19:40:00.000Z'),
      graceMinutes: 20,
    },
  );

  assert.equal(report.ok, true);
  assert.equal(report.due.length, 1);
  assert.equal(report.overdue.length, 0);
});

test('owner-skipped backlog no longer blocks runtime health', () => {
  const state = emptyState();
  state.skipped.A1 = {
    at: '2026-09-01T19:45:00.000Z',
    reason: 'missed during scheduler hardening',
  };

  const report = analyzeRuntime(
    [queued()],
    state,
    {
      now: new Date('2026-09-01T20:00:00.000Z'),
      graceMinutes: 20,
    },
  );

  assert.equal(report.ok, true);
  assert.equal(report.unresolvedCount, 0);
  assert.equal(report.overdue.length, 0);
  assert.equal(report.skippedCount, 1);
});

test('ambiguous inflight publication blocks runtime health', () => {
  const state = emptyState();
  state.inflight = {
    postId: 'A1',
    status: 'needs_reconciliation',
  };

  const report = analyzeRuntime(
    [],
    state,
    {
      now: new Date('2026-09-01T20:00:00.000Z'),
    },
  );

  assert.equal(report.ok, false);
  assert.equal(report.inflight.postId, 'A1');
});

test('state rejects a post that is both posted and skipped', () => {
  assert.throws(
    () => normalizeState({
      posted: {
        A1: { tweetId: '1', at: '2026-09-01T19:31:00.000Z' },
      },
      skipped: {
        A1: { at: '2026-09-01T19:32:00.000Z', reason: 'bad state' },
      },
      spend: 0,
      inflight: null,
    }),
    /cannot be both posted and skipped/i,
  );
});
