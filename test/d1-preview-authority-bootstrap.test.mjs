import test from 'node:test';
import assert from 'node:assert/strict';

import { executeInitialPreviewAuthorityBootstrap } from '../src/d1-preview-authority-bootstrap.mjs';

const candidateSha = 'e70352a3ca2cb50c854c473dd5c30106f3ffba6b';
const eventAt = '2026-09-15T10:00:00.000Z';
const transitionId = 'preview-bootstrap-none-1';

function successBatch({ eventRows, stateRows }) {
  return {
    exitCode: 0,
    stdout: JSON.stringify([
      { success: true, results: eventRows, meta: {} },
      { success: true, results: stateRows, meta: {} },
    ]),
    stderr: '',
  };
}

function eventRow() {
  return {
    generation: 1,
    transition_id: transitionId,
    previous_owner: null,
    next_owner: 'none',
    transition_state: 'stable',
    candidate_sha: candidateSha,
    deployment_id: null,
    event_at: eventAt,
    detail: 'initial preview authority bootstrap; authority intentionally unowned',
  };
}

function stateRow() {
  return {
    singleton_id: 1,
    owner: 'none',
    generation: 1,
    transition_state: 'stable',
    transition_id: transitionId,
    previous_owner: null,
    candidate_sha: candidateSha,
    deployment_id: null,
    transitioned_at: eventAt,
    updated_at: eventAt,
  };
}

async function execute(runProcess, extra = {}) {
  return executeInitialPreviewAuthorityBootstrap({
    candidateSha,
    transitionId,
    eventAt,
    runProcess,
    ...extra,
  });
}

test('bootstrap executor is hard-pinned to preview and confirms owner none', async () => {
  const calls = [];
  const runProcess = async (invocation) => {
    calls.push(invocation);
    return successBatch({ eventRows: [eventRow()], stateRows: [stateRow()] });
  };

  const result = await execute(runProcess, { env: 'production' });

  assert.equal(result.ok, true);
  assert.equal(result.status, 'confirmed_seeded_unowned');
  assert.equal(result.env, 'preview');
  assert.equal(result.owner, 'none');
  assert.equal(result.generation, 1);
  assert.equal(result.deploymentId, null);

  assert.equal(calls.length, 1);
  const [call] = calls;
  assert.equal(call.command, 'pnpm');
  assert.equal(call.args[3], 'xqueue-preview');
  assert.equal(call.args[5], 'wrangler.preview.jsonc');
  assert.notEqual(call.args[3], 'xqueue-production');
  assert.notEqual(call.args[5], 'wrangler.jsonc');
  assert.equal(call.args.includes('--remote'), true);
  assert.equal(call.args.includes('--json'), true);
  assert.doesNotMatch(call.args.at(-1), /runtime_metadata|publication_state|publication_events/);
});

test('bootstrap executor refuses when empty-table precondition does not apply', async () => {
  const result = await execute(async () => successBatch({
    eventRows: [],
    stateRows: [],
  }));

  assert.deepEqual(result, {
    ok: false,
    status: 'refused',
    reason: 'preview_authority_bootstrap_precondition_failed',
    writeAttempted: true,
  });
});

test('bootstrap executor reports partial return as indeterminate', async () => {
  const result = await execute(async () => successBatch({
    eventRows: [eventRow()],
    stateRows: [],
  }));

  assert.equal(result.ok, false);
  assert.equal(result.status, 'indeterminate');
  assert.equal(result.reason, 'preview_authority_bootstrap_readback_mismatch');
});

test('bootstrap executor rejects malformed or failed Wrangler output', async () => {
  await assert.rejects(
    () => execute(async () => ({ exitCode: 0, stdout: 'not-json', stderr: '' })),
    /not valid JSON/,
  );

  await assert.rejects(
    () => execute(async () => ({
      exitCode: 1,
      stdout: '',
      stderr: 'preview D1 unavailable',
    })),
    /preview D1 unavailable/,
  );

  await assert.rejects(
    () => execute(async () => ({
      exitCode: 0,
      stdout: JSON.stringify([{ success: true, results: [], meta: {} }]),
      stderr: '',
    })),
    /exactly two statement results/,
  );
});

test('bootstrap executor rejects mismatched returned authority evidence', async () => {
  const badState = {
    ...stateRow(),
    owner: 'local-systemd',
    deployment_id: 'unexpected',
  };

  const result = await execute(async () => successBatch({
    eventRows: [eventRow()],
    stateRows: [badState],
  }));

  assert.equal(result.ok, false);
  assert.equal(result.status, 'indeterminate');
  assert.equal(result.reason, 'preview_authority_bootstrap_readback_mismatch');
});
