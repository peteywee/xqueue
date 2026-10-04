import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ownerPublicKeyFingerprint } from '../src/authoring/owner-approval.mjs';
import {
  authorizeProductionIntakeInput,
  createMutationProductionIntakeWorker,
  identityProof,
} from '../cloudflare/src/mutation-production-intake-worker.mjs';
import {
  MUTATION_WORKER_SERVICE,
  REQUIRED_MUTATION_MIGRATIONS,
  REQUIRED_MUTATION_TRIGGERS,
  REQUIRED_MUTATION_TRIGGER_SQL,
  MUTEX_COMPATIBLE_PUBLISHER_COMMIT,
  MUTATION_OWNED_TABLES,
  assertHealthIdentity,
  childEnvironment,
  collectD1TokenReadiness,
  launchConfigurationBlockers,
  collectExactMainCandidate,
  collectOperatorPreflight,
  committedTriggerDefinitions,
  mutationTriggerDrift,
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

function roleBody() {
  const { bindings: _bindings, ...role } = healthBody();
  return role;
}

// A fake ephemeral Worker: minimal /health, and an /identity answer proven
// with the control token the CLI handed the spawned child.
function serveWorker(calls, {
  intake = async () => jsonResponse({ ok: true, planned: { operationId: 'mutation-intake-x' } }),
  bindings = { ...EXPECTED, secretsBound: BOUND },
  identity = null,
  requests = null,
} = {}) {
  return async (url, init = {}) => {
    requests?.push({ url, init });
    if (url.endsWith('/health')) return jsonResponse(roleBody());
    if (url.includes('/identity?')) {
      if (identity) return identity(url, init);
      const challenge = new URL(url).searchParams.get('challenge');
      const token = calls.spawn.options.env.MUTATION_CONTROL_TOKEN;
      return jsonResponse(healthBody(bindings, {
        challenge,
        challengeResponse: await identityProof(token, challenge, bindings),
      }));
    }
    return intake(url, init);
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
    on: (name, fn) => signals.on(name, fn),
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
    identityRetryDelayMs: 10,
    ...overrides,
  });
}

test('the Worker reports its bound trust root only with a proof of the control token', async () => {
  const worker = createMutationProductionIntakeWorker({});
  const token = 'control-token-'.padEnd(64, '0');
  const env = { ...DESCRIPTOR.vars, DB: {}, MUTATION_CONTROL_TOKEN: token };
  const challenge = 'ab'.repeat(32);
  const identify = async (bound, query = '?challenge=' + challenge, init = {}) =>
    worker.fetch(new Request('https://example.test/identity' + query, init), bound);

  // /health is readiness only and never reports bindings.
  const health = await (await worker.fetch(new Request('https://example.test/health'), env)).json();
  assert.deepEqual(health, { ...roleBody() });

  const body = await (await identify(env)).json();
  assert.equal(body.challenge, challenge);
  assert.deepEqual(body.bindings, {
    accountId: ACCOUNT,
    productionDatabaseId: DESCRIPTOR.vars.XQUEUE_PRODUCTION_DATABASE_ID,
    ownerApprovalKeyFingerprint: ownerPublicKeyFingerprint(DESCRIPTOR.vars.OWNER_APPROVAL_PUBLIC_KEY_PEM),
    bindingNames: [...Object.keys(DESCRIPTOR.vars), 'DB', 'MUTATION_CONTROL_TOKEN'].sort(),
    secretsBound: { MUTATION_D1_API_TOKEN: false, MUTATION_CONTROL_TOKEN: true },
  });
  assert.equal(body.challengeResponse, await identityProof(token, challenge, body.bindings));
  assert.notEqual(body.challengeResponse, await identityProof('other-token'.padEnd(64, '0'), challenge, body.bindings));
  assert.doesNotMatch(JSON.stringify(body), /control-token-/);

  const full = await (await identify({ ...env, MUTATION_D1_API_TOKEN: 'secret-value-1' })).json();
  const { secretsBound, ...trustRoot } = full.bindings;
  assert.deepEqual(secretsBound, BOUND);
  assert.deepEqual(trustRoot, { ...EXPECTED });
  assert.doesNotMatch(JSON.stringify(full), /secret-value/);

  const overridden = await (await identify({ ...env, XQUEUE_PRODUCTION_DATABASE_ID: 'other-db' })).json();
  assert.equal(overridden.bindings.productionDatabaseId, 'other-db');

  // A malformed challenge, a missing control token, or a non-GET is a refusal
  // that names the Worker.
  for (const [response, status, faultClass] of [
    [await identify(env, '?challenge=xyz'), 400, 'INVALID_CHALLENGE'],
    [await identify(env, ''), 400, 'INVALID_CHALLENGE'],
    [await identify({ ...env, MUTATION_CONTROL_TOKEN: undefined }), 503, 'CONTROL_TOKEN_UNAVAILABLE'],
    [await identify(env, '?challenge=' + challenge, { method: 'POST' }), 405, 'METHOD_NOT_ALLOWED'],
  ]) {
    assert.equal(response.status, status, faultClass);
    const refused = await response.json();
    assert.equal(refused.faultClass, faultClass);
    assert.equal(refused.service, MUTATION_WORKER_SERVICE);
    assert.equal(refused.requiresReadback, false);
    assert.equal(refused.challengeResponse, undefined);
  }
});

