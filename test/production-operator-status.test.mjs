import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildOperatorStatus,
  calculateRunwayDays,
  classifyOperatorStatus,
} from '../src/production-operator-status.mjs';
import {
  parseWranglerJson,
  STATUS_SQL,
} from '../scripts/production-operator-status.mjs';

test('runway is measured from now to the last future scheduled assignment', () => {
  const days = calculateRunwayDays(
    new Date('2026-09-28T00:00:00.000Z'),
    '2026-10-08T00:00:00.000Z',
    10,
  );
  assert.equal(days, 10);
  assert.equal(
    calculateRunwayDays(
      new Date('2026-09-28T00:00:00.000Z'),
      null,
      0,
    ),
    0,
  );
});

test('operator status warns before approved scheduled inventory runs low', () => {
  const verdict = classifyOperatorStatus({
    healthStatus: 'ok',
    authority: { owner: 'cloudflare', transitionState: 'stable' },
    halt: { halted: false },
    futureScheduledCount: 12,
    runwayDays: 10,
    approvedUnscheduledCount: 3,
    deferredCount: 0,
    reconciliationCount: 0,
    unresolvedAttemptCount: 0,
    schedulerObservedAt: '2026-09-28T00:55:00.000Z',
    now: new Date('2026-09-28T01:00:00.000Z'),
    warningDays: 14,
    criticalDays: 7,
  });

  assert.equal(verdict.level, 'warning');
  assert.ok(verdict.reasons.includes('scheduled_runway_warning'));
  assert.ok(verdict.reasons.includes('approved_unscheduled_inventory_available'));
});

test('reconciliation, authority drift, stale scheduler, or empty runway is critical', () => {
  const verdict = classifyOperatorStatus({
    healthStatus: 'error',
    authority: { owner: 'none', transitionState: 'stable' },
    halt: { halted: false },
    futureScheduledCount: 0,
    runwayDays: 0,
    approvedUnscheduledCount: 0,
    deferredCount: 0,
    reconciliationCount: 1,
    unresolvedAttemptCount: 1,
    schedulerObservedAt: '2026-09-27T23:00:00.000Z',
    now: new Date('2026-09-28T01:00:00.000Z'),
  });

  assert.equal(verdict.level, 'critical');
  assert.ok(verdict.reasons.includes('production_health_not_ok'));
  assert.ok(verdict.reasons.includes('publication_authority_not_stable_cloudflare'));
  assert.ok(verdict.reasons.includes('publication_reconciliation_required'));
  assert.ok(verdict.reasons.includes('no_future_scheduled_inventory'));
  assert.ok(verdict.reasons.includes('scheduler_heartbeat_stale'));
});

test('owner halt and pending deferral are warning states when everything else is healthy', () => {
  const report = buildOperatorStatus({
    now: new Date('2026-09-28T01:00:00.000Z'),
    healthStatus: 'ok',
    inventory: {
      futureScheduledCount: 30,
      runwayEndAt: '2026-10-28T01:00:00.000Z',
      approvedUnscheduledCount: 0,
      deferredCount: 1,
      reconciliationCount: 0,
      unresolvedAttemptCount: 0,
    },
    authority: { owner: 'cloudflare', transitionState: 'stable' },
    halt: { halted: true, generation: 8 },
    scheduler: { observedAt: '2026-09-28T00:50:00.000Z' },
  });

  assert.equal(report.level, 'warning');
  assert.ok(report.reasons.includes('publication_halt_set'));
  assert.ok(report.reasons.includes('deferred_content_pending_replacement'));
});

test('Wrangler JSON parser tolerates package-manager chatter', () => {
  const parsed = parseWranglerJson(
    '$ wrangler d1 execute\n' +
    '[{"success":true,"results":[{"future_scheduled_count":12}]}]\n',
  );
  assert.equal(parsed[0].results[0].future_scheduled_count, 12);
});

test('production operator status D1 transport is structurally read-only', () => {
  assert.match(STATUS_SQL, /SELECT COUNT\(\*\) AS future_scheduled_count/);
  assert.match(STATUS_SQL, /FROM authority_state/);
  assert.match(STATUS_SQL, /scheduler\.last_invocation/);
  assert.doesNotMatch(
    STATUS_SQL,
    /\b(?:INSERT|UPDATE|DELETE|REPLACE|DROP|ALTER|CREATE|PRAGMA)\b/i,
  );
});
