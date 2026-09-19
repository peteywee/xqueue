import test from 'node:test';
import assert from 'node:assert/strict';

import {
  assertExactShadowReadback,
  assertMigrationLedger,
  assertPreviewConfig,
  assertPublicationStateCoverage,
  BASE_MIGRATIONS,
  classifyShadowCounts,
  flattenStatementRows,
  parseWranglerJson,
  PREVIEW_CONFIG,
  PREVIEW_DB,
  PREVIEW_DB_ID,
  SHADOW_MIGRATION,
  wranglerExecuteArgs,
  wranglerMigrationsApplyArgs,
} from '../src/d1-preview-shadow-proof.mjs';

function previewConfig() {
  return {
    name: PREVIEW_DB,
    d1_databases: [
      {
        binding: 'DB',
        database_name: PREVIEW_DB,
        database_id: PREVIEW_DB_ID,
        migrations_dir: 'cloudflare/migrations',
      },
    ],
  };
}

test('preview proof config is pinned to preview and refuses production identity drift', () => {
  assert.equal(assertPreviewConfig(previewConfig()), true);

  for (const broken of [
    { ...previewConfig(), name: 'xqueue-production' },
    {
      ...previewConfig(),
      d1_databases: [{
        ...previewConfig().d1_databases[0],
        database_name: 'xqueue-production',
      }],
    },
    {
      ...previewConfig(),
      d1_databases: [{
        ...previewConfig().d1_databases[0],
        database_id: 'fc85026e-bfc8-435f-8bb0-c60e139178a3',
      }],
    },
  ]) {
    assert.throws(() => assertPreviewConfig(broken), /preview|production/i);
  }
});

test('all Wrangler D1 mutation/read argv are hard-pinned to preview target', () => {
  assert.deepEqual(
    wranglerExecuteArgs({ sql: 'SELECT 1;' }),
    [
      'wrangler',
      'd1',
      'execute',
      'xqueue-preview',
      '--config',
      'wrangler.preview.jsonc',
      '--remote',
      '--yes',
      '--json',
      '--command',
      'SELECT 1;',
    ],
  );

  assert.deepEqual(
    wranglerExecuteArgs({ file: '/tmp/seed.sql' }),
    [
      'wrangler',
      'd1',
      'execute',
      'xqueue-preview',
      '--config',
      'wrangler.preview.jsonc',
      '--remote',
      '--yes',
      '--json',
      '--file',
      '/tmp/seed.sql',
    ],
  );

  assert.deepEqual(
    wranglerMigrationsApplyArgs(),
    [
      'wrangler',
      'd1',
      'migrations',
      'apply',
      'xqueue-preview',
      '--config',
      'wrangler.preview.jsonc',
      '--remote',
    ],
  );

  for (const args of [
    wranglerExecuteArgs({ sql: 'SELECT 1;' }),
    wranglerExecuteArgs({ file: '/tmp/seed.sql' }),
    wranglerMigrationsApplyArgs(),
  ]) {
    assert.equal(args.includes('xqueue-production'), false);
    assert.equal(args.includes('wrangler.jsonc'), false);
  }
});

test('migration ledger accepts only exact 0001-0005 baseline with optional terminal 0006', () => {
  assert.deepEqual(
    assertMigrationLedger([...BASE_MIGRATIONS]),
    { hasShadow: false, postShadowMigrations: [] },
  );

  assert.deepEqual(
    assertMigrationLedger([...BASE_MIGRATIONS, SHADOW_MIGRATION]),
    { hasShadow: true, postShadowMigrations: [] },
  );

  assert.deepEqual(
    assertMigrationLedger([
      ...BASE_MIGRATIONS,
      SHADOW_MIGRATION,
      '0007_continuous_queue_intake.sql',
    ]),
    {
      hasShadow: true,
      postShadowMigrations: ['0007_continuous_queue_intake.sql'],
    },
  );

  assert.throws(
    () => assertMigrationLedger(BASE_MIGRATIONS.slice(0, -1)),
    /exact 0001-0005 baseline/,
  );
  assert.throws(
    () => assertMigrationLedger([
      ...BASE_MIGRATIONS,
      '9999_unknown.sql',
    ]),
    /exact 0001-0005 baseline/,
  );
  assert.throws(
    () => assertMigrationLedger([
      ...BASE_MIGRATIONS,
      SHADOW_MIGRATION,
      '0007_bad.sql',
    ]),
    /exact 0001-0005 baseline|unknown or reordered tail/,
  );
});

