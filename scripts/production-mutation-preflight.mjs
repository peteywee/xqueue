import { spawnSync } from 'node:child_process';

function run(command, args, { allowNonZero = false } = {}) {
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    env: process.env,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  const code = result.status ?? 1;
  if (code !== 0 && !allowNonZero) {
    const detail = [result.stderr, result.stdout].filter(Boolean).join('\n').trim();
    throw new Error(
      [command, ...args].join(' ') + ' failed with exit ' + code +
      (detail ? '\n' + detail : ''),
    );
  }
  return { code, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

function parseWranglerJson(raw) {
  const text = String(raw ?? '').trim();
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] !== '[' && text[index] !== '{') continue;
    try {
      return JSON.parse(text.slice(index));
    } catch {
      // Continue past command chatter.
    }
  }
  throw new Error('Wrangler output did not contain valid JSON');
}

function first(payload, index) {
  return payload?.[index]?.results?.[0] ?? null;
}

function exactHead() {
  return run('git', ['rev-parse', 'HEAD']).stdout.trim().toLowerCase();
}

function requireCleanMain() {
  const branch = run('git', ['branch', '--show-current']).stdout.trim();
  if (branch !== 'main') throw new Error('production queue mutation requires local main');

  const dirty = run('git', ['status', '--porcelain', '--untracked-files=all']).stdout.trim();
  if (dirty) throw new Error('production queue mutation requires a clean worktree');
}

export function readProductionMutationGuard({ expectedHaltGeneration }) {
  const haltGeneration = Number(expectedHaltGeneration);
  if (!Number.isSafeInteger(haltGeneration) || haltGeneration < 1) {
    throw new Error('production mutation requires --expected-halt-generation <n>');
  }

  requireCleanMain();
  const headSha = exactHead();

  run('pnpm', ['cf:auth:preflight', '--environment', 'production']);

  const sql = [
    'SELECT halted,generation,actor_class,reason,updated_at',
    'FROM publication_halt_state WHERE singleton_id=1;',
    'SELECT owner,generation,transition_state,candidate_sha,deployment_id',
    'FROM authority_state WHERE singleton_id=1;',
    "SELECT COUNT(*) AS unresolved FROM publication_state",
    "WHERE status IN ('prepared','publishing','needs_reconciliation');",
    'SELECT COUNT(*) AS active_leases FROM publication_leases',
    'WHERE owner_token IS NOT NULL',
    "AND expires_at_ms > CAST(strftime('%s','now') AS INTEGER) * 1000;",
    "SELECT json_extract(value,'$.inflight') AS inflight",
    "FROM runtime_metadata WHERE key='state.snapshot_json';",
  ].join(' ');

  const raw = run('pnpm', [
    'wrangler',
    'd1',
    'execute',
    'xqueue-production',
    '--config',
    'wrangler.status.jsonc',
    '--remote',
    '--yes',
    '--json',
    '--command',
    sql,
  ]).stdout;

  const payload = parseWranglerJson(raw);
  const halt = first(payload, 0);
  const authority = first(payload, 1);
  const unresolved = Number(first(payload, 2)?.unresolved ?? -1);
  const activeLeases = Number(first(payload, 3)?.active_leases ?? -1);
  const inflight = first(payload, 4)?.inflight ?? null;

  if (
    Number(halt?.halted) !== 1 ||
    Number(halt?.generation) !== haltGeneration ||
    halt?.actor_class !== 'owner'
  ) {
    throw new Error('production owner halt does not match expected generation');
  }

  if (
    authority?.owner !== 'cloudflare' ||
    authority?.transition_state !== 'stable' ||
    String(authority?.candidate_sha ?? '').toLowerCase() !== headSha ||
    typeof authority?.deployment_id !== 'string'
  ) {
    throw new Error(
      'production authority is not stable Cloudflare on the exact local main candidate',
    );
  }

  if (unresolved !== 0 || activeLeases !== 0 || inflight !== null) {
    throw new Error(
      'production mutation refused: publication state is not quiescent',
    );
  }

  return Object.freeze({
    haltGeneration,
    candidateSha: headSha,
    deploymentId: authority.deployment_id,
    authorityGeneration: Number(authority.generation),
  });
}
