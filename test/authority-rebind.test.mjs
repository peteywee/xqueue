import test from 'node:test';
import assert from 'node:assert/strict';

import { compilePreviewLocalSystemdRebindSql } from '../src/authority-rebind-sql.mjs';
import { executePreviewLocalSystemdRebind } from '../src/d1-preview-authority-rebind.mjs';
import { runPreviewLocalSystemdAuthorityRebind } from '../scripts/d1-preview-authority-rebind-local-systemd.mjs';

const oldSha = '6941f4455ae48d05d7b3760537ff4be7f7579b40';
const newSha = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const deploymentId = 'systemd-user:xqueue.service:sha256:311376c041277dd27b393ef102113077d080bb10b65cc46569cbc5f4bf617db0';
const eventAt = '2026-09-15T21:00:00.000Z';
const transitionId = `preview-local-rebind-${newSha}`;

function currentAuthority() {
  return {
    state: {
      singleton_id: 1,
      owner: 'local-systemd',
      generation: 2,
      transition_state: 'stable',
      transition_id: `preview-none-to-local-${oldSha}`,
      previous_owner: 'none',
      candidate_sha: oldSha,
      deployment_id: deploymentId,
      transitioned_at: '2026-09-15T20:13:49.233Z',
      updated_at: '2026-09-15T20:13:49.233Z',
    },
    latestEvent: {
      generation: 2,
      transition_id: `preview-none-to-local-${oldSha}`,
      previous_owner: 'none',
      next_owner: 'local-systemd',
      transition_state: 'stable',
      candidate_sha: oldSha,
      deployment_id: deploymentId,
      event_at: '2026-09-15T20:13:49.233Z',
      detail: null,
    },
  };
}

function reboundAuthority() {
  return {
    state: {
      singleton_id: 1,
      owner: 'local-systemd',
      generation: 3,
      transition_state: 'stable',
      transition_id: transitionId,
      previous_owner: 'local-systemd',
      candidate_sha: newSha,
      deployment_id: deploymentId,
      transitioned_at: eventAt,
      updated_at: eventAt,
    },
    latestEvent: {
      generation: 3,
      transition_id: transitionId,
      previous_owner: 'local-systemd',
      next_owner: 'local-systemd',
      transition_state: 'stable',
      candidate_sha: newSha,
      deployment_id: deploymentId,
      event_at: eventAt,
      detail: 'preview authority rebind: local-systemd -> local-systemd',
    },
  };
}

test('same-owner rebind SQL is generation-bounded and authority-only', () => {
  const sql = compilePreviewLocalSystemdRebindSql({
    expectedGeneration: 2,
    expectedCandidateSha: oldSha,
    candidateSha: newSha,
    deploymentId,
    transitionId,
    eventAt,
  });

  assert.match(sql, /generation = 2/);
  assert.match(sql, /generation >= 3/);
  assert.match(sql, /'local-systemd'/);
  assert.match(sql, new RegExp(newSha));
  assert.match(sql, new RegExp(oldSha));
  assert.doesNotMatch(sql, /runtime_metadata/i);
  assert.doesNotMatch(sql, /publication_state/i);
  assert.doesNotMatch(sql, /publication_events/i);
});

test('rebind executor confirms exact generation 3 rows', async () => {
  const runProcess = async (invocation) => {
    assert.equal(invocation.command, 'pnpm');
    const payload = [
      {
        success: true,
        results: [{
          generation: 3,
          transition_id: transitionId,
          previous_owner: 'local-systemd',
          next_owner: 'local-systemd',
          transition_state: 'stable',
          candidate_sha: newSha,
          deployment_id: deploymentId,
          event_at: eventAt,
          detail: 'preview authority rebind: local-systemd -> local-systemd',
        }],
      },
      {
        success: true,
        results: [{
          singleton_id: 1,
          owner: 'local-systemd',
          generation: 3,
          transition_state: 'stable',
          transition_id: transitionId,
          previous_owner: 'local-systemd',
          candidate_sha: newSha,
          deployment_id: deploymentId,
          transitioned_at: eventAt,
          updated_at: eventAt,
        }],
      },
    ];
    return { exitCode: 0, stdout: JSON.stringify(payload), stderr: '' };
  };

  const result = await executePreviewLocalSystemdRebind({
    expectedGeneration: 2,
    expectedCandidateSha: oldSha,
    candidateSha: newSha,
    deploymentId,
    transitionId,
    eventAt,
    runProcess,
  });

  assert.equal(result.ok, true);
  assert.equal(result.status, 'confirmed_local_systemd_rebound');
  assert.equal(result.generation, 3);
  assert.equal(result.candidateSha, newSha);
  assert.equal(result.deploymentId, deploymentId);
});