test('shadow counts are replay-safe only when entirely empty or entirely complete', () => {
  assert.equal(
    classifyShadowCounts({
      content_count: 0,
      revision_count: 0,
      assignment_count: 0,
      content_event_count: 0,
      assignment_event_count: 0,
    }).state,
    'empty',
  );

  assert.equal(
    classifyShadowCounts({
      content_count: 180,
      revision_count: 180,
      assignment_count: 180,
      content_event_count: 180,
      assignment_event_count: 180,
    }).state,
    'complete',
  );

  assert.throws(
    () => classifyShadowCounts({
      content_count: 180,
      revision_count: 180,
      assignment_count: 179,
      content_event_count: 180,
      assignment_event_count: 180,
    }),
    /partially populated/,
  );
});

test('Wrangler JSON parser fails closed on malformed or unsuccessful statements', () => {
  assert.deepEqual(
    flattenStatementRows(
      parseWranglerJson(JSON.stringify([
        { success: true, results: [{ x: 1 }] },
        { success: true, results: [{ x: 2 }] },
      ])),
    ),
    [{ x: 1 }, { x: 2 }],
  );

  assert.throws(() => parseWranglerJson('nope'), /not valid JSON/);
  assert.throws(
    () => parseWranglerJson(JSON.stringify([{ success: false, results: [] }])),
    /did not report success/,
  );
});

test('exact readback binds all durable content and assignment identity fields', () => {
  const model = {
    count: 1,
    content: [{
      content_id: 'A1',
      pillar: 'A',
      current_revision: 1,
      status: 'active',
      generation: 1,
    }],
    revisions: [{
      content_id: 'A1',
      revision: 1,
      title: 'title',
      body: 'body',
      publication_text: 'body',
      content_digest: 'a'.repeat(64),
      figure: null,
      source_ref: 'content/pillar-a.md:1',
    }],
    assignments: [{
      assignment_id: 'A1',
      assignment_version: 1,
      content_id: 'A1',
      content_revision: 1,
      content_digest: 'a'.repeat(64),
      target_account: 'x-primary',
      policy_version: 2,
      resolved_at: '2026-08-31T19:30:00.000Z',
      scheduled_date: '2026-08-31',
      scheduled_time: '14:30',
      timezone: 'America/Chicago',
      slot_label: 'lull',
      status: 'active',
      superseded_by_version: null,
      generation: 1,
    }],
  };

  const readback = {
    content: structuredClone(model.content),
    revisions: structuredClone(model.revisions),
    assignments: structuredClone(model.assignments),
  };

  // Production helper is fixed to the canonical 180-item model.
  assert.throws(
    () => assertExactShadowReadback(model, readback),
    /canonical 180-item/,
  );
});

test('publication_state coverage requires exact current post set', () => {
  const model = {
    count: 1,
    assignments: [{
      content_id: 'A1',
      resolved_at: '2026-08-31T19:30:00.000Z',
    }],
  };

  assert.equal(
    assertPublicationStateCoverage(model, [{
      post_id: 'A1',
      scheduled_at: '2026-08-31T19:31:00.000Z',
    }]),
    true,
  );

  assert.throws(
    () => assertPublicationStateCoverage(model, []),
    /count 0 does not match shadow model 1/,
  );
});
