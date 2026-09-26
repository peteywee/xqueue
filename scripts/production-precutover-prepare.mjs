#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MEDIA_MANIFEST } from '../cloudflare/generated/media-manifest.mjs';
import {
  ACTIVE_ASSIGNMENTS_SQL,
  APPROVED_UNSCHEDULED_SQL,
  buildDynamicRuntimeSnapshot,
  CURRENT_MEDIA_SQL,
  DEFERRED_ASSIGNMENTS_SQL,
  RUNTIME_STATE_SQL,
} from '../cloudflare/src/dynamic-runtime-integrity.mjs';
import {
  CANONICAL_QUEUE_JSON,
  DECLARED_QUEUE_COUNT,
  DECLARED_QUEUE_SHA256,
} from '../cloudflare/generated/queue-bundle.mjs';
import { decodeBundledQueue } from '../cloudflare/src/queue-integrity.mjs';
import {
  renderShadowBackfillSql,
} from '../src/continuous-queue-shadow.mjs';
import {
  nextRuntimeRevision,
  renderMediaInsertSql,
  renderRuntimeRevisionInsertSql,
} from '../src/continuous-queue-runtime-write.mjs';
import { buildProductionShadow } from './build-continuous-queue-shadow.mjs';

const DB = 'xqueue-production';
const CONFIG = 'wrangler.prep.jsonc';
const CONFIRM = 'PREPARE_XQUEUE_PRODUCTION';
const OLD_QUEUE_SHA = 'a8cda41f869f4e58d2566e5c558fbbd3f7ce89ae6cbf6d138b1e517f363750b7';
const EVIDENCE =
  process.env.XQUEUE_PRODUCTION_PREP_EVIDENCE ??
  '/tmp/xqueue-production-prep.json';

const MIME = Object.freeze({
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
});

function requireApproval() {
  if (process.env.XQUEUE_PRODUCTION_PREP_APPROVED !== CONFIRM) {
    throw new Error(
      'production preparation requires XQUEUE_PRODUCTION_PREP_APPROVED=' + CONFIRM,
    );
  }
}

