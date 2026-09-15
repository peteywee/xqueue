import test from 'node:test';
import assert from 'node:assert/strict';

import { executePreviewNoneToLocalSystemdTransition } from '../src/d1-preview-authority-transition.mjs';

const candidateSha = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const eventAt = '2026-09-15T19:00:00.000Z';
const deploymentId = 'local-systemd:xqueue.service:preview';
const transitionId = `preview-none-to-local-${candidateSha}`;

function batch(eventRows, stateRows) {
  return JSON.stringify([
    { success: true, results: eventRows, meta: {} },
    { success: true, results: stateRows, meta: {} },
  ]);
}
function eventRow(overrides = {}) { return { generation: 2, transition_id: transitionId, previous_owner: 'none', next_owner: 'local-systemd', transition_state: 'stable', candidate_sha: candidateSha, deployment_id: deploymentId, event_at: eventAt, detail: 'preview authority transition: none -> local-systemd', ...overrides }; }
function stateRow(overrides = {}) { return { singleton_id: 1, owner: 'local-systemd', generation: 2, transition_state: 'stable', transition_id: transitionId, previous_owner: 'none', candidate_sha: candidateSha, deployment_id: deploymentId, transitioned_at: eventAt, updated_at: eventAt, ...overrides }; }

test('executor is pinned to preview and confirms exact rows', async () => {
  const calls = [];
  const result = await executePreviewNoneToLocalSystemdTransition({
    candidateSha, deploymentId, transitionId, eventAt,
    runProcess: async (invocation) => { calls.push(invocation); return { exitCode: 0, stdout: batch([eventRow()], [stateRow()]), stderr: '' }; },
  });
  assert.equal(result.ok, true);
  assert.equal(result.status, 'confirmed_local_systemd');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].args[3], 'xqueue-preview');
  assert.equal(calls[0].args[5], 'wrangler.preview.jsonc');
  assert.doesNotMatch(calls[0].args.at(-1), /runtime_metadata|publication_state|publication_events/);
});

test('zero-row transition refuses and partial result is indeterminate', async () => {
  const refused = await executePreviewNoneToLocalSystemdTransition({ candidateSha, deploymentId, transitionId, eventAt, runProcess: async () => ({ exitCode: 0, stdout: batch([], []), stderr: '' }) });
  assert.equal(refused.status, 'refused');
  const partial = await executePreviewNoneToLocalSystemdTransition({ candidateSha, deploymentId, transitionId, eventAt, runProcess: async () => ({ exitCode: 0, stdout: batch([eventRow()], []), stderr: '' }) });
  assert.equal(partial.status, 'indeterminate');
});

test('stdout-only Wrangler failures remain visible', async () => {
  await assert.rejects(
    () => executePreviewNoneToLocalSystemdTransition({ candidateSha, deploymentId, transitionId, eventAt, runProcess: async () => ({ exitCode: 1, stdout: '{"error":"7403"}', stderr: '' }) }),
    /7403/,
  );
});
