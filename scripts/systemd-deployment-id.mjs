#!/usr/bin/env node

import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { deriveSystemdDeploymentIdentity } from '../src/systemd-deployment-identity.mjs';

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

export async function readSystemdDeploymentIdentity({ runProcess = actualProcessRunner } = {}) {
  return deriveSystemdDeploymentIdentity({ runProcess });
}

function isDirectExecution() {
  if (!process.argv[1]) return false;
  return resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

if (isDirectExecution()) {
  try {
    const result = await readSystemdDeploymentIdentity();
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`XQUEUE SYSTEMD DEPLOYMENT ID: FAIL\n${message}\n`);
    process.exitCode = 1;
  }
}
