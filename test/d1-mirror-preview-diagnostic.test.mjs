import test from 'node:test';
import assert from 'node:assert/strict';

import { runPreviewMirrorDiagnostic } from '../scripts/d1-mirror-preview-diagnostic.mjs';

const candidateSha = 'e3aaedb8222158c499bd1c58466b2a5003f5e328';
const at = '2026-09-15T07:00:00.000Z';

function result(rows) {
  return {
    exitCode: 0,
    stdout: JSON.stringify([{ success: true, results: rows, meta: {} }]),
    stderr: '',
  };
}

function authorityState() {
  return {
    singleton_id: 1,
    owner: 'local-systemd',
    generation: 51,
    transition_state: 'stable',
    transition_id: 'transition-51',
    previous_owner: 'cloudflare',
    candidate_sha: candidateSha,
    deployment_id: 'local-systemd@51',
    transitioned_at: at,
    updated_at: at,
  };
}

function authorityEvent() {
  return {
    generation: 51,
    transition_id: 'transition-51',
    previous_owner: 'cloudflare',
    next_owner: 'local-systemd',
    transition_state: 'stable',
    candidate_sha: candidateSha,
    deployment_id: 'local-systemd@51',
    event_at: at,
    detail: null,
  };
}

function canonicalMirror() {
  return `${JSON.stringify({
    version: 1,
    posted: { A1: { tweetId: 'tweet-1' } },
    skipped: {},
    spend: 0,
    inflight: null,
  }, null, 2)}\n`;
}

test('preview diagnostic performs only three pinned SELECT calls', async () => {
  const calls = [];
  const responses = [
    result([authorityState()]),
    result([authorityEvent()]),
    result([{ value: canonicalMirror(), updated_at: at }]),
  ];
  const runProcess = async (invocation) => {
    calls.push(invocation);
    return responses.shift();
  };

  const diagnostic = await runPreviewMirrorDiagnostic({ runProcess });

  assert.equal(diagnostic.ok, true);
  assert.equal(diagnostic.mode, 'read_only_preview_diagnostic');
  assert.equal(diagnostic.env, 'preview');
  assert.equal(diagnostic.mirror.exists, true);
  assert.equal(diagnostic.mirror.valid, true);
  assert.deepEqual(diagnostic.mirror.counts, {
    posted: 1,
    skipped: 0,
    inflight: 0,
  });

  assert.equal(calls.length, 3);
  for (const call of calls) {
    assert.equal(call.command, 'pnpm');
    assert.equal(call.args[3], 'xqueue-preview');
    assert.equal(call.args[5], 'wrangler.preview.jsonc');
    assert.equal(call.args.includes('--remote'), true);
    assert.equal(call.args.includes('--json'), true);
    assert.match(call.args.at(-1), /^SELECT\b/);
    assert.doesNotMatch(
      call.args.at(-1),
      /\b(?:INSERT|UPDATE|DELETE|REPLACE|DROP|ALTER|CREATE)\b/i,
    );
  }
});

test('preview diagnostic fails closed on remote read failure and does not continue', async () => {
  const calls = [];
  const runProcess = async (invocation) => {
    calls.push(invocation);
    return {
      exitCode: 1,
      stdout: '',
      stderr: 'preview authority table unavailable',
    };
  };

  await assert.rejects(
    () => runPreviewMirrorDiagnostic({ runProcess }),
    /preview authority table unavailable/,
  );
  assert.equal(calls.length, 1);
});

test('preview diagnostic cannot be retargeted through its public API', async () => {
  const calls = [];
  const responses = [result([]), result([]), result([])];
  const runProcess = async (invocation) => {
    calls.push(invocation);
    return responses.shift();
  };

  await runPreviewMirrorDiagnostic({
    runProcess,
    env: 'production',
  });

  assert.equal(calls.length, 3);
  for (const call of calls) {
    assert.equal(call.args[3], 'xqueue-preview');
    assert.equal(call.args[5], 'wrangler.preview.jsonc');
    assert.notEqual(call.args[3], 'xqueue-production');
    assert.notEqual(call.args[5], 'wrangler.jsonc');
  }
});
