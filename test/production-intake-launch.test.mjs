import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ownerPublicKeyFingerprint } from '../src/authoring/owner-approval.mjs';
import {
  authorizeProductionIntakeInput,
  createMutationProductionIntakeWorker,
} from '../cloudflare/src/mutation-production-intake-worker.mjs';
import {
  MUTATION_WORKER_SERVICE,
  REQUIRED_MUTATION_MIGRATIONS,
  REQUIRED_MUTATION_TRIGGERS,
  MUTEX_COMPATIBLE_PUBLISHER_COMMIT,
  assertHealthIdentity,
  childEnvironment,
  collectD1TokenReadiness,
  launchConfigurationBlockers,
  collectOperatorPreflight,
  evaluateOperatorReadiness,
  expectedTrustRoot,
  invokeEphemeralWorker,
  readMutationWorkerDescriptor,
  verifyTreeUnchanged,
} from '../scripts/production-mutation-intake.mjs';

const DESCRIPTOR = readMutationWorkerDescriptor();
const EXPECTED = expectedTrustRoot(DESCRIPTOR);
const ACCOUNT = DESCRIPTOR.vars.CLOUDFLARE_ACCOUNT_ID;

const AUTHORITY = Object.freeze({
  generation: 9,
  candidate_sha: 'b'.repeat(40),
  deployment_id: 'cloudflare-worker:xqueue-publisher-production:version:11111111-1111-4111-8111-111111111111',
});

function launchEnv(overrides = {}) {
  return {
    PATH: '/usr/bin',
    CLOUDFLARE_API_TOKEN: 'launch-token-with-script-edit-0001',
    CLOUDFLARE_ACCOUNT_ID: ACCOUNT,
    MUTATION_D1_API_TOKEN: 'd1-scoped-token-000000000000001',
    ...overrides,
  };
}

const BOUND = Object.freeze({ MUTATION_D1_API_TOKEN: true, MUTATION_CONTROL_TOKEN: true });

