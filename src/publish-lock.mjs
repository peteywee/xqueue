import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { hostname as currentHostname } from 'node:os';

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === 'ESRCH') {
      return false;
    }
    return true;
  }
}

function readLock(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

export function acquirePublishLock(
  path,
  {
    pid = process.pid,
    hostname = currentHostname(),
    isProcessAlive = processAlive,
    now = () => new Date(),
  } = {},
) {
  const token = randomUUID();
  const record = {
    token,
    pid,
    hostname,
    startedAt: now().toISOString(),
  };

  const tryAcquire = (allowStaleRecovery) => {
    let fd;
    try {
      fd = openSync(path, 'wx', 0o600);
      writeFileSync(fd, JSON.stringify(record, null, 2) + '\n', 'utf8');
      closeSync(fd);
      return;
    } catch (error) {
      if (fd !== undefined) {
        try {
          closeSync(fd);
        } catch {
          // Ignore cleanup error.
        }
      }

      if (error?.code !== 'EEXIST') {
        throw error;
      }

      const existing = readLock(path);
      const stale =
        allowStaleRecovery &&
        existing?.hostname === hostname &&
        Number.isInteger(existing?.pid) &&
        existing.pid > 0 &&
        !isProcessAlive(existing.pid);

      if (stale) {
        unlinkSync(path);
        return tryAcquire(false);
      }

      const detail = existing
        ? ` pid=${existing.pid ?? '?'} host=${existing.hostname ?? '?'} started=${existing.startedAt ?? '?'}`
        : '';

      throw new Error(
        `Publisher lock is already held; refusing concurrent live execution.${detail}`,
      );
    }
  };

  tryAcquire(true);

  let released = false;

  return {
    record,
    release() {
      if (released) return;
      released = true;

      if (!existsSync(path)) return;

      const existing = readLock(path);
      if (existing?.token && existing.token !== token) {
        throw new Error('Publisher lock ownership changed; refusing to remove another process lock');
      }

      unlinkSync(path);
    },
  };
}
