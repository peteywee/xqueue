#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MEDIA_MANIFEST } from '../cloudflare/generated/media-manifest.mjs';
import {
  ACTIVE_ASSIGNMENTS_SQL,
  APPROVED_UNSCHEDULED_SQL,
  buildDynamicRuntimeSnapshot,
  CURRENT_MEDIA_SQL,
  RUNTIME_STATE_SQL,
} from '../cloudflare/src/dynamic-runtime-integrity.mjs';
import {
  nextRuntimeRevision,
  renderMediaInsertSql,
  renderRuntimeRevisionInsertSql,
} from '../src/continuous-queue-runtime-write.mjs';

const PREVIEW_DB = 'xqueue-preview';
const PREVIEW_CONFIG = 'wrangler.preview.jsonc';
const BUCKET = 'xqueue-media';
const EVIDENCE =
  process.env.XQUEUE_PREVIEW_DYNAMIC_RUNTIME_EVIDENCE ??
  '/tmp/xqueue-preview-dynamic-runtime-proof.json';

const MIME = Object.freeze({
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
});

function run(command, args, { capture = true } = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    env: process.env,
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
  });

  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = [result.stderr, result.stdout].filter(Boolean).join('\n').trim();
    throw new Error(
      `${command} ${args.join(' ')} failed with exit ${result.status}${detail ? `: ${detail}` : ''}`,
    );
  }

  return result.stdout ?? '';
}

function parseWranglerJson(stdout) {
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error('Wrangler D1 output is not valid JSON');
  }

  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error('Wrangler D1 output contained no statement results');
  }

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
      PREVIEW_DB,
      '--config',
      PREVIEW_CONFIG,
      '--remote',
      '--yes',
      '--json',
      '--command',
      sql,
    ]),
  );
}

