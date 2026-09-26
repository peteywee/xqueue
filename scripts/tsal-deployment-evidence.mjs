import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const CLOUDFLARE_API = 'https://api.cloudflare.com/client/v4';
const WORKER_NAME = 'xqueue-publisher-production';
const STATUS_WORKER_NAME = 'xqueue-production';
const PRODUCTION_DB_ID = 'fc85026e-bfc8-435f-8bb0-c60e139178a3';
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
  if (!Array.isArray(deployment.versions) || deployment.versions.length !== 1) {
    return false;
  }

  return Number(deployment.versions[0]?.percentage) === 100 &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
      .test(deployment.versions[0]?.version_id ?? '');
}

function compactVersion(version) {
  if (!version || typeof version !== 'object') return null;
  const bindings = Array.isArray(version.resources?.bindings) ? version.resources.bindings : [];
  return {
    id: version.id ?? null,
    tag: version.annotations?.['workers/tag'] ?? null,
    authority_enabled: bindings.some((binding) => binding.name === 'XQUEUE_PUBLISH_AUTHORITY' &&
      binding.type === 'plain_text' && binding.text === 'enabled'),
    version_metadata: bindings.some((binding) => binding.name === 'CF_VERSION_METADATA' &&
      binding.type === 'version_metadata'),
    production_database: bindings.some((binding) => binding.name === 'DB' &&
      binding.type === 'd1' && binding.id === PRODUCTION_DB_ID),
  };
}

export function evaluateDeploymentAuthority({ schedules, deployments, health, statusSchedules, version }) {
  const schedulesReadable = Array.isArray(schedules);
  const deploymentsReadable = Array.isArray(deployments);
  const healthReadable = health && typeof health === 'object' && !Array.isArray(health);

  if (!schedulesReadable || !deploymentsReadable || !healthReadable ||
      !Array.isArray(statusSchedules) || !version || typeof version !== 'object') {
    return {
      observable: false,
      authorized: false,
      checks: {},
      failing: [],
      reason: 'required_observation_unavailable',
    };
  }

  const activeDeployment = deployments[0] ?? null;
  const authority = health.publisherAuthority;
  const activeVersionId = activeDeployment?.versions?.[0]?.version_id;
  const checks = {
    exact_cron:
      schedules.length === 1 &&
      schedules[0]?.cron === EXPECTED_CRON,
    active_deployment_present: activeDeploymentLooksValid(activeDeployment),
    status_unscheduled: statusSchedules.length === 0,
    worker_identity: health?.service === 'xqueue',
    status_role: health?.role === 'status-only' && health?.publicationCapable === false &&
      health?.livePublication === false && health?.schedulerAuthority === false,
    durable_authority: authority?.ok === true && authority?.owner === 'cloudflare' &&
      authority?.transitionState === 'stable',
    exact_version: typeof activeVersionId === 'string' && version.id === activeVersionId &&
      authority?.deploymentId === `cloudflare-worker:${WORKER_NAME}:version:${activeVersionId}`,
    exact_candidate_tag: /^[0-9a-f]{40}$/i.test(version.tag ?? '') &&
      String(version.tag).toLowerCase() === String(authority?.candidateSha ?? '').toLowerCase(),
    runtime_authority_flag: version.authority_enabled === true,
    runtime_version_binding: version.version_metadata === true,
    production_database: version.production_database === true,
    halt_cleared: health?.publicationHalt?.ok === true && health?.publicationHalt?.halted === false,
    scheduler_liveness: health?.schedulerLiveness?.required === true &&
      health?.schedulerLiveness?.ok === true && health?.schedulerLiveness?.state === 'fresh',
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
      statusSchedules: null,
      version: null,
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
    const [scheduleResult, deploymentResult, healthResult, statusScheduleResult] = await Promise.all([
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
      cloudflareGet({
        accountId, token,
        pathname: `/accounts/${encodedAccount}/workers/scripts/${STATUS_WORKER_NAME}/schedules`,
        fetchImpl, timeoutMs,
      }),
    ]);

    const observationErrors = [];
    let schedules = null;
    let deployments = null;
    let statusSchedules = null;
    let version = null;

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

    if (statusScheduleResult.ok) {
      statusSchedules = normalizeSchedules(statusScheduleResult.body);
      if (!statusSchedules) observationErrors.push('status_schedules_response_malformed');
    } else {
      observationErrors.push(statusScheduleResult.error);
    }

    // Read only the immutable version named by the active publisher deployment.
    const activeVersionId = deployments?.[0]?.versions?.[0]?.version_id;
    if (typeof activeVersionId === 'string' && activeVersionId.length > 0) {
      const result = await cloudflareGet({
        accountId, token,
        pathname: `/accounts/${encodedAccount}/workers/scripts/${encodedWorker}/versions/${encodeURIComponent(activeVersionId)}`,
        fetchImpl, timeoutMs,
      });
      if (result.ok) version = compactVersion(result.body?.result ?? result.body);
      else observationErrors.push(result.error);
    } else if (deployments) {
      // A readable but empty deployment is a proven mismatch, not an unknown read.
      version = {};
    }

    return {
      schedules,
      deployments,
      statusSchedules,
      version,
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
      statusSchedules: null,
      version: null,
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
    statusSchedules: observation?.statusSchedules ?? null,
    version: observation?.version ?? null,
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
      status_schedules: observation?.statusSchedules?.map(compactSchedule) ?? null,
      publisher_version: observation?.version ?? null,
      durable_authority: health?.publisherAuthority ?? null,
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
      note: 'GET-only observations bind the publisher deployment/version/tag to durable D1 authority reported by the separate status Worker. The status Worker must be unscheduled and incapable of publication. No token or secret values are recorded.',
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
