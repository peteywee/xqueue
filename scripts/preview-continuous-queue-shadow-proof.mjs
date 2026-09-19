#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import {
  assertExactShadowReadback,
  assertMigrationLedger,
  assertPreviewConfig,
  assertPublicationStateParity,
  classifyShadowCounts,
  flattenStatementRows,
  migrationNames,
  parseWranglerJson,
  PREVIEW_CONFIG,
  PREVIEW_DB,
  SHADOW_MIGRATION,
  sha256Json,
  wranglerExecuteArgs,
  wranglerMigrationsApplyArgs,
} from '../src/d1-preview-shadow-proof.mjs';
import {
  renderShadowBackfillSql,
  shadowManifestSha256,
} from '../src/continuous-queue-shadow.mjs';
import { buildProductionShadow } from './build-continuous-queue-shadow.mjs';

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
      `${command} ${args.join(' ')} failed with exit ${result.status}${detail ? `: ${detail}` : ''}`,
    );
  }

  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

function query(sql) {
  const { stdout } = run('pnpm', wranglerExecuteArgs({ sql }));
  return flattenStatementRows(parseWranglerJson(stdout));
}

function executeFile(file) {
  const { stdout } = run('pnpm', wranglerExecuteArgs({ file }));
  return parseWranglerJson(stdout);
}

function readMigrationLedger() {
  return query('SELECT id,name,applied_at FROM d1_migrations ORDER BY id;');
}

function readShadowCounts() {
  const [row] = query(
    [
      'SELECT',
      '  (SELECT COUNT(*) FROM queue_content) AS content_count,',
      '  (SELECT COUNT(*) FROM queue_content_revisions) AS revision_count,',
      "  (SELECT COUNT(*) FROM queue_assignments WHERE status = 'active') AS assignment_count,",
      '  (SELECT COUNT(*) FROM queue_content_events) AS content_event_count,',
      '  (SELECT COUNT(*) FROM queue_assignment_events) AS assignment_event_count;',
    ].join('\n'),
  );
  if (!row) throw new Error('preview shadow count query returned no row');
  return row;
}

function readShadowRows() {
  return {
    content: query(
      'SELECT content_id,pillar,current_revision,status,generation FROM queue_content ORDER BY content_id;',
    ),
    revisions: query(
      'SELECT content_id,revision,title,body,publication_text,content_digest,figure,source_ref FROM queue_content_revisions ORDER BY content_id,revision;',
    ),
    assignments: query(
      [
        'SELECT assignment_id,assignment_version,content_id,content_revision,content_digest,',
        'target_account,policy_version,resolved_at,scheduled_date,scheduled_time,timezone,',
        'slot_label,status,superseded_by_version,generation',
        "FROM queue_assignments WHERE status = 'active' ORDER BY content_id;",
      ].join(' '),
    ),
  };
}

function immutableRuntimeSnapshot() {
  const publicationState = query(
    'SELECT * FROM publication_state ORDER BY post_id;',
  );
  const runtimeMetadata = query(
    'SELECT key,value,updated_at FROM runtime_metadata ORDER BY key;',
  );
  const authorityState = query(
    'SELECT * FROM authority_state ORDER BY singleton_id;',
  );

  return {
    publicationStateHash: sha256Json(publicationState),
    runtimeMetadataHash: sha256Json(runtimeMetadata),
    authorityStateHash: sha256Json(authorityState),
    publicationState,
  };
}

function assertSameRuntimeSnapshot(before, after) {
  for (const key of [
    'publicationStateHash',
    'runtimeMetadataHash',
    'authorityStateHash',
  ]) {
    if (before[key] !== after[key]) {
      throw new Error(`preview live-state snapshot changed unexpectedly: ${key}`);
    }
  }
}

function requireCloudflareCredentials() {
  for (const name of ['CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_API_TOKEN']) {
    if (typeof process.env[name] !== 'string' || process.env[name].length === 0) {
      throw new Error(`${name} is required`);
    }
  }
}