function executeFile(sql) {
  const dir = mkdtempSync(join(tmpdir(), 'xqueue-runtime-proof-'));
  const file = join(dir, 'operation.sql');

  try {
    writeFileSync(file, sql, 'utf8');
    // Wrangler 4.131.0 emits human-formatted output for --file even when
    // --json is requested. Exit status is the mutation result; exact state is
    // always reconciled by the caller's independent D1 readback before retry.
    run('pnpm', [
      'wrangler',
      'd1',
      'execute',
      PREVIEW_DB,
      '--config',
      PREVIEW_CONFIG,
      '--remote',
      '--yes',
      '--file',
      file,
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function runtimeMediaRows() {
  return MEDIA_MANIFEST.objects.map((object) => {
    const mimeType = MIME[object.extension];
    if (!mimeType) throw new Error(`unsupported bootstrap media extension: ${object.extension}`);

    return {
      content_id: object.postId,
      content_revision: 1,
      media_ordinal: 0,
      figure: object.figure,
      logical_media_id: object.logicalMediaId,
      r2_key: object.r2Key,
      extension: object.extension,
      mime_type: mimeType,
      byte_size: object.byteSize,
      sha256: object.sha256,
      status: 'ready',
      generation: 1,
    };
  });
}

function readMediaRows() {
  return query(
    'SELECT content_id,content_revision,media_ordinal,figure,logical_media_id,' +
    'r2_key,extension,mime_type,byte_size,sha256,status,generation AS media_generation ' +
    'FROM queue_media_objects WHERE status <> \'retired\' ' +
    'ORDER BY content_id,content_revision,media_ordinal;',
  );
}

function assertMediaReadback(expected, actual) {
  if (actual.length !== expected.length) {
    throw new Error(
      `preview media row count ${actual.length} does not match expected ${expected.length}`,
    );
  }

  const canonical = (row) => JSON.stringify({
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

  const want = expected
    .map((row) => canonical({ ...row, media_generation: row.generation }))
    .sort();
  const got = actual.map(canonical).sort();

  if (JSON.stringify(want) !== JSON.stringify(got)) {
    throw new Error('preview media metadata readback does not match bootstrap manifest');
  }
}

async function snapshot() {
  return buildDynamicRuntimeSnapshot({
    assignments: query(ACTIVE_ASSIGNMENTS_SQL),
    approvedUnscheduled: query(APPROVED_UNSCHEDULED_SQL),
    media: query(CURRENT_MEDIA_SQL),
  });
}

function readRuntimeState() {
  return query(RUNTIME_STATE_SQL)[0] ?? null;
}

function readRevisionHead() {
  return query(
    'SELECT generation,revision_digest,active_assignment_count,' +
    'approved_unscheduled_count,media_required_count,media_ready_count,' +
    'previous_revision_digest,source_operation_id,created_at ' +
    'FROM queue_runtime_revisions ORDER BY generation DESC LIMIT 2;',
  );
}

function verifyR2Bytes(mediaRows) {
  const dir = mkdtempSync(join(tmpdir(), 'xqueue-runtime-r2-'));
  const verified = [];

  try {
    for (const row of mediaRows) {
      const destination = join(
        dir,
        `${String(row.figure).padStart(4, '0')}.${row.extension}`,
      );

      run('pnpm', [
        'wrangler',
        'r2',
        'object',
        'get',
        `${BUCKET}/${row.r2_key}`,
        '--file',
        destination,
        '--remote',
      ], { capture: false });

      const byteSize = statSync(destination).size;
      const sha256 = createHash('sha256')
        .update(readFileSync(destination))
        .digest('hex');

      if (byteSize !== Number(row.byte_size)) {
        throw new Error(`${row.r2_key}: R2 byte size mismatch`);
      }
      if (sha256 !== row.sha256) {
        throw new Error(`${row.r2_key}: R2 SHA-256 mismatch`);
      }

      verified.push({
        r2Key: row.r2_key,
        byteSize,
        sha256,
      });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  return verified;
}

async function main() {
  const migrations = query('SELECT id,name,applied_at FROM d1_migrations ORDER BY id;');
  const names = migrations.map((row) => row.name);
  const expectedTail = [
    '0006_continuous_queue_shadow.sql',
    '0007_continuous_queue_intake.sql',
    '0008_dynamic_runtime_integrity.sql',
    '0009_deferred_lifecycle.sql',
    '0010_publication_fence_identity.sql',
    '0011_global_publication_halt.sql',
    '0012_reconciliation_determinations.sql',
  ];

  if (JSON.stringify(names.slice(-7)) !== JSON.stringify(expectedTail)) {
    throw new Error(
      `preview migration tail is not exact 0006-0012: ${JSON.stringify(names)}`,
    );
  }

  const reconciliationSchema = query(
    "SELECT name FROM sqlite_master WHERE type='table' " +
    "AND name='publication_reconciliation_determinations';",
  );
  if (reconciliationSchema.length !== 1) {
    throw new Error('preview reconciliation determination schema is missing');
  }

  const halt = query(
    'SELECT halted,generation,reason,actor_class,updated_at ' +
    'FROM publication_halt_state WHERE singleton_id=1;',
  )[0] ?? null;
  if (
    !halt ||
    Number(halt.halted) !== 0 ||
    Number(halt.generation) !== 1 ||
    halt.reason !== 'initial_unhalted' ||
    halt.actor_class !== 'migration'
  ) {
    throw new Error('preview global publication halt did not initialize fail-safe state exactly');
  }

  const mediaExpected = runtimeMediaRows();
  let mediaActual = readMediaRows();
  let mediaAction = 'already_complete';

  if (mediaActual.length === 0) {
    if (readRuntimeState()) {
      throw new Error(
        'runtime revision exists before media bootstrap; refusing to mutate canonical inputs',
      );
    }

    executeFile(
      renderMediaInsertSql(mediaExpected, {
        recordedAt: new Date().toISOString(),
        eventType: 'preview_runtime_media_backfill',
      }),
    );
    mediaActual = readMediaRows();
    mediaAction = 'inserted';
  }

  assertMediaReadback(mediaExpected, mediaActual);

  const computed = await snapshot();
  if (computed.active_assignment_count !== 180) {
    throw new Error(
      `preview dynamic runtime expected 180 active assignments, got ${computed.active_assignment_count}`,
    );
  }
  if (
    computed.media_required_count !== 4 ||
    computed.media_ready_count !== 4
  ) {
    throw new Error(
      `preview dynamic runtime media counts are not 4/4: ${computed.media_required_count}/${computed.media_ready_count}`,
    );
  }

  let state = readRuntimeState();
  let revisionAction = 'already_complete';

  if (!state) {
    const revision = nextRuntimeRevision({
      currentState: null,
      snapshot: computed,
      sourceOperationId: null,
      recordedAt: new Date().toISOString(),
    });

    executeFile(renderRuntimeRevisionInsertSql(revision));
    state = readRuntimeState();
    revisionAction = 'initialized';
  }

  if (
    !state ||
    Number(state.generation) !== 1 ||
    state.revision_digest !== computed.revision_digest ||
    Number(state.active_assignment_count) !== computed.active_assignment_count ||
    Number(state.approved_unscheduled_count) !== computed.approved_unscheduled_count ||
    Number(state.media_required_count) !== computed.media_required_count ||
    Number(state.media_ready_count) !== computed.media_ready_count
  ) {
    throw new Error('preview runtime revision state does not match recomputed durable truth');
  }

  const head = readRevisionHead();
  if (
    head.length !== 1 ||
    Number(head[0].generation) !== 1 ||
    head[0].revision_digest !== state.revision_digest ||
    head[0].previous_revision_digest !== null
  ) {
    throw new Error('preview runtime revision history is not exact generation 1');
  }

  const r2 = verifyR2Bytes(mediaActual);

  const evidence = {
    format: 1,
    environment: 'preview',
    database: PREVIEW_DB,
    config: PREVIEW_CONFIG,
    mainCandidate: process.env.GITHUB_SHA ?? null,
    migrationTail: expectedTail,
    publicationHalt: {
      halted: Number(halt.halted) === 1,
      generation: Number(halt.generation),
      reason: halt.reason,
      actorClass: halt.actor_class,
      updatedAt: halt.updated_at,
    },
    mediaAction,
    revisionAction,
    runtime: {
      generation: Number(state.generation),
      revisionDigest: state.revision_digest,
      activeAssignmentCount: Number(state.active_assignment_count),
      approvedUnscheduledCount: Number(state.approved_unscheduled_count),
      mediaRequiredCount: Number(state.media_required_count),
      mediaReadyCount: Number(state.media_ready_count),
    },
    mediaRows: mediaActual.map((row) => ({
      contentId: row.content_id,
      contentRevision: Number(row.content_revision),
      figure: Number(row.figure),
      r2Key: row.r2_key,
      mimeType: row.mime_type,
      byteSize: Number(row.byte_size),
      sha256: row.sha256,
      status: row.status,
    })),
    r2ByteVerification: r2,
    productionMutation: false,
    publicationAuthorityChanged: false,
    proofFixtureInserted: false,
  };

  writeFileSync(EVIDENCE, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');

  console.log('XQUEUE PREVIEW DYNAMIC RUNTIME PROOF: PASS');
  console.log(`  revision generation  ${state.generation}`);
  console.log(`  revision digest      ${state.revision_digest}`);
  console.log(`  active assignments   ${state.active_assignment_count}`);
  console.log(`  media ready           ${state.media_ready_count}/${state.media_required_count}`);
  console.log(`  media action          ${mediaAction}`);
  console.log(`  revision action       ${revisionAction}`);
  console.log(`  R2 bytes verified     ${r2.length}`);
  console.log(`  evidence              ${EVIDENCE}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