function healthBody(bindings = { ...EXPECTED, secretsBound: BOUND }, overrides = {}) {
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

// Fake children lead their own process group; fakeProcess().kill(-pid) reaches
// the whole group, the way the CLI tears wrangler down.
const CHILDREN = new Map();
let NEXT_PID = 40_000;

function fakeChild({ exitImmediately = false, stderrText = null, spawnError = null } = {}) {
  const calls = { spawn: null, killed: false, groupSignals: [] };
  const spawnImpl = (command, args, options) => {
    const child = new EventEmitter();
    child.pid = ++NEXT_PID;
    child.stdout = new EventEmitter();
    child.stdout.resume = () => {};
    child.stderr = new EventEmitter();
    CHILDREN.set(child.pid, { child, calls, exited: false });
    child.on('exit', () => { CHILDREN.get(child.pid).exited = true; });
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

function fakeProcess() {
  const signals = new EventEmitter();
  const record = [];
  return {
    pid: 4242,
    signals,
    record,
    once: (name, fn) => signals.once(name, fn),
    removeListener: (name, fn) => signals.removeListener(name, fn),
    kill: (pid, signal) => {
      record.push([pid, signal]);
      const entry = CHILDREN.get(-pid);
      if (!entry) return;
      entry.calls.killed = true;
      entry.calls.groupSignals.push(signal);
      if (!entry.exited) entry.child.emit('exit', null, signal);
    },
  };
}

function launch(overrides = {}) {
  return invokeEphemeralWorker({
    payload: { mode: 'single', sourceMode: 'owner-manual', input: { body: 'b' } },
    candidate: { branch: 'main', clean: true, headSha: 'a'.repeat(40), originMainSha: 'a'.repeat(40) },
    expectedPublicationAuthority: AUTHORITY,
    port: 18789,
    env: launchEnv(),
    probePort: async () => true,
    verifyTree: () => true,
    healthDeadlineMs: 2_000,
    intakeTimeoutMs: 2_000,
    processImpl: fakeProcess(),
    ...overrides,
  });
}

test('the Worker reports the trust root it actually bound', async () => {
  const worker = createMutationProductionIntakeWorker({});
  const env = { ...DESCRIPTOR.vars, DB: {} };
  const body = await (await worker.fetch(new Request('https://example.test/health'), env)).json();
  assert.deepEqual(body.bindings, {
    accountId: ACCOUNT,
    productionDatabaseId: DESCRIPTOR.vars.XQUEUE_PRODUCTION_DATABASE_ID,
    ownerApprovalKeyFingerprint: ownerPublicKeyFingerprint(DESCRIPTOR.vars.OWNER_APPROVAL_PUBLIC_KEY_PEM),
    bindingNames: [...Object.keys(DESCRIPTOR.vars), 'DB'].sort(),
    secretsBound: { MUTATION_D1_API_TOKEN: false, MUTATION_CONTROL_TOKEN: false },
  });
  const full = await (await worker.fetch(
    new Request('https://example.test/health'),
    { ...env, MUTATION_D1_API_TOKEN: 'v1-secret-value', MUTATION_CONTROL_TOKEN: 'v2-secret-value' },
  )).json();
  const { secretsBound: _bound, ...trustRoot } = full.bindings;
  assert.deepEqual(trustRoot, { ...EXPECTED });
  assert.doesNotMatch(JSON.stringify(full), /secret-value/);

  const withSecrets = await (await worker.fetch(
    new Request('https://example.test/health'),
    { ...env, MUTATION_D1_API_TOKEN: 'secret-value-1', MUTATION_CONTROL_TOKEN: 'secret-value-2' },
  )).json();
  assert.deepEqual(withSecrets.bindings.secretsBound, BOUND);
  assert.doesNotMatch(JSON.stringify(withSecrets), /secret-value/);

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
  for (const override of [{ publicationCapable: true }, { schedulerAuthority: true }, { environment: 'preview' }]) {
    assert.throws(
      () => assertHealthIdentity(healthBody(undefined, override), EXPECTED),
      /not the ephemeral production mutation Worker/,
      JSON.stringify(override),
    );
  }
  for (const key of ['accountId', 'productionDatabaseId', 'ownerApprovalKeyFingerprint']) {
    assert.throws(
      () => assertHealthIdentity(healthBody({ ...EXPECTED, secretsBound: BOUND, [key]: 'overridden' }), EXPECTED),
      new RegExp('bound ' + key + ' that does not match'),
    );
  }
  for (const missing of ['MUTATION_D1_API_TOKEN', 'MUTATION_CONTROL_TOKEN']) {
    assert.throws(
      () => assertHealthIdentity(
        healthBody({ ...EXPECTED, secretsBound: { ...BOUND, [missing]: false } }),
        EXPECTED,
      ),
      /did not bind both mutation secrets/,
    );
  }
});

test('the launch credential is never passed to the Worker as its D1 credential', () => {
  const child = childEnvironment({
    env: launchEnv({
      OWNER_APPROVAL_PUBLIC_KEY_PEM: 'shell-key',
      XQUEUE_PRODUCTION_DATABASE_ID: 'shell-db',
      CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: 'false',
      CLOUDFLARE_INCLUDE_PROCESS_ENV: 'true',
      CLOUDFLARE_ENV: 'staging',
    }),
    descriptor: DESCRIPTOR,
    controlToken: 'c'.repeat(64),
  });
  assert.equal(child.MUTATION_CONTROL_TOKEN, 'c'.repeat(64));
  assert.equal(child.MUTATION_D1_API_TOKEN, 'd1-scoped-token-000000000000001');
  // Committed vars travel explicitly: process.env outranks .env in wrangler dev.
  assert.equal(child.OWNER_APPROVAL_PUBLIC_KEY_PEM, DESCRIPTOR.vars.OWNER_APPROVAL_PUBLIC_KEY_PEM);
  assert.equal(child.XQUEUE_PRODUCTION_DATABASE_ID, DESCRIPTOR.vars.XQUEUE_PRODUCTION_DATABASE_ID);
  assert.equal(child.CLOUDFLARE_ACCOUNT_ID, ACCOUNT);
  for (const name of ['CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV', 'CLOUDFLARE_INCLUDE_PROCESS_ENV', 'CLOUDFLARE_ENV']) {
    assert.equal(Object.hasOwn(child, name), false, name);
  }

  assert.throws(
    () => childEnvironment({ env: launchEnv({ CLOUDFLARE_API_TOKEN: undefined }), descriptor: DESCRIPTOR, controlToken: 'x' }),
    /apply refused: launch_token_missing/,
  );

  // childEnvironment refuses on exactly the blockers observe mode reports.
  const refused = (env, descriptor = DESCRIPTOR) => {
    try {
      childEnvironment({ env, descriptor, controlToken: 'x' });
      return null;
    } catch (error) {
      return error.message;
    }
  };
  assert.match(refused(launchEnv({ MUTATION_D1_API_TOKEN: '' })), /apply refused: mutation_d1_token_missing/);
  assert.match(
    refused(launchEnv({ MUTATION_D1_API_TOKEN: 'launch-token-with-script-edit-0001' })),
    /mutation_d1_token_not_separated/,
  );
  assert.match(refused(launchEnv({ CLOUDFLARE_ACCOUNT_ID: 'other' })), /launch_account_mismatch/);
  assert.match(
    refused(launchEnv(), { ...DESCRIPTOR, secrets: { required: ['CLOUDFLARE_API_TOKEN', 'MUTATION_CONTROL_TOKEN'] } }),
    /mutation_descriptor_secrets_invalid/,
  );
  for (const env of [launchEnv({ MUTATION_D1_API_TOKEN: '' }), launchEnv({ CLOUDFLARE_ACCOUNT_ID: 'other' })]) {
    assert.deepEqual(
      launchConfigurationBlockers(env, DESCRIPTOR).map((item) => item.id),
      [...refused(env).matchAll(/(?:refused: |; )([a-z0-9_]+) \(/g)].map((match) => match[1]),
    );
  }
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
  const args = calls.spawn.args;
  assert.deepEqual(args.slice(0, 9), [
    'wrangler', 'dev', '--config', 'wrangler.mutation-production-intake.jsonc', '--remote',
    '--ip', '127.0.0.1', '--port', '18789',
  ]);
  // An empty --env-file stops wrangler loading .env or .dev.vars at all.
  assert.equal(args[9], '--env-file');
  assert.match(args[10], /xqueue-mutation-env-[^/]+\/empty\.env$/);
  assert.deepEqual(args.slice(11), ['--inspector-ip', '127.0.0.1']);
  assert.equal(calls.spawn.options.detached, true, 'child leads its own process group');
  assert.deepEqual(calls.groupSignals, ['SIGTERM', 'SIGKILL'], 'group terminated, then killed');
  const token = calls.spawn.options.env.MUTATION_CONTROL_TOKEN;
  assert.match(token, /^[0-9a-f]{64}$/);
  assert.equal(
    calls.spawn.options.env.OWNER_APPROVAL_PUBLIC_KEY_PEM,
    DESCRIPTOR.vars.OWNER_APPROVAL_PUBLIC_KEY_PEM,
  );
  assert.equal(requests[0].url, 'http://127.0.0.1:18789/health');
  assert.equal(requests[0].init.headers.authorization, undefined);
  assert.equal(requests[1].url, 'http://127.0.0.1:18789/production-intake');
  assert.equal(requests[1].init.headers.authorization, 'Bearer ' + token);
  assert.ok(requests[1].init.signal, 'intake request has a timeout signal');
  assert.deepEqual(JSON.parse(requests[1].init.body).expectedPublicationAuthority, { ...AUTHORITY });
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
    return jsonResponse(healthBody({ ...EXPECTED, secretsBound: BOUND, ownerApprovalKeyFingerprint: 'sha256:' + 'f'.repeat(64) }));
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
      : jsonResponse({ service: MUTATION_WORKER_SERVICE, status: 'blocked', requiresReadback, faultClass: 'X' }, 409));
    await assert.rejects(launch({ spawnImpl, fetchImpl }), (error) => {
      assert.equal(error.httpStatus, 409);
      assert.equal(error.response.requiresReadback, requiresReadback);
      return true;
    });
  }
});

test('a JSON error that did not come from the Worker requires readback', async () => {
  const { spawnImpl } = fakeChild();
  const fetchImpl = async (url) => (url.endsWith('/health')
    ? jsonResponse(healthBody())
    : jsonResponse({ error: 'upstream connect error' }, 502));
  await assert.rejects(launch({ spawnImpl, fetchImpl }), (error) => {
    assert.equal(error.response?.requiresReadback, true);
    assert.equal(error.response?.faultClass, 'POST_DISPATCH_TRANSPORT_AMBIGUOUS');
    return true;
  });
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
    if (key === 'git rev-parse HEAD' || key === 'git rev-parse FETCH_HEAD') return 'a'.repeat(40) + '\n';
    if (key === 'pnpm cf:auth:preflight --environment production') {
      return JSON.stringify({ ok: true, environment: 'production', token_type: 'account', token_status: 'active', d1: { readable: true } });
    }
    if (key.includes('SELECT name FROM d1_migrations')) {
      return JSON.stringify([{ results: [{ name: '0014_authority_event_projection.sql' }] }]);
    }
    throw new Error('unexpected command: ' + key);
  };
  const preflight = collectOperatorPreflight(run, () => { throw new Error('publisher check must not run'); }, {
    d1Token: { ok: true, blockers: [] },
  });
  assert.equal(preflight.readiness.ok, false);
  assert.deepEqual(preflight.readiness.blockers.map((item) => item.id), ['production_mutation_schema_not_active']);
  assert.equal(preflight.safety, null);
  assert.equal(commands.some((key) => key.includes('mutation_lane_state')), false);

  // cf:auth:preflight exits non-zero on failure, and a migrations read can fail:
  // both become structured blockers instead of a raw exception.
  const failing = (command, argv) => {
    const key = [command, ...argv].join(' ');
    if (key === 'pnpm cf:auth:preflight --environment production') {
      throw new Error('pnpm cf:auth:preflight --environment production failed with exit 1');
    }
    if (key.includes('SELECT name FROM d1_migrations')) throw new Error('wrangler d1 execute failed with exit 1');
    return run(command, argv);
  };
  const failed = collectOperatorPreflight(failing, () => { throw new Error('publisher check must not run'); }, {
    d1Token: { ok: true, blockers: [] },
  });
  const ids = failed.readiness.blockers.map((item) => item.id);
  assert.ok(ids.includes('cloudflare_auth_not_verified'), ids.join(','));
  assert.ok(ids.includes('production_migrations_unreadable'), ids.join(','));
  assert.equal(ids.includes('production_mutation_schema_not_active'), false);
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

test('a checkout that changes after preflight never receives the intake request', async () => {
  const { spawnImpl, calls } = fakeChild();
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(url);
    return jsonResponse(healthBody());
  };
  await assert.rejects(
    launch({ spawnImpl, fetchImpl, verifyTree: () => { throw new Error('the checkout changed after preflight; refusing'); } }),
    /checkout changed after preflight/,
  );
  assert.deepEqual(urls, ['http://127.0.0.1:18789/health']);
  assert.equal(calls.killed, true);

  const candidate = { branch: 'main', headSha: 'a'.repeat(40) };
  const git = (state) => (command, argv) => {
    const key = [command, ...argv].join(' ');
    if (key === 'git branch --show-current') return state.branch + '\n';
    if (key === 'git status --porcelain --untracked-files=all') return state.dirty;
    if (key === 'git rev-parse HEAD') return state.head + '\n';
    throw new Error('unexpected ' + key);
  };
  assert.equal(verifyTreeUnchanged(candidate, git({ branch: 'main', dirty: '', head: 'a'.repeat(40) })), true);
  for (const state of [
    { branch: 'feature', dirty: '', head: 'a'.repeat(40) },
    { branch: 'main', dirty: ' M src/x.mjs', head: 'a'.repeat(40) },
    { branch: 'main', dirty: '', head: 'b'.repeat(40) },
  ]) {
    assert.throws(() => verifyTreeUnchanged(candidate, git(state)), /checkout changed after preflight/);
  }
});

test('a lane held by the planned operation is resumable; any other holder is contention', () => {
  const base = {
    auth: { ok: true, environment: 'production', token_type: 'account', token_status: 'active', d1: { readable: true } },
    candidate: { branch: 'main', clean: true, headSha: 'a'.repeat(40), originMainSha: 'a'.repeat(40) },
    migrations: [...REQUIRED_MUTATION_MIGRATIONS],
    publisherMutex: { ok: true, reason: 'publisher_mutex_compatible' },
    safety: {
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
      mutationLane: { generation: 8, active_operation_id: 'mutation-intake-' + 'a1'.repeat(12) },
      runtimeState: { generation: 12, revision_digest: 'c'.repeat(64) },
    },
  };
  const ids = (plannedOperationId) =>
    evaluateOperatorReadiness({ ...base, plannedOperationId }).blockers.map((item) => item.id);
  assert.equal(ids('mutation-intake-' + 'a1'.repeat(12)).includes('mutation_lane_contended'), false);
  assert.ok(ids('mutation-intake-' + 'b2'.repeat(12)).includes('mutation_lane_contended'));
  assert.ok(ids(null).includes('mutation_lane_contended'));
});

test('readiness proves the Worker credential, not only the launch credential', async () => {
  const authOk = JSON.stringify({ ok: true, environment: 'production', d1: { readable: true } });
  const seen = [];
  const run = (command, argv, options) => {
    seen.push(options?.env?.CLOUDFLARE_API_TOKEN);
    return authOk;
  };
  const env = launchEnv();
  const probes = { probeTimeTravel: async () => true, probeWorkersAccess: async () => 'denied' };
  const ok = await collectD1TokenReadiness({ run, env, descriptor: DESCRIPTOR, ...probes });
  assert.equal(ok.ok, true);
  assert.deepEqual(seen, [env.MUTATION_D1_API_TOKEN], 'auth preflight runs with the Worker token');

  const id = async (overrides) =>
    (await collectD1TokenReadiness({ run, descriptor: DESCRIPTOR, ...probes, ...overrides }))
      .blockers.map((item) => item.id);
  // Launch configuration apply would refuse is reported in observe mode too.
  assert.deepEqual(await id({ env: launchEnv({ CLOUDFLARE_API_TOKEN: undefined }) }), ['launch_token_missing']);
  assert.deepEqual(await id({ env: launchEnv({ CLOUDFLARE_ACCOUNT_ID: 'other' }) }), ['launch_account_mismatch']);
  assert.deepEqual(
    await id({ env, descriptor: { ...DESCRIPTOR, secrets: { required: ['MUTATION_D1_API_TOKEN', 'MUTATION_CONTROL_TOKEN', 'X_ACCESS_TOKEN'] } } }),
    ['mutation_descriptor_secrets_invalid'],
  );
  // A Worker token that can reach Workers scripts is refused; an inconclusive probe also blocks.
  assert.deepEqual(await id({ env, probeWorkersAccess: async () => 'granted' }), ['mutation_d1_token_overscoped']);
  const scope = await collectD1TokenReadiness({
    run, env, descriptor: DESCRIPTOR, ...probes,
    probeWorkersAccess: async () => { throw new Error('HTTP 500 for ' + env.MUTATION_D1_API_TOKEN); },
  });
  assert.deepEqual(scope.blockers.map((item) => item.id), ['mutation_d1_token_scope_unverified']);
  assert.doesNotMatch(scope.blockers[0].detail, /d1-scoped-token/);
  assert.deepEqual(await id({ env: launchEnv({ MUTATION_D1_API_TOKEN: '' }) }), ['mutation_d1_token_missing']);
  assert.deepEqual(
    await id({ env: launchEnv({ MUTATION_D1_API_TOKEN: env.CLOUDFLARE_API_TOKEN }) }),
    ['mutation_d1_token_not_separated'],
  );
  assert.deepEqual(
    await id({ env, run: () => JSON.stringify({ ok: false }) }),
    ['mutation_d1_token_not_verified'],
  );
  const authFailed = await collectD1TokenReadiness({
    env, descriptor: DESCRIPTOR, ...probes,
    run: () => { throw new Error('auth failed for ' + env.MUTATION_D1_API_TOKEN + '\nstack'); },
  });
  assert.deepEqual(authFailed.blockers.map((item) => item.id), ['mutation_d1_token_not_verified']);
  assert.match(authFailed.blockers[0].detail, /auth failed for \[redacted\] \| stack$/);
  assert.doesNotMatch(authFailed.blockers[0].detail, /d1-scoped-token/);
  assert.deepEqual(
    await id({ env, probeTimeTravel: async () => { throw new Error('HTTP 403'); } }),
    ['mutation_d1_time_travel_unavailable'],
  );
});

test('a missing schema still reports candidate, auth and Worker-credential blockers', () => {
  const run = (command, argv) => {
    const key = [command, ...argv].join(' ');
    if (key === 'git branch --show-current') return 'feature\n';
    if (key === 'git status --porcelain --untracked-files=all') return ' M x\n';
    if (key === 'git fetch origin main') return '';
    if (key === 'git rev-parse HEAD') return 'a'.repeat(40) + '\n';
    if (key === 'git rev-parse FETCH_HEAD') return 'b'.repeat(40) + '\n';
    if (key === 'pnpm cf:auth:preflight --environment production') {
      throw new Error('pnpm cf:auth:preflight --environment production failed with exit 1');
    }
    if (key.includes('SELECT name FROM d1_migrations')) {
      return JSON.stringify([{ results: [{ name: '0014_authority_event_projection.sql' }] }]);
    }
    throw new Error('unexpected command: ' + key);
  };
  const preflight = collectOperatorPreflight(run, () => { throw new Error('publisher check must not run'); }, {
    d1Token: { ok: false, blockers: [{ id: 'mutation_d1_token_missing', detail: 'x' }] },
  });
  const ids = preflight.readiness.blockers.map((item) => item.id);
  for (const id of [
    'production_mutation_schema_not_active',
    'candidate_not_main',
    'candidate_dirty',
    'candidate_not_exact_main',
    'cloudflare_auth_not_verified',
    'mutation_d1_token_missing',
  ]) {
    assert.ok(ids.includes(id), id);
  }
  assert.equal(ids.some((id) => id.startsWith('publication_') || id === 'active_publication_lease'), false);
});

// sha256 over the publisher-worker module graph (path + content per file) at
// MUTEX_COMPATIBLE_PUBLISHER_COMMIT. If publisher code changes, this fails so
// the pin is re-evaluated in the same change; CI checkouts are shallow, so the
// tripwire uses content rather than git ancestry.
const PUBLISHER_GRAPH_DIGEST_AT_PIN = 'e54c37a1113160cedb6ab9e71cb64c3d25e3c5cd9cba08b68f97dcf0ad5200de';

function publisherGraphDigest() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const seen = new Set();
  const walk = (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    const source = readFileSync(file, 'utf8');
    const pattern = /(?:import|export)[^"']*?from\s*["'](\.[^"']+)["']|import\(\s*["'](\.[^"']+)["']\s*\)/g;
    for (const match of source.matchAll(pattern)) walk(path.resolve(path.dirname(file), match[1] || match[2]));
  };
  walk(path.join(root, 'cloudflare/src/publisher-worker.mjs'));
  const hash = createHash('sha256');
  for (const file of [...seen].map((item) => path.relative(root, item)).sort()) {
    hash.update(file + '\0');
    hash.update(readFileSync(path.join(root, file)));
    hash.update('\0');
  }
  return hash.digest('hex');
}

