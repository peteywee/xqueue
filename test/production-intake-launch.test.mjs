import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { ownerPublicKeyFingerprint } from '../src/authoring/owner-approval.mjs';
import {
  authorizeProductionIntakeInput,
  createMutationProductionIntakeWorker,
} from '../cloudflare/src/mutation-production-intake-worker.mjs';
import {
  MUTATION_WORKER_SERVICE,
  REQUIRED_MUTATION_MIGRATIONS,
  assertHealthIdentity,
  assertNoLocalDevOverrides,
  childEnvironment,
  collectOperatorPreflight,
  evaluateOperatorReadiness,
  expectedTrustRoot,
  invokeEphemeralWorker,
  readMutationWorkerDescriptor,
} from '../scripts/production-mutation-intake.mjs';

const DESCRIPTOR = readMutationWorkerDescriptor();
const EXPECTED = expectedTrustRoot(DESCRIPTOR);
const ACCOUNT = DESCRIPTOR.vars.CLOUDFLARE_ACCOUNT_ID;

function launchEnv(overrides = {}) {
  return {
    PATH: '/usr/bin',
    CLOUDFLARE_API_TOKEN: 'launch-token-with-script-edit-0001',
    CLOUDFLARE_ACCOUNT_ID: ACCOUNT,
    MUTATION_D1_API_TOKEN: 'd1-scoped-token-000000000000001',
    ...overrides,
  };
}

function healthBody(bindings = EXPECTED, overrides = {}) {
  return {
    service: MUTATION_WORKER_SERVICE,
    role: 'production-mutation-intake',
    environment: 'production',
    publicationCapable: false,
    schedulerAuthority: false,
    status: 'ok',
    bindings,
    ...overrides,
  };
}

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return body;
    },
  };
}

function fakeChild({ exitImmediately = false, stderrText = null, spawnError = null } = {}) {
  const calls = { spawn: null, killed: false };
  const spawnImpl = (command, args, options) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {
      calls.killed = true;
      child.emit('exit', null, 'SIGTERM');
    };
    calls.spawn = { command, args, options, child };
    queueMicrotask(() => {
      if (stderrText) child.stderr.emit('data', stderrText(options.env));
      if (spawnError) child.emit('error', spawnError);
      else if (exitImmediately) child.emit('exit', 1, null);
    });
    return child;
  };
  return { spawnImpl, calls };
}

function launch(overrides = {}) {
  return invokeEphemeralWorker({
    payload: { mode: 'single', sourceMode: 'owner-manual', input: { body: 'b' } },
    candidate: { branch: 'main', clean: true, headSha: 'a'.repeat(40), originMainSha: 'a'.repeat(40) },
    port: 18789,
    env: launchEnv(),
    assertLocalOverrides: () => true,
    probePort: async () => true,
    healthDeadlineMs: 2_000,
    intakeTimeoutMs: 2_000,
    ...overrides,
  });
}

test('the Worker reports the trust root it actually bound', async () => {
  const worker = createMutationProductionIntakeWorker({});
  const env = { ...DESCRIPTOR.vars };
  const body = await (await worker.fetch(new Request('https://example.test/health'), env)).json();
  assert.deepEqual(body.bindings, {
    accountId: ACCOUNT,
    productionDatabaseId: DESCRIPTOR.vars.XQUEUE_PRODUCTION_DATABASE_ID,
    ownerApprovalKeyFingerprint: ownerPublicKeyFingerprint(DESCRIPTOR.vars.OWNER_APPROVAL_PUBLIC_KEY_PEM),
  });
  assert.deepEqual(body.bindings, { ...EXPECTED });

  const overridden = await (await worker.fetch(
    new Request('https://example.test/health'),
    { ...env, XQUEUE_PRODUCTION_DATABASE_ID: 'other-db' },
  )).json();
  assert.equal(overridden.bindings.productionDatabaseId, 'other-db');
});

