import { compileInitialPreviewAuthorityBootstrapSql } from './authority-bootstrap-sql.mjs';
import { compileWranglerD1Invocation } from './d1-mirror-wrangler-transport.mjs';

function assertRunner(runProcess) {
  if (typeof runProcess !== 'function') {
    throw new TypeError('runProcess injection is required');
  }
}

function normalizeProcessResult(result) {
  if (!result || typeof result !== 'object') {
    throw new Error('Wrangler process returned no structured result');
  }

  const exitCode = result.exitCode ?? result.code;
  if (!Number.isSafeInteger(exitCode)) {
    throw new Error('Wrangler process result must include an integer exitCode');
  }

  return {
    exitCode,
    stdout: typeof result.stdout === 'string' ? result.stdout : '',
    stderr: typeof result.stderr === 'string' ? result.stderr : '',
  };
}

function parseBatch(stdout) {
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error('Wrangler D1 bootstrap output was not valid JSON');
  }

  if (!Array.isArray(parsed) || parsed.length !== 2) {
    throw new Error('Wrangler D1 bootstrap must return exactly two statement results');
  }

  for (const statement of parsed) {
    if (!statement || typeof statement !== 'object' || statement.success !== true) {
      throw new Error('Wrangler D1 bootstrap statement did not report success');
    }
    if (!Array.isArray(statement.results)) {
      throw new Error('Wrangler D1 bootstrap statement results were missing');
    }
    if (statement.results.length > 1) {
      throw new Error('Wrangler D1 bootstrap statement returned too many rows');
    }
  }

  return parsed;
}

function sameText(left, right) {
  return typeof left === 'string' && left === right;
}

function validateReturnedRows({ eventRow, stateRow, candidateSha, transitionId, eventAt }) {
  const normalizedSha = candidateSha.toLowerCase();

  const eventOk = eventRow &&
    eventRow.generation === 1 &&
    sameText(eventRow.transition_id, transitionId) &&
    (eventRow.previous_owner ?? null) === null &&
    eventRow.next_owner === 'none' &&
    eventRow.transition_state === 'stable' &&
    typeof eventRow.candidate_sha === 'string' &&
    eventRow.candidate_sha.toLowerCase() === normalizedSha &&
    (eventRow.deployment_id ?? null) === null &&
    eventRow.event_at === eventAt;

  const stateOk = stateRow &&
    stateRow.singleton_id === 1 &&
    stateRow.owner === 'none' &&
    stateRow.generation === 1 &&
    stateRow.transition_state === 'stable' &&
    sameText(stateRow.transition_id, transitionId) &&
    (stateRow.previous_owner ?? null) === null &&
    typeof stateRow.candidate_sha === 'string' &&
    stateRow.candidate_sha.toLowerCase() === normalizedSha &&
    (stateRow.deployment_id ?? null) === null &&
    stateRow.transitioned_at === eventAt &&
    stateRow.updated_at === eventAt;

  return eventOk && stateOk;
}

export async function executeInitialPreviewAuthorityBootstrap({
  candidateSha,
  transitionId,
  eventAt,
  runProcess,
} = {}) {
  assertRunner(runProcess);

  const sql = compileInitialPreviewAuthorityBootstrapSql({
    candidateSha,
    transitionId,
    eventAt,
  });

  const invocation = compileWranglerD1Invocation({
    env: 'preview',
    sql,
  });

  const processResult = normalizeProcessResult(await runProcess(invocation));
  if (processResult.exitCode !== 0) {
    const detail = processResult.stderr.trim();
    throw new Error(
      detail.length > 0
        ? `Wrangler D1 preview authority bootstrap failed: ${detail}`
        : `Wrangler D1 preview authority bootstrap failed with exit code ${processResult.exitCode}`,
    );
  }

  const statements = parseBatch(processResult.stdout);
  const eventRow = statements[0].results[0] ?? null;
  const stateRow = statements[1].results[0] ?? null;

  if (eventRow === null && stateRow === null) {
    return {
      ok: false,
      status: 'refused',
      reason: 'preview_authority_bootstrap_precondition_failed',
      writeAttempted: true,
    };
  }

  if (!validateReturnedRows({
    eventRow,
    stateRow,
    candidateSha,
    transitionId,
    eventAt,
  })) {
    return {
      ok: false,
      status: 'indeterminate',
      reason: 'preview_authority_bootstrap_readback_mismatch',
      writeAttempted: true,
      eventRow,
      stateRow,
    };
  }

  return {
    ok: true,
    status: 'confirmed_seeded_unowned',
    reason: null,
    env: 'preview',
    owner: 'none',
    generation: 1,
    transitionId,
    candidateSha: candidateSha.toLowerCase(),
    deploymentId: null,
    eventAt,
    writeAttempted: true,
  };
}
