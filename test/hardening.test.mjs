import test from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import {
  dirname,
  isAbsolute,
  join,
  resolve,
} from 'node:path';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { loadLibrary } from '../src/parse.mjs';
import { validate } from '../src/validate.mjs';
import {
  emptyState,
  readState,
  writeStateAtomic,
} from '../src/state-store.mjs';
import { acquirePublishLock } from '../src/publish-lock.mjs';
import {
  beginPublication,
  clearPreparedPublication,
  markNeedsReconciliation,
  markPublishing,
  reconcileAsNotPosted,
  reconcileAsPosted,
} from '../src/publication-state.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CONTENT = resolve(HERE, '../content');
const SYSTEMD_SERVICE = resolve(HERE, '../deploy/systemd/xqueue.service');
const SYSTEMD_RUNTIME_CHECK = resolve(HERE, '../deploy/systemd/check-runtime.sh');

function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'xqueue-hardening-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function post(overrides = {}) {
  return {
    id: 'A1',
    pillar: 'A',
    seq: 1,
    title: 'test',
    body: 'A body that is comfortably longer than forty characters for validation.',
    figure: null,
    pinned: false,
    note: null,
    sourceFile: 'content/test.md',
    sourceLine: 1,
    ...overrides,
  };
}

test('generated library records use repo-relative source paths', () => {
  const posts = loadLibrary(CONTENT);
  assert.ok(posts.length > 0);

  for (const item of posts) {
    assert.equal(isAbsolute(item.sourceFile), false, `${item.id}: ${item.sourceFile}`);
    assert.match(item.sourceFile, /^content\//, `${item.id}: ${item.sourceFile}`);
  }
});

test('production validation blocks an empty media directory', () => {
  const findings = validate(
    [post({ figure: 23 })],
    {
      figuresAvailable: new Set(),
      requireFigures: true,
    },
  );

  assert.ok(
    findings.some((f) => f.level === 'error' && f.rule === 'missing-figure'),
    JSON.stringify(findings, null, 2),
  );
});

test('authoring validation keeps an empty media directory informational', () => {
  const findings = validate(
    [post({ figure: 23 })],
    {
      figuresAvailable: new Set(),
      requireFigures: false,
    },
  );

  assert.ok(
    findings.some((f) => f.level === 'info' && f.rule === 'figure-unchecked'),
  );
  assert.equal(findings.some((f) => f.level === 'error'), false);
});

test('state writes atomically and reads back validated state', () =>
  withTempDir((dir) => {
    const path = join(dir, 'state.json');
    const state = emptyState();
    state.posted.A1 = {
      tweetId: '123',
      at: '2026-09-01T00:00:00.000Z',
      cost: 0.015,
    };
    state.spend = 0.015;

    writeStateAtomic(path, state);

    assert.deepEqual(readState(path), state);
    assert.doesNotThrow(() => JSON.parse(readFileSync(path, 'utf8')));
  }));

test('corrupt state fails closed instead of becoming an empty ledger', () =>
  withTempDir((dir) => {
    const path = join(dir, 'state.json');
    writeFileSync(path, '{ definitely not json', 'utf8');

    assert.throws(
      () => readState(path),
      /refusing to assume nothing was posted/i,
    );
  }));

test('publisher lock blocks concurrent live executions', () =>
  withTempDir((dir) => {
    const path = join(dir, '.xqueue-publish.lock');
    const first = acquirePublishLock(path);

    assert.throws(
      () => acquirePublishLock(path),
      /already held/i,
    );

    first.release();

    const second = acquirePublishLock(path);
    second.release();
  }));

test('prepared publication can be safely cleared before create-post begins', () => {
  const state = emptyState();
  beginPublication(state, post(), 'hello world', 0.015);
  assert.equal(state.inflight.status, 'prepared');

  clearPreparedPublication(state);
  assert.equal(state.inflight, null);
});

test('ambiguous create-post outcome requires explicit reconciliation', () => {
  const state = emptyState();
  beginPublication(state, post(), 'hello world', 0.015);
  markPublishing(state);
  markNeedsReconciliation(state, new Error('socket reset'));

  assert.equal(state.inflight.status, 'needs_reconciliation');
  assert.throws(() => clearPreparedPublication(state), /cannot automatically clear/i);

  reconcileAsPosted(state, '999');
  assert.equal(state.inflight, null);
  assert.equal(state.posted.A1.tweetId, '999');
  assert.equal(state.posted.A1.reconciled, true);
});

test('owner can reconcile an ambiguous attempt as not posted', () => {
  const state = emptyState();
  beginPublication(state, post(), 'hello world', 0.015);
  markPublishing(state);
  markNeedsReconciliation(state, new Error('timeout'));

  reconcileAsNotPosted(state);
  assert.equal(state.inflight, null);
  assert.deepEqual(state.posted, {});
});

test('systemd compatibility service pins runtime and cannot publish live', () => {
  const unit = readFileSync(SYSTEMD_SERVICE, 'utf8');
  assert.match(unit, /EnvironmentFile=%h\/\.config\/xqueue\/runtime\.env/);
  assert.match(unit, /ExecStartPre=.*check-runtime\.sh/);
  assert.match(unit, /\$\$XQUEUE_COREPACK/);
  assert.match(unit, /post:dry/);
  assert.doesNotMatch(unit, /post:live/);
  assert.doesNotMatch(unit, /bash\s+-lc/);
});

test('systemd runtime checker accepts explicit compatible binaries', () =>
  withTempDir((dir) => {
    const fakeCorepack = join(dir, 'corepack');
    writeFileSync(
      fakeCorepack,
      '#!/usr/bin/env bash\nif [[ "$1" == "pnpm" && "$2" == "--version" ]]; then echo 11.24.0; exit 0; fi\nexit 2\n',
      'utf8',
    );
    chmodSync(fakeCorepack, 0o755);

    const nodeDir = dirname(process.execPath);
    const result = spawnSync(
      '/bin/bash',
      [SYSTEMD_RUNTIME_CHECK],
      {
        encoding: 'utf8',
        env: {
          PATH: `${nodeDir}:/usr/local/bin:/usr/bin:/bin`,
          XQUEUE_NODE: process.execPath,
          XQUEUE_COREPACK: fakeCorepack,
        },
      },
    );

    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /pinned systemd runtime/i);
  }));
