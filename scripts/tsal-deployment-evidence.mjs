import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const CLOUDFLARE_API = 'https://api.cloudflare.com/client/v4';
const WORKER_NAME = 'xqueue-production';
const EXPECTED_CRON = '*/15 * * * *';
const HEALTH_URL = 'https://xqueue-production.patrickcraven.workers.dev/health';
const CLAIM_ID = 'xqueue-publisher.deployment.authority';

function finitePositive(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function isoAfter(iso, minutes) {
  return new Date(Date.parse(iso) + minutes * 60_000).toISOString();
}

function compactSchedule(schedule) {
  return {
    cron: typeof schedule?.cron === 'string' ? schedule.cron : null,
    created_on: typeof schedule?.created_on === 'string' ? schedule.created_on : null,
    modified_on: typeof schedule?.modified_on === 'string' ? schedule.modified_on : null,
  };
}

function compactDeployment(deployment) {
  return {
    id: typeof deployment?.id === 'string' ? deployment.id : null,
    created_on: typeof deployment?.created_on === 'string' ? deployment.created_on : null,
    source: typeof deployment?.source === 'string' ? deployment.source : null,
    triggered_by:
      typeof deployment?.annotations?.['workers/triggered_by'] === 'string'
        ? deployment.annotations['workers/triggered_by']
        : null,
    versions: Array.isArray(deployment?.versions)
      ? deployment.versions.map((version) => ({
          version_id: typeof version?.version_id === 'string' ? version.version_id : null,
          percentage: Number.isFinite(Number(version?.percentage))
            ? Number(version.percentage)
            : null,
        }))
      : [],
  };
}

function normalizeSchedules(body) {
  const value = body?.result ?? body;
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.schedules)) return value.schedules;
  return null;
}

function normalizeDeployments(body) {
  const value = body?.result ?? body;
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.deployments)) return value.deployments;
  return null;
}

function activeDeploymentLooksValid(deployment) {
  if (!deployment || typeof deployment.id !== 'string' || deployment.id.length === 0) {
    return false;
  }
  if (!Array.isArray(deployment.versions) || deployment.versions.length === 0) {
    return false;
  }

  const percentages = deployment.versions.map((version) => Number(version?.percentage));
  if (percentages.some((value) => !Number.isFinite(value) || value <= 0)) return false;

  const total = percentages.reduce((sum, value) => sum + value, 0);
  return total >= 99.99 && total <= 100.01;
}

export function evaluateDeploymentAuthority({ schedules, deployments, health }) {
  const schedulesReadable = Array.isArray(schedules);
  const deploymentsReadable = Array.isArray(deployments);
  const healthReadable = health && typeof health === 'object' && !Array.isArray(health);

  if (!schedulesReadable || !deploymentsReadable || !healthReadable) {
    return {
      observable: false,
      authorized: false,
      checks: {},
      failing: [],
      reason: 'required_observation_unavailable',
    };
  }

  const activeDeployment = deployments[0] ?? null;
  const checks = {
    exact_cron:
      schedules.length === 1 &&
      schedules[0]?.cron === EXPECTED_CRON,
    active_deployment_present: activeDeploymentLooksValid(activeDeployment),
    worker_identity: health?.service === 'xqueue',
    runtime_authority_flag: health?.authorityReadiness?.authorityFlag === true,
    runtime_authorized: health?.authorityReadiness?.authorized === true,
    scheduler_authority: health?.schedulerAuthority === true,
    live_publication_authority: health?.livePublication === true,
  };

  const failing = Object.entries(checks)
    .filter(([, value]) => value !== true)
    .map(([name]) => name);

  return {
    observable: true,
    authorized: failing.length === 0,
    checks,
    failing,
    reason: failing.length === 0 ? null : 'authoritative_deployment_state_mismatch',
  };
}