test('health identity must name the Worker and match every committed binding', () => {
  assert.equal(assertHealthIdentity(healthBody(), EXPECTED), true);
  assert.throws(
    () => assertHealthIdentity(healthBody(EXPECTED, { service: 'something-else' }), EXPECTED),
    /not the ephemeral production mutation Worker/,
  );
  assert.throws(
    () => assertHealthIdentity(healthBody(EXPECTED, { publicationCapable: true }), EXPECTED),
    /not the ephemeral production mutation Worker/,
  );
  for (const key of ['accountId', 'productionDatabaseId', 'ownerApprovalKeyFingerprint']) {
    assert.throws(
      () => assertHealthIdentity(healthBody({ ...EXPECTED, [key]: 'overridden' }), EXPECTED),
      new RegExp('bound ' + key + ' that does not match'),
    );
  }
});

test('the launch credential is never passed to the Worker as its D1 credential', () => {
  const child = childEnvironment({
    env: launchEnv({ OWNER_APPROVAL_PUBLIC_KEY_PEM: 'shell-key', XQUEUE_PRODUCTION_DATABASE_ID: 'shell-db' }),
    descriptor: DESCRIPTOR,
    controlToken: 'c'.repeat(64),
  });
  assert.equal(child.MUTATION_CONTROL_TOKEN, 'c'.repeat(64));
  assert.equal(child.MUTATION_D1_API_TOKEN, 'd1-scoped-token-000000000000001');
  assert.equal(Object.hasOwn(child, 'OWNER_APPROVAL_PUBLIC_KEY_PEM'), false);
  assert.equal(Object.hasOwn(child, 'XQUEUE_PRODUCTION_DATABASE_ID'), false);
  assert.equal(child.CLOUDFLARE_ACCOUNT_ID, ACCOUNT);

  assert.throws(
    () => childEnvironment({ env: launchEnv({ MUTATION_D1_API_TOKEN: '' }), descriptor: DESCRIPTOR, controlToken: 'x' }),
    /requires MUTATION_D1_API_TOKEN/,
  );
  assert.throws(
    () => childEnvironment({
      env: launchEnv({ MUTATION_D1_API_TOKEN: 'launch-token-with-script-edit-0001' }),
      descriptor: DESCRIPTOR,
      controlToken: 'x',
    }),
    /must differ from CLOUDFLARE_API_TOKEN/,
  );
  assert.throws(
    () => childEnvironment({ env: launchEnv({ CLOUDFLARE_ACCOUNT_ID: 'other' }), descriptor: DESCRIPTOR, controlToken: 'x' }),
    /must equal the mutation Worker descriptor account id/,
  );
  assert.throws(
    () => childEnvironment({
      env: launchEnv(),
      descriptor: { ...DESCRIPTOR, secrets: { required: ['CLOUDFLARE_API_TOKEN', 'MUTATION_CONTROL_TOKEN'] } },
      controlToken: 'x',
    }),
    /must require exactly its own D1 and control secrets/,
  );
});

test('local dev files that could override Worker bindings block the launch', () => {
  const files = (map) => ({
    readDir: () => Object.keys(map),
    readText: (path) => map[path.split('/').pop()],
  });
  assert.equal(
    assertNoLocalDevOverrides({ dir: '/repo', descriptor: DESCRIPTOR, ...files({ '.env': 'X_API_KEY=x\n', 'README.md': '' }) }),
    true,
  );
  assert.throws(
    () => assertNoLocalDevOverrides({ dir: '/repo', descriptor: DESCRIPTOR, ...files({ '.env': 'OWNER_APPROVAL_PUBLIC_KEY_PEM="k"\n' }) }),
    /\.env defines OWNER_APPROVAL_PUBLIC_KEY_PEM/,
  );
  assert.throws(
    () => assertNoLocalDevOverrides({ dir: '/repo', descriptor: DESCRIPTOR, ...files({ '.env.local': 'export MUTATION_D1_API_TOKEN=t\n' }) }),
    /\.env\.local defines MUTATION_D1_API_TOKEN/,
  );
  assert.throws(
    () => assertNoLocalDevOverrides({ dir: '/repo', descriptor: DESCRIPTOR, ...files({ '.dev.vars': '' }) }),
    /\.dev\.vars exists/,
  );
});

