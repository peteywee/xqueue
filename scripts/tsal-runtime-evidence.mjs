import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const DEFAULT_RUNTIME_URL = 'https://xqueue-production.patrickcraven.workers.dev/health';
const CLAIM_ID = 'xqueue-publisher.runtime.safe';

function asFinitePositiveNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function isoAfter(iso, minutes) {
  const start = Date.parse(iso);
  return new Date(start + minutes * 60_000).toISOString();
}

export function evaluateRuntimeHealth(health) {
  const authorityFlag = health?.authorityReadiness?.authorityFlag === true;
  const checks = {
    service_identity: health?.service === 'xqueue',
    status_role: health?.role === 'status-only' &&
      health?.publicationCapable === false &&
      health?.livePublication === false &&
      health?.schedulerAuthority === false,
    service_status: health?.status === 'ok',
    dynamic_runtime: health?.dynamicRuntimeReadiness?.ok === true &&
      health?.dynamicRuntimeReadiness?.authoritative === true &&
      health?.dynamicRuntimeReadiness?.source === 'production-d1-r2',
    authority_readiness: health?.authorityReadiness?.ok === true,
    publisher_authority: health?.publisherAuthority?.ok === true &&
      health?.publisherAuthority?.owner === 'cloudflare' &&
      health?.publisherAuthority?.transitionState === 'stable',
    halt_readable: health?.publicationHalt?.ok === true,
    scheduler_liveness: health?.schedulerLiveness?.required === true &&
      health?.schedulerLiveness?.ok === true &&
      health?.schedulerLiveness?.state === 'fresh',
    d1_reachable: health?.storage?.d1?.reachable === true,
    r2_reachable: health?.storage?.r2?.reachable === true,
  };

  const failing = Object.entries(checks)
    .filter(([, value]) => value !== true)
    .map(([name]) => name);

  return {
    safe: failing.length === 0,
    checks,
    failing,
    authority: {
      authorized: health?.authorityReadiness?.authorized === true,
      authorityFlag,
      livePublication: health?.livePublication === true,
      schedulerAuthority: health?.schedulerAuthority === true,
      schedulerLiveness: health?.schedulerLiveness ?? null,
    },
  };
}

export function buildRuntimeEvidence({
  health = null,
  observationError = null,
  producedAt = new Date().toISOString(),
  validForMinutes = 90,
  source = DEFAULT_RUNTIME_URL,
  runId = null,
  actor = null,
  observerCommit = null,
} = {}) {
  const validityMinutes = asFinitePositiveNumber(validForMinutes, 90);
  let result = 'unknown';
  let evaluation = null;

  if (health && typeof health === 'object' && !Array.isArray(health)) {
    evaluation = evaluateRuntimeHealth(health);
    result = evaluation.safe ? 'pass' : 'fail';
  }

  const evidenceIdSuffix = runId || producedAt.replace(/[^0-9]/g, '').slice(0, 14);

  return {
    schema_version: '0.3',
    evidence_id: `xqueue-runtime-safe-${evidenceIdSuffix}`,
    project_id: 'xqueue',
    automation_id: 'xqueue-publisher',
    tsal_version: '0.3.2',
    candidate: null,
    produced_at: producedAt,
    valid_until: isoAfter(producedAt, validityMinutes),
    claim_id: CLAIM_ID,
    claim: 'Current XQueue production runtime is technically healthy; whenever production scheduler authority is expected, its durable scheduler heartbeat is current.',
    result,
    evidence_class: 'runtime',
    evidence_type: 'runtime_observation',
    details: {
      observation_error: observationError,
      evaluation,
      observed_health: health,
      observer_commit: observerCommit,
      note: 'Runtime safety requires a fresh scheduler heartbeat whenever production scheduler authority is expected. Deployment authority remains a separate deployment-class claim.',
    },
    provenance: {
      producer: 'XQueue TSAL runtime evidence collector',
      source,
      run_id: runId,
      actor,
    },
  };
}

export async function observeRuntime({
  url = DEFAULT_RUNTIME_URL,
  fetchImpl = globalThis.fetch,
  timeoutMs = 10_000,
} = {}) {
  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      headers: {
        accept: 'application/json',
        'user-agent': 'xqueue-tsal-runtime-evidence/1',
      },
      signal: AbortSignal.timeout(timeoutMs),
    });

    const text = await response.text();
    let health = null;

    try {
      health = text.length > 0 ? JSON.parse(text) : null;
    } catch {
      return {
        health: null,
        observationError: `HTTP ${response.status} returned non-JSON health data`,
      };
    }

    if (!response.ok && (!health || typeof health !== 'object')) {
      return {
        health: null,
        observationError: `HTTP ${response.status} while reading production health`,
      };
    }

    return {
      health,
      observationError: response.ok ? null : `HTTP ${response.status} reported by production health`,
    };
  } catch (error) {
    return {
      health: null,
      observationError: error instanceof Error ? error.message : String(error),
    };
  }
}

function argValue(flag, fallback = null) {
  const index = process.argv.indexOf(flag);
  if (index === -1 || index + 1 >= process.argv.length) return fallback;
  return process.argv[index + 1];
}

async function main() {
  const url = argValue('--url', DEFAULT_RUNTIME_URL);
  const output = argValue('--output', path.join('docs', 'evidence', 'tsal-runtime', 'runtime-safe.json'));
  const validForMinutes = asFinitePositiveNumber(argValue('--valid-minutes', '90'), 90);
  const runId = argValue('--run-id', process.env.GITHUB_RUN_ID ?? null);
  const actor = argValue('--actor', process.env.GITHUB_ACTOR ?? null);
  const observerCommit = argValue('--observer-commit', process.env.GITHUB_SHA ?? null);

  const observed = await observeRuntime({ url });
  const evidence = buildRuntimeEvidence({
    ...observed,
    validForMinutes,
    source: url,
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
    failing_checks: evidence.details.evaluation?.failing ?? [],
    observation_error: evidence.details.observation_error,
  }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