test('publisher code is unchanged since the mutex pin, or the pin must be re-evaluated', () => {
  assert.equal(MUTEX_COMPATIBLE_PUBLISHER_COMMIT, '518554553c0a6654447a63a4871ce330ed100ad7');
  assert.equal(
    publisherGraphDigest(),
    PUBLISHER_GRAPH_DIGEST_AT_PIN,
    'publisher code changed after MUTEX_COMPATIBLE_PUBLISHER_COMMIT: re-evaluate the pin and record the new digest',
  );
});

test('a signal tears the ephemeral Worker down before the CLI exits', async () => {
  const { spawnImpl, calls } = fakeChild();
  const processImpl = fakeProcess();
  let envDirSeen = null;
  const fetchImpl = async () => {
    envDirSeen = path.dirname(calls.spawn.args[10]);
    processImpl.signals.emit('SIGTERM', 'SIGTERM');
    throw new TypeError('aborted by signal');
  };
  await assert.rejects(launch({ spawnImpl, fetchImpl, processImpl, healthDeadlineMs: 300 }));
  const pid = calls.spawn.child.pid;
  // On a signal there is no time to wait: the whole group is killed at once,
  // then the signal is re-raised for this process.
  assert.deepEqual(processImpl.record.slice(0, 2), [[-pid, 'SIGKILL'], [4242, 'SIGTERM']]);
  assert.equal(calls.killed, true, 'wrangler group was killed');
  assert.equal(existsSync(envDirSeen), false, 'temp env dir removed');
  for (const name of ['SIGINT', 'SIGTERM', 'SIGHUP']) assert.equal(processImpl.signals.listenerCount(name), 0, name);
});

