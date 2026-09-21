#!/usr/bin/env node

import { readFileSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { resolve } from 'node:path';

import {
  backupEvidence,
  compareBackupToRows,
  renderLogicalRestoreSql,
  verifyLogicalBackup,
} from '../src/d1-logical-backup.mjs';

const args = process.argv.slice(2);

function opt(name, fallback = null) {
  const index = args.indexOf('--' + name);
  return index >= 0 && args[index + 1] !== undefined ? args[index + 1] : fallback;
}

function quotedIdentifier(name) {
  return '"' + String(name).replaceAll('"', '""') + '"';
}

function main() {
  const input = resolve(
    opt('backup', '/tmp/xqueue-d1-logical-backup.json'),
  );
  const evidenceOutput = resolve(
    opt('evidence', '/tmp/xqueue-d1-restore-proof.json'),
  );

  const backup = JSON.parse(readFileSync(input, 'utf8'));
  verifyLogicalBackup(backup);

  const db = new DatabaseSync(':memory:');
  db.exec(renderLogicalRestoreSql(backup));

  const integrity = db.prepare('PRAGMA integrity_check').all();
  if (
    integrity.length !== 1 ||
    String(integrity[0]?.integrity_check).toLowerCase() !== 'ok'
  ) {
    throw new Error('isolated restore integrity_check failed');
  }

  const foreignKeys = db.prepare('PRAGMA foreign_key_check').all();
  if (foreignKeys.length !== 0) {
    throw new Error(
      'isolated restore foreign_key_check found ' +
      foreignKeys.length + ' violation(s)',
    );
  }

  const rowsByTable = {};
  for (const name of Object.keys(backup.data)) {
    rowsByTable[name] = db.prepare(
      'SELECT * FROM ' + quotedIdentifier(name),
    ).all().map((row) => ({ ...row }));
  }

  const parity = compareBackupToRows(backup, rowsByTable);
  if (!parity.ok) {
    throw new Error(
      'isolated restore table parity failed: ' +
      JSON.stringify(parity.differences),
    );
  }

  const duplicateActiveSlots = db.prepare(
    "SELECT target_account,resolved_at,COUNT(*) AS n " +
    "FROM queue_assignments " +
    "WHERE status='active' AND lifecycle_state='scheduled' " +
    "GROUP BY target_account,resolved_at HAVING COUNT(*) > 1",
  ).all();
  if (duplicateActiveSlots.length !== 0) {
    throw new Error('isolated restore contains duplicate active assignment slots');
  }

  const duplicateAssignmentVersions = db.prepare(
    "SELECT assignment_id,assignment_version,COUNT(*) AS n " +
    "FROM queue_assignments " +
    "GROUP BY assignment_id,assignment_version HAVING COUNT(*) > 1",
  ).all();
  if (duplicateAssignmentVersions.length !== 0) {
    throw new Error('isolated restore contains duplicate assignment versions');
  }

  const contentDigestMismatches = db.prepare(
    "SELECT COUNT(*) AS n FROM queue_assignments a " +
    "JOIN queue_content_revisions r " +
    "ON r.content_id=a.content_id AND r.revision=a.content_revision " +
    "WHERE a.content_digest <> r.content_digest",
  ).get();
  if (Number(contentDigestMismatches?.n ?? 0) !== 0) {
    throw new Error('isolated restore contains assignment/content digest drift');
  }

  const evidence = {
    ...backupEvidence(backup),
    isolatedRestore: true,
    integrityCheck: 'ok',
    foreignKeyViolations: 0,
    parity: true,
    duplicateActiveSlots: 0,
    duplicateAssignmentVersions: 0,
    contentDigestMismatches: 0,
    productionMutation: false,
  };

  writeFileSync(
    evidenceOutput,
    JSON.stringify(evidence, null, 2) + '\n',
    'utf8',
  );

  console.log('XQUEUE D1 BACKUP/RESTORE PROOF: PASS');
  console.log('  backup id    ' + backup.backupId);
  console.log('  backup hash  ' + backup.backupHash);
  console.log('  tables       ' + Object.keys(backup.tables).length);
  console.log('  parity       exact');
  console.log('  evidence     ' + evidenceOutput);
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
}
