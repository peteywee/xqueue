import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';

export function emptyState() {
  return {
    version: 1,
    posted: {},
    spend: 0,
    inflight: null,
  };
}

export function normalizeState(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('state.json must contain a JSON object');
  }

  const posted = value.posted ?? {};
  if (!posted || typeof posted !== 'object' || Array.isArray(posted)) {
    throw new Error('state.json posted must be an object');
  }

  for (const [postId, record] of Object.entries(posted)) {
    if (!record || typeof record !== 'object' || Array.isArray(record)) {
      throw new Error(`state.json posted.${postId} must be an object`);
    }
    if (!record.tweetId || typeof record.tweetId !== 'string') {
      throw new Error(`state.json posted.${postId}.tweetId must be a non-empty string`);
    }
  }

  const spend = value.spend ?? 0;
  if (!Number.isFinite(spend) || spend < 0) {
    throw new Error('state.json spend must be a non-negative finite number');
  }

  const inflight = value.inflight ?? null;
  if (inflight !== null) {
    if (!inflight || typeof inflight !== 'object' || Array.isArray(inflight)) {
      throw new Error('state.json inflight must be null or an object');
    }
    if (!inflight.postId || typeof inflight.postId !== 'string') {
      throw new Error('state.json inflight.postId must be a non-empty string');
    }
    if (!['prepared', 'publishing', 'needs_reconciliation'].includes(inflight.status)) {
      throw new Error(`state.json inflight.status is invalid: ${inflight.status}`);
    }
  }

  return {
    ...value,
    version: 1,
    posted,
    spend,
    inflight,
  };
}

export function readState(path) {
  if (!existsSync(path)) {
    return emptyState();
  }

  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(
      `Unable to parse state.json; refusing to assume nothing was posted: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  return normalizeState(parsed);
}

export function writeStateAtomic(path, value) {
  const state = normalizeState(value);
  const dir = dirname(path);
  const tmp = join(
    dir,
    `.${basename(path)}.${process.pid}.${Date.now()}.tmp`,
  );

  let fd = null;

  try {
    fd = openSync(tmp, 'wx', 0o600);
    writeFileSync(fd, JSON.stringify(state, null, 2) + '\n', 'utf8');
    fsyncSync(fd);
    closeSync(fd);
    fd = null;

    renameSync(tmp, path);

    try {
      const dirFd = openSync(dir, 'r');
      try {
        fsyncSync(dirFd);
      } finally {
        closeSync(dirFd);
      }
    } catch {
      // Some platforms do not allow fsync on a directory handle.
    }
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // Ignore cleanup errors; preserve the original failure.
      }
    }

    if (existsSync(tmp)) {
      try {
        unlinkSync(tmp);
      } catch {
        // Best-effort cleanup only.
      }
    }
  }
}