test('rebind wrapper rejects an operator identity that does not match loaded systemd', async () => {
  let nonGitCalls = 0;
  const runProcess = async (invocation) => {
    if (invocation.command !== 'git') {
      nonGitCalls += 1;
      throw new Error('should not reach D1');
    }
    const command = invocation.args.join(' ');
    if (command === 'branch --show-current') {
      return { exitCode: 0, stdout: 'hardening/issue-59-d1-mirror-activation\n', stderr: '' };
    }
    if (command === 'rev-parse HEAD') {
      return { exitCode: 0, stdout: `${newSha}\n`, stderr: '' };
    }
    if (command === 'status --porcelain --untracked-files=all') {
      return { exitCode: 0, stdout: '', stderr: '' };
    }
    throw new Error(`unexpected git command: ${command}`);
  };

  await assert.rejects(
    () => runPreviewLocalSystemdAuthorityRebind({
      argv: ['--confirm-preview-local-systemd-rebind'],
      runProcess,
      envVars: { XQUEUE_DEPLOYMENT_ID: 'invented-id' },
      deriveDeploymentIdentity: async () => ({
        deploymentId,
        unit: 'xqueue.service',
        unitHash: deploymentId.split(':').at(-1),
      }),
    }),
    /does not match the loaded xqueue\.service identity/,
  );
  assert.equal(nonGitCalls, 0);
});

test('rebind wrapper preserves mirror and independently proves generation 3', async () => {
  const mirror = '{"version":1}\n';
  let authorityReads = 0;
  let rebindArgs = null;

  const runProcess = async (invocation) => {
    if (invocation.command === 'git') {
      const command = invocation.args.join(' ');
      if (command === 'branch --show-current') return { exitCode: 0, stdout: 'hardening/issue-59-d1-mirror-activation\n', stderr: '' };
      if (command === 'rev-parse HEAD') return { exitCode: 0, stdout: `${newSha}\n`, stderr: '' };
      if (command === 'status --porcelain --untracked-files=all') return { exitCode: 0, stdout: '', stderr: '' };
      throw new Error(`unexpected git command: ${command}`);
    }
    if (invocation.command === 'pnpm') {
      return {
        exitCode: 0,
        stdout: JSON.stringify([{ success: true, results: [] }]),
        stderr: '',
      };
    }
    throw new Error(`unexpected process: ${invocation.command}`);
  };

  const transport = {
    async readAuthority() {
      authorityReads += 1;
      return authorityReads === 1 ? currentAuthority() : reboundAuthority();
    },
    async readMirror() {
      return mirror;
    },
  };

  const result = await runPreviewLocalSystemdAuthorityRebind({
    argv: ['--confirm-preview-local-systemd-rebind'],
    runProcess,
    now: () => new Date(eventAt),
    envVars: { XQUEUE_DEPLOYMENT_ID: deploymentId },
    deriveDeploymentIdentity: async () => ({
      deploymentId,
      unit: 'xqueue.service',
      unitHash: deploymentId.split(':').at(-1),
    }),
    transportFactory: () => transport,
    executeRebind: async (args) => {
      rebindArgs = args;
      return {
        ok: true,
        status: 'confirmed_local_systemd_rebound',
        generation: 3,
      };
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.status, 'confirmed_local_systemd_rebound');
  assert.equal(result.generation, 3);
  assert.equal(result.previousCandidateSha, oldSha);
  assert.equal(result.candidateSha, newSha);
  assert.equal(result.mirrorUnchanged, true);
  assert.equal(result.productionAuthoritySchemaAbsent, true);
  assert.equal(rebindArgs.expectedGeneration, 2);
  assert.equal(rebindArgs.expectedCandidateSha, oldSha);
  assert.equal(rebindArgs.candidateSha, newSha);
  assert.equal(rebindArgs.deploymentId, deploymentId);
});