async function readJson(response) {
  const text = await response.text();
  if (text.length === 0) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function cloudflareGet({ accountId, token, pathname, fetchImpl, timeoutMs }) {
  const response = await fetchImpl(`${CLOUDFLARE_API}${pathname}`, {
    method: 'GET',
    headers: {
      accept: 'application/json',
      authorization: `Bearer ${token}`,
      'user-agent': 'xqueue-tsal-deployment-evidence/1',
    },
    signal: AbortSignal.timeout(timeoutMs),
  });

  const body = await readJson(response);
  if (!response.ok || body?.success === false) {
    return {
      ok: false,
      status: response.status,
      body: null,
      error: `Cloudflare GET ${pathname} returned HTTP ${response.status}`,
    };
  }

  return { ok: true, status: response.status, body, error: null };
}

async function healthGet({ url, fetchImpl, timeoutMs }) {
  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      headers: {
        accept: 'application/json',
        'user-agent': 'xqueue-tsal-deployment-evidence/1',
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = await readJson(response);
    if (!body || typeof body !== 'object') {
      return {
        ok: false,
        status: response.status,
        health: null,
        error: `Health GET returned non-JSON data (HTTP ${response.status})`,
      };
    }
    return {
      ok: true,
      status: response.status,
      health: body,
      error: response.ok ? null : `Health endpoint returned HTTP ${response.status}`,
    };
  } catch (error) {
    return {
      ok: false,
      status: null,
      health: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function observeDeploymentAuthority({
  accountId,
  token,
  workerName = WORKER_NAME,
  healthUrl = HEALTH_URL,
  fetchImpl = globalThis.fetch,
  timeoutMs = 10_000,
} = {}) {
  if (!accountId || !token) {
    return {
      schedules: null,
      deployments: null,
      health: null,
      observationErrors: ['cloudflare_read_credentials_unavailable'],
      cloudflare: {
        account_id_present: Boolean(accountId),
        api_token_present: Boolean(token),
        worker_name: workerName,
      },
    };
  }

  try {
    const encodedWorker = encodeURIComponent(workerName);
    const encodedAccount = encodeURIComponent(accountId);
    const [scheduleResult, deploymentResult, healthResult] = await Promise.all([
      cloudflareGet({
        accountId,
        token,
        pathname: `/accounts/${encodedAccount}/workers/scripts/${encodedWorker}/schedules`,
        fetchImpl,
        timeoutMs,
      }),
      cloudflareGet({
        accountId,
        token,
        pathname: `/accounts/${encodedAccount}/workers/scripts/${encodedWorker}/deployments`,
        fetchImpl,
        timeoutMs,
      }),
      healthGet({ url: healthUrl, fetchImpl, timeoutMs }),
    ]);

    const observationErrors = [];
    let schedules = null;
    let deployments = null;

    if (scheduleResult.ok) {
      schedules = normalizeSchedules(scheduleResult.body);
      if (!schedules) observationErrors.push('cloudflare_schedules_response_malformed');
    } else {
      observationErrors.push(scheduleResult.error);
    }

    if (deploymentResult.ok) {
      deployments = normalizeDeployments(deploymentResult.body);
      if (!deployments) observationErrors.push('cloudflare_deployments_response_malformed');
    } else {
      observationErrors.push(deploymentResult.error);
    }

    if (!healthResult.ok) observationErrors.push(healthResult.error);

    return {
      schedules,
      deployments,
      health: healthResult.health,
      observationErrors: observationErrors.filter(Boolean),
      cloudflare: {
        account_id_present: true,
        api_token_present: true,
        worker_name: workerName,
        schedules_http_status: scheduleResult.status,
        deployments_http_status: deploymentResult.status,
      },
    };
  } catch (error) {
    return {
      schedules: null,
      deployments: null,
      health: null,
      observationErrors: [error instanceof Error ? error.message : String(error)],
      cloudflare: {
        account_id_present: true,
        api_token_present: true,
        worker_name: workerName,
      },
    };
  }
}

export function buildDeploymentEvidence({
  observation,
  producedAt = new Date().toISOString(),
  validForMinutes = 90,
  runId = null,
  actor = null,
  observerCommit = null,
} = {}) {
  const validityMinutes = finitePositive(validForMinutes, 90);
  const evaluation = evaluateDeploymentAuthority({
    schedules: observation?.schedules ?? null,
    deployments: observation?.deployments ?? null,
    health: observation?.health ?? null,
  });

  const result = !evaluation.observable
    ? 'unknown'
    : (evaluation.authorized ? 'pass' : 'fail');

  const compactSchedules = Array.isArray(observation?.schedules)
    ? observation.schedules.map(compactSchedule)
    : null;
  const compactDeployments = Array.isArray(observation?.deployments)
    ? observation.deployments.slice(0, 3).map(compactDeployment)
    : null;
  const health = observation?.health;

  return {
    schema_version: '0.3',
    evidence_id: `xqueue-deployment-authority-${runId || producedAt.replace(/[^0-9]/g, '').slice(0, 14)}`,
    project_id: 'xqueue',
    automation_id: 'xqueue-publisher',
    tsal_version: '0.3.2',
    candidate: null,
    produced_at: producedAt,
    valid_until: isoAfter(producedAt, validityMinutes),
    claim_id: CLAIM_ID,
    claim: 'Cloudflare control-plane state and the deployed Worker jointly prove the intended XQueue production publication authority is active.',
    result,
    evidence_class: 'deployment',
    evidence_type: 'configuration',
    details: {
      expected_worker: WORKER_NAME,
      expected_cron: EXPECTED_CRON,
      evaluation,
      observation_errors: observation?.observationErrors ?? [],
      cloudflare: observation?.cloudflare ?? null,
      schedules: compactSchedules,
      deployments: compactDeployments,
      runtime_authority: health && typeof health === 'object'
        ? {
            service: health.service ?? null,
            livePublication: health.livePublication === true,
            schedulerAuthority: health.schedulerAuthority === true,
            authorityFlag: health.authorityReadiness?.authorityFlag === true,
            authorized: health.authorityReadiness?.authorized === true,
          }
        : null,
      observer_commit: observerCommit,
      note: 'Cloudflare API calls are GET-only. The API token value and secret values are never recorded. Runtime authority corroboration is read from the public health endpoint; no deployment or publication mutation is performed.',
    },
    provenance: {
      producer: 'XQueue TSAL deployment evidence collector',
      source: 'Cloudflare Workers schedules/deployments APIs plus XQueue production health endpoint',
      run_id: runId,
      actor,
    },
  };
}

function argValue(flag, fallback = null) {
  const index = process.argv.indexOf(flag);
  if (index === -1 || index + 1 >= process.argv.length) return fallback;
  return process.argv[index + 1];
}

async function main() {
  const accountId = argValue('--account-id', process.env.CLOUDFLARE_ACCOUNT_ID ?? '');
  const token = argValue('--api-token', process.env.CLOUDFLARE_API_TOKEN ?? '');
  const output = argValue(
    '--output',
    path.join('docs', 'evidence', 'tsal-deployment', 'deployment-authority.json'),
  );
  const validForMinutes = finitePositive(argValue('--valid-minutes', '90'), 90);
  const runId = argValue('--run-id', process.env.GITHUB_RUN_ID ?? null);
  const actor = argValue('--actor', process.env.GITHUB_ACTOR ?? null);
  const observerCommit = argValue('--observer-commit', process.env.GITHUB_SHA ?? null);

  const observation = await observeDeploymentAuthority({ accountId, token });
  const evidence = buildDeploymentEvidence({
    observation,
    validForMinutes,
    runId,
    actor,
    observerCommit,
  });

  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');

  console.log(JSON.stringify({
    output,
    claim_id: evidence.claim_id,
    result: evidence.result,
    valid_until: evidence.valid_until,
    failing_checks: evidence.details.evaluation.failing,
    observation_errors: evidence.details.observation_errors,
    cloudflare_credentials_present: {
      account_id: Boolean(accountId),
      api_token: Boolean(token),
    },
  }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
