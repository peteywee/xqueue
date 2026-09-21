#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

import { buildProductionShadow } from './build-continuous-queue-shadow.mjs';
import {
  assertPreviewConfig,
  flattenStatementRows,
  parseWranglerJson,
  PREVIEW_CONFIG,
  PREVIEW_DB,
  wranglerExecuteArgs,
} from '../src/d1-preview-shadow-proof.mjs';
import {
  dynamicParityRows,
  proveBoundaryObservationParity,
  proveLiveParity,
  staticParityRows,
} from '../src/static-dynamic-parity.mjs';

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    env: process.env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = [result.stderr, result.stdout].filter(Boolean).join('\n').trim();
    throw new Error(
      command + ' ' + args.join(' ') + ' failed with exit ' + result.status +
      (detail ? ': ' + detail : ''),
    );
  }

  return result.stdout ?? '';
}

function query(sql) {
  return flattenStatementRows(
    parseWranglerJson(
      run('pnpm', wranglerExecuteArgs({ sql })),
    ),
  );
}

function requireCloudflareCredentials() {
  for (const name of ['CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_API_TOKEN']) {
    if (typeof process.env[name] !== 'string' || process.env[name].length === 0) {
      throw new Error(name + ' is required');
    }
  }
}

function parseLedger(raw) {
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new Error('preview runtime snapshot is missing');
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('preview runtime snapshot is invalid JSON');
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('preview runtime snapshot is not an object');
  }

  return parsed;
}

function readDynamicRows() {
  return query(
    [
      'SELECT',
      '  a.assignment_id,',
      '  a.assignment_version,',
      '  a.content_id,',
      '  a.content_revision,',
      '  a.content_digest,',
      '  a.target_account,',
      '  a.policy_version,',
      '  a.resolved_at,',
      '  a.scheduled_date,',
      '  a.scheduled_time,',
      '  a.timezone,',
      '  a.slot_label,',
      '  a.status AS assignment_status,',
      '  a.lifecycle_state,',
      '  c.current_revision,',
      '  c.status AS content_status,',
      '  r.content_digest AS revision_digest',
      'FROM queue_assignments a',
      'JOIN queue_content c ON c.content_id = a.content_id',
      'JOIN queue_content_revisions r',
      '  ON r.content_id = a.content_id',
      ' AND r.revision = a.content_revision',
      "WHERE a.status = 'active'",
      'ORDER BY a.resolved_at, a.content_id, a.assignment_version;',
    ].join('\n'),
  );
}

function readPublicationRows() {
  return query(
    [
      'SELECT',
      '  post_id,',
      '  status,',
      '  tweet_id,',
      '  attempt_id,',
      '  skipped_at,',
      '  skip_reason,',
      '  generation,',
      '  scheduled_at',
      'FROM publication_state',
      'ORDER BY post_id;',
    ].join('\n'),
  );
}

function readDeferralRows() {
  return query(
    [
      'SELECT',
      '  content_id,',
      '  assignment_id,',
      '  assignment_version,',
      '  policy_version,',
      '  prior_resolved_at,',
      '  reason,',
      '  state,',
      '  generation,',
      '  replacement_assignment_version',
      'FROM queue_deferrals',
      'ORDER BY content_id;',
    ].join('\n'),
  );
}

function readRuntimeHead() {
  return query(
    [
      'SELECT',
      '  generation,',
      '  revision_digest,',
      '  active_assignment_count,',
      '  approved_unscheduled_count,',
      '  media_required_count,',
      '  media_ready_count,',
      '  previous_revision_digest,',
      '  source_operation_id,',
      '  created_at',
      'FROM queue_runtime_revisions',
      'ORDER BY generation DESC',
      'LIMIT 1;',
    ].join('\n'),
  )[0] ?? null;
}