test('a synchronous spawn failure still removes the temporary env dir and handlers', async () => {
  const processImpl = fakeProcess();
  const signals = processImpl.signals;
  let envFile = null;
  const spawnImpl = (command, args) => {
    envFile = args[10];
    throw new TypeError('ERR_INVALID_ARG_VALUE');
  };
  await assert.rejects(launch({ spawnImpl, processImpl }), /ERR_INVALID_ARG_VALUE/);
  assert.equal(existsSync(path.dirname(envFile)), false);
  for (const name of ['SIGINT', 'SIGTERM', 'SIGHUP']) assert.equal(signals.listenerCount(name), 0, name);
});

test('stderr is redacted before the tail is cut, so no secret leaks in part', async () => {
  const exited = fakeChild({
    exitImmediately: true,
    // Place the control token so the 4096-char tail cut lands inside it.
    stderrText: (env) => 'x'.repeat(5000) + env.MUTATION_CONTROL_TOKEN + 'y'.repeat(4096 - 20),
  });
  const neverHealthy = async () => { throw new TypeError('ECONNREFUSED'); };
  await assert.rejects(launch({ spawnImpl: exited.spawnImpl, fetchImpl: neverHealthy }), (error) => {
    const token = exited.calls.spawn.options.env.MUTATION_CONTROL_TOKEN;
    for (let length = 12; length <= token.length; length += 4) {
      assert.equal(error.message.includes(token.slice(-length)), false, 'token suffix of length ' + length);
    }
    return true;
  });
});