test('a successful launch sends the generated bearer only after a verified health check', async () => {
  const { spawnImpl, calls } = fakeChild();
  const requests = [];
  const fetchImpl = async (url, init = {}) => {
    requests.push({ url, init });
    if (url.endsWith('/health')) return jsonResponse(healthBody());
    return jsonResponse({ ok: true, planned: { operationId: 'mutation-intake-x' } });
  };
  const result = await launch({ spawnImpl, fetchImpl });

  assert.equal(result.ok, true);
  assert.deepEqual(calls.spawn.args, [
    'wrangler', 'dev', '--config', 'wrangler.mutation-production-intake.jsonc', '--remote', '--port', '18789',
  ]);
  const token = calls.spawn.options.env.MUTATION_CONTROL_TOKEN;
  assert.match(token, /^[0-9a-f]{64}$/);
  assert.equal(Object.hasOwn(calls.spawn.options.env, 'OWNER_APPROVAL_PUBLIC_KEY_PEM'), false);
  assert.equal(requests[0].url, 'http://127.0.0.1:18789/health');
  assert.equal(requests[0].init.headers.authorization, undefined);
  assert.equal(requests[1].url, 'http://127.0.0.1:18789/production-intake');
  assert.equal(requests[1].init.headers.authorization, 'Bearer ' + token);
  assert.ok(requests[1].init.signal, 'intake request has a timeout signal');
  assert.equal(calls.killed, true);
});

test('a busy port refuses before anything is spawned', async () => {
  const { spawnImpl, calls } = fakeChild();
  await assert.rejects(
    launch({ spawnImpl, probePort: async () => { throw new Error('port 18789 already has a listener; refusing to launch'); } }),
    /already has a listener/,
  );
  assert.equal(calls.spawn, null);
});

test('a listener with overridden bindings never receives the bearer or payload', async () => {
  const { spawnImpl, calls } = fakeChild();
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(url);
    return jsonResponse(healthBody({ ...EXPECTED, ownerApprovalKeyFingerprint: 'sha256:' + 'f'.repeat(64) }));
  };
  await assert.rejects(launch({ spawnImpl, fetchImpl }), /bound ownerApprovalKeyFingerprint that does not match/);
  assert.deepEqual(urls, ['http://127.0.0.1:18789/health']);
  assert.equal(calls.killed, true);
});

test('any failure after dispatch requires readback instead of looking like an ordinary failure', async () => {
  const health = async () => jsonResponse(healthBody());
  const cases = [
    ['connection lost', async () => { throw new TypeError('fetch failed'); }],
    ['timeout', async () => { throw new DOMException('timed out', 'TimeoutError'); }],
    ['non-JSON body', async () => ({ ok: false, status: 502, async json() { throw new SyntaxError('<html>'); } })],
  ];
  for (const [name, intake] of cases) {
    const { spawnImpl, calls } = fakeChild();
    const fetchImpl = async (url, init) => (url.endsWith('/health') ? health() : intake(url, init));
    await assert.rejects(
      launch({ spawnImpl, fetchImpl }),
      (error) => {
        assert.equal(error.response?.requiresReadback, true, name);
        assert.equal(error.response?.faultClass, 'POST_DISPATCH_TRANSPORT_AMBIGUOUS', name);
        return true;
      },
    );
    assert.equal(calls.killed, true, name);
  }
});

test('a definitive Worker error keeps the Worker\'s own readback decision', async () => {
  for (const requiresReadback of [true, false]) {
    const { spawnImpl } = fakeChild();
    const fetchImpl = async (url) => (url.endsWith('/health')
      ? jsonResponse(healthBody())
      : jsonResponse({ status: 'blocked', requiresReadback, faultClass: 'X' }, 409));
    await assert.rejects(launch({ spawnImpl, fetchImpl }), (error) => {
      assert.equal(error.httpStatus, 409);
      assert.equal(error.response.requiresReadback, requiresReadback);
      return true;
    });
  }
});

test('a child that exits or fails to spawn stops the launch with redacted output', async () => {
  const exited = fakeChild({
    exitImmediately: true,
    stderrText: (env) => 'auth failed for token ' + env.MUTATION_CONTROL_TOKEN + ' and ' + env.MUTATION_D1_API_TOKEN,
  });
  const neverHealthy = async () => { throw new TypeError('ECONNREFUSED'); };
  await assert.rejects(launch({ spawnImpl: exited.spawnImpl, fetchImpl: neverHealthy }), (error) => {
    assert.match(error.message, /exited before health became ready/);
    assert.match(error.message, /auth failed for token \[redacted\] and \[redacted\]/);
    assert.doesNotMatch(error.message, /d1-scoped-token/);
    assert.equal(error.response, undefined);
    return true;
  });

  const failed = fakeChild({ spawnError: Object.assign(new Error('spawn pnpm ENOENT'), { code: 'ENOENT' }) });
  await assert.rejects(launch({ spawnImpl: failed.spawnImpl, fetchImpl: neverHealthy }), /spawn pnpm ENOENT/);
});

