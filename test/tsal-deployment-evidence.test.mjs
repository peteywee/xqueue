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
    status: 'ok',
    livePublication: true,
    schedulerAuthority: true,
    authorityReadiness: {
      ok: true,
      authorityFlag: true,
      authorized: true,
    },
    ...overrides,
  };
}

function observation(overrides = {}) {
  return {
    schedules: schedules(),
    deployments: deployments(),
    health: health(),
    observationErrors: [],
    cloudflare: {
      account_id_present: true,
      api_token_present: true,
      worker_name: 'xqueue-production',
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
      livePublication: false,
      schedulerAuthority: false,
      authorityReadiness: {
        ok: true,
        authorityFlag: false,
        authorized: false,
      },
    }),
  }));

  assert.equal(result.authorized, false);
  assert.deepEqual(result.failing, [
    'runtime_authority_flag',
    'runtime_authorized',
    'scheduler_authority',
    'live_publication_authority',
  ]);
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
  assert.equal(evidence.details.observation_errors.length, 2);
});

test('successful Cloudflare reads produce passing deployment evidence without leaking token', async () => {
  const secretToken = 'super-secret-token-value';
  const fetchImpl = async (url, init = {}) => {
    assert.equal(init.method, 'GET');

    if (String(url).endsWith('/schedules')) {
      assert.equal(init.headers.authorization, `Bearer ${secretToken}`);
      return new Response(JSON.stringify({
        success: true,
        result: { schedules: schedules() },
      }), { status: 200 });
    }

    if (String(url).endsWith('/deployments')) {
      assert.equal(init.headers.authorization, `Bearer ${secretToken}`);
      return new Response(JSON.stringify({
        success: true,
        result: { deployments: deployments() },
      }), { status: 200 });
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
  assert.equal(evidence.details.runtime_authority.authorized, true);
});
