#!/usr/bin/env node

import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createWranglerD1MirrorTransport } from '../src/d1-mirror-wrangler-transport.mjs';
import { inspectD1MirrorText } from '../src/d1-mirror-sync-plan.mjs';

const PREVIEW_ENV = 'preview';
const TARGET_KEY = 'state.snapshot_json';

function actualProcessRunner(invocation) {
  return new Promise((resolvePromise) => {
    execFile(
      invocation.command,
      invocation.args,
      {
        encoding: 'utf8',
        maxBuffer: 4 * 1024 * 1024,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        resolvePromise({
          exitCode: error ? (Number.isSafeInteger(error.code) ? error.code : 1) : 0,
          stdout: typeof stdout === 'string' ? stdout : '',
          stderr: typeof stderr === 'string' ? stderr : '',
        });
      },
    );
  });
}

export async function runPreviewMirrorDiagnostic({ runProcess = actualProcessRunner } = {}) {
  if (typeof runProcess !== 'function') {
    throw new TypeError('runProcess must be a function');
  }

  const transport = createWranglerD1MirrorTransport({ runProcess });
  const authority = await transport.readAuthority({ env: PREVIEW_ENV });
  const mirrorValue = await transport.readMirror({
    env: PREVIEW_ENV,
    key: TARGET_KEY,
  });
  const mirror = inspectD1MirrorText(mirrorValue);

  return {
    ok: true,
    mode: 'read_only_preview_diagnostic',
    env: PREVIEW_ENV,
    authority,
    mirror: {
      exists: mirror.exists,
      rawHash: mirror.rawHash,
      valid: mirror.valid,
      reason: mirror.reason,
      normalizedHash: mirror.hash,
      counts: mirror.counts,
    },
  };
}

function isDirectExecution() {
  if (!process.argv[1]) return false;
  return resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

if (isDirectExecution()) {
  try {
    const result = await runPreviewMirrorDiagnostic();
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`XQUEUE PREVIEW MIRROR DIAGNOSTIC: FAIL\n${message}\n`);
    process.exitCode = 1;
  }
}