test('a failed safety read is a structured blocker, not a raw exception', () => {
  const run = (command, argv) => {
    const key = [command, ...argv].join(' ');
    if (key === 'git branch --show-current') return 'main\n';
    if (key === 'git status --porcelain --untracked-files=all') return '';
    if (key === 'git fetch origin main') return '';
    if (key === 'git rev-parse HEAD' || key === 'git rev-parse FETCH_HEAD') return 'a'.repeat(40) + '\n';
    if (key === 'pnpm cf:auth:preflight --environment production') {
      return JSON.stringify({ ok: true, environment: 'production', token_type: 'account', token_status: 'active', d1: { readable: true } });
    }
    if (key.includes('SELECT name FROM d1_migrations')) {
      return JSON.stringify([
        { results: REQUIRED_MUTATION_MIGRATIONS.map((name) => ({ name })) },
        { results: REQUIRED_MUTATION_TRIGGERS.map((name) => ({ name })) },
      ]);
    }
    if (key.includes('SELECT owner,generation,transition_state')) throw new Error('wrangler rate limited');
    throw new Error('unexpected command: ' + key);
  };
  const preflight = collectOperatorPreflight(run, () => { throw new Error('publisher check must not run'); }, {
    d1Token: { ok: false, blockers: [{ id: 'mutation_d1_token_missing', detail: 'x' }] },
  });
  const ids = preflight.readiness.blockers.map((item) => item.id);
  assert.deepEqual(ids, ['publication_safety_unreadable', 'mutation_d1_token_missing']);
});