test('missing mutation lane or halt rows block readiness explicitly', () => {
  const base = {
    auth: { ok: true, environment: 'production', token_type: 'account', token_status: 'active', d1: { readable: true } },
    candidate: { branch: 'main', clean: true, headSha: 'a'.repeat(40), originMainSha: 'a'.repeat(40) },
    migrations: [...REQUIRED_MUTATION_MIGRATIONS],
    publisherMutex: { ok: true, reason: 'publisher_mutex_compatible' },
  };
  const safety = {
    authority: {
      owner: 'cloudflare', generation: 9, transition_state: 'stable', candidate_sha: 'b'.repeat(40),
      deployment_id: 'cloudflare-worker:xqueue-publisher-production:version:11111111-1111-4111-8111-111111111111',
    },
    unresolvedAttemptCount: 0,
    activeLeaseCount: 0,
    publicationLeaseGeneration: 5,
    publicationEventCursor: 17,
    runtimeSnapshotObserved: true,
    inflight: null,
    mutationHalt: { halted: 0, generation: 4 },
    mutationLane: { generation: 8, active_operation_id: null },
    runtimeState: { generation: 12, revision_digest: 'c'.repeat(64) },
  };
  const ids = (s) => evaluateOperatorReadiness({ ...base, safety: s }).blockers.map((item) => item.id);
  assert.equal(ids(safety).includes('mutation_lane_unreadable'), false);
  assert.ok(ids({ ...safety, mutationLane: null }).includes('mutation_lane_unreadable'));
  assert.ok(ids({ ...safety, mutationHalt: null }).includes('mutation_lane_halt_unreadable'));
  assert.equal(ids({ ...safety, mutationHalt: null }).includes('mutation_lane_halted'), false);
});

test('a missing mutation schema is a structured blocker and production tables are not queried', () => {
  const commands = [];
  const run = (command, argv) => {
    const key = [command, ...argv].join(' ');
    commands.push(key);
    if (key === 'git branch --show-current') return 'main\n';
    if (key === 'git status --porcelain --untracked-files=all') return '';
    if (key === 'git fetch origin main') return '';
    if (key === 'git rev-parse HEAD' || key === 'git rev-parse origin/main') return 'a'.repeat(40) + '\n';
    if (key === 'pnpm cf:auth:preflight --environment production') {
      return JSON.stringify({ ok: true, environment: 'production', token_type: 'account', token_status: 'active', d1: { readable: true } });
    }
    if (key.includes('SELECT name FROM d1_migrations')) {
      return JSON.stringify([{ results: [{ name: '0014_authority_event_projection.sql' }] }]);
    }
    throw new Error('unexpected command: ' + key);
  };
  const preflight = collectOperatorPreflight(run, () => { throw new Error('publisher check must not run'); });
  assert.equal(preflight.readiness.ok, false);
  assert.deepEqual(preflight.readiness.blockers.map((item) => item.id), ['production_mutation_schema_not_active']);
  assert.equal(preflight.safety, null);
  assert.equal(commands.some((key) => key.includes('mutation_lane_state')), false);
});

test('approval evidence must come from the item or the top level, never both', () => {
  const item = {
    content_id: 'I-DUAL-1',
    title: 't',
    body: 'b',
    source_ref: 'source:test',
    owner_approval: { decision: 'approve' },
    approved_candidate: { artifact_kind: 'post' },
  };
  assert.throws(
    () => authorizeProductionIntakeInput(
      {
        mode: 'single',
        sourceMode: 'automated',
        input: item,
        ownerApproval: { decision: 'approve' },
        approvedCandidate: { artifact_kind: 'post' },
      },
      {
        ownerPublicKeyPem: DESCRIPTOR.vars.OWNER_APPROVAL_PUBLIC_KEY_PEM,
        verifyOwnerApproval: () => true,
      },
    ),
    /carries approval evidence; do not also supply top-level/,
  );
});
