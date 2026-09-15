import test from 'node:test';
import assert from 'node:assert/strict';

import { runPreviewLocalSystemdAuthorityTransition } from '../scripts/d1-preview-authority-local-systemd.mjs';

const candidateSha = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const seedSha = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const eventAt = '2026-09-15T19:00:00.000Z';
const seedAt = '2026-09-15T17:36:48.169Z';
const unitHash = 'f'.repeat(64);
const deploymentId = `systemd-user:xqueue.service:sha256:${unitHash}`;
const transitionId = `preview-none-to-local-${candidateSha}`;
const confirm = '--confirm-preview-local-systemd-authority';
const mirror = '{"version":1,"posted":{},"skipped":{},"spend":0,"inflight":null}';

function jsonStatement(results) { return JSON.stringify([{ success: true, results, meta: {} }]); }
function batch(eventRows, stateRows) { return JSON.stringify([{ success: true, results: eventRows, meta: {} }, { success: true, results: stateRows, meta: {} }]); }
function seedState() { return { singleton_id: 1, owner: 'none', generation: 1, transition_state: 'stable', transition_id: `preview-bootstrap-none-${seedSha}`, previous_owner: null, candidate_sha: seedSha, deployment_id: null, transitioned_at: seedAt, updated_at: seedAt }; }
function seedEvent() { return { generation: 1, transition_id: `preview-bootstrap-none-${seedSha}`, previous_owner: null, next_owner: 'none', transition_state: 'stable', candidate_sha: seedSha, deployment_id: null, event_at: seedAt, detail: 'initial preview authority bootstrap; authority intentionally unowned' }; }
function localState() { return { singleton_id: 1, owner: 'local-systemd', generation: 2, transition_state: 'stable', transition_id: transitionId, previous_owner: 'none', candidate_sha: candidateSha, deployment_id: deploymentId, transitioned_at: eventAt, updated_at: eventAt }; }
function localEvent() { return { generation: 2, transition_id: transitionId, previous_owner: 'none', next_owner: 'local-systemd', transition_state: 'stable', candidate_sha: candidateSha, deployment_id: deploymentId, event_at: eventAt, detail: 'preview authority transition: none -> local-systemd' }; }

function createRunner({ branch = 'hardening/issue-59-d1-mirror-activation', status = '' } = {}) {
  const calls = [];
  let transitioned = false;
  const runProcess = async (invocation) => {
    calls.push(invocation);
    if (invocation.command === 'git') {
      const command = invocation.args.join(' ');
      if (command === 'branch --show-current') return { exitCode: 0, stdout: `${branch}\n`, stderr: '' };
      if (command === 'rev-parse HEAD') return { exitCode: 0, stdout: `${candidateSha}\n`, stderr: '' };
      if (command === 'status --porcelain --untracked-files=all') return { exitCode: 0, stdout: status, stderr: '' };
      throw new Error(`unexpected git invocation: ${command}`);
    }
    assert.equal(invocation.command, 'pnpm');
    const database = invocation.args[3];
    const sql = invocation.args.at(-1);
    if (sql.includes('FROM sqlite_master')) return { exitCode: 0, stdout: jsonStatement(database === 'xqueue-production' ? [] : [{ name: 'authority_events' }, { name: 'authority_state' }]), stderr: '' };
    if (sql.includes('FROM authority_state') && sql.includes('LIMIT 1')) return { exitCode: 0, stdout: jsonStatement([transitioned ? localState() : seedState()]), stderr: '' };
    if (sql.includes('FROM authority_events') && sql.includes('ORDER BY generation DESC')) return { exitCode: 0, stdout: jsonStatement([transitioned ? localEvent() : seedEvent()]), stderr: '' };
    if (sql.includes('FROM runtime_metadata') && sql.includes('state.snapshot_json')) return { exitCode: 0, stdout: jsonStatement([{ value: mirror, updated_at: eventAt }]), stderr: '' };
    if (sql.includes('INSERT INTO authority_events') && sql.includes('UPDATE authority_state')) {
      assert.equal(database, 'xqueue-preview');
      transitioned = true;
      return { exitCode: 0, stdout: batch([localEvent()], [localState()]), stderr: '' };
    }
    throw new Error(`unexpected Wrangler SQL: ${sql}`);
  };
  return { calls, runProcess };
}