function run(command, args, { capture = true } = {}) {
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    env: process.env,
    encoding: 'utf8',
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
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

function parseWranglerJson(stdout) {
  const parsed = JSON.parse(stdout);
  if (!Array.isArray(parsed)) throw new Error('Wrangler D1 output is not an array');

  const rows = [];
  for (const statement of parsed) {
    if (statement?.success !== true) {
      throw new Error('Wrangler D1 statement did not report success');
    }
    if (Array.isArray(statement.results)) rows.push(...statement.results);
  }
  return rows;
}

function query(sql) {
  return parseWranglerJson(
    run('pnpm', [
      'wrangler',
      'd1',
      'execute',
      DB,
      '--config',
      CONFIG,
      '--remote',
      '--yes',
      '--json',
      '--command',
      sql,
    ]),
  );
}

function executeSql(sql) {
  const dir = mkdtempSync(join(tmpdir(), 'xqueue-production-prep-'));
  const file = join(dir, 'operation.sql');

  try {
    writeFileSync(file, sql, 'utf8');
    run('pnpm', [
      'wrangler',
      'd1',
      'execute',
      DB,
      '--config',
      CONFIG,
      '--remote',
      '--yes',
      '--file',
      file,
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function one(sql, label) {
  const rows = query(sql);
  if (rows.length !== 1) {
    throw new Error(label + ' expected exactly one row, got ' + rows.length);
  }
  return rows[0];
}

function assertBundle() {
  const queue = decodeBundledQueue();
  if (queue.length !== 180 || DECLARED_QUEUE_COUNT !== 180) {
    throw new Error('production prep requires exact 180-row bundle');
  }
  if (queue.some((row) => typeof row.scheduledAt !== 'string')) {
    throw new Error('production prep refuses a bundle without committed UTC on every row');
  }

  const sha = createHash('sha256')
    .update(Buffer.from(CANONICAL_QUEUE_JSON, 'utf8'))
    .digest('hex');
  if (sha !== DECLARED_QUEUE_SHA256) {
    throw new Error('declared queue SHA does not match canonical bundle bytes');
  }

  return queue;
}

function assertPreMutationState() {
  const metadata = query(
    "SELECT key,value FROM runtime_metadata WHERE key IN ('queue.sha256','queue.count') ORDER BY key;",
  );
  const map = Object.fromEntries(metadata.map((row) => [row.key, row.value]));

  if (![OLD_QUEUE_SHA, DECLARED_QUEUE_SHA256].includes(map['queue.sha256'])) {
    throw new Error(
      'refusing unknown production queue SHA: ' + String(map['queue.sha256']),
    );
  }
  if (Number(map['queue.count']) !== 180) {
    throw new Error('refusing production queue count other than 180');
  }

  const unresolved = one(
    "SELECT COUNT(*) AS count FROM publication_state WHERE status IN ('prepared','publishing','needs_reconciliation');",
    'unresolved publication state',
  );
  if (Number(unresolved.count) !== 0) {
    throw new Error('production contains an unresolved publication attempt');
  }

  const nowMs = Date.now();
  const lease = one(
    'SELECT COUNT(*) AS count FROM publication_leases ' +
      'WHERE owner_token IS NOT NULL AND expires_at_ms > ' + String(nowMs) + ';',
    'active lease count',
  );
  if (Number(lease.count) !== 0) {
    throw new Error('production has an active publication lease');
  }

  return {
    priorQueueSha256: map['queue.sha256'],
    queueCount: Number(map['queue.count']),
  };
}

function assertMigrationTail() {
  const rows = query('SELECT name FROM d1_migrations ORDER BY id;');
  const names = rows.map((row) => row.name);
  const required = [
    '0006_continuous_queue_shadow.sql',
    '0007_continuous_queue_intake.sql',
    '0008_dynamic_runtime_integrity.sql',
    '0009_deferred_lifecycle.sql',
    '0010_publication_fence_identity.sql',
    '0011_global_publication_halt.sql',
    '0012_reconciliation_determinations.sql',
  ];

  for (const name of required) {
    if (!names.includes(name)) {
      throw new Error('production migration missing after apply: ' + name);
    }
  }

  return names;
}

function shadowCounts() {
  return one(
    [
      'SELECT',
      ' (SELECT COUNT(*) FROM queue_content) AS content_count,',
      ' (SELECT COUNT(*) FROM queue_content_revisions) AS revision_count,',
      " (SELECT COUNT(*) FROM queue_assignments WHERE status='active') AS assignment_count;",
    ].join('\n'),
    'shadow counts',
  );
}

function seedShadow() {
  const model = buildProductionShadow();
  if (model.count !== 180) throw new Error('production shadow model is not 180 rows');

  const before = shadowCounts();
  const values = [
    Number(before.content_count),
    Number(before.revision_count),
    Number(before.assignment_count),
  ];

  let action = 'already_complete';
  if (values.every((value) => value === 0)) {
    executeSql(
      renderShadowBackfillSql(model, {
        recordedAt: new Date().toISOString(),
      }),
    );
    action = 'seeded_180';
  } else if (!values.every((value) => value === 180)) {
    throw new Error('production shadow is partial; refusing automatic repair');
  }

  const after = shadowCounts();
  if (
    Number(after.content_count) !== 180 ||
    Number(after.revision_count) !== 180 ||
    Number(after.assignment_count) !== 180
  ) {
    throw new Error('production shadow readback is not exact 180/180/180');
  }

  const coverage = one(
    [
      'SELECT',
      " (SELECT COUNT(*) FROM publication_state) AS publication_count,",
      " (SELECT COUNT(*) FROM queue_assignments WHERE status='active') AS assignment_count,",
      " (SELECT COUNT(*) FROM publication_state p LEFT JOIN queue_assignments a",
      "  ON a.content_id=p.post_id AND a.status='active' WHERE a.content_id IS NULL) AS publication_missing_assignment,",
      " (SELECT COUNT(*) FROM queue_assignments a LEFT JOIN publication_state p",
      "  ON p.post_id=a.content_id WHERE a.status='active' AND p.post_id IS NULL) AS assignment_missing_publication;",
    ].join('\n'),
    'publication/shadow coverage',
  );

  if (
    Number(coverage.publication_count) !== 180 ||
    Number(coverage.assignment_count) !== 180 ||
    Number(coverage.publication_missing_assignment) !== 0 ||
    Number(coverage.assignment_missing_publication) !== 0
  ) {
    throw new Error('publication_state and durable assignments do not have exact set parity');
  }

  return { action, counts: after };
}

function expectedMediaRows() {
  return MEDIA_MANIFEST.objects.map((object) => ({
    content_id: object.postId,
    content_revision: 1,
    media_ordinal: 0,
    figure: object.figure,
    logical_media_id: object.logicalMediaId,
    r2_key: object.r2Key,
    extension: object.extension,
    mime_type: MIME[object.extension],
    byte_size: object.byteSize,
    sha256: object.sha256,
    status: 'ready',
    generation: 1,
  }));
}

function readMediaRows() {
  return query(
    'SELECT content_id,content_revision,media_ordinal,figure,logical_media_id,' +
      'r2_key,extension,mime_type,byte_size,sha256,status,generation AS media_generation ' +
      "FROM queue_media_objects WHERE status <> 'retired' " +
      'ORDER BY content_id,content_revision,media_ordinal;',
  );
}

function canonicalMedia(row) {
  return JSON.stringify({
    content_id: row.content_id,
    content_revision: Number(row.content_revision),
    media_ordinal: Number(row.media_ordinal ?? 0),
    figure: row.figure == null ? null : Number(row.figure),
    logical_media_id: row.logical_media_id,
    r2_key: row.r2_key,
    extension: row.extension,
    mime_type: row.mime_type,
    byte_size: Number(row.byte_size),
    sha256: row.sha256,
    status: row.status,
    media_generation: Number(row.media_generation ?? row.generation),
  });
}

async function seedDynamicRuntime() {
  const expected = expectedMediaRows();
  let actual = readMediaRows();
  let mediaAction = 'already_complete';

  if (actual.length === 0) {
    if (query(RUNTIME_STATE_SQL)[0]) {
      throw new Error('runtime revision exists before media metadata bootstrap');
    }

    executeSql(
      renderMediaInsertSql(expected, {
        recordedAt: new Date().toISOString(),
        eventType: 'production_precutover_media_backfill',
      }),
    );
    actual = readMediaRows();
    mediaAction = 'inserted';
  }

  const want = expected.map((row) =>
    canonicalMedia({ ...row, media_generation: row.generation }),
  ).sort();
  const got = actual.map(canonicalMedia).sort();
  if (JSON.stringify(want) !== JSON.stringify(got)) {
    throw new Error('production media metadata does not match canonical manifest');
  }

  const snapshot = await buildDynamicRuntimeSnapshot({
    assignments: query(ACTIVE_ASSIGNMENTS_SQL),
    deferred: query(DEFERRED_ASSIGNMENTS_SQL),
    approvedUnscheduled: query(APPROVED_UNSCHEDULED_SQL),
    media: query(CURRENT_MEDIA_SQL),
  });

  if (
    snapshot.active_assignment_count + snapshot.deferred_count !== 180 ||
    snapshot.media_required_count !== 4 ||
    snapshot.media_ready_count !== 4
  ) {
    throw new Error('production dynamic runtime snapshot does not preserve 180 assigned/deferred items and 4 of 4 media');
  }

  let state = query(RUNTIME_STATE_SQL)[0] ?? null;
  let revisionAction = 'already_complete';

  if (!state) {
    const revision = nextRuntimeRevision({
      currentState: null,
      snapshot,
      sourceOperationId: null,
      recordedAt: new Date().toISOString(),
    });
    executeSql(renderRuntimeRevisionInsertSql(revision));
    state = query(RUNTIME_STATE_SQL)[0] ?? null;
    revisionAction = 'initialized';
  }

  if (
    !state ||
    !Number.isSafeInteger(Number(state.generation)) ||
    Number(state.generation) < 1 ||
    state.revision_digest !== snapshot.revision_digest ||
    Number(state.active_assignment_count) !== snapshot.active_assignment_count ||
    Number(state.approved_unscheduled_count) !== snapshot.approved_unscheduled_count ||
    Number(state.media_required_count) !== snapshot.media_required_count ||
    Number(state.media_ready_count) !== snapshot.media_ready_count
  ) {
    throw new Error('production runtime revision does not match recomputed durable truth');
  }

  return {
    mediaAction,
    revisionAction,
    revisionDigest: state.revision_digest,
  };
}

function activateQueueMetadata() {
  const current = one(
    "SELECT value FROM runtime_metadata WHERE key='queue.sha256';",
    'current queue sha',
  ).value;

  let action = 'already_active';
  if (current === OLD_QUEUE_SHA) {
    const at = new Date().toISOString().replaceAll("'", "''");
    const next = DECLARED_QUEUE_SHA256.replaceAll("'", "''");
    const old = OLD_QUEUE_SHA.replaceAll("'", "''");
    executeSql(
      "UPDATE runtime_metadata SET value='" + next + "', updated_at='" + at + "' " +
      "WHERE key='queue.sha256' AND value='" + old + "';\n" +
      "UPDATE runtime_metadata SET value='180', updated_at='" + at + "' " +
      "WHERE key='queue.count';\n",
    );
    action = 'activated';
  } else if (current !== DECLARED_QUEUE_SHA256) {
    throw new Error('queue SHA changed during production preparation');
  }

  const rows = query(
    "SELECT key,value FROM runtime_metadata WHERE key IN ('queue.sha256','queue.count') ORDER BY key;",
  );
  const map = Object.fromEntries(rows.map((row) => [row.key, row.value]));
  if (
    map['queue.sha256'] !== DECLARED_QUEUE_SHA256 ||
    Number(map['queue.count']) !== 180
  ) {
    throw new Error('production queue metadata readback failed');
  }

  return { action, queueSha256: map['queue.sha256'], queueCount: 180 };
}

function assertHaltState() {
  const row = one(
    'SELECT halted,generation,reason,actor_class,updated_at ' +
      'FROM publication_halt_state WHERE singleton_id=1;',
    'global halt state',
  );

  if (![0, 1].includes(Number(row.halted)) || Number(row.generation) < 1) {
    throw new Error('production global halt state is malformed');
  }

  return row;
}

async function main() {
  requireApproval();
  assertBundle();
  const before = assertPreMutationState();
  const migrations = assertMigrationTail();
  const shadow = seedShadow();
  const runtime = await seedDynamicRuntime();
  const metadata = activateQueueMetadata();
  const halt = assertHaltState();

  const evidence = {
    format: 1,
    issue: 52,
    candidateSha: process.env.GITHUB_SHA ?? null,
    producedAt: new Date().toISOString(),
    environment: 'production',
    mode: 'precutover-preparation',
    before,
    migrations,
    shadow,
    runtime,
    metadata,
    halt: {
      halted: Number(halt.halted) === 1,
      generation: Number(halt.generation),
      reason: halt.reason,
      actorClass: halt.actor_class,
      updatedAt: halt.updated_at,
    },
    safety: {
      xWrite: false,
      authorityTransfer: false,
      localPublisherChanged: false,
    },
  };

  writeFileSync(EVIDENCE, JSON.stringify(evidence, null, 2) + '\n', 'utf8');

  console.log('XQUEUE PRODUCTION PRE-CUTOVER PREP: PASS');
  console.log('  prior queue sha      ' + before.priorQueueSha256);
  console.log('  active queue sha     ' + metadata.queueSha256);
  console.log('  shadow               ' + shadow.action);
  console.log('  media                ' + runtime.mediaAction);
  console.log('  runtime revision     ' + runtime.revisionAction);
  console.log('  evidence             ' + EVIDENCE);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