function main() {
  requireCloudflareCredentials();

  const config = JSON.parse(readFileSync(PREVIEW_CONFIG, 'utf8'));
  assertPreviewConfig(config);

  const staticRows = staticParityRows(buildProductionShadow());
  const dynamicRows = dynamicParityRows(readDynamicRows());

  const publicationRows = readPublicationRows();
  const deferralRows = readDeferralRows();

  const snapshot = query(
    "SELECT value,updated_at FROM runtime_metadata " +
    "WHERE key='state.snapshot_json' LIMIT 1;",
  )[0] ?? null;

  const ledger = parseLedger(snapshot?.value);
  const runtimeHead = readRuntimeHead();

  if (!runtimeHead) {
    throw new Error('preview dynamic runtime revision head is missing');
  }

  const boundary = proveBoundaryObservationParity({
    staticRows,
    dynamicRows,
    publicationRows,
    deferralRows,
    graceMinutes: 20,
  });

  const live = proveLiveParity({
    staticRows,
    dynamicRows,
    ledger,
    publicationRows,
    deferralRows,
    now: new Date(),
    graceMinutes: 20,
  });

  if (Number(runtimeHead.active_assignment_count) !== dynamicRows.length) {
    throw new Error(
      'runtime revision active assignment count does not match parity rows',
    );
  }

  const evidence = {
    format: 1,
    issue: 93,
    environment: 'preview',
    database: PREVIEW_DB,
    config: PREVIEW_CONFIG,
    candidateSha:
      process.env.XQUEUE_PARITY_CANDIDATE_SHA ??
      process.env.GITHUB_SHA ??
      null,
    producedAt: new Date().toISOString(),
    staticAuthority: 'markdown+schedule-policy',
    dynamicAuthorityCandidate: 'preview-d1',
    graceMinutes: 20,
    assignmentCount: boundary.assignmentCount,
    canonicalRowsHash: boundary.canonicalRowsHash,
    boundaryObservationCount: boundary.observationCount,
    boundaryObservationDigest: boundary.observationDigest,
    boundaryWindow: {
      first: boundary.firstObservation.at,
      last: boundary.lastObservation.at,
    },
    liveState: live.state,
    liveObservation: {
      at: live.observation.at,
      next: live.observation.next,
      due: live.observation.due,
      overdue: live.observation.overdue,
      selected: live.observation.selected,
      safeToPublish: live.observation.safeToPublish,
      projectedDeferrals: live.observation.projectedDeferrals,
    },
    runtimeRevision: {
      generation: Number(runtimeHead.generation),
      revisionDigest: runtimeHead.revision_digest,
      activeAssignmentCount: Number(runtimeHead.active_assignment_count),
      approvedUnscheduledCount: Number(runtimeHead.approved_unscheduled_count),
      mediaRequiredCount: Number(runtimeHead.media_required_count),
      mediaReadyCount: Number(runtimeHead.media_ready_count),
      previousRevisionDigest: runtimeHead.previous_revision_digest,
      sourceOperationId: runtimeHead.source_operation_id,
      createdAt: runtimeHead.created_at,
    },
    checks: {
      exactAssignmentIdentity: 'pass',
      exactResolvedUtcAndLocalSlot: 'pass',
      exactContentDigest: 'pass',
      publicationStateLedgerParity: 'pass',
      deferredLifecycleParity: 'pass',
      boundaryNextDueOverdueSelection: 'pass',
      liveNextDueOverdueSelection: 'pass',
      recoveryPrerequisite: 'workflow-gated',
    },
    productionMutation: false,
    publicationAuthorityChanged: false,
    staticProductionAuthorityRetained: true,
  };

  const output = resolve(
    process.env.XQUEUE_PREVIEW_PARITY_EVIDENCE ??
    join(tmpdir(), 'xqueue-preview-static-dynamic-parity.json'),
  );
  writeFileSync(output, JSON.stringify(evidence, null, 2) + '\n', 'utf8');

  console.log('XQUEUE STATIC/DYNAMIC PARITY PROOF: PASS');
  console.log('  assignments          ' + evidence.assignmentCount);
  console.log('  canonical rows hash  ' + evidence.canonicalRowsHash);
  console.log('  boundary observations ' + evidence.boundaryObservationCount);
  console.log('  observation digest   ' + evidence.boundaryObservationDigest);
  console.log('  live next            ' + (evidence.liveObservation.next ?? 'none'));
  console.log('  live selected        ' + (evidence.liveObservation.selected.join(',') || 'none'));
  console.log('  runtime generation   ' + evidence.runtimeRevision.generation);
  console.log('  evidence             ' + output);
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
}
