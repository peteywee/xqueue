#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { MEDIA_MANIFEST } from '../cloudflare/generated/media-manifest.mjs';
import {
  ACTIVE_ASSIGNMENTS_SQL,
  APPROVED_UNSCHEDULED_SQL,
  DEFERRED_ASSIGNMENTS_SQL,
  buildDynamicRuntimeSnapshot,
  CURRENT_MEDIA_SQL,
  RUNTIME_STATE_SQL,
} from '../cloudflare/src/dynamic-runtime-integrity.mjs';
import {
  nextRuntimeRevision,
  renderMediaInsertSql,
  renderRuntimeRevisionInsertSql,
} from '../src/continuous-queue-runtime-write.mjs';
import { assertPreviewConfig } from '../src/d1-preview-shadow-proof.mjs';
import {
  assertPreviewHaltState,
  assertPreviewMigrationLane,
  assertPreviewRevisionChain,
  PREVIEW_BOOTSTRAP_ACTIVE_ASSIGNMENTS,
  PREVIEW_DYNAMIC_RUNTIME_MIGRATIONS,
  PREVIEW_HALT_EVENTS_SQL,
  PREVIEW_MUTATION_OPERATIONS_SQL,
  PREVIEW_REVISION_HISTORY_SQL,
} from '../src/preview-runtime-proof-checks.mjs';

const PREVIEW_DB = 'xqueue-preview';
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PREVIEW_CONFIG = 'wrangler.preview.jsonc';
const PROOF_URL =
  process.env.XQUEUE_PREVIEW_PROOF_URL ??
  'http://127.0.0.1:8787/proof';
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
    deferred: query(DEFERRED_ASSIGNMENTS_SQL),
    approvedUnscheduled: query(APPROVED_UNSCHEDULED_SQL),
    media: query(CURRENT_MEDIA_SQL),
  });
}

function readRuntimeState() {
  return query(RUNTIME_STATE_SQL)[0] ?? null;
}

async function verifyR2Bytes(mediaRows) {
  let response;
  try {
    response = await fetch(PROOF_URL, {
      headers: {
        accept: 'application/json',
        'cache-control': 'no-cache',
      },
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    throw new Error(
      'preview proof Worker was unreachable: ' +
      (error instanceof Error ? error.message : String(error)),
    );
  }

  let body;
  try {
    body = await response.json();
  } catch {
    throw new Error(
      'preview proof Worker returned non-JSON data (HTTP ' + response.status + ')',
    );
  }

  if (!response.ok || body?.status !== 'ok') {
    throw new Error(
      'preview proof Worker reported failure: ' + JSON.stringify(body),
    );
  }
  if (
    body?.service !== 'xqueue-preview-proof' ||
    body?.role !== 'read-only-proof' ||
    body?.publicationCapable !== false ||
    body?.schedulerAuthority !== false
  ) {
    throw new Error('preview proof Worker role boundary is invalid');
  }

  const runtime = body?.dynamicRuntime;
  const proof = body?.mediaBodyProof;
  if (
    runtime?.ok !== true ||
    runtime?.media?.ok !== true ||
    Number(runtime?.mediaRequiredCount) !== mediaRows.length ||
    Number(runtime?.mediaReadyCount) !== mediaRows.length ||
    proof?.ok !== true ||
    Number(proof?.bodyObservedCount) !== mediaRows.length ||
    !Array.isArray(proof?.objects)
  ) {
    throw new Error('preview proof Worker did not verify every required media body');
  }

  const expected = new Map(
    mediaRows.map((row) => [
      row.r2_key,
      {
        byteSize: Number(row.byte_size),
        sha256: String(row.sha256).toLowerCase(),
      },
    ]),
  );

  for (const object of proof.objects) {
    const want = expected.get(object?.r2Key);
    if (
      !want ||
      Number(object.byteSize) !== want.byteSize ||
      String(object.sha256 ?? '').toLowerCase() !== want.sha256 ||
      object.sizeMatch !== true ||
      object.hashMatch !== true
    ) {
      throw new Error(
        'preview proof Worker media readback mismatch for ' +
        String(object?.r2Key ?? 'unknown'),
      );
    }
    expected.delete(object.r2Key);
  }

  if (expected.size !== 0) {
    throw new Error(
      'preview proof Worker omitted media keys: ' +
      JSON.stringify([...expected.keys()]),
    );
  }

  return proof.objects.map((object) => ({
    r2Key: object.r2Key,
    byteSize: Number(object.byteSize),
    sha256: String(object.sha256).toLowerCase(),
    proofSource: 'preview-proof-worker-r2-binding',
  }));
}

async function main() {
  const migrations = query('SELECT id,name,applied_at FROM d1_migrations ORDER BY id;');
  // The lane is wrangler.preview.jsonc's migrations_dir, the same directory the
  // workflow's apply step uses; assertPreviewConfig pins it.
  const previewConfig = JSON.parse(readFileSync(join(REPO_ROOT, PREVIEW_CONFIG), 'utf8'));
  assertPreviewConfig(previewConfig);
  const migrationsDir = join(REPO_ROOT, previewConfig.d1_databases[0].migrations_dir);
  const names = assertPreviewMigrationLane(
    migrations.map((row) => row.name),
    readdirSync(migrationsDir).filter((name) => name.endsWith('.sql')),
  );

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
  const haltSummary = assertPreviewHaltState({
    state: halt,
    events: query(PREVIEW_HALT_EVENTS_SQL),
  });

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
    if (computed.active_assignment_count !== PREVIEW_BOOTSTRAP_ACTIVE_ASSIGNMENTS) {
      throw new Error(
        `preview dynamic runtime bootstrap expected ${PREVIEW_BOOTSTRAP_ACTIVE_ASSIGNMENTS} active assignments, got ${computed.active_assignment_count}`,
      );
    }
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
    state.revision_digest !== computed.revision_digest ||
    Number(state.active_assignment_count) !== computed.active_assignment_count ||
    Number(state.approved_unscheduled_count) !== computed.approved_unscheduled_count ||
    Number(state.media_required_count) !== computed.media_required_count ||
    Number(state.media_ready_count) !== computed.media_ready_count
  ) {
    throw new Error('preview runtime revision state does not match recomputed durable truth');
  }

  const revisionChain = assertPreviewRevisionChain({
    revisions: query(PREVIEW_REVISION_HISTORY_SQL),
    operations: query(PREVIEW_MUTATION_OPERATIONS_SQL),
    state,
  });

  const r2 = await verifyR2Bytes(mediaActual);

  const evidence = {
    format: 1,
    environment: 'preview',
    database: PREVIEW_DB,
    config: PREVIEW_CONFIG,
    mainCandidate: process.env.GITHUB_SHA ?? null,
    migrations: names,
    dynamicRuntimeMigrations: PREVIEW_DYNAMIC_RUNTIME_MIGRATIONS,
    revisionChain,
    publicationHalt: {
      halted: Number(halt.halted) === 1,
      generation: Number(halt.generation),
      reason: halt.reason,
      actorClass: halt.actor_class,
      updatedAt: halt.updated_at,
      events: haltSummary.events,
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
    r2ProofUrl: PROOF_URL,
    productionMutation: false,
    publicationAuthorityChanged: false,
    proofFixtureInserted: false,
  };

  writeFileSync(EVIDENCE, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');

  console.log('XQUEUE PREVIEW DYNAMIC RUNTIME PROOF: PASS');
  console.log(`  revision generation  ${state.generation}`);
  console.log(`  revision digest      ${state.revision_digest}`);
  console.log(`  mutation revisions   ${revisionChain.mutationRevisions}`);
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
