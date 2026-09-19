import { createHash } from 'node:crypto';

export const PREVIEW_DB = 'xqueue-preview';
export const PREVIEW_CONFIG = 'wrangler.preview.jsonc';
export const PREVIEW_DB_ID = 'f5f9bea9-e88c-41ab-9407-70356079a638';

export const BASE_MIGRATIONS = Object.freeze([
  '0001_xqueue_runtime.sql',
  '0002_runtime_evidence.sql',
  '0003_publication_lease.sql',
  '0004_authority_ownership.sql',
  '0005_publication_state_generation.sql',
]);

export const SHADOW_MIGRATION = '0006_continuous_queue_shadow.sql';

export function sha256Json(value) {
  return createHash('sha256')
    .update(Buffer.from(JSON.stringify(value), 'utf8'))
    .digest('hex');
}

export function assertPreviewConfig(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error('preview config must be an object');
  }
  if (config.name !== PREVIEW_DB) {
    throw new Error(`preview Worker name must be ${PREVIEW_DB}`);
  }

  const databases = config.d1_databases;
  if (!Array.isArray(databases) || databases.length !== 1) {
    throw new Error('preview config must declare exactly one D1 database');
  }

  const [db] = databases;
  if (
    db.binding !== 'DB' ||
    db.database_name !== PREVIEW_DB ||
    db.database_id !== PREVIEW_DB_ID ||
    db.migrations_dir !== 'cloudflare/migrations'
  ) {
    throw new Error('preview D1 identity/config drifted from the pinned proof target');
  }

  const raw = JSON.stringify(config);
  if (/xqueue-production|fc85026e-bfc8-435f-8bb0-c60e139178a3/.test(raw)) {
    throw new Error('preview config contains a production D1 identity');
  }

  return true;
}

export function wranglerExecuteArgs({ sql = null, file = null } = {}) {
  if ((sql === null) === (file === null)) {
    throw new Error('provide exactly one of sql or file');
  }

  const args = [
    'wrangler',
    'd1',
    'execute',
    PREVIEW_DB,
    '--config',
    PREVIEW_CONFIG,
    '--remote',
    '--yes',
    '--json',
  ];

  if (sql !== null) args.push('--command', sql);
  else args.push('--file', file);

  return args;
}

export function wranglerMigrationsApplyArgs() {
  return [
    'wrangler',
    'd1',
    'migrations',
    'apply',
    PREVIEW_DB,
    '--config',
    PREVIEW_CONFIG,
    '--remote',
  ];
}

export function parseWranglerJson(stdout) {
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error('Wrangler D1 output is not valid JSON');
  }

  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error('Wrangler D1 output contained no statement results');
  }

  const results = [];
  for (const statement of parsed) {
    if (statement?.success !== true) {
      throw new Error('Wrangler D1 statement did not report success');
    }
    if (!Array.isArray(statement.results)) {
      throw new Error('Wrangler D1 statement results are missing');
    }
    results.push(statement.results);
  }

  return results;
}

export function flattenStatementRows(statementResults) {
  return statementResults.flatMap((rows) => rows);
}

export function migrationNames(rows) {
  if (!Array.isArray(rows)) throw new Error('migration rows must be an array');
  return rows.map((row) => row?.name).filter((name) => typeof name === 'string');
}

export function assertMigrationLedger(names, { shadowMayExist = true } = {}) {
  const expectedBase = [...BASE_MIGRATIONS];

  if (!Array.isArray(names)) throw new Error('migration names must be an array');
  if (new Set(names).size !== names.length) {
    throw new Error('preview migration ledger contains duplicate names');
  }

  const withoutShadow = names.filter((name) => name !== SHADOW_MIGRATION);
  if (JSON.stringify(withoutShadow) !== JSON.stringify(expectedBase)) {
    throw new Error(
      `preview migration ledger is not the exact 0001-0005 baseline: ${JSON.stringify(names)}`,
    );
  }

  const hasShadow = names.includes(SHADOW_MIGRATION);
  if (!shadowMayExist && hasShadow) {
    throw new Error('shadow migration is already applied unexpectedly');
  }

  if (hasShadow && names.at(-1) !== SHADOW_MIGRATION) {
    throw new Error('shadow migration is not the latest preview migration');
  }

  return Object.freeze({ hasShadow });
}

