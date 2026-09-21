import { createHash } from 'node:crypto';

const INTERNAL_PREFIXES = Object.freeze([
  'sqlite_',
  '_cf_',
  'd1_',
]);

function sha256(value) {
  const bytes = Buffer.isBuffer(value)
    ? value
    : Buffer.from(String(value), 'utf8');
  return createHash('sha256').update(bytes).digest('hex');
}

function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';

  return '{' + Object.keys(value)
    .sort()
    .map((key) => JSON.stringify(key) + ':' + canonical(value[key]))
    .join(',') + '}';
}

function requiredString(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(label + ' is required');
  }
  return value;
}

function canonicalIso(value, label) {
  const text = requiredString(value, label);
  const ms = Date.parse(text);
  if (!Number.isFinite(ms) || new Date(ms).toISOString() !== text) {
    throw new Error(label + ' must be canonical ISO-8601 UTC');
  }
  return text;
}

function schemaSort(a, b) {
  const order = { table: 0, index: 1, trigger: 2, view: 3 };
  return (order[a.type] ?? 9) - (order[b.type] ?? 9) ||
    a.name.localeCompare(b.name);
}

function stableRows(rows) {
  if (!Array.isArray(rows)) throw new Error('table rows must be an array');
  return rows
    .map((row) => {
      if (!row || typeof row !== 'object' || Array.isArray(row)) {
        throw new Error('table row must be an object');
      }
      return { ...row };
    })
    .sort((a, b) => canonical(a).localeCompare(canonical(b)));
}

export function isApplicationTable(name) {
  if (typeof name !== 'string' || name.length === 0) return false;
  return !INTERNAL_PREFIXES.some((prefix) => name.startsWith(prefix));
}

export function applicationTableNames(schemaRows) {
  if (!Array.isArray(schemaRows)) throw new Error('schema rows are required');

  return schemaRows
    .filter((row) => row?.type === 'table' && isApplicationTable(row?.name))
    .map((row) => row.name)
    .sort();
}

export function buildLogicalBackup({
  environment,
  database,
  schemaRows,
  rowsByTable,
  migrations = [],
  createdAt = new Date().toISOString(),
}) {
  const env = requiredString(environment, 'environment');
  const db = requiredString(database, 'database');
  const at = canonicalIso(createdAt, 'createdAt');

  if (!Array.isArray(schemaRows)) throw new Error('schema rows are required');
  if (!rowsByTable || typeof rowsByTable !== 'object' || Array.isArray(rowsByTable)) {
    throw new Error('rowsByTable is required');
  }

  const schema = schemaRows
    .filter((row) =>
      row &&
      typeof row.type === 'string' &&
      typeof row.name === 'string' &&
      typeof row.sql === 'string' &&
      row.sql.length > 0 &&
      (
        row.type !== 'table' ||
        isApplicationTable(row.name)
      ) &&
      (
        row.type === 'table' ||
        isApplicationTable(row.tbl_name)
      ),
    )
    .map((row) => ({
      type: row.type,
      name: row.name,
      tbl_name: row.tbl_name,
      sql: row.sql,
    }))
    .sort(schemaSort);

  const tableNames = applicationTableNames(schema);
  const tables = {};

  for (const name of tableNames) {
    const rows = stableRows(rowsByTable[name] ?? []);
    const rowsHash = sha256(canonical(rows));
    tables[name] = {
      rowCount: rows.length,
      rowsHash,
      rows,
    };
  }

  const normalizedMigrations = [...migrations]
    .map((row) => ({
      id: Number(row.id),
      name: requiredString(row.name, 'migration name'),
      applied_at: row.applied_at ?? null,
    }))
    .sort((a, b) => a.id - b.id);

  const schemaHash = sha256(canonical(schema));
  const migrationHash = sha256(canonical(normalizedMigrations));
  const tableManifest = Object.fromEntries(
    tableNames.map((name) => [
      name,
      {
        rowCount: tables[name].rowCount,
        rowsHash: tables[name].rowsHash,
      },
    ]),
  );

  const identity = {
    format: 1,
    environment: env,
    database: db,
    createdAt: at,
    schemaHash,
    migrationHash,
    tables: tableManifest,
  };
  const backupId = 'xqueue-d1-' + sha256(canonical(identity)).slice(0, 32);

  const backupWithoutHash = {
    ...identity,
    backupId,
    schema,
    migrations: normalizedMigrations,
    data: tables,
  };
  const backupHash = sha256(canonical(backupWithoutHash));

  return Object.freeze({
    ...backupWithoutHash,
    backupHash,
  });
}

