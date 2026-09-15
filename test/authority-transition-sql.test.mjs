import test from 'node:test';
import assert from 'node:assert/strict';

import { compilePreviewNoneToLocalSystemdSql } from '../src/authority-transition-sql.mjs';

const candidateSha = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const eventAt = '2026-09-15T19:00:00.000Z';
const deploymentId = 'local-systemd:xqueue.service:preview';
const transitionId = `preview-none-to-local-${candidateSha}`;

test('none->local SQL is generation-2, authority-only CAS', () => {
  const sql = compilePreviewNoneToLocalSystemdSql({ candidateSha, deploymentId, transitionId, eventAt });
  assert.match(sql, /INSERT INTO authority_events/);
  assert.match(sql, /UPDATE authority_state/);
  assert.match(sql, /generation = 2/);
  assert.match(sql, /owner = 'none'/);
  assert.match(sql, /'local-systemd'/);
  assert.match(sql, /deployment_id = 'local-systemd:xqueue\.service:preview'/);
  assert.match(sql, /NOT EXISTS \(SELECT 1 FROM authority_events WHERE generation >= 2\)/);
  assert.doesNotMatch(sql, /runtime_metadata|publication_state|publication_events/);
});

test('none->local SQL rejects invalid identity inputs', () => {
  const valid = { candidateSha, deploymentId, transitionId, eventAt };
  assert.throws(() => compilePreviewNoneToLocalSystemdSql({ ...valid, candidateSha: 'nope' }), /40-hex/);
  assert.throws(() => compilePreviewNoneToLocalSystemdSql({ ...valid, deploymentId: ' ' }), /deploymentId/);
  assert.throws(() => compilePreviewNoneToLocalSystemdSql({ ...valid, transitionId: '' }), /transitionId/);
  assert.throws(() => compilePreviewNoneToLocalSystemdSql({ ...valid, eventAt: 'yesterday' }), /ISO-8601/);
});
