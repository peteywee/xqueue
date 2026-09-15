import test from 'node:test';
import assert from 'node:assert/strict';

import { runPreviewAuthorityBootstrap } from '../scripts/d1-preview-authority-bootstrap.mjs';
import { createWranglerD1MirrorTransport } from '../src/d1-mirror-wrangler-transport.mjs';

const candidateSha = 'ef4056501054250d27a2c4406b52b0287d7b31f7';
const confirmation = '--confirm-preview-owner-none-bootstrap';

test('preview bootstrap accepts a package-manager separator but still requires the exact confirmation', async () => {
  const calls = [];
  const runProcess = async (invocation) => {
    calls.push(invocation);
    if (invocation.command === 'git') {
      const command = invocation.args.join(' ');
      if (command === 'branch --show-current') {
        return { exitCode: 0, stdout: 'hardening/issue-59-d1-mirror-activation\n', stderr: '' };
      }
      if (command === 'rev-parse HEAD') {
        return { exitCode: 0, stdout: `${candidateSha}\n`, stderr: '' };
      }
      if (command === 'status --porcelain --untracked-files=all') {
        return { exitCode: 0, stdout: '', stderr: '' };
      }
      throw new Error(`unexpected git invocation: ${command}`);
    }

    return {
      exitCode: 1,
      stdout: '{"error":"cloudflare-auth-failed"}\n',
      stderr: '',
    };
  };

  await assert.rejects(
    () => runPreviewAuthorityBootstrap({
      argv: ['--', confirmation],
      runProcess,
      now: () => new Date('2026-09-15T17:00:00.000Z'),
    }),
    /production authority schema read failed: .*cloudflare-auth-failed/,
  );

  const wranglerCalls = calls.filter((call) => call.command === 'pnpm');
  assert.equal(wranglerCalls.length, 1);
  assert.equal(wranglerCalls[0].args[3], 'xqueue-production');
  assert.match(wranglerCalls[0].args.at(-1), /^SELECT name\nFROM sqlite_master/);
  assert.doesNotMatch(
    wranglerCalls[0].args.at(-1),
    /\b(?:INSERT|UPDATE|DELETE|REPLACE|DROP|ALTER|CREATE)\b/i,
  );
});

test('shared Wrangler transport surfaces stdout on a nonzero exit', async () => {
  const transport = createWranglerD1MirrorTransport({
    runProcess: async () => ({
      exitCode: 1,
      stdout: '{"error":"cloudflare-auth-failed"}\n',
      stderr: '',
    }),
  });

  await assert.rejects(
    () => transport.readMirror({ env: 'preview', key: 'state.snapshot_json' }),
    /Wrangler D1 command failed: .*cloudflare-auth-failed/,
  );
});
