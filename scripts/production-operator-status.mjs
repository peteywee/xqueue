#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

import {
  buildOperatorStatus,
  DEFAULT_CRITICAL_DAYS,
  DEFAULT_WARNING_DAYS,
} from '../src/production-operator-status.mjs';

const args = process.argv.slice(2);
const HEALTH_URL = 'https://xqueue-production.patrickcraven.workers.dev/health';

function flag(name) {
  return args.includes('--' + name);
}

function opt(name, fallback = null) {
  const exact = '--' + name;
  const index = args.indexOf(exact);
  if (index >= 0 && args[index + 1] !== undefined) return args[index + 1];
  const inline = args.find((arg) => arg.startsWith(exact + '='));
  return inline ? inline.slice(exact.length + 1) : fallback;
}

export function parseWranglerJson(raw) {
  const text = String(raw ?? '').trim();
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] !== '[' && text[index] !== '{') continue;
    try {
      return JSON.parse(text.slice(index));
    } catch {
      // Keep scanning past package-manager chatter.
    }
  }
  throw new Error('Wrangler output did not contain valid JSON');
}

function run(command, argv) {
  const result = spawnSync(command, argv, {
    cwd: process.cwd(),
    env: process.env,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = [result.stderr, result.stdout].filter(Boolean).join('\n').trim();
    throw new Error(
      [command, ...argv].join(' ') + ' failed with exit ' + result.status +
      (detail ? '\n' + detail : ''),
    );
  }
  return result.stdout ?? '';
}

function first(payload, index) {
  return payload?.[index]?.results?.[0] ?? null;
}

function rows(payload, index) {
  return payload?.[index]?.results ?? [];
}

function positiveNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

export const STATUS_SQL = [
  "SELECT COUNT(*) AS future_scheduled_count, MAX(a.resolved_at) AS runway_end_at",
  "FROM queue_assignments a JOIN publication_state p ON p.post_id=a.content_id",
  "WHERE a.status='active' AND a.lifecycle_state='scheduled'",
  "AND p.status='scheduled' AND a.resolved_at > strftime('%Y-%m-%dT%H:%M:%fZ','now');",

  "SELECT COUNT(*) AS approved_unscheduled_count FROM queue_content",
  "WHERE status='active' AND intake_state='approved_unscheduled';",

  "SELECT COUNT(*) AS deferred_count FROM queue_deferrals",
  "WHERE state='pending_replacement';",

  "SELECT",
  "SUM(CASE WHEN status='needs_reconciliation' THEN 1 ELSE 0 END) AS reconciliation_count,",
  "SUM(CASE WHEN status IN ('prepared','publishing','needs_reconciliation') THEN 1 ELSE 0 END) AS unresolved_attempt_count",
  "FROM publication_state;",

  "SELECT a.content_id,a.assignment_id,a.assignment_version,a.policy_version,a.resolved_at,",
  "a.scheduled_date,a.scheduled_time,a.timezone,a.slot_label",
  "FROM queue_assignments a JOIN publication_state p ON p.post_id=a.content_id",
  "WHERE a.status='active' AND a.lifecycle_state='scheduled' AND p.status='scheduled'",
  "AND a.resolved_at > strftime('%Y-%m-%dT%H:%M:%fZ','now')",
  "ORDER BY a.resolved_at,a.content_id LIMIT 1;",

  "SELECT generation,revision_digest,active_assignment_count,approved_unscheduled_count,",
  "media_required_count,media_ready_count,source_operation_id,created_at",
  "FROM queue_runtime_revisions ORDER BY generation DESC LIMIT 1;",

  "SELECT MIN(policy_version) AS min_policy_version,MAX(policy_version) AS max_policy_version,",
  "COUNT(DISTINCT policy_version) AS active_policy_version_count",
  "FROM queue_assignments WHERE status='active' AND lifecycle_state='scheduled';",

  "SELECT halted,generation,reason,actor_class,updated_at",
  "FROM publication_halt_state WHERE singleton_id=1;",

  "SELECT owner,generation,transition_state,candidate_sha,deployment_id,updated_at",
  "FROM authority_state WHERE singleton_id=1;",

  "SELECT value,updated_at FROM runtime_metadata WHERE key='scheduler.last_invocation';",

  "SELECT post_id,event_type,event_at FROM publication_events",
  "WHERE event_type IN ('posted','confirmed_not_posted','needs_reconciliation','reconciled_posted','reconciled_not_posted')",
  "ORDER BY id DESC LIMIT 1;",
].join(' ');

async function readHealth() {
  try {
    const response = await fetch(HEALTH_URL, {
      headers: { accept: 'application/json' },
    });
    const body = await response.json();
    return {
      httpStatus: response.status,
      status: body?.status ?? (response.ok ? 'ok' : 'error'),
    };
  } catch (error) {
    return {
      httpStatus: null,
      status: 'unknown',
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function readPolicyFile() {
  const policy = JSON.parse(
    readFileSync(new URL('../config/schedule-policy.json', import.meta.url), 'utf8'),
  );
  return {
    repositoryVersion: Number(policy.version),
    timezone: policy.timezone,
    postsPerDay: Number(policy.postsPerDay),
  };
}

function schedulerFromRow(row) {
  if (!row) return null;
  let value = {};
  try {
    value = JSON.parse(row.value);
  } catch {
    value = {};
  }
  return {
    observedAt: value.observedAt ?? row.updated_at ?? null,
    scheduledTime: value.scheduledTime ?? null,
    updatedAt: row.updated_at ?? null,
  };
}

function renderText(report) {
  const next = report.nextAssignment;
  const authority = report.authority;
  const halt = report.halt;
  const runtime = report.runtimeRevision;

  console.log('=== XQUEUE PRODUCTION STATUS ===');
  console.log('level:               ' + report.level.toUpperCase());
  console.log('production health:   ' + report.productionHealth);
  console.log('future scheduled:    ' + report.inventory.futureScheduledCount);
  console.log('runway:              ' + report.inventory.runwayDays + ' days');
  console.log('runway ends:         ' + (report.inventory.runwayEndAt ?? 'none'));
  console.log('approved unscheduled:' + ' ' + report.inventory.approvedUnscheduledCount);
  console.log('deferred pending:    ' + report.inventory.deferredCount);
  console.log('reconciliation:      ' + report.inventory.reconciliationCount);
  console.log('unresolved attempts: ' + report.inventory.unresolvedAttemptCount);
  console.log(
    'next assignment:     ' +
    (next ? next.contentId + ' @ ' + next.resolvedAt : 'none'),
  );
  console.log(
    'runtime revision:    ' +
    (runtime ? 'gen ' + runtime.generation + ' ' + runtime.revisionDigest : 'missing'),
  );
  console.log(
    'policy:              repo=' + report.policy.repositoryVersion +
    ' active=' + (report.policy.activeVersion ?? 'mixed/none'),
  );
  console.log(
    'authority:           ' +
    (authority ? authority.owner + ' gen=' + authority.generation + ' ' + authority.transitionState : 'missing'),
  );
  console.log(
    'halt:                ' +
    (halt ? (halt.halted ? 'SET' : 'clear') + ' gen=' + halt.generation : 'missing'),
  );
  console.log(
    'scheduler heartbeat: ' +
    (report.scheduler?.observedAt ?? 'missing') +
    (report.scheduler?.ageMinutes == null ? '' : ' (' + report.scheduler.ageMinutes + 'm old)'),
  );
  console.log(
    'last publication:    ' +
    (report.lastPublicationEvent
      ? report.lastPublicationEvent.eventType + ' ' + report.lastPublicationEvent.postId +
        ' @ ' + report.lastPublicationEvent.eventAt
      : 'none'),
  );

  if (report.reasons.length > 0) {
    console.log('\nattention:');
    for (const reason of report.reasons) console.log('  - ' + reason);
  }
}

async function main() {
  const warningDays = positiveNumber(
    opt('warning-days', DEFAULT_WARNING_DAYS),
    DEFAULT_WARNING_DAYS,
  );
  const criticalDays = positiveNumber(
    opt('critical-days', DEFAULT_CRITICAL_DAYS),
    DEFAULT_CRITICAL_DAYS,
  );

  run('pnpm', ['cf:auth:preflight', '--environment', 'production']);

  const raw = run('pnpm', [
    'wrangler',
    'd1',
    'execute',
    'xqueue-production',
    '--config',
    'wrangler.status.jsonc',
    '--remote',
    '--yes',
    '--json',
    '--command',
    STATUS_SQL,
  ]);
  const payload = parseWranglerJson(raw);

  const inventoryRow = first(payload, 0) ?? {};
  const approvedRow = first(payload, 1) ?? {};
  const deferredRow = first(payload, 2) ?? {};
  const publicationRow = first(payload, 3) ?? {};
  const nextRow = first(payload, 4);
  const runtimeRow = first(payload, 5);
  const policyRow = first(payload, 6) ?? {};
  const haltRow = first(payload, 7);
  const authorityRow = first(payload, 8);
  const schedulerRow = first(payload, 9);
  const eventRow = first(payload, 10);

  const repoPolicy = readPolicyFile();
  const activePolicyVersion =
    Number(policyRow.active_policy_version_count) === 1
      ? Number(policyRow.min_policy_version)
      : null;

  const health = await readHealth();
  const report = buildOperatorStatus({
    now: new Date(),
    healthStatus: health.status,
    warningDays,
    criticalDays,
    inventory: {
      futureScheduledCount: Number(inventoryRow.future_scheduled_count ?? 0),
      runwayEndAt: inventoryRow.runway_end_at ?? null,
      approvedUnscheduledCount: Number(approvedRow.approved_unscheduled_count ?? 0),
      deferredCount: Number(deferredRow.deferred_count ?? 0),
      reconciliationCount: Number(publicationRow.reconciliation_count ?? 0),
      unresolvedAttemptCount: Number(publicationRow.unresolved_attempt_count ?? 0),
    },
    nextAssignment: nextRow
      ? {
          contentId: nextRow.content_id,
          assignmentId: nextRow.assignment_id,
          assignmentVersion: Number(nextRow.assignment_version),
          policyVersion: Number(nextRow.policy_version),
          resolvedAt: nextRow.resolved_at,
          scheduledDate: nextRow.scheduled_date,
          scheduledTime: nextRow.scheduled_time,
          timezone: nextRow.timezone,
          slotLabel: nextRow.slot_label,
        }
      : null,
    runtimeRevision: runtimeRow
      ? {
          generation: Number(runtimeRow.generation),
          revisionDigest: runtimeRow.revision_digest,
          activeAssignmentCount: Number(runtimeRow.active_assignment_count),
          approvedUnscheduledCount: Number(runtimeRow.approved_unscheduled_count),
          mediaRequiredCount: Number(runtimeRow.media_required_count),
          mediaReadyCount: Number(runtimeRow.media_ready_count),
          sourceOperationId: runtimeRow.source_operation_id,
          createdAt: runtimeRow.created_at,
        }
      : null,
    policy: {
      ...repoPolicy,
      activeVersion: activePolicyVersion,
      activeVersionMin: policyRow.min_policy_version == null ? null : Number(policyRow.min_policy_version),
      activeVersionMax: policyRow.max_policy_version == null ? null : Number(policyRow.max_policy_version),
      activeVersionCount: Number(policyRow.active_policy_version_count ?? 0),
    },
    halt: haltRow
      ? {
          halted: Number(haltRow.halted) === 1,
          generation: Number(haltRow.generation),
          actorClass: haltRow.actor_class,
          reason: haltRow.reason,
          updatedAt: haltRow.updated_at,
        }
      : null,
    authority: authorityRow
      ? {
          owner: authorityRow.owner,
          generation: Number(authorityRow.generation),
          transitionState: authorityRow.transition_state,
          candidateSha: authorityRow.candidate_sha,
          deploymentId: authorityRow.deployment_id,
          updatedAt: authorityRow.updated_at,
        }
      : null,
    scheduler: schedulerFromRow(schedulerRow),
    lastPublicationEvent: eventRow
      ? {
          postId: eventRow.post_id,
          eventType: eventRow.event_type,
          eventAt: eventRow.event_at,
        }
      : null,
  });

  if (flag('json')) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    renderText(report);
  }

  if (flag('strict') && report.level !== 'ok') {
    process.exitCode = report.level === 'critical' ? 2 : 1;
  }
}

if (import.meta.url === new URL(process.argv[1], 'file:').href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