function main() {
  requireCloudflareCredentials();

  const config = JSON.parse(readFileSync(PREVIEW_CONFIG, 'utf8'));
  assertPreviewConfig(config);

  run('node', ['scripts/authority-boundary-audit.mjs'], { capture: false });

  const model = buildProductionShadow();
  if (model.count !== 180) {
    throw new Error(`expected 180 shadow rows, got ${model.count}`);
  }

  const beforeMigrations = readMigrationLedger();
  const beforeLedger = assertMigrationLedger(migrationNames(beforeMigrations));
  const beforeRuntime = immutableRuntimeSnapshot();

  let migrationAction = 'already_applied';
  if (!beforeLedger.hasShadow) {
    run('pnpm', wranglerMigrationsApplyArgs(), { capture: false });
    migrationAction = 'applied_0006';
  }

  const afterMigrationRows = readMigrationLedger();
  const afterLedger = assertMigrationLedger(migrationNames(afterMigrationRows));
  if (!afterLedger.hasShadow) {
    throw new Error(`${SHADOW_MIGRATION} was not present after migration apply`);
  }

  const initialCounts = classifyShadowCounts(readShadowCounts(), model.count);
  let seedAction = 'already_complete';

  if (initialCounts.state === 'empty') {
    const dir = mkdtempSync(join(tmpdir(), 'xqueue-shadow-'));
    const seedFile = join(dir, 'shadow-backfill.sql');
    const recordedAt = new Date().toISOString();
    writeFileSync(
      seedFile,
      renderShadowBackfillSql(model, { recordedAt }),
      'utf8',
    );
    executeFile(seedFile);
    seedAction = 'seeded_180';
  }

  const finalCounts = classifyShadowCounts(readShadowCounts(), model.count);
  if (finalCounts.state !== 'complete') {
    throw new Error('preview shadow seed did not reach exact complete state');
  }

  const readback = readShadowRows();
  assertExactShadowReadback(model, readback);

  const publicationRows = query(
    'SELECT post_id,scheduled_at FROM publication_state ORDER BY post_id;',
  );
  assertPublicationStateParity(model, publicationRows);

  const afterRuntime = immutableRuntimeSnapshot();
  assertSameRuntimeSnapshot(beforeRuntime, afterRuntime);

  const evidence = {
    schema_version: 1,
    environment: 'preview',
    database: PREVIEW_DB,
    config: PREVIEW_CONFIG,
    candidate_sha: process.env.GITHUB_SHA ?? null,
    produced_at: new Date().toISOString(),
    model_sha256: shadowManifestSha256(model),
    expected_count: model.count,
    migration_action: migrationAction,
    seed_action: seedAction,
    migrations_before: migrationNames(beforeMigrations),
    migrations_after: migrationNames(afterMigrationRows),
    shadow_counts: finalCounts.counts,
    publication_state_count: publicationRows.length,
    unchanged_runtime_hashes: {
      publication_state: afterRuntime.publicationStateHash,
      runtime_metadata: afterRuntime.runtimeMetadataHash,
      authority_state: afterRuntime.authorityStateHash,
    },
    checks: {
      exact_shadow_readback: 'pass',
      publication_state_slot_parity: 'pass',
      publication_state_unchanged: 'pass',
      runtime_metadata_unchanged: 'pass',
      authority_state_unchanged: 'pass',
    },
  };

  const evidencePath =
    process.env.XQUEUE_PREVIEW_SHADOW_EVIDENCE ??
    join(tmpdir(), 'xqueue-preview-shadow-proof.json');
  writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');

  console.log('XQUEUE PREVIEW SHADOW PROOF: PASS');
  console.log(`  model sha256       ${evidence.model_sha256}`);
  console.log(`  migration action   ${migrationAction}`);
  console.log(`  seed action        ${seedAction}`);
  console.log(`  shadow rows        ${model.count}`);
  console.log(`  evidence           ${resolve(evidencePath)}`);
}

main();
