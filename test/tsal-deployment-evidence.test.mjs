import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildDeploymentEvidence,
  evaluateDeploymentAuthority,
  observeDeploymentAuthority,
} from '../scripts/tsal-deployment-evidence.mjs';

function schedules(crons = ['*/15 * * * *']) {
  return crons.map((cron) => ({ cron }));
}

function deployments() {
  return [
    {
      id: '11111111-1111-1111-1111-111111111111',
      created_on: '2026-09-06T02:00:00.000Z',
      source: 'api',
      annotations: { 'workers/triggered_by': 'upload' },
      versions: [
        {
          version_id: '22222222-2222-2222-2222-222222222222',
          percentage: 100,
        },
      ],
    },
  ];
}

function health(overrides = {}) {
  return {
    service: 'xqueue',
    role: 'status-only',
    publicationCapable: false,
    status: 'ok',
    livePublication: false,
    schedulerAuthority: false,
    publisherAuthority: {
      ok: true, owner: 'cloudflare', transitionState: 'stable',
      candidateSha: 'a'.repeat(40),
      deploymentId: 'cloudflare-worker:xqueue-publisher-production:version:22222222-2222-2222-2222-222222222222',
    },
    publicationHalt: { ok: true, halted: false },
    schedulerLiveness: { required: true, ok: true, state: 'fresh' },
    authorityReadiness: {
      ok: true,
      authorityFlag: false,
      authorized: false,
    },
    ...overrides,
  };
}

function observation(overrides = {}) {
  return {
    schedules: schedules(),
    deployments: deployments(),
    statusSchedules: [],
    version: {
      id: '22222222-2222-2222-2222-222222222222',
      tag: 'a'.repeat(40), authority_enabled: true, version_metadata: true,
      production_database: true,
    },
    health: health(),
    observationErrors: [],
    cloudflare: {
      account_id_present: true,
      api_token_present: true,
      worker_name: 'xqueue-publisher-production',
      schedules_http_status: 200,
      deployments_http_status: 200,
    },
    ...overrides,
  };
}

test('exact authoritative deployment state passes', () => {
  const result = evaluateDeploymentAuthority(observation());

  assert.equal(result.observable, true);
  assert.equal(result.authorized, true);
  assert.deepEqual(result.failing, []);
});

test('extra or wrong cron is an explicit deployment mismatch', () => {
  const result = evaluateDeploymentAuthority(observation({
    schedules: schedules(['*/15 * * * *', '0 * * * *']),
  }));

  assert.equal(result.observable, true);
  assert.equal(result.authorized, false);
  assert.deepEqual(result.failing, ['exact_cron']);
});

test('missing active deployment is an explicit deployment mismatch', () => {
  const result = evaluateDeploymentAuthority(observation({ deployments: [] }));

  assert.equal(result.observable, true);
  assert.equal(result.authorized, false);
  assert.ok(result.failing.includes('active_deployment_present'));
});

test('runtime authority must corroborate Cloudflare control-plane authority', () => {
  const result = evaluateDeploymentAuthority(observation({
    health: health({
      publisherAuthority: { ...health().publisherAuthority, ok: false },
    }),
  }));

  assert.equal(result.authorized, false);
  assert.deepEqual(result.failing, [
    'durable_authority',
  ]);
});

test('split topology rejects duplicate scheduling, split traffic, wrong version/tag/database, halt, and stale heartbeat', () => {
  const base = observation();
  for (const overrides of [
    { statusSchedules: schedules() },
    { deployments: [{ ...deployments()[0], versions: [
      { version_id: base.version.id, percentage: 50 },
      { version_id: '33333333-3333-3333-3333-333333333333', percentage: 50 },
    ] }] },
    { version: { ...base.version, id: '33333333-3333-3333-3333-333333333333' } },
    { version: { ...base.version, tag: 'b'.repeat(40) } },
    { version: { ...base.version, tag: null } },
    { version: { ...base.version, authority_enabled: false } },
    { version: { ...base.version, version_metadata: false } },
    { version: { ...base.version, production_database: false } },
    { health: health({ publicationHalt: { ok: true, halted: true } }) },
    { health: health({ schedulerLiveness: { required: false, ok: true, state: 'not_required' } }) },
    { health: health({ role: undefined }) },
  ]) {
    assert.equal(evaluateDeploymentAuthority(observation(overrides)).authorized, false);
  }
});