export function classifyShadowCounts(row, expected = 180) {
  const counts = {
    content: Number(row?.content_count),
    revisions: Number(row?.revision_count),
    assignments: Number(row?.assignment_count),
    contentEvents: Number(row?.content_event_count),
    assignmentEvents: Number(row?.assignment_event_count),
  };

  for (const [key, value] of Object.entries(counts)) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`shadow ${key} count is invalid`);
    }
  }

  const values = Object.values(counts);
  if (values.every((value) => value === 0)) {
    return Object.freeze({ state: 'empty', counts });
  }

  if (values.every((value) => value === expected)) {
    return Object.freeze({ state: 'complete', counts });
  }

  throw new Error(
    `preview shadow tables are partially populated: ${JSON.stringify(counts)}`,
  );
}

function mapBy(rows, key) {
  const map = new Map();
  for (const row of rows) {
    const id = row?.[key];
    if (typeof id !== 'string' || id.length === 0 || map.has(id)) {
      throw new Error(`readback has invalid or duplicate ${key}`);
    }
    map.set(id, row);
  }
  return map;
}

function equalValue(actual, expected) {
  return actual === expected ||
    (actual === null && expected === undefined) ||
    (actual === undefined && expected === null);
}

function assertFields(actual, expected, fields, label) {
  for (const field of fields) {
    if (!equalValue(actual?.[field], expected?.[field])) {
      throw new Error(
        `${label} field ${field} mismatch: expected ${JSON.stringify(expected?.[field])}, got ${JSON.stringify(actual?.[field])}`,
      );
    }
  }
}

export function assertExactShadowReadback(model, readback) {
  if (!model || model.count !== 180) {
    throw new Error('expected the canonical 180-item shadow model');
  }

  const content = mapBy(readback.content, 'content_id');
  const revisions = mapBy(readback.revisions, 'content_id');
  const assignments = mapBy(readback.assignments, 'content_id');

  if (content.size !== model.count || revisions.size !== model.count || assignments.size !== model.count) {
    throw new Error('shadow readback count does not match model');
  }

  const contentFields = [
    'content_id',
    'pillar',
    'current_revision',
    'status',
    'generation',
  ];
  const revisionFields = [
    'content_id',
    'revision',
    'title',
    'body',
    'publication_text',
    'content_digest',
    'figure',
    'source_ref',
  ];
  const assignmentFields = [
    'assignment_id',
    'assignment_version',
    'content_id',
    'content_revision',
    'content_digest',
    'target_account',
    'policy_version',
    'resolved_at',
    'scheduled_date',
    'scheduled_time',
    'timezone',
    'slot_label',
    'status',
    'superseded_by_version',
    'generation',
  ];

  for (const expected of model.content) {
    assertFields(
      content.get(expected.content_id),
      expected,
      contentFields,
      `content ${expected.content_id}`,
    );
  }

  for (const expected of model.revisions) {
    assertFields(
      revisions.get(expected.content_id),
      expected,
      revisionFields,
      `revision ${expected.content_id}`,
    );
  }

  for (const expected of model.assignments) {
    assertFields(
      assignments.get(expected.content_id),
      expected,
      assignmentFields,
      `assignment ${expected.content_id}`,
    );
  }

  const slots = new Set(
    readback.assignments.map(
      (row) => `${row.target_account}\u0000${row.resolved_at}`,
    ),
  );
  if (slots.size !== model.count) {
    throw new Error('shadow readback contains duplicate active slots');
  }

  return true;
}

export function assertPublicationStateParity(model, publicationRows) {
  const rows = mapBy(publicationRows, 'post_id');
  if (rows.size !== model.count) {
    throw new Error(
      `publication_state count ${rows.size} does not match shadow model ${model.count}`,
    );
  }

  for (const assignment of model.assignments) {
    const row = rows.get(assignment.content_id);
    if (!row) {
      throw new Error(`publication_state is missing ${assignment.content_id}`);
    }
    if (row.scheduled_at !== assignment.resolved_at) {
      throw new Error(
        `${assignment.content_id} publication_state UTC mismatch: ${row.scheduled_at} != ${assignment.resolved_at}`,
      );
    }
  }

  return true;
}
