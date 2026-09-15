import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { deriveSystemdDeploymentIdentity } from '../src/systemd-deployment-identity.mjs';

const unitText = `[Unit]\nDescription=XQueue live publisher\n\n[Service]\nWorkingDirectory=%h/xqueue\nExecStart=/bin/bash -c 'exec "$XQUEUE_COREPACK" pnpm post:live'\n`;
const unitHash = createHash('sha256').update(Buffer.from(unitText, 'utf8')).digest('hex');

function runner({ loadState = 'loaded', fragmentPath = '/home/patrick/.config/systemd/user/xqueue.service', text = unitText } = {}) {
  const calls = [];
  const runProcess = async (invocation) => {
    calls.push(invocation);
    assert.equal(invocation.command, 'systemctl');
    const args = invocation.args.join(' ');
    if (args.includes('--property=LoadState')) return { exitCode: 0, stdout: `${loadState}\n`, stderr: '' };
    if (args.includes('--property=FragmentPath')) return { exitCode: 0, stdout: `${fragmentPath}\n`, stderr: '' };
    if (args === '--user cat xqueue.service --no-pager') return { exitCode: 0, stdout: text, stderr: '' };
    throw new Error(`unexpected systemctl invocation: ${args}`);
  };
  return { calls, runProcess };
}

test('derives deployment identity from the loaded xqueue.service bytes', async () => {
  const fake = runner();
  const result = await deriveSystemdDeploymentIdentity({ runProcess: fake.runProcess });
  assert.equal(result.unit, 'xqueue.service');
  assert.equal(result.unitHash, unitHash);
  assert.equal(result.deploymentId, `systemd-user:xqueue.service:sha256:${unitHash}`);
  assert.equal(fake.calls.length, 3);
  assert.equal(fake.calls.some((call) => 'shell' in call), false);
});

test('unloaded, pathless, or non-XQueue units fail closed', async () => {
  await assert.rejects(() => deriveSystemdDeploymentIdentity({ runProcess: runner({ loadState: 'not-found' }).runProcess }), /must be loaded/);
  await assert.rejects(() => deriveSystemdDeploymentIdentity({ runProcess: runner({ fragmentPath: '' }).runProcess }), /FragmentPath/);
  await assert.rejects(() => deriveSystemdDeploymentIdentity({ runProcess: runner({ text: '[Service]\nExecStart=/bin/true\n' }).runProcess }), /publisher contract/);
});

test('arbitrary unit names are rejected before process execution', async () => {
  let calls = 0;
  await assert.rejects(
    () => deriveSystemdDeploymentIdentity({
      unit: '../../evil.service;rm',
      runProcess: async () => { calls += 1; throw new Error('should not run'); },
    }),
    /explicit \.service name/,
  );
  assert.equal(calls, 0);
});
