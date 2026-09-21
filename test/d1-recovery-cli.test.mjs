import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

function text(path) {
  return readFileSync(new URL('../' + path, import.meta.url), 'utf8');
}

test('D1 reconciliation is dry-run by default and production mutation requires explicit confirmation', () => {
  const source = text('scripts/d1-reconcile.mjs');

  assert.match(source, /if \(!flag\('apply'\)\)/);
  assert.match(source, /xqueue-production-reconciliation/);
  assert.match(source, /automatic_retry: false/);
  assert.doesNotMatch(source, /automatic_retry: true/);
});

test('logical backup is read-only and production source selection requires confirmation', () => {
  const source = text('scripts/d1-logical-backup.mjs');

  assert.match(source, /xqueue-production-backup/);
  assert.match(source, /SELECT \* FROM/);
  assert.doesNotMatch(source, /\b(?:INSERT|UPDATE|DELETE|REPLACE)\b/);
});

test('restore proof uses isolated in-memory SQLite and never calls Wrangler', () => {
  const source = text('scripts/d1-backup-restore-proof.mjs');

  assert.match(source, /new DatabaseSync\(':memory:'\)/);
  assert.match(source, /PRAGMA integrity_check/);
  assert.match(source, /PRAGMA foreign_key_check/);
  assert.doesNotMatch(source, /wrangler|xqueue-production|xqueue-preview/);
});

test('recovery workflow deletes raw backup before uploading evidence', () => {
  const source = text('.github/workflows/preview-recovery-proof.yml');

  assert.match(source, /Remove raw backup before artifact upload/);
  assert.match(source, /rm -f \/tmp\/xqueue-preview-recovery-backup\.json/);
  assert.doesNotMatch(
    source,
    /path:\s*\|[\s\S]*xqueue-preview-recovery-backup\.json\s*(?:\n|$)/,
  );
});
