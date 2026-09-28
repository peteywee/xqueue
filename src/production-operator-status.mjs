export const DEFAULT_WARNING_DAYS = 14;
export const DEFAULT_CRITICAL_DAYS = 7;

function number(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function calculateRunwayDays(now, runwayEndAt, futureScheduledCount) {
  const count = number(futureScheduledCount, 0);
  if (count <= 0 || !runwayEndAt) return 0;
  const start = now instanceof Date ? now : new Date(now);
  const end = new Date(runwayEndAt);
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime())) {
    throw new Error('runway timestamps must be valid');
  }
  return Math.max(0, (end.getTime() - start.getTime()) / 86_400_000);
}

const SEVERITY = Object.freeze({ ok: 0, warning: 1, critical: 2 });

export function classifyOperatorStatus({
  healthStatus,
  authority,
  halt,
  futureScheduledCount,
  runwayDays,
  approvedUnscheduledCount,
  deferredCount,
  reconciliationCount,
  unresolvedAttemptCount,
  schedulerObservedAt,
  now = new Date(),
  warningDays = DEFAULT_WARNING_DAYS,
  criticalDays = DEFAULT_CRITICAL_DAYS,
} = {}) {
  const warning = Number(warningDays);
  const critical = Number(criticalDays);
  if (!Number.isFinite(warning) || !Number.isFinite(critical) || critical < 0 || warning < critical) {
    throw new Error('thresholds require warning-days >= critical-days >= 0');
  }

  let level = 'ok';
  const reasons = [];
  const raise = (next, reason) => {
    if (SEVERITY[next] > SEVERITY[level]) level = next;
    reasons.push(reason);
  };

  if (healthStatus !== 'ok') raise('critical', 'production_health_not_ok');

  if (
    authority?.owner !== 'cloudflare' ||
    authority?.transitionState !== 'stable'
  ) {
    raise('critical', 'publication_authority_not_stable_cloudflare');
  }

  if (Number(reconciliationCount) > 0) {
    raise('critical', 'publication_reconciliation_required');
  }
  if (Number(unresolvedAttemptCount) > 0) {
    raise('critical', 'publication_attempt_in_progress_or_unresolved');
  }

  const future = Number(futureScheduledCount);
  if (!Number.isFinite(future) || future <= 0) {
    raise('critical', 'no_future_scheduled_inventory');
  } else if (Number(runwayDays) <= critical) {
    raise('critical', 'scheduled_runway_critical');
  } else if (Number(runwayDays) <= warning) {
    raise('warning', 'scheduled_runway_warning');
  }

  if (Number(deferredCount) > 0) {
    raise('warning', 'deferred_content_pending_replacement');
  }
  if (halt?.halted === true) {
    raise('warning', 'publication_halt_set');
  }

  const nowDate = now instanceof Date ? now : new Date(now);
  const schedulerDate = schedulerObservedAt ? new Date(schedulerObservedAt) : null;
  let schedulerAgeMinutes = null;
  if (schedulerDate && Number.isFinite(schedulerDate.getTime()) && Number.isFinite(nowDate.getTime())) {
    schedulerAgeMinutes = Math.max(0, (nowDate.getTime() - schedulerDate.getTime()) / 60_000);
    if (schedulerAgeMinutes > 45) {
      raise('critical', 'scheduler_heartbeat_stale');
    }
  } else {
    raise('critical', 'scheduler_heartbeat_missing');
  }

  if (Number(approvedUnscheduledCount) > 0 && future > 0 && Number(runwayDays) <= warning) {
    reasons.push('approved_unscheduled_inventory_available');
  }

  return Object.freeze({
    level,
    reasons: [...new Set(reasons)],
    schedulerAgeMinutes,
    thresholds: {
      warningDays: warning,
      criticalDays: critical,
    },
  });
}

export function buildOperatorStatus({
  now = new Date(),
  healthStatus,
  inventory,
  runtimeRevision,
  nextAssignment,
  policy,
  halt,
  authority,
  scheduler,
  lastPublicationEvent,
  warningDays = DEFAULT_WARNING_DAYS,
  criticalDays = DEFAULT_CRITICAL_DAYS,
} = {}) {
  const runwayDays = calculateRunwayDays(
    now,
    inventory?.runwayEndAt ?? null,
    inventory?.futureScheduledCount ?? 0,
  );

  const classification = classifyOperatorStatus({
    healthStatus,
    authority,
    halt,
    futureScheduledCount: inventory?.futureScheduledCount ?? 0,
    runwayDays,
    approvedUnscheduledCount: inventory?.approvedUnscheduledCount ?? 0,
    deferredCount: inventory?.deferredCount ?? 0,
    reconciliationCount: inventory?.reconciliationCount ?? 0,
    unresolvedAttemptCount: inventory?.unresolvedAttemptCount ?? 0,
    schedulerObservedAt: scheduler?.observedAt ?? null,
    now,
    warningDays,
    criticalDays,
  });

  return Object.freeze({
    generatedAt: (now instanceof Date ? now : new Date(now)).toISOString(),
    level: classification.level,
    reasons: classification.reasons,
    thresholds: classification.thresholds,
    inventory: {
      futureScheduledCount: Number(inventory?.futureScheduledCount ?? 0),
      runwayDays: Number(runwayDays.toFixed(2)),
      runwayEndAt: inventory?.runwayEndAt ?? null,
      approvedUnscheduledCount: Number(inventory?.approvedUnscheduledCount ?? 0),
      deferredCount: Number(inventory?.deferredCount ?? 0),
      reconciliationCount: Number(inventory?.reconciliationCount ?? 0),
      unresolvedAttemptCount: Number(inventory?.unresolvedAttemptCount ?? 0),
    },
    nextAssignment: nextAssignment ?? null,
    runtimeRevision: runtimeRevision ?? null,
    policy: policy ?? null,
    halt: halt ?? null,
    authority: authority ?? null,
    scheduler: {
      ...(scheduler ?? {}),
      ageMinutes: classification.schedulerAgeMinutes == null
        ? null
        : Number(classification.schedulerAgeMinutes.toFixed(2)),
    },
    lastPublicationEvent: lastPublicationEvent ?? null,
    productionHealth: healthStatus ?? 'unknown',
  });
}