const fixedNow = () => new Date(eventAt);
const systemdIdentity = async () => ({ unit: 'xqueue.service', fragmentPath: '/home/patrick/.config/systemd/user/xqueue.service', unitHash, deploymentId });

test('wrapper performs only preview authority transition and proves mirror/production unchanged', async () => {
  const { calls, runProcess } = createRunner();
  const result = await runPreviewLocalSystemdAuthorityTransition({ argv: [confirm], runProcess, now: fixedNow, envVars: { XQUEUE_DEPLOYMENT_ID: deploymentId }, deriveDeploymentIdentity: systemdIdentity });
  assert.equal(result.ok, true);
  assert.equal(result.owner, 'local-systemd');
  assert.equal(result.generation, 2);
  assert.equal(result.candidateSha, candidateSha);
  assert.equal(result.deploymentId, deploymentId);
  assert.equal(result.systemdUnitHash, unitHash);
  assert.equal(result.mirrorUnchanged, true);
  assert.equal(result.productionAuthoritySchemaAbsent, true);
  const writes = calls.filter((call) => call.command === 'pnpm' && /\bINSERT INTO authority_events\b/.test(call.args.at(-1)));
  assert.equal(writes.length, 1);
  assert.equal(writes[0].args[3], 'xqueue-preview');
  assert.doesNotMatch(writes[0].args.at(-1), /runtime_metadata|publication_state|publication_events/);
});

test('confirmation and deployment identity are required before process calls', async () => {
  const first = createRunner();
  await assert.rejects(() => runPreviewLocalSystemdAuthorityTransition({ argv: [], runProcess: first.runProcess, now: fixedNow, envVars: { XQUEUE_DEPLOYMENT_ID: deploymentId } }), /explicit confirmation required/);
  assert.equal(first.calls.length, 0);
  const second = createRunner();
  await assert.rejects(() => runPreviewLocalSystemdAuthorityTransition({ argv: [confirm], runProcess: second.runProcess, now: fixedNow, envVars: {} }), /XQUEUE_DEPLOYMENT_ID is required/);
  assert.equal(second.calls.length, 0);
});

test('wrong branch, dirty tree, and extra args fail before D1 mutation', async () => {
  const wrong = createRunner({ branch: 'main' });
  await assert.rejects(() => runPreviewLocalSystemdAuthorityTransition({ argv: [confirm], runProcess: wrong.runProcess, now: fixedNow, envVars: { XQUEUE_DEPLOYMENT_ID: deploymentId } }), /requires branch/);
  assert.equal(wrong.calls.some((call) => call.command === 'pnpm'), false);
  const dirty = createRunner({ status: '?? note.txt\n' });
  await assert.rejects(() => runPreviewLocalSystemdAuthorityTransition({ argv: [confirm], runProcess: dirty.runProcess, now: fixedNow, envVars: { XQUEUE_DEPLOYMENT_ID: deploymentId } }), /clean worktree/);
  assert.equal(dirty.calls.some((call) => call.command === 'pnpm'), false);
  const extra = createRunner();
  await assert.rejects(() => runPreviewLocalSystemdAuthorityTransition({ argv: [confirm, '--env=production'], runProcess: extra.runProcess, now: fixedNow, envVars: { XQUEUE_DEPLOYMENT_ID: deploymentId } }), /explicit confirmation required/);
  assert.equal(extra.calls.length, 0);
});

test('explicit deployment id must match the loaded systemd unit identity before D1 access', async () => {
  const fake = createRunner();
  await assert.rejects(
    () => runPreviewLocalSystemdAuthorityTransition({
      argv: [confirm],
      runProcess: fake.runProcess,
      now: fixedNow,
      envVars: { XQUEUE_DEPLOYMENT_ID: 'operator-invented-id' },
      deriveDeploymentIdentity: systemdIdentity,
    }),
    /does not match the loaded xqueue\.service identity/,
  );
  assert.equal(fake.calls.some((call) => call.command === 'pnpm'), false);
});