test('payload fields can never replace the verified request fields', async () => {
  const { spawnImpl } = fakeChild();
  let sent = null;
  const fetchImpl = async (url, init) => {
    if (url.endsWith('/health')) return jsonResponse(healthBody());
    sent = JSON.parse(init.body);
    return jsonResponse({ ok: true });
  };
  await launch({
    spawnImpl,
    fetchImpl,
    payload: {
      mode: 'single',
      environment: 'preview',
      candidate: { branch: 'evil' },
      expectedPublicationAuthority: { generation: 1, candidate_sha: 'f'.repeat(40), deployment_id: 'evil' },
      input: { body: 'b' },
    },
  });
  assert.equal(sent.environment, 'production');
  assert.equal(sent.candidate.branch, 'main');
  assert.deepEqual(sent.expectedPublicationAuthority, { ...AUTHORITY });
  assert.equal(sent.mode, 'single');
});

test('a Worker with any binding beyond its descriptor is refused', () => {
  for (const extra of [['X_API_KEY'], ['CLOUDFLARE_API_TOKEN'], []]) {
    const names = extra.length
      ? [...EXPECTED.bindingNames, ...extra].sort()
      : EXPECTED.bindingNames.filter((name) => name !== 'DB');
    assert.throws(
      () => assertHealthIdentity(healthBody({ ...EXPECTED, secretsBound: BOUND, bindingNames: names }), EXPECTED),
      /has bindings .* expected exactly/,
      JSON.stringify(extra),
    );
  }
  assert.deepEqual(
    [...EXPECTED.bindingNames],
    ['CLOUDFLARE_ACCOUNT_ID', 'DB', 'MUTATION_CONTROL_TOKEN', 'MUTATION_D1_API_TOKEN', 'OWNER_APPROVAL_PUBLIC_KEY_PEM', 'XQUEUE_PRODUCTION_DATABASE_ID'],
  );
});