test('Worker refusals name the Worker so the CLI can treat them as definitive', async () => {
  const worker = createMutationProductionIntakeWorker({});
  const env = { ...DESCRIPTOR.vars, DB: {}, MUTATION_CONTROL_TOKEN: 'control-token-'.padEnd(64, '0') };
  for (const [request, status, faultClass] of [
    [new Request('https://example.test/production-intake', { method: 'POST', body: '{}' }), 401, 'UNAUTHORIZED'],
    [new Request('https://example.test/production-intake', {
      method: 'POST', body: '{}', headers: { authorization: 'Bearer wrong-token' },
    }), 401, 'UNAUTHORIZED'],
    [new Request('https://example.test/production-intake'), 405, 'METHOD_NOT_ALLOWED'],
    [new Request('https://example.test/elsewhere'), 404, 'NOT_FOUND'],
  ]) {
    const response = await worker.fetch(request, env);
    assert.equal(response.status, status, faultClass);
    const body = await response.json();
    assert.equal(body.service, MUTATION_WORKER_SERVICE, faultClass);
    assert.equal(body.faultClass, faultClass);
    assert.equal(body.requiresReadback, false);
    assert.equal(body.retryable, false);
  }
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

test('a successful launch sends the generated bearer only after a proven identity', async () => {
  const { spawnImpl, calls } = fakeChild();
  const requests = [];
  const fetchImpl = serveWorker(calls, { requests });
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
  // The identity challenge is fresh and carries no credential.
  assert.match(requests[1].url, /^http:\/\/127\.0\.0\.1:18789\/identity\?challenge=[0-9a-f]{64}$/);
  assert.equal(requests[1].init.headers.authorization, undefined);
  assert.equal(requests[1].url.includes(token), false);
  assert.equal(requests[2].url, 'http://127.0.0.1:18789/production-intake');
  assert.equal(requests[2].init.headers.authorization, 'Bearer ' + token);
  assert.ok(requests[2].init.signal, 'intake request has a timeout signal');
  assert.deepEqual(JSON.parse(requests[2].init.body).expectedPublicationAuthority, { ...AUTHORITY });
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
  const requests = [];
  const fetchImpl = serveWorker(calls, {
    requests,
    bindings: { ...EXPECTED, secretsBound: BOUND, ownerApprovalKeyFingerprint: 'sha256:' + 'f'.repeat(64) },
  });
  await assert.rejects(launch({ spawnImpl, fetchImpl }), /bound ownerApprovalKeyFingerprint that does not match/);
  assert.deepEqual(requests.map((item) => new URL(item.url).pathname), ['/health', '/identity']);
  assert.equal(calls.killed, true);
});

test('a listener that cannot prove this launch\'s control token never receives the bearer', async () => {
  const goodBindings = { ...EXPECTED, secretsBound: BOUND };
  const cases = [
    ['wrong token', async (url) => {
      const challenge = new URL(url).searchParams.get('challenge');
      return jsonResponse(healthBody(goodBindings, {
        challenge,
        challengeResponse: await identityProof('stale-launch-token'.padEnd(64, '0'), challenge, goodBindings),
      }));
    }, /does not hold this launch's control token/],
    ['replayed challenge', async () => jsonResponse(healthBody(goodBindings, {
      challenge: 'cd'.repeat(32),
      challengeResponse: 'ef'.repeat(32),
    })), /did not answer the identity challenge/],
    ['no proof', async (url) => jsonResponse(healthBody(goodBindings, {
      challenge: new URL(url).searchParams.get('challenge'),
    })), /did not answer the identity challenge/],
    ['identity refused', async () => jsonResponse({ service: MUTATION_WORKER_SERVICE, faultClass: 'CONTROL_TOKEN_UNAVAILABLE' }, 503),
      /refused the identity challenge: CONTROL_TOKEN_UNAVAILABLE \(wrangler did not bind MUTATION_CONTROL_TOKEN\)/],
    ['identity unreachable', async () => { throw new TypeError('fetch failed'); }, /did not answer the identity challenge/],
  ];
  for (const [name, identity, pattern] of cases) {
    const { spawnImpl, calls } = fakeChild();
    const requests = [];
    await assert.rejects(launch({ spawnImpl, fetchImpl: serveWorker(calls, { requests, identity }) }), pattern, name);
    assert.equal(requests.some((item) => item.url.endsWith('/production-intake')), false, name);
    assert.equal(calls.killed, true, name);
  }

  // The proof covers the reported bindings: a valid proof over the committed
  // bindings does not vouch for different ones.
  const { spawnImpl, calls } = fakeChild();
  const swapped = async (url) => {
    const challenge = new URL(url).searchParams.get('challenge');
    const token = calls.spawn.options.env.MUTATION_CONTROL_TOKEN;
    return jsonResponse(healthBody({ ...goodBindings, productionDatabaseId: 'other-db' }, {
      challenge,
      challengeResponse: await identityProof(token, challenge, goodBindings),
    }));
  };
  await assert.rejects(
    launch({ spawnImpl, fetchImpl: serveWorker(calls, { identity: swapped }) }),
    /does not hold this launch's control token/,
  );
});

test('any failure after dispatch requires readback instead of looking like an ordinary failure', async () => {
  const cases = [
    ['connection lost', async () => { throw new TypeError('fetch failed'); }],
    ['timeout', async () => { throw new DOMException('timed out', 'TimeoutError'); }],
    ['non-JSON body', async () => ({ ok: false, status: 502, async json() { throw new SyntaxError('<html>'); } })],
  ];
  for (const [name, intake] of cases) {
    const { spawnImpl, calls } = fakeChild();
    const fetchImpl = serveWorker(calls, { intake });
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
    const { spawnImpl, calls } = fakeChild();
    const fetchImpl = serveWorker(calls, {
      intake: async () =>
        jsonResponse({ service: MUTATION_WORKER_SERVICE, status: 'blocked', requiresReadback, faultClass: 'X' }, 409),
    });
    await assert.rejects(launch({ spawnImpl, fetchImpl }), (error) => {
      assert.equal(error.httpStatus, 409);
      assert.equal(error.response.requiresReadback, requiresReadback);
      return true;
    });
  }
});

test('a JSON error that did not come from the Worker requires readback', async () => {
  const { spawnImpl, calls } = fakeChild();
  const fetchImpl = serveWorker(calls, {
    intake: async () => jsonResponse({ error: 'upstream connect error' }, 502),
  });
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
  const requests = [];
  const fetchImpl = serveWorker(calls, { requests });
  await assert.rejects(
    launch({ spawnImpl, fetchImpl, verifyTree: () => { throw new Error('the checkout changed after preflight; refusing'); } }),
    /checkout changed after preflight/,
  );
  assert.deepEqual(requests.map((item) => new URL(item.url).pathname), ['/health', '/identity']);
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
        { results: REQUIRED_MUTATION_TRIGGERS.map((name) => ({ name, sql: REQUIRED_MUTATION_TRIGGER_SQL[name] })) },
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
  assert.match(preflight.readiness.blockers[0].detail, /could not be read: wrangler rate limited$/);
});

test('payload fields can never replace the verified request fields', async () => {
  const { spawnImpl, calls } = fakeChild();
  let sent = null;
  const fetchImpl = serveWorker(calls, {
    intake: async (url, init) => {
      sent = JSON.parse(init.body);
      return jsonResponse({ ok: true });
    },
  });
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
        { results: triggers.map((name) => ({ name, sql: REQUIRED_MUTATION_TRIGGER_SQL[name] })) },
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
  assert.equal(preflight.safety, null);
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

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// D1 stores each trigger's text from CREATE TRIGGER through END, without the
// final semicolon (observed on preview D1 for all 29 mutation triggers).
function storedTriggers() {
  return REQUIRED_MUTATION_MIGRATIONS.flatMap((name) =>
    [...readFileSync(path.join(ROOT, 'cloudflare/migrations-production', name), 'utf8')
      .matchAll(/^CREATE TRIGGER\s+(\w+)[\s\S]*?^END;/gm)]
      .map((match) => ({ name: match[1], sql: match[0].slice(0, -1) })));
}

test('applied triggers must match the committed bodies, not only the names', () => {
  const stored = storedTriggers();
  const created = REQUIRED_MUTATION_MIGRATIONS.reduce((count, name) =>
    count + readFileSync(path.join(ROOT, 'cloudflare/migrations-production', name), 'utf8')
      .split('CREATE TRIGGER').length - 1, 0);
  assert.equal(REQUIRED_MUTATION_TRIGGERS.length, created, 'every CREATE TRIGGER is captured once');
  assert.equal(stored.length, created);
  for (const name of REQUIRED_MUTATION_TRIGGERS) {
    assert.match(REQUIRED_MUTATION_TRIGGER_SQL[name], new RegExp('^CREATE TRIGGER ' + name + ' .* END$'));
  }
  assert.deepEqual(committedTriggerDefinitions('CREATE TRIGGER a\nBEGIN\n  SELECT 1;\nEND;\n'), [
    ['a', 'CREATE TRIGGER a BEGIN SELECT 1; END'],
  ]);

  assert.deepEqual(mutationTriggerDrift(stored), []);
  // Whitespace-only differences are not drift.
  assert.deepEqual(mutationTriggerDrift(stored.map((row) => ({ ...row, sql: row.sql.replace(/\n/g, '\n  ') }))), []);
  // A weakened guard with the right name is drift.
  const weakened = stored.map((row) => (row.name === 'mutation_lane_claim_guard'
    ? { ...row, sql: row.sql.replace('OLD.generation + 1', 'OLD.generation + 0') }
    : row));
  assert.deepEqual(mutationTriggerDrift(weakened), ['mutation_lane_claim_guard']);
  const relabeled = stored.map((row) => (row.name === 'authority_state_mutation_lane_guard'
    ? { ...row, sql: row.sql.replace("'authority transition blocked by active mutation lane'", "'ok'") }
    : row));
  assert.deepEqual(mutationTriggerDrift(relabeled), ['authority_state_mutation_lane_guard']);
  assert.deepEqual(
    mutationTriggerDrift(stored.filter((row) => row.name !== 'mutation_lane_halt_audit')),
    ['mutation_lane_halt_audit'],
  );
  assert.deepEqual(
    mutationTriggerDrift(stored.map((row) => (row.name === 'mutation_lane_halt_audit' ? { name: row.name, sql: null } : row))),
    ['mutation_lane_halt_audit'],
  );
  assert.deepEqual(mutationTriggerDrift(null), [...REQUIRED_MUTATION_TRIGGERS]);

  // The preflight refuses a weakened trigger before reading safety facts.
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
        { results: weakened },
      ]);
    }
    throw new Error('unexpected command: ' + key);
  };
  const preflight = collectOperatorPreflight(run, () => { throw new Error('publisher check must not run'); }, {
    d1Token: { ok: true, blockers: [] },
  });
  assert.deepEqual(preflight.readiness.blockers.map((item) => item.id), ['production_mutation_schema_incomplete']);
  assert.match(preflight.readiness.blockers[0].detail, /missing, differ from, or are not in the committed migrations: mutation_lane_claim_guard$/);
});

test('an empty descriptor account never matches an empty launch account', () => {
  const noAccount = { ...DESCRIPTOR, vars: { ...DESCRIPTOR.vars, CLOUDFLARE_ACCOUNT_ID: '' } };
  for (const account of ['', undefined]) {
    const ids = launchConfigurationBlockers(launchEnv({ CLOUDFLARE_ACCOUNT_ID: account }), noAccount).map((item) => item.id);
    assert.ok(ids.includes('launch_account_mismatch'), String(account));
  }
  const { CLOUDFLARE_ACCOUNT_ID: _account, ...varsWithout } = DESCRIPTOR.vars;
  assert.ok(launchConfigurationBlockers(
    launchEnv({ CLOUDFLARE_ACCOUNT_ID: undefined }),
    { ...DESCRIPTOR, vars: varsWithout },
  ).map((item) => item.id).includes('launch_account_mismatch'));
  // A missing descriptor is a blocker list, not a crash.
  const ids = launchConfigurationBlockers(launchEnv(), null).map((item) => item.id);
  assert.ok(ids.includes('mutation_descriptor_secrets_invalid'));
  assert.ok(ids.includes('launch_account_mismatch'));
  assert.deepEqual(launchConfigurationBlockers(launchEnv(), DESCRIPTOR), []);
});

test('a failed origin fetch is a structured exact-main blocker with a redacted cause', () => {
  const seenEnv = [];
  const run = (command, argv, options) => {
    const key = [command, ...argv].join(' ');
    if (command === 'pnpm') seenEnv.push(options?.env);
    if (key === 'git branch --show-current') return 'main\n';
    if (key === 'git status --porcelain --untracked-files=all') return '';
    if (key === 'git rev-parse HEAD') return 'a'.repeat(40) + '\n';
    if (key === 'git fetch origin main') {
      throw new Error("fatal: unable to access 'https://x-access-token:ghs_SECRET123@github.com/o/r/': Could not resolve host");
    }
    if (key === 'pnpm cf:auth:preflight --environment production') {
      return JSON.stringify({ ok: true, environment: 'production', token_type: 'account', token_status: 'active', d1: { readable: true } });
    }
    if (key.includes('SELECT name FROM d1_migrations')) {
      return JSON.stringify([{ results: [{ name: '0014_authority_event_projection.sql' }] }]);
    }
    throw new Error('unexpected command: ' + key);
  };
  const candidate = collectExactMainCandidate(run);
  assert.equal(candidate.originMainSha, null);
  assert.match(candidate.originMainError, /Could not resolve host/);
  assert.doesNotMatch(candidate.originMainError, /ghs_SECRET123/);

  const env = launchEnv();
  const preflight = collectOperatorPreflight(run, () => { throw new Error('publisher check must not run'); }, {
    d1Token: { ok: true, blockers: [] },
    env,
  });
  const byId = Object.fromEntries(preflight.readiness.blockers.map((item) => [item.id, item.detail]));
  assert.match(byId.candidate_not_exact_main, /Cause: git fetch origin main failed: .*Could not resolve host/);
  assert.doesNotMatch(JSON.stringify(preflight), /ghs_SECRET123/);
  // The operator environment main received is the one every Cloudflare read uses.
  assert.ok(seenEnv.length >= 2);
  for (const used of seenEnv) assert.equal(used, env);
});

test('a signal during the graceful teardown wait still kills the group', async () => {
  const { spawnImpl, calls } = fakeChild();
  const processImpl = fakeProcess();
  const kill = processImpl.kill;
  processImpl.kill = (pid, signal) => {
    if (pid < 0 && signal === 'SIGTERM') {
      // wrangler ignores SIGTERM, and the operator interrupts during the wait.
      processImpl.record.push([pid, signal]);
      setTimeout(() => processImpl.signals.emit('SIGINT', 'SIGINT'), 20);
      return;
    }
    kill(pid, signal);
  };
  const started = Date.now();
  await assert.rejects(launch({
    spawnImpl,
    processImpl,
    fetchImpl: async () => { throw new TypeError('ECONNREFUSED'); },
    healthDeadlineMs: 100,
  }));
  const pid = calls.spawn.child.pid;
  assert.deepEqual(processImpl.record.slice(0, 3), [[-pid, 'SIGTERM'], [-pid, 'SIGKILL'], [4242, 'SIGINT']]);
  assert.ok(Date.now() - started < 4_000, 'did not sit out the graceful wait');
  for (const name of ['SIGINT', 'SIGTERM', 'SIGHUP']) assert.equal(processImpl.signals.listenerCount(name), 0, name);
});

test('an interruption after dispatch reports readback; before dispatch it does not', async () => {
  for (const [stage, expected] of [['identity', []], ['intake', ['SIGINT']]]) {
    const { spawnImpl, calls } = fakeChild();
    const processImpl = fakeProcess();
    const interrupted = [];
    const interrupt = async () => {
      processImpl.signals.emit('SIGINT', 'SIGINT');
      throw new TypeError('aborted by signal');
    };
    const fetchImpl = serveWorker(calls, stage === 'intake' ? { intake: interrupt } : { identity: interrupt });
    await assert.rejects(launch({
      spawnImpl,
      processImpl,
      fetchImpl,
      onInterruptedAfterDispatch: (signal) => interrupted.push(signal),
    }));
    assert.deepEqual(interrupted, expected, stage);
    assert.ok(processImpl.record.some(([pid, signal]) => pid === 4242 && signal === 'SIGINT'), stage);
  }

  // A failing reporter never stops the signal from being re-raised.
  const { spawnImpl, calls } = fakeChild();
  const processImpl = fakeProcess();
  await assert.rejects(launch({
    spawnImpl,
    processImpl,
    fetchImpl: serveWorker(calls, {
      intake: async () => {
        processImpl.signals.emit('SIGTERM', 'SIGTERM');
        throw new TypeError('aborted by signal');
      },
    }),
    onInterruptedAfterDispatch: () => { throw new Error('stderr closed'); },
  }));
  assert.ok(processImpl.record.some(([pid, signal]) => pid === 4242 && signal === 'SIGTERM'));
});

test('identity transport hiccups are retried with a fresh challenge; a wrong proof is final', async () => {
  const { spawnImpl, calls } = fakeChild();
  const requests = [];
  let failures = 1;
  const flaky = serveWorker(calls, { requests });
  const fetchImpl = async (url, init) => {
    if (url.includes('/identity?') && failures > 0) {
      failures -= 1;
      requests.push({ url, init });
      throw new DOMException('timed out', 'TimeoutError');
    }
    return flaky(url, init);
  };
  const result = await launch({ spawnImpl, fetchImpl });
  assert.equal(result.ok, true);
  const challenges = requests.filter((item) => item.url.includes('/identity?')).map((item) => new URL(item.url).searchParams.get('challenge'));
  assert.equal(challenges.length, 2);
  assert.notEqual(challenges[0], challenges[1], 'each attempt uses a fresh challenge');

  const wrong = fakeChild();
  let identityCalls = 0;
  const goodBindings = { ...EXPECTED, secretsBound: BOUND };
  await assert.rejects(launch({
    spawnImpl: wrong.spawnImpl,
    fetchImpl: serveWorker(wrong.calls, {
      identity: async (url) => {
        identityCalls += 1;
        const challenge = new URL(url).searchParams.get('challenge');
        return jsonResponse(healthBody(goodBindings, {
          challenge,
          challengeResponse: await identityProof('stale'.padEnd(64, '0'), challenge, goodBindings),
        }));
      },
    }),
  }), /does not hold this launch's control token/);
  assert.equal(identityCalls, 1);
});

test('identity failures keep the wrangler stderr tail', async () => {
  const child = fakeChild({ stderrText: () => 'wrangler: secret binding skipped\n' });
  await assert.rejects(launch({
    spawnImpl: child.spawnImpl,
    fetchImpl: serveWorker(child.calls, {
      identity: async () => jsonResponse({ service: MUTATION_WORKER_SERVICE, faultClass: 'CONTROL_TOKEN_UNAVAILABLE' }, 503),
    }),
  }), /CONTROL_TOKEN_UNAVAILABLE[\s\S]*wrangler stderr \(tail\):\nwrangler: secret binding skipped/);
});

test('an interruption during teardown reports the Worker answer instead of a blind readback', async () => {
  const { spawnImpl, calls } = fakeChild();
  const processImpl = fakeProcess();
  const kill = processImpl.kill;
  processImpl.kill = (pid, signal) => {
    if (pid < 0 && signal === 'SIGTERM') {
      processImpl.record.push([pid, signal]);
      setTimeout(() => processImpl.signals.emit('SIGINT', 'SIGINT'), 20);
      return;
    }
    kill(pid, signal);
  };
  const reports = [];
  const answer = { service: MUTATION_WORKER_SERVICE, status: 'ok', requiresReadback: false, planned: { operationId: 'mutation-intake-x' } };
  const result = await launch({
    spawnImpl,
    processImpl,
    fetchImpl: serveWorker(calls, { intake: async () => jsonResponse(answer) }),
    onInterruptedAfterDispatch: (signal, received) => {
      // Reported before the env dir is removed: nothing can cut it short.
      reports.push({ signal, received, envDirPresent: existsSync(path.dirname(calls.spawn.args[10])) });
      // A second signal during the report is ignored.
      processImpl.signals.emit('SIGTERM', 'SIGTERM');
    },
  });
  assert.deepEqual(result, answer);
  assert.equal(reports.length, 1);
  assert.equal(reports[0].signal, 'SIGINT');
  assert.deepEqual(reports[0].received, { httpStatus: 200, ok: true, body: answer });
  assert.equal(reports[0].envDirPresent, true);
  assert.deepEqual(processImpl.record.filter(([pid]) => pid === 4242), [[4242, 'SIGINT']]);
  for (const name of ['SIGINT', 'SIGTERM', 'SIGHUP']) assert.equal(processImpl.signals.listenerCount(name), 0, name);
});

test('only committed triggers may act on mutation-owned tables', () => {
  assert.deepEqual([...MUTATION_OWNED_TABLES], [
    'mutation_lane_events', 'mutation_lane_halt_events', 'mutation_lane_halt_state', 'mutation_lane_state',
    'mutation_operation_events', 'mutation_operation_items', 'mutation_operations',
  ]);
  const stored = storedTriggers();
  const extra = { name: 'mutation_lane_auto_release', tbl_name: 'mutation_lane_state', sql: 'CREATE TRIGGER mutation_lane_auto_release AFTER UPDATE ON mutation_lane_state BEGIN SELECT 1; END' };
  assert.deepEqual(mutationTriggerDrift([...stored, extra]), ['mutation_lane_auto_release']);
  // Shared publication tables carry triggers from their own migrations.
  const shared = { name: 'publication_leases_owner_guard', tbl_name: 'publication_leases', sql: 'CREATE TRIGGER publication_leases_owner_guard BEFORE UPDATE ON publication_leases BEGIN SELECT 1; END' };
  assert.deepEqual(mutationTriggerDrift([...stored, shared]), []);
  // sqlite_master keeps identifiers as written; SQLite resolves them case-insensitively.
  const shouting = { name: 'lane_auto_release', tbl_name: 'MUTATION_LANE_STATE', sql: 'CREATE TRIGGER lane_auto_release AFTER UPDATE ON MUTATION_LANE_STATE BEGIN SELECT 1; END' };
  assert.deepEqual(mutationTriggerDrift([...stored, shouting]), ['lane_auto_release']);
  // The table alone is enough, even if the body text were unavailable.
  assert.deepEqual(
    mutationTriggerDrift([...stored, { name: 'lane_auto_release', tbl_name: 'MUTATION_LANE_STATE', sql: null }]),
    ['lane_auto_release'],
  );
  // A trigger on a shared table that writes a mutation table is also drift.
  const writer = { name: 'lease_releases_lane', tbl_name: 'publication_leases', sql: 'CREATE TRIGGER lease_releases_lane AFTER UPDATE ON publication_leases BEGIN UPDATE "Mutation_Lane_State" SET active_operation_id = NULL; END' };
  assert.deepEqual(mutationTriggerDrift([...stored, writer]), ['lease_releases_lane']);
  // The committed 0017 guards on shared tables name the lane and are not drift.
  assert.ok(stored.some((row) => row.name === 'publication_lease_mutation_lane_insert_guard'));
});

test('a non-JSON identity answer is final, and identity retries stop once wrangler exits', async () => {
  const html = fakeChild();
  let identityCalls = 0;
  await assert.rejects(launch({
    spawnImpl: html.spawnImpl,
    fetchImpl: serveWorker(html.calls, {
      identity: async () => {
        identityCalls += 1;
        return { ok: true, status: 200, async json() { throw new SyntaxError('Unexpected token <'); } };
      },
    }),
  }), /answered the identity challenge without JSON \(HTTP 200: Unexpected token <\)/);
  assert.equal(identityCalls, 1);

  const dying = fakeChild();
  let attempts = 0;
  await assert.rejects(launch({
    spawnImpl: dying.spawnImpl,
    fetchImpl: serveWorker(dying.calls, {
      identity: async () => {
        attempts += 1;
        dying.calls.spawn.child.emit('exit', 1, null);
        throw new TypeError('fetch failed');
      },
    }),
  }), /exited before answering the identity challenge/);
  assert.equal(attempts, 1);

  // A proxy error status is retried, and the final message keeps the cause.
  const proxied = fakeChild();
  await assert.rejects(launch({
    spawnImpl: proxied.spawnImpl,
    fetchImpl: serveWorker(proxied.calls, { identity: async () => jsonResponse({ error: 'bad gateway' }, 502) }),
  }), /did not answer the identity challenge \(HTTP 502\)/);
});

test('no other production migration redefines a required trigger or adds one to a mutation table', () => {
  const dir = path.join(ROOT, 'cloudflare/migrations-production');
  const others = readdirSync(dir).filter((name) => name.endsWith('.sql') && !REQUIRED_MUTATION_MIGRATIONS.includes(name));
  assert.ok(others.length > 0);
  for (const name of others) {
    const text = readFileSync(path.join(dir, name), 'utf8');
    for (const match of text.matchAll(/\b(?:CREATE|DROP)\s+TRIGGER\s+(?:IF\s+(?:NOT\s+)?EXISTS\s+)?([A-Za-z_]\w*)/gi)) {
      assert.equal(
        REQUIRED_MUTATION_TRIGGERS.map((item) => item.toLowerCase()).includes(match[1].toLowerCase()), false,
        name + ' redefines ' + match[1] + '; add it to REQUIRED_MUTATION_MIGRATIONS so readiness compares the final body',
      );
    }
    for (const table of MUTATION_OWNED_TABLES) {
      assert.equal(
        new RegExp('\\b' + table + '\\b', 'i').test(text), false,
        name + ' touches mutation table ' + table + '; add it to REQUIRED_MUTATION_MIGRATIONS',
      );
    }
  }
});
