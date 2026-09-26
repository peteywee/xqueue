import { createHash } from 'node:crypto';

function bool(value) {
  return value === true;
}

function sha256(value) {
  return createHash('sha256').update(Buffer.from(String(value), 'utf8')).digest('hex');
}

function blocker(id, detail) {
  return Object.freeze({ id, detail });
}

export function evaluateCutoverReadiness({
  queue = [],
  canonicalQueueText = '',
  declaredQueueSha256 = null,
  health = null,
  d1 = null,
  controlPlane = null,
  authorityBoundaryIntact = false,
  credentialBoundaryIntact = false,
} = {}) {
  const blockers = [];
  const checks = {};

  const computedQueueSha256 = sha256(canonicalQueueText);
  const queueRows = Array.isArray(queue) ? queue : [];
  const scheduledAtCount = queueRows.filter((row) => {
    if (typeof row?.scheduledAt !== 'string') return false;
    const ms = Date.parse(row.scheduledAt);
    return Number.isFinite(ms) && new Date(ms).toISOString() === row.scheduledAt;
  }).length;

  checks.scheduleActivation = (
    queueRows.length > 0 &&
    scheduledAtCount === queueRows.length &&
    typeof declaredQueueSha256 === 'string' &&
    declaredQueueSha256 === computedQueueSha256 &&
    d1?.queueSha256 === declaredQueueSha256 &&
    Number(d1?.queueCount) === queueRows.length
  );
  if (!checks.scheduleActivation) {
    blockers.push(blocker(
      'schedule_activation',
      'Production bundle/D1 metadata do not yet prove the #52 committed-UTC activation.',
    ));
  }

  checks.productionHealthObserved = Boolean(health && typeof health === 'object');
  if (!checks.productionHealthObserved) {
    blockers.push(blocker('production_health_unobserved', 'Production /health was not readable.'));
  }

  checks.productionTechnicalReadiness = (
    checks.productionHealthObserved &&
    health?.status === 'ok' &&
    bool(health?.queueIntegrity?.ok) &&
    bool(health?.dynamicRuntimeReadiness?.ok) &&
    bool(health?.authorityReadiness?.ok) &&
    bool(health?.storage?.d1?.reachable) &&
    bool(health?.storage?.r2?.reachable)
  );
  if (!checks.productionTechnicalReadiness) {
    blockers.push(blocker(
      'production_technical_readiness',
      'Production queue/dynamic runtime/authority-readiness/storage gates are not all technically ready.',
    ));
  }

  const authorityFields = {
    authorityFlag: health?.authorityReadiness?.authorityFlag,
    authorized: health?.authorityReadiness?.authorized,
    livePublication: health?.livePublication,
    schedulerAuthority: health?.schedulerAuthority,
  };
  const authorityObservable = Object.values(authorityFields)
    .every((value) => typeof value === 'boolean');
  const authorityState = !authorityObservable
    ? 'unknown'
    : Object.values(authorityFields).some((value) => value === true)
      ? 'active'
      : 'inert';

  checks.cloudflareAuthoritySafelyInert = authorityState === 'inert';
  if (!checks.cloudflareAuthoritySafelyInert) {
    blockers.push(blocker(
      authorityState === 'active'
        ? 'cloudflare_authority_active'
        : 'cloudflare_authority_unobserved',
      authorityState === 'active'
        ? 'Cloudflare publication authority is active before the controlled transfer step.'
        : 'Cloudflare publication authority state is not fully observable from production health.',
    ));
  }

  checks.productionDynamicSchema = (
    Array.isArray(d1?.migrationNames) &&
    ['0006_continuous_queue_shadow.sql','0007_continuous_queue_intake.sql','0008_dynamic_runtime_integrity.sql','0009_deferred_lifecycle.sql','0010_publication_fence_identity.sql','0011_global_publication_halt.sql','0012_reconciliation_determinations.sql']
      .every((name) => d1.migrationNames.includes(name))
  );
  if (!checks.productionDynamicSchema) {
    blockers.push(blocker(
      'production_dynamic_schema',
      'Production D1 does not prove the complete 0006-0012 continuous-queue/recovery schema.',
    ));
  }

  checks.noUnresolvedPublicationAttempt = Number(d1?.unresolvedAttemptCount) === 0;
  if (!checks.noUnresolvedPublicationAttempt) {
    blockers.push(blocker(
      'unresolved_publication_attempt',
      'Production contains prepared/publishing/needs_reconciliation publication state.',
    ));
  }

  checks.noActivePublicationLease = Number(d1?.activeLeaseCount) === 0;
  if (!checks.noActivePublicationLease) {
    blockers.push(blocker(
      'active_publication_lease',
      'Production has an active publication lease; authority transfer must not race it.',
    ));
  }

  checks.haltStateReadable = (
    d1?.haltState &&
    Number.isSafeInteger(Number(d1.haltState.generation)) &&
    [0, 1].includes(Number(d1.haltState.halted))
  );
  if (!checks.haltStateReadable) {
    blockers.push(blocker(
      'halt_state_unreadable',
      'Durable global halt state is not readable in production.',
    ));
  }

  checks.controlPlaneObservable = (
    Array.isArray(controlPlane?.schedules) &&
    Array.isArray(controlPlane?.deployments) &&
    (!Array.isArray(controlPlane?.observationErrors) || controlPlane.observationErrors.length === 0)
  );
  if (!checks.controlPlaneObservable) {
    blockers.push(blocker(
      'cloudflare_control_plane_unobservable',
      'Production schedules/deployments cannot be independently read with the evidence credential.',
    ));
  }

  checks.authorityBoundaryIntact = authorityBoundaryIntact === true;
  if (!checks.authorityBoundaryIntact) {
    blockers.push(blocker('authority_boundary', 'Repository authority-boundary audit is not proven.'));
  }

  checks.credentialBoundaryIntact = credentialBoundaryIntact === true;
  if (!checks.credentialBoundaryIntact) {
    blockers.push(blocker('credential_boundary', 'Publishing credential separation is not proven.'));
  }

  return Object.freeze({
    ready: blockers.length === 0,
    checks: Object.freeze(checks),
    blockers: Object.freeze(blockers),
    observed: Object.freeze({
      queueCount: queueRows.length,
      committedUtcCount: scheduledAtCount,
      computedQueueSha256,
      declaredQueueSha256,
      d1QueueSha256: d1?.queueSha256 ?? null,
      d1QueueCount: d1?.queueCount == null ? null : Number(d1.queueCount),
      unresolvedAttemptCount: d1?.unresolvedAttemptCount == null ? null : Number(d1.unresolvedAttemptCount),
      activeLeaseCount: d1?.activeLeaseCount == null ? null : Number(d1.activeLeaseCount),
      cloudflareAuthorityState: authorityState,
      cloudflareAuthority: Object.freeze({ ...authorityFields }),
    }),
  });
}