test('a mutation schema missing any required trigger is incomplete, not active', () => {
  // 0017 gained its authority guards after it was first written; names alone are not proof.
  for (const name of ['authority_event_mutation_lane_guard', 'authority_state_mutation_lane_guard',
    'publication_lease_mutation_lane_insert_guard', 'mutation_lane_claim_guard']) {
    assert.ok(REQUIRED_MUTATION_TRIGGERS.includes(name), name);
  }
  const run = (triggers) => (command, argv) => {
    const key = [command, ...argv].join(' ');
    if (key === 'git branch --show-current') return 'main\n';
    if (key === 'git status --porcelain --untracked-files=all') return '';
    if (key === 'git fetch origin main') return '';
    if (key === 'git rev-parse HEAD' || key === 'git rev-parse FETCH_HEAD') return 'a'.repeat(40) + '\n';
    if (key === 'pnpm cf:auth:preflight --environment production') {
      throw new Error('pnpm cf:auth:preflight --environment production failed with exit 1\nCloudflare account API token verification failed (1000)');
    }
    if (key.includes('SELECT name FROM d1_migrations')) {
      return JSON.stringify([
        { results: REQUIRED_MUTATION_MIGRATIONS.map((name) => ({ name })) },
        { results: triggers.map((name) => ({ name })) },
      ]);
    }
    throw new Error('unexpected command: ' + key);
  };
  const missing = REQUIRED_MUTATION_TRIGGERS.filter((name) => name !== 'authority_state_mutation_lane_guard');
  const preflight = collectOperatorPreflight(run(missing), () => { throw new Error('publisher check must not run'); }, {
    d1Token: { ok: true, blockers: [] },
  });
  const byId = Object.fromEntries(preflight.readiness.blockers.map((item) => [item.id, item.detail]));
  assert.match(byId.production_mutation_schema_incomplete, /authority_state_mutation_lane_guard/);
  // The launch credential failure keeps its cause.
  assert.match(byId.cloudflare_auth_not_verified, /Cause: .*verification failed \(1000\)/);
});

test('the process group is torn down even when pnpm has already exited', async () => {
  const exited = fakeChild({ exitImmediately: true });
  await assert.rejects(launch({
    spawnImpl: exited.spawnImpl,
    fetchImpl: async () => { throw new TypeError('ECONNREFUSED'); },
  }));
  assert.deepEqual(exited.calls.groupSignals, ['SIGTERM', 'SIGKILL']);
});