export function verifyLogicalBackup(backup) {
  if (!backup || backup.format !== 1) {
    throw new Error('unsupported logical backup format');
  }

  const rebuilt = buildLogicalBackup({
    environment: backup.environment,
    database: backup.database,
    schemaRows: backup.schema,
    rowsByTable: Object.fromEntries(
      Object.entries(backup.data ?? {}).map(([name, value]) => [name, value.rows]),
    ),
    migrations: backup.migrations,
    createdAt: backup.createdAt,
  });

  if (
    rebuilt.backupId !== backup.backupId ||
    rebuilt.backupHash !== backup.backupHash ||
    rebuilt.schemaHash !== backup.schemaHash ||
    rebuilt.migrationHash !== backup.migrationHash
  ) {
    throw new Error('logical backup identity/hash verification failed');
  }

  for (const [name, manifest] of Object.entries(backup.tables ?? {})) {
    const rebuiltManifest = rebuilt.tables[name];
    if (
      !rebuiltManifest ||
      Number(rebuiltManifest.rowCount) !== Number(manifest.rowCount) ||
      rebuiltManifest.rowsHash !== manifest.rowsHash
    ) {
      throw new Error('logical backup table hash mismatch: ' + name);
    }
  }

  return true;
}

function quotedIdentifier(name) {
  return '"' + String(name).replaceAll('"', '""') + '"';
}

function sqlValue(value) {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('non-finite number in backup');
    return String(value);
  }
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'boolean') return value ? '1' : '0';
  return "'" + String(value).replaceAll("'", "''") + "'";
}

function createSqlByType(schema, type) {
  return schema
    .filter((entry) => entry.type === type)
    .sort(schemaSort)
    .map((entry) => entry.sql.trim().replace(/;?$/, ';'));
}

export function renderLogicalRestoreSql(backup) {
  verifyLogicalBackup(backup);

  const tableSchema = backup.schema.filter((entry) => entry.type === 'table');
  const tableOrder = tableSchema.map((entry) => entry.name);
  const statements = [
    'PRAGMA foreign_keys=OFF;',
    'BEGIN IMMEDIATE;',
    ...createSqlByType(backup.schema, 'table'),
  ];

  for (const tableName of tableOrder) {
    const table = backup.data[tableName];
    if (!table) throw new Error('backup data missing table ' + tableName);

    for (const row of table.rows) {
      const columns = Object.keys(row);
      if (columns.length === 0) continue;
      statements.push(
        'INSERT INTO ' + quotedIdentifier(tableName) +
        ' (' + columns.map(quotedIdentifier).join(',') + ')' +
        ' VALUES (' + columns.map((column) => sqlValue(row[column])).join(',') + ');',
      );
    }
  }

  statements.push(
    ...createSqlByType(backup.schema, 'index'),
    ...createSqlByType(backup.schema, 'trigger'),
    ...createSqlByType(backup.schema, 'view'),
    'COMMIT;',
    'PRAGMA foreign_keys=ON;',
  );

  return statements.join('\n');
}

export function compareBackupToRows(backup, rowsByTable) {
  verifyLogicalBackup(backup);
  const differences = [];

  for (const [name, expected] of Object.entries(backup.data)) {
    const rows = stableRows(rowsByTable[name] ?? []);
    const actualHash = sha256(canonical(rows));
    if (
      rows.length !== expected.rowCount ||
      actualHash !== expected.rowsHash
    ) {
      differences.push({
        table: name,
        expectedRowCount: expected.rowCount,
        actualRowCount: rows.length,
        expectedRowsHash: expected.rowsHash,
        actualRowsHash: actualHash,
      });
    }
  }

  return Object.freeze({
    ok: differences.length === 0,
    differences: Object.freeze(differences),
  });
}

export function backupEvidence(backup) {
  verifyLogicalBackup(backup);
  return Object.freeze({
    format: backup.format,
    backupId: backup.backupId,
    backupHash: backup.backupHash,
    environment: backup.environment,
    database: backup.database,
    createdAt: backup.createdAt,
    schemaHash: backup.schemaHash,
    migrationHash: backup.migrationHash,
    tableCount: Object.keys(backup.tables).length,
    tables: backup.tables,
  });
}
