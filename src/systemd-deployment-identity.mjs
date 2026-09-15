import { createHash } from 'node:crypto';

const DEFAULT_UNIT = 'xqueue.service';
const REQUIRED_WORKING_DIRECTORY = 'WorkingDirectory=%h/xqueue';

function assertRunner(runProcess) {
  if (typeof runProcess !== 'function') {
    throw new TypeError('runProcess injection is required');
  }
}

function normalizeProcessResult(result, label) {
  if (!result || typeof result !== 'object') {
    throw new Error(`${label} returned no structured process result`);
  }
  const exitCode = result.exitCode ?? result.code;
  if (!Number.isSafeInteger(exitCode)) {
    throw new Error(`${label} process result must include an integer exitCode`);
  }
  return {
    exitCode,
    stdout: typeof result.stdout === 'string' ? result.stdout : '',
    stderr: typeof result.stderr === 'string' ? result.stderr : '',
  };
}

async function runChecked(runProcess, invocation, label) {
  const result = normalizeProcessResult(await runProcess(invocation), label);
  if (result.exitCode !== 0) {
    const stderr = result.stderr.trim();
    const stdout = result.stdout.trim();
    const detail = stderr || stdout;
    throw new Error(
      detail.length > 0
        ? `${label} failed: ${detail}`
        : `${label} failed with exit code ${result.exitCode}`,
    );
  }
  return result.stdout;
}

function unitArg(unit) {
  if (typeof unit !== 'string' || !/^[A-Za-z0-9_.@:-]+\.service$/.test(unit)) {
    throw new TypeError('systemd unit must be an explicit .service name');
  }
  return unit;
}

export async function deriveSystemdDeploymentIdentity({
  runProcess,
  unit = DEFAULT_UNIT,
} = {}) {
  assertRunner(runProcess);
  const service = unitArg(unit);

  const loadState = (await runChecked(
    runProcess,
    {
      command: 'systemctl',
      args: ['--user', 'show', service, '--property=LoadState', '--value'],
    },
    'systemd load-state check',
  )).trim();
  if (loadState !== 'loaded') {
    throw new Error(`systemd unit ${service} must be loaded; got ${loadState || 'empty'}`);
  }

  const fragmentPath = (await runChecked(
    runProcess,
    {
      command: 'systemctl',
      args: ['--user', 'show', service, '--property=FragmentPath', '--value'],
    },
    'systemd fragment-path check',
  )).trim();
  if (!fragmentPath.startsWith('/')) {
    throw new Error(`systemd unit ${service} has no absolute FragmentPath`);
  }

  const unitText = await runChecked(
    runProcess,
    {
      command: 'systemctl',
      args: ['--user', 'cat', service, '--no-pager'],
    },
    'systemd unit read',
  );
  if (
    unitText.length === 0 ||
    !unitText.includes('[Service]') ||
    !unitText.includes(REQUIRED_WORKING_DIRECTORY) ||
    !unitText.includes('ExecStart=')
  ) {
    throw new Error(`systemd unit ${service} content does not match the XQueue publisher contract`);
  }

  const unitHash = createHash('sha256')
    .update(Buffer.from(unitText, 'utf8'))
    .digest('hex');

  return {
    unit: service,
    fragmentPath,
    unitHash,
    deploymentId: `systemd-user:${service}:sha256:${unitHash}`,
  };
}
