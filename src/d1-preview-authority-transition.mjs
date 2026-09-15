import { compilePreviewNoneToLocalSystemdSql } from './authority-transition-sql.mjs';
import { compileWranglerD1Invocation } from './d1-mirror-wrangler-transport.mjs';

function assertRunner(runProcess) {
  if (typeof runProcess !== 'function') throw new TypeError('runProcess injection is required');
}

function normalizeProcessResult(result) {
  if (!result || typeof result !== 'object') throw new Error('Wrangler process returned no structured result');
  const exitCode = result.exitCode ?? result.code;
  if (!Number.isSafeInteger(exitCode)) throw new Error('Wrangler process result must include an integer exitCode');
  return {
    exitCode,
    stdout: typeof result.stdout === 'string' ? result.stdout : '',
    stderr: typeof result.stderr === 'string' ? result.stderr : '',
  };
}

function parseBatch(stdout) {
  let parsed;
  try { parsed = JSON.parse(stdout); } catch { throw new Error('Wrangler D1 authority transition output was not valid JSON'); }
  if (!Array.isArray(parsed) || parsed.length !== 2) throw new Error('Wrangler D1 authority transition must return exactly two statement results');
  for (const statement of parsed) {
    if (!statement || typeof statement !== 'object' || statement.success !== true) throw new Error('Wrangler D1 authority transition statement did not report success');
    if (!Array.isArray(statement.results)) throw new Error('Wrangler D1 authority transition statement results were missing');
    if (statement.results.length > 1) throw new Error('Wrangler D1 authority transition statement returned too many rows');
  }
  return parsed;
}

function validateReturnedRows({ eventRow, stateRow, candidateSha, deploymentId, transitionId, eventAt }) {
  const sha = candidateSha.toLowerCase();
  const eventOk = eventRow && eventRow.generation === 2 && eventRow.transition_id === transitionId && eventRow.previous_owner === 'none' && eventRow.next_owner === 'local-systemd' && eventRow.transition_state === 'stable' && typeof eventRow.candidate_sha === 'string' && eventRow.candidate_sha.toLowerCase() === sha && eventRow.deployment_id === deploymentId && eventRow.event_at === eventAt;
  const stateOk = stateRow && stateRow.singleton_id === 1 && stateRow.owner === 'local-systemd' && stateRow.generation === 2 && stateRow.transition_state === 'stable' && stateRow.transition_id === transitionId && stateRow.previous_owner === 'none' && typeof stateRow.candidate_sha === 'string' && stateRow.candidate_sha.toLowerCase() === sha && stateRow.deployment_id === deploymentId && stateRow.transitioned_at === eventAt && stateRow.updated_at === eventAt;
  return Boolean(eventOk && stateOk);
}

export async function executePreviewNoneToLocalSystemdTransition({ candidateSha, deploymentId, transitionId, eventAt, runProcess } = {}) {
  assertRunner(runProcess);
  const sql = compilePreviewNoneToLocalSystemdSql({ candidateSha, deploymentId, transitionId, eventAt });
  const invocation = compileWranglerD1Invocation({ env: 'preview', sql });
  const processResult = normalizeProcessResult(await runProcess(invocation));
  if (processResult.exitCode !== 0) {
    const stderr = processResult.stderr.trim();
    const stdout = processResult.stdout.trim();
    const detail = stderr || stdout;
    throw new Error(detail.length > 0 ? `Wrangler D1 preview authority transition failed: ${detail}` : `Wrangler D1 preview authority transition failed with exit code ${processResult.exitCode}`);
  }
  const statements = parseBatch(processResult.stdout);
  const eventRow = statements[0].results[0] ?? null;
  const stateRow = statements[1].results[0] ?? null;
  if (eventRow === null && stateRow === null) return { ok: false, status: 'refused', reason: 'preview_authority_transition_precondition_failed', writeAttempted: true };
  if (!validateReturnedRows({ eventRow, stateRow, candidateSha, deploymentId, transitionId, eventAt })) {
    return { ok: false, status: 'indeterminate', reason: 'preview_authority_transition_readback_mismatch', writeAttempted: true, eventRow, stateRow };
  }
  return { ok: true, status: 'confirmed_local_systemd', reason: null, env: 'preview', owner: 'local-systemd', generation: 2, transitionId, candidateSha: candidateSha.toLowerCase(), deploymentId, eventAt, writeAttempted: true };
}