test('missing Cloudflare read credentials stays unknown', async () => {
  const observed = await observeDeploymentAuthority({
    accountId: '',
    token: '',
    fetchImpl: async () => {
      throw new Error('fetch must not be called without credentials');
    },
  });
  const evidence = buildDeploymentEvidence({
    observation: observed,
    producedAt: '2026-09-06T03:00:00.000Z',
    runId: '100',
  });

  assert.equal(evidence.result, 'unknown');
  assert.deepEqual(evidence.details.observation_errors, [
    'cloudflare_read_credentials_unavailable',
  ]);
});

test('Cloudflare authorization failure stays unknown rather than fabricating a mismatch', async () => {
  const fetchImpl = async (url) => {
    if (String(url).includes('workers.dev/health')) {
      return new Response(JSON.stringify(health()), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }

    return new Response(JSON.stringify({
      success: false,
      errors: [{ code: 9109, message: 'Unauthorized' }],
    }), {
      status: 403,
      headers: { 'content-type': 'application/json' },
    });
  };

  const observed = await observeDeploymentAuthority({
    accountId: 'account-1',
    token: 'not-authorized',
    fetchImpl,
  });
  const evidence = buildDeploymentEvidence({
    observation: observed,
    producedAt: '2026-09-06T03:00:00.000Z',
  });

  assert.equal(evidence.result, 'unknown');
  assert.equal(evidence.details.evaluation.observable, false);
  assert.equal(evidence.details.observation_errors.length, 3);
});

test('successful Cloudflare reads produce passing deployment evidence without leaking token', async () => {
  const secretToken = 'super-secret-token-value';
  const fetchImpl = async (url, init = {}) => {
    assert.equal(init.method, 'GET');

    if (String(url).endsWith('/schedules')) {
      assert.equal(init.headers.authorization, `Bearer ${secretToken}`);
      const status = String(url).includes('/scripts/xqueue-production/');
      if (!status) assert.ok(String(url).includes('/scripts/xqueue-publisher-production/'));
      return new Response(JSON.stringify({
        success: true,
        result: { schedules: status ? [] : schedules() },
      }), { status: 200 });
    }

    if (String(url).endsWith('/deployments')) {
      assert.equal(init.headers.authorization, `Bearer ${secretToken}`);
      assert.ok(String(url).includes('/scripts/xqueue-publisher-production/'));
      return new Response(JSON.stringify({
        success: true,
        result: { deployments: deployments() },
      }), { status: 200 });
    }

    if (String(url).includes('/versions/')) {
      assert.ok(String(url).endsWith('/xqueue-publisher-production/versions/22222222-2222-2222-2222-222222222222'));
      return new Response(JSON.stringify({ success: true, result: {
        id: '22222222-2222-2222-2222-222222222222',
        annotations: { 'workers/tag': 'a'.repeat(40) },
        resources: { bindings: [
          { name: 'XQUEUE_PUBLISH_AUTHORITY', type: 'plain_text', text: 'enabled' },
          { name: 'CF_VERSION_METADATA', type: 'version_metadata' },
          { name: 'DB', type: 'd1', id: 'fc85026e-bfc8-435f-8bb0-c60e139178a3' },
          { name: 'X_API_KEY', type: 'secret_text', text: secretToken },
        ] },
      } }), { status: 200 });
    }

    if (String(url).includes('workers.dev/health')) {
      assert.equal(init.headers.authorization, undefined);
      return new Response(JSON.stringify(health()), { status: 200 });
    }

    throw new Error(`unexpected URL ${url}`);
  };

  const observed = await observeDeploymentAuthority({
    accountId: 'account-1',
    token: secretToken,
    fetchImpl,
  });
  const evidence = buildDeploymentEvidence({
    observation: observed,
    producedAt: '2026-09-06T03:00:00.000Z',
    validForMinutes: 90,
    runId: '200',
    actor: 'peteywee',
    observerCommit: 'abc123',
  });

  assert.equal(evidence.result, 'pass');
  assert.equal(evidence.evidence_class, 'deployment');
  assert.equal(evidence.claim_id, 'xqueue-publisher.deployment.authority');
  assert.equal(evidence.valid_until, '2026-09-06T04:30:00.000Z');
  assert.equal(JSON.stringify(evidence).includes(secretToken), false);
  assert.equal(evidence.details.runtime_authority.authorized, false);
  assert.equal(evidence.details.durable_authority.owner, 'cloudflare');
  assert.equal(evidence.details.publisher_version.authority_enabled, true);
});
