#!/usr/bin/env node

import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const args = process.argv.slice(2);

function flag(name) {
  return args.includes('--' + name);
}

function opt(name, fallback = null) {
  const exact = '--' + name;
  const prefix = exact + '=';
  const index = args.indexOf(exact);
  if (index >= 0 && args[index + 1] !== undefined) return args[index + 1];
  const inline = args.find((arg) => arg.startsWith(prefix));
  return inline ? inline.slice(prefix.length) : fallback;
}

function nowIso() {
  return new Date().toISOString();
}

function stamp() {
  return nowIso().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

function quoteArg(value) {
  const text = String(value);
  return /^[A-Za-z0-9_./:@=-]+$/.test(text)
    ? text
    : "'" + text.replaceAll("'", "'\\''") + "'";
}

function commandText(command, argv) {
  return [command, ...argv].map(quoteArg).join(' ');
}

export function parseJsonOutput(raw) {
  const text = String(raw ?? '').trim();
  const starts = [];
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === '{' || text[index] === '[') starts.push(index);
  }
  for (const start of starts) {
    const candidate = text.slice(start).trim();
    try {
      return JSON.parse(candidate);
    } catch {
      // Continue until a valid JSON suffix is found.
    }
  }
  throw new Error('command output did not contain a parseable JSON value');
}

export function parseWorkerVersionId(raw) {
  const match = String(raw ?? '').match(
    /Worker Version ID:\s*([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i,
  );
  if (!match) throw new Error('Worker Version ID was not present in upload output');
  return match[1].toLowerCase();
}

export function parseScheduledLog(raw) {
  const lines = String(raw ?? '').split(/\r?\n/);
  for (const line of lines) {
    const marker = line.indexOf('{"event":"scheduled"');
    if (marker < 0) continue;
    try {
      return JSON.parse(line.slice(marker));
    } catch {
      // Ignore malformed matching lines and keep scanning.
    }
  }
  return null;
}

function firstD1Row(payload, statementIndex = 0) {
  const statement = Array.isArray(payload) ? payload[statementIndex] : null;
  return statement?.results?.[0] ?? null;
}

function fail(message) {
  throw new Error(message);
}

function bootstrap(command, argv, { allowNonZero = false } = {}) {
  const result = spawnSync(command, argv, {
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
      commandText(command, argv) + ' failed with exit ' + code +
      (detail ? '\n' + detail : ''),
    );
  }
  return {
    code,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

function ensureCleanWorktree() {
  const status = bootstrap('git', ['status', '--porcelain', '--untracked-files=all']);
  if (status.stdout.trim().length > 0) {
    fail('worktree must be clean before production acceptance\n' + status.stdout.trim());
  }
}

function syncMain() {
  ensureCleanWorktree();
  bootstrap('git', ['checkout', 'main']);
  bootstrap('git', ['fetch', 'origin']);
  bootstrap('git', ['pull', '--ff-only', 'origin', 'main']);
  ensureCleanWorktree();
}

function gitHead() {
  return bootstrap('git', ['rev-parse', 'HEAD']).stdout.trim().toLowerCase();
}

function gitBranch() {
  return bootstrap('git', ['branch', '--show-current']).stdout.trim();
}

function loadJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function writeJson(path, value) {
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n', 'utf8');
}

function acceptanceRoot() {
  return join(
    homedir(),
    '.local',
    'state',
    'xqueue',
    'production-acceptance',
  );
}

function chooseEvidenceDir(headSha) {
  const requested = opt('evidence-dir');
  if (requested) return resolve(requested);

  const root = acceptanceRoot();
  mkdirSync(root, { recursive: true });
  const latestPath = join(root, 'latest.json');

  if (existsSync(latestPath)) {
    try {
      const latest = loadJson(latestPath);
      const statePath = join(latest.evidenceDir, 'state.json');
      if (existsSync(statePath)) {
        const state = loadJson(statePath);
        if (
          state.headSha === headSha &&
          state.status !== 'complete' &&
          state.status !== 'abandoned'
        ) {
          return latest.evidenceDir;
        }
      }
    } catch {
      // A broken pointer must not prevent a new evidence run.
    }
  }

  return join(root, stamp() + '-' + headSha.slice(0, 12));
}

function createContext(headSha) {
  const evidenceDir = chooseEvidenceDir(headSha);
  mkdirSync(evidenceDir, { recursive: true });
  const statePath = join(evidenceDir, 'state.json');

  let state;
  if (existsSync(statePath)) {
    state = loadJson(statePath);
    if (state.headSha !== headSha) {
      fail(
        'saved acceptance state belongs to ' + state.headSha +
        ', but current HEAD is ' + headSha,
      );
    }
  } else {
    state = {
      schema: 1,
      status: 'running',
      startedAt: nowIso(),
      updatedAt: nowIso(),
      headSha,
      evidenceDir,
      mode: {
        apply: flag('apply'),
        release: flag('release'),
      },
      facts: {},
      steps: {},
    };
    writeJson(statePath, state);
  }

  const latestPath = join(acceptanceRoot(), 'latest.json');
  mkdirSync(acceptanceRoot(), { recursive: true });
  writeJson(latestPath, { evidenceDir });

  function save() {
    state.updatedAt = nowIso();
    writeJson(statePath, state);
  }

  return { evidenceDir, statePath, state, save };
}

function stepFile(ctx, name, stream) {
  const safe = name.replace(/[^A-Za-z0-9._-]+/g, '-');
  return join(ctx.evidenceDir, safe + '.' + stream + '.log');
}

function printStep(name, status, detail = '') {
  const suffix = detail ? ' — ' + detail : '';
  console.log('[' + status + '] ' + name + suffix);
}

function assertNoAmbiguousStep(ctx) {
  const ambiguous = Object.entries(ctx.state.steps)
    .find(([, step]) => step.status === 'ambiguous');
  if (ambiguous) {
    fail(
      'previous mutation has ambiguous outcome: ' + ambiguous[0] +
      '. Inspect ' + ctx.evidenceDir + ' before any retry.',
    );
  }
}

function runStep(
  ctx,
  name,
  command,
  argv,
  {
    mutation = false,
    allowNonZero = false,
    skipPassed = true,
    timeoutMs = 10 * 60 * 1000,
  } = {},
) {
  assertNoAmbiguousStep(ctx);

  const prior = ctx.state.steps[name];
  if (skipPassed && prior?.status === 'pass') {
    printStep(name, 'SKIP', 'already proven');
    return {
      code: prior.exitCode,
      stdout: existsSync(prior.stdoutFile)
        ? readFileSync(prior.stdoutFile, 'utf8')
        : '',
      stderr: existsSync(prior.stderrFile)
        ? readFileSync(prior.stderrFile, 'utf8')
        : '',
    };
  }

  const stdoutFile = stepFile(ctx, name, 'stdout');
  const stderrFile = stepFile(ctx, name, 'stderr');
  const startedAt = nowIso();

  printStep(name, 'RUN');
  const result = spawnSync(command, argv, {
    cwd: process.cwd(),
    env: process.env,
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
  });

  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';
  writeFileSync(stdoutFile, stdout, 'utf8');
  writeFileSync(stderrFile, stderr, 'utf8');

  const exitCode = result.status ?? 1;
  const ok = !result.error && (exitCode === 0 || allowNonZero);
  const status = ok ? 'pass' : (mutation ? 'ambiguous' : 'fail');

  ctx.state.steps[name] = {
    status,
    mutation,
    command: commandText(command, argv),
    startedAt,
    finishedAt: nowIso(),
    exitCode,
    signal: result.signal ?? null,
    error: result.error ? String(result.error.message ?? result.error) : null,
    stdoutFile,
    stderrFile,
  };
  ctx.save();

  if (!ok) {
    const detail = [stderr, stdout].filter(Boolean).join('\n').trim();
    printStep(name, status.toUpperCase());
    fail(
      name + ' failed' +
      (mutation ? '; mutation outcome is treated as ambiguous and will not auto-retry' : '') +
      (detail ? '\n' + detail.slice(-4000) : ''),
    );
  }

  printStep(name, 'PASS');
  return { code: exitCode, stdout, stderr };
}

async function runTailStep(
  ctx,
  name,
  worker,
  versionId,
  predicate,
  {
    timeoutMs = 17 * 60 * 1000,
  } = {},
) {
  assertNoAmbiguousStep(ctx);
  const prior = ctx.state.steps[name];
  if (prior?.status === 'pass') {
    printStep(name, 'SKIP', 'already proven');
    return prior.event;
  }

  const argv = [
    'wrangler',
    'tail',
    worker,
    '--config',
    'wrangler.authority.jsonc',
    '--version-id',
    versionId,
    '--search',
    'scheduled',
    '--format',
    'pretty',
  ];
  const stdoutFile = stepFile(ctx, name, 'stdout');
  const stderrFile = stepFile(ctx, name, 'stderr');
  const startedAt = nowIso();
  const output = [];
  const errors = [];

  printStep(name, 'RUN', 'waiting for one qualifying scheduled invocation');

  const event = await new Promise((resolveEvent, rejectEvent) => {
    const child = spawn('pnpm', argv, {
      cwd: process.cwd(),
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGTERM');
      rejectEvent(new Error(name + ' timed out waiting for scheduled evidence'));
    }, timeoutMs);

    function scan() {
      const parsed = parseScheduledLog(output.join(''));
      if (!parsed || !predicate(parsed) || settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill('SIGTERM');
      resolveEvent(parsed);
    }

    child.stdout.on('data', (chunk) => {
      output.push(chunk.toString());
      scan();
    });
    child.stderr.on('data', (chunk) => {
      errors.push(chunk.toString());
      output.push(chunk.toString());
      scan();
    });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      rejectEvent(error);
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      rejectEvent(
        new Error(name + ' tail exited before qualifying evidence; exit=' + code),
      );
    });
  }).catch((error) => {
    writeFileSync(stdoutFile, output.join(''), 'utf8');
    writeFileSync(stderrFile, errors.join(''), 'utf8');
    ctx.state.steps[name] = {
      status: 'fail',
      mutation: false,
      command: commandText('pnpm', argv),
      startedAt,
      finishedAt: nowIso(),
      exitCode: 1,
      stdoutFile,
      stderrFile,
      error: String(error.message ?? error),
    };
    ctx.save();
    throw error;
  });

  writeFileSync(stdoutFile, output.join(''), 'utf8');
  writeFileSync(stderrFile, errors.join(''), 'utf8');
  ctx.state.steps[name] = {
    status: 'pass',
    mutation: false,
    command: commandText('pnpm', argv),
    startedAt,
    finishedAt: nowIso(),
    exitCode: 0,
    stdoutFile,
    stderrFile,
    event,
  };
  ctx.save();
  printStep(name, 'PASS');
  return event;
}

function haltFact(raw) {
  const payload = parseJsonOutput(raw);
  const row = firstD1Row(payload);
  if (!row) fail('halt status returned no row');
  return {
    halted: Number(row.halted),
    generation: Number(row.generation),
    actorClass: row.actor_class,
    reason: row.reason,
    updatedAt: row.updated_at,
  };
}

function authorityFact(raw) {
  const payload = parseJsonOutput(raw);
  const row = firstD1Row(payload);
  if (!row) fail('authority query returned no row');
  return {
    owner: row.owner,
    generation: Number(row.generation),
    transitionState: row.transition_state,
    candidateSha: String(row.candidate_sha ?? '').toLowerCase(),
    deploymentId: row.deployment_id,
  };
}

function versionIdFromDeploymentId(value) {
  const prefix = 'cloudflare-worker:xqueue-publisher-production:version:';
  if (typeof value !== 'string' || !value.startsWith(prefix)) {
    fail('authority deployment ID is not an exact publisher version identity');
  }
  return value.slice(prefix.length).toLowerCase();
}

function validateVersionView(raw, expectedVersionId, expectedTag) {
  const value = parseJsonOutput(raw);
  const observedId = String(value?.id ?? '').toLowerCase();
  const tag = String(value?.annotations?.['workers/tag'] ?? '').toLowerCase();
  const bindings = Array.isArray(value?.resources?.bindings)
    ? value.resources.bindings
    : [];
  const authority = bindings.find(
    (binding) => binding?.name === 'XQUEUE_PUBLISH_AUTHORITY',
  )?.text;
  const metadataCount = bindings.filter(
    (binding) => binding?.name === 'CF_VERSION_METADATA',
  ).length;

  if (observedId !== expectedVersionId.toLowerCase()) {
    fail('Worker version inspection returned the wrong version ID');
  }
  if (tag !== expectedTag.toLowerCase()) {
    fail('Worker version tag does not equal the expected Git HEAD');
  }
  if (authority !== 'enabled') {
    fail('Worker version does not carry enabled publication authority');
  }
  if (metadataCount !== 1) {
    fail('Worker version does not carry exactly one CF_VERSION_METADATA binding');
  }

  return { observedId, tag, authority, metadataCount };
}

function durableSql(clearAt = null) {
  const eventClause = clearAt
    ? "SELECT COUNT(*) AS post_clear_events FROM publication_events WHERE event_at > '" +
      clearAt.replaceAll("'", "''") + "';"
    : 'SELECT COUNT(*) AS publication_events FROM publication_events;';

  return [
    'SELECT halted,generation,actor_class,reason,updated_at',
    'FROM publication_halt_state WHERE singleton_id=1;',
    'SELECT owner,generation,transition_state,candidate_sha,deployment_id',
    'FROM authority_state WHERE singleton_id=1;',
    "SELECT COUNT(*) AS unresolved FROM publication_state",
    "WHERE status IN ('prepared','publishing','needs_reconciliation');",
    'SELECT COUNT(*) AS active_leases FROM publication_leases',
    'WHERE owner_token IS NOT NULL',
    "AND expires_at_ms > CAST(strftime('%s','now') AS INTEGER) * 1000;",
    "SELECT json_extract(value, '$.inflight') AS inflight",
    "FROM runtime_metadata WHERE key='state.snapshot_json';",
    "SELECT json_extract(value, '$.scheduledTime') AS scheduled_time,",
    "json_extract(value, '$.observedAt') AS observed_at,updated_at",
    "FROM runtime_metadata WHERE key='scheduler.last_invocation';",
    "SELECT content_id,state,reason,deferred_at,replacement_assignment_version",
    "FROM queue_deferrals WHERE state='pending_replacement'",
    'ORDER BY deferred_at,content_id;',
    eventClause,
  ].join(' ');
}

function durableFact(raw) {
  const payload = parseJsonOutput(raw);
  const halt = firstD1Row(payload, 0);
  const authority = firstD1Row(payload, 1);
  const unresolved = Number(firstD1Row(payload, 2)?.unresolved ?? -1);
  const activeLeases = Number(firstD1Row(payload, 3)?.active_leases ?? -1);
  const inflight = firstD1Row(payload, 4)?.inflight ?? null;
  const heartbeat = firstD1Row(payload, 5) ?? null;
  const pendingDeferrals = payload?.[6]?.results ?? [];
  const eventRow = firstD1Row(payload, 7);
  const publicationEventCount = Number(
    eventRow?.post_clear_events ??
    eventRow?.publication_events ??
    -1,
  );
  return {
    halt,
    authority,
    unresolved,
    activeLeases,
    inflight,
    heartbeat,
    pendingDeferrals,
    publicationEventCount,
  };
}

async function waitForDurablePostClear(
  ctx,
  {
    clearAt,
    clearedGeneration,
    headSha,
    expectedDeploymentId,
    expectDeferral = null,
    timeoutMs = 17 * 60 * 1000,
    pollMs = 15 * 1000,
  },
) {
  assertNoAmbiguousStep(ctx);
  const name = 'durable-postclear-proof';
  const prior = ctx.state.steps[name];
  if (prior?.status === 'pass') {
    printStep(name, 'SKIP', 'already proven');
    return prior.fact;
  }

  const stdoutFile = stepFile(ctx, name, 'stdout');
  const stderrFile = stepFile(ctx, name, 'stderr');
  const startedAt = nowIso();
  const output = [];
  const errors = [];
  const deadline = Date.now() + timeoutMs;
  const clearMs = Date.parse(clearAt);

  printStep(
    name,
    'RUN',
    'polling durable scheduler/deferral evidence until acceptance is proven',
  );

  while (Date.now() < deadline) {
    const queryArgs = [
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
      durableSql(clearAt),
    ];
    const result = spawnSync('pnpm', queryArgs, {
      cwd: process.cwd(),
      env: process.env,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });

    output.push(
      '\n=== poll ' + nowIso() + ' ===\n' +
      String(result.stdout ?? ''),
    );
    errors.push(String(result.stderr ?? ''));

    if (!result.error && result.status === 0) {
      let fact = null;
      try {
        fact = durableFact(result.stdout);
      } catch {
        fact = null;
      }

      if (fact) {
        const haltExact =
          Number(fact.halt?.halted) === 0 &&
          Number(fact.halt?.generation) === clearedGeneration &&
          fact.halt?.actor_class === 'owner';
        const authorityExact =
          fact.authority?.owner === 'cloudflare' &&
          fact.authority?.transition_state === 'stable' &&
          String(fact.authority?.candidate_sha ?? '').toLowerCase() === headSha &&
          fact.authority?.deployment_id === expectedDeploymentId;
        const stateClean =
          fact.unresolved === 0 &&
          fact.activeLeases === 0 &&
          fact.inflight === null;
        const heartbeatMs = Date.parse(fact.heartbeat?.observed_at ?? '');
        const freshHeartbeat =
          Number.isFinite(heartbeatMs) &&
          Number.isFinite(clearMs) &&
          heartbeatMs > clearMs;
        const deferralExact =
          !expectDeferral ||
          fact.pendingDeferrals.some(
            (row) =>
              row?.content_id === expectDeferral &&
              row?.state === 'pending_replacement',
          );
        const noPublicationTransaction =
          !expectDeferral || fact.publicationEventCount === 0;

        if (!haltExact || !authorityExact) {
          writeFileSync(stdoutFile, output.join(''), 'utf8');
          writeFileSync(stderrFile, errors.join(''), 'utf8');
          ctx.state.steps[name] = {
            status: 'fail',
            mutation: false,
            command: commandText('pnpm', queryArgs),
            startedAt,
            finishedAt: nowIso(),
            exitCode: 1,
            stdoutFile,
            stderrFile,
            error: 'post-clear authority/halt state changed unexpectedly',
            fact,
          };
          ctx.save();
          fail('post-clear authority/halt state changed unexpectedly');
        }

        if (
          fact.unresolved > 0 ||
          fact.activeLeases > 0 ||
          fact.inflight !== null
        ) {
          writeFileSync(stdoutFile, output.join(''), 'utf8');
          writeFileSync(stderrFile, errors.join(''), 'utf8');
          ctx.state.steps[name] = {
            status: 'fail',
            mutation: false,
            command: commandText('pnpm', queryArgs),
            startedAt,
            finishedAt: nowIso(),
            exitCode: 1,
            stdoutFile,
            stderrFile,
            error: 'post-clear publication residue is not clean',
            fact,
          };
          ctx.save();
          fail('post-clear publication residue is not clean');
        }

        if (
          stateClean &&
          freshHeartbeat &&
          deferralExact &&
          noPublicationTransaction
        ) {
          writeFileSync(stdoutFile, output.join(''), 'utf8');
          writeFileSync(stderrFile, errors.join(''), 'utf8');
          ctx.state.steps[name] = {
            status: 'pass',
            mutation: false,
            command: commandText('pnpm', queryArgs),
            startedAt,
            finishedAt: nowIso(),
            exitCode: 0,
            stdoutFile,
            stderrFile,
            fact,
          };
          ctx.save();
          printStep(name, 'PASS');
          return fact;
        }
      }
    }

    await new Promise((resolveSleep) => setTimeout(resolveSleep, pollMs));
  }

  writeFileSync(stdoutFile, output.join(''), 'utf8');
  writeFileSync(stderrFile, errors.join(''), 'utf8');
  ctx.state.steps[name] = {
    status: 'fail',
    mutation: false,
    command: 'durable post-clear polling',
    startedAt,
    finishedAt: nowIso(),
    exitCode: 1,
    stdoutFile,
    stderrFile,
    error: 'timed out waiting for durable post-clear acceptance evidence',
  };
  ctx.save();
  fail('timed out waiting for durable post-clear acceptance evidence');
}

function countResult(raw, key = 'n') {
  const payload = parseJsonOutput(raw);
  return Number(firstD1Row(payload)?.[key] ?? -1);
}

function writeSummary(ctx) {
  const summary = {
    status: ctx.state.status,
    headSha: ctx.state.headSha,
    evidenceDir: ctx.evidenceDir,
    facts: ctx.state.facts,
    steps: Object.fromEntries(
      Object.entries(ctx.state.steps).map(([name, step]) => [
        name,
        {
          status: step.status,
          mutation: step.mutation,
          finishedAt: step.finishedAt,
          stdoutFile: step.stdoutFile,
          stderrFile: step.stderrFile,
        },
      ]),
    ),
  };
  writeJson(join(ctx.evidenceDir, 'summary.json'), summary);

  const text = [
    'XQueue production acceptance',
    'status=' + ctx.state.status,
    'head=' + ctx.state.headSha,
    'evidence_dir=' + ctx.evidenceDir,
    'halt=' + JSON.stringify(ctx.state.facts.halt ?? null),
    'authority=' + JSON.stringify(ctx.state.facts.authority ?? null),
    'new_version_id=' + String(ctx.state.facts.newVersionId ?? ''),
    'halted_scheduler=' + JSON.stringify(ctx.state.facts.haltedScheduler ?? null),
    'post_clear_durable=' + JSON.stringify(ctx.state.facts.postClearDurable ?? null),
    'runtime_evidence=' + String(ctx.state.facts.runtimeEvidence ?? ''),
    'deployment_evidence=' + String(ctx.state.facts.deploymentEvidence ?? ''),
    'backup_evidence=' + String(ctx.state.facts.backupEvidence ?? ''),
    'restore_evidence=' + String(ctx.state.facts.restoreEvidence ?? ''),
  ].join('\n') + '\n';
  writeFileSync(join(ctx.evidenceDir, 'SUMMARY.txt'), text, 'utf8');
}

async function main() {
  const apply = flag('apply');
  const release = flag('release');
  const confirm = opt('confirm');
  const expectDeferral = opt('expect-deferral');

  if (release && !apply) {
    fail('--release requires --apply');
  }
  if (apply && confirm !== 'xqueue-production-acceptance') {
    fail(
      '--apply requires --confirm xqueue-production-acceptance',
    );
  }

  if (flag('sync-main')) {
    console.log('[BOOT] syncing clean local main');
    syncMain();
  }

  if (gitBranch() !== 'main') {
    fail('production acceptance must run from local main');
  }
  ensureCleanWorktree();

  const headSha = gitHead();
  const ctx = createContext(headSha);
  assertNoAmbiguousStep(ctx);

  console.log('Evidence directory: ' + ctx.evidenceDir);
  console.log('Candidate HEAD:     ' + headSha);
  console.log('Mode:               ' + (apply ? (release ? 'APPLY+RELEASE' : 'APPLY') : 'OBSERVE'));

  runStep(ctx, 'auth-preflight', 'pnpm', [
    'cf:auth:preflight',
    '--environment',
    'production',
  ]);
  runStep(ctx, 'authority-audit', 'pnpm', ['audit:authority']);
  runStep(ctx, 'credential-audit', 'pnpm', ['audit:credentials']);

  const haltStatus = runStep(ctx, 'halt-status-initial', 'pnpm', [
    'halt:status',
    '--environment',
    'production',
  ]);
  const initialHalt = haltFact(haltStatus.stdout);
  ctx.state.facts.initialHalt = initialHalt;
  ctx.state.facts.halt = initialHalt;
  ctx.save();

  if (
    initialHalt.halted !== 1 ||
    initialHalt.actorClass !== 'owner'
  ) {
    fail('production must be owner-halted before acceptance mutation');
  }

  const authorityRead = runStep(ctx, 'authority-read-initial', 'pnpm', [
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
    'SELECT owner,generation,transition_state,candidate_sha,deployment_id FROM authority_state WHERE singleton_id=1;',
  ]);
  const initialAuthority = authorityFact(authorityRead.stdout);
  ctx.state.facts.initialAuthority = initialAuthority;
  ctx.state.facts.authority = initialAuthority;
  ctx.save();

  if (
    initialAuthority.owner !== 'cloudflare' ||
    initialAuthority.transitionState !== 'stable'
  ) {
    fail('current durable authority is not stable Cloudflare');
  }

  const rollbackVersionId = versionIdFromDeploymentId(
    initialAuthority.deploymentId,
  );
  ctx.state.facts.rollbackVersionId = rollbackVersionId;
  ctx.save();

  const rollbackView = runStep(ctx, 'rollback-version-proof', 'pnpm', [
    'wrangler',
    'versions',
    'view',
    rollbackVersionId,
    '--config',
    'wrangler.authority.jsonc',
    '--json',
  ]);
  ctx.state.facts.rollbackVersion = validateVersionView(
    rollbackView.stdout,
    rollbackVersionId,
    initialAuthority.candidateSha,
  );
  ctx.save();

  const serviceEnabled = runStep(
    ctx,
    'local-service-enabled',
    'systemctl',
    ['--user', 'is-enabled', 'xqueue.service'],
    { allowNonZero: true },
  ).stdout.trim();
  const serviceActive = runStep(
    ctx,
    'local-service-active',
    'systemctl',
    ['--user', 'is-active', 'xqueue.service'],
    { allowNonZero: true },
  ).stdout.trim();
  const timerEnabled = runStep(
    ctx,
    'local-timer-enabled',
    'systemctl',
    ['--user', 'is-enabled', 'xqueue.timer'],
    { allowNonZero: true },
  ).stdout.trim();
  const timerActive = runStep(
    ctx,
    'local-timer-active',
    'systemctl',
    ['--user', 'is-active', 'xqueue.timer'],
    { allowNonZero: true },
  ).stdout.trim();

  ctx.state.facts.localAuthority = {
    serviceEnabled,
    serviceActive,
    timerEnabled,
    timerActive,
  };
  ctx.save();

  if (
    serviceEnabled !== 'disabled' ||
    serviceActive !== 'inactive' ||
    timerEnabled !== 'disabled' ||
    timerActive !== 'inactive'
  ) {
    fail('local service/timer publication authority is not fully retired');
  }

  if (!apply) {
    ctx.state.status = 'observed';
    ctx.save();
    writeSummary(ctx);
    console.log('OBSERVE COMPLETE — no production mutation performed');
    console.log('Evidence: ' + ctx.evidenceDir);
    return;
  }

  runStep(
    ctx,
    'deploy-status-worker',
    'pnpm',
    ['wrangler', 'deploy', '--config', 'wrangler.status.jsonc'],
    { mutation: true },
  );

  const upload = runStep(
    ctx,
    'upload-publisher-version',
    'pnpm',
    [
      'wrangler',
      'versions',
      'upload',
      '--config',
      'wrangler.authority.jsonc',
      '--tag',
      headSha,
      '--message',
      'XQueue production acceptance ' + headSha,
    ],
    { mutation: true },
  );

  const newVersionId =
    ctx.state.facts.newVersionId ?? parseWorkerVersionId(upload.stdout);
  ctx.state.facts.newVersionId = newVersionId;
  ctx.save();

  const newView = runStep(ctx, 'new-version-proof', 'pnpm', [
    'wrangler',
    'versions',
    'view',
    newVersionId,
    '--config',
    'wrangler.authority.jsonc',
    '--json',
  ]);
  ctx.state.facts.newVersion = validateVersionView(
    newView.stdout,
    newVersionId,
    headSha,
  );
  ctx.save();

  runStep(
    ctx,
    'authority-rebind',
    'pnpm',
    [
      'production:authority',
      'rebind',
      '--expected-halt-generation=' + initialHalt.generation,
      '--deployment-id=cloudflare-worker:xqueue-publisher-production:version:' + newVersionId,
      '--confirm=xqueue-production-authority-rebind',
    ],
    { mutation: true },
  );

  const postRebindHaltRun = runStep(ctx, 'halt-status-post-rebind', 'pnpm', [
    'halt:status',
    '--environment',
    'production',
  ]);
  const postRebindHalt = haltFact(postRebindHaltRun.stdout);
  if (
    postRebindHalt.halted !== 1 ||
    postRebindHalt.generation !== initialHalt.generation ||
    postRebindHalt.actorClass !== 'owner'
  ) {
    fail('owner halt changed unexpectedly during authority rebind');
  }
  ctx.state.facts.halt = postRebindHalt;
  ctx.save();

  runStep(
    ctx,
    'promote-publisher-version',
    'pnpm',
    [
      'wrangler',
      'versions',
      'deploy',
      newVersionId + '@100%',
      '--config',
      'wrangler.authority.jsonc',
      '--message',
      'XQueue production acceptance ' + headSha,
      '--yes',
    ],
    { mutation: true },
  );

  runStep(
    ctx,
    'deploy-publisher-triggers',
    'pnpm',
    ['wrangler', 'triggers', 'deploy', '--config', 'wrangler.authority.jsonc'],
    { mutation: true },
  );

  const haltedScheduler = await runTailStep(
    ctx,
    'halted-scheduler-proof',
    'xqueue-publisher-production',
    newVersionId,
    (event) =>
      event?.event === 'scheduled' &&
      event?.heartbeatRecorded === true &&
      event?.schedulerAuthority === true &&
      event?.result?.reason === 'publication_halted' &&
      event?.result?.dispatched === false &&
      Number(event?.result?.halt?.generation) === initialHalt.generation,
  );
  ctx.state.facts.haltedScheduler = haltedScheduler;
  ctx.save();

  const preclear = runStep(ctx, 'durable-preclear-proof', 'pnpm', [
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
    durableSql(),
  ]);
  const preclearFact = durableFact(preclear.stdout);
  ctx.state.facts.preclear = preclearFact;
  ctx.save();

  const expectedDeploymentId =
    'cloudflare-worker:xqueue-publisher-production:version:' + newVersionId;
  if (
    Number(preclearFact.halt?.halted) !== 1 ||
    Number(preclearFact.halt?.generation) !== initialHalt.generation ||
    preclearFact.halt?.actor_class !== 'owner' ||
    preclearFact.authority?.owner !== 'cloudflare' ||
    preclearFact.authority?.transition_state !== 'stable' ||
    String(preclearFact.authority?.candidate_sha ?? '').toLowerCase() !== headSha ||
    preclearFact.authority?.deployment_id !== expectedDeploymentId ||
    preclearFact.unresolved !== 0 ||
    preclearFact.activeLeases !== 0 ||
    preclearFact.inflight !== null
  ) {
    fail('durable pre-clear state is not acceptance-clean');
  }

  const postRebindAuthorityGeneration =
    Number(preclearFact.authority?.generation);
  if (!Number.isSafeInteger(postRebindAuthorityGeneration)) {
    fail('post-rebind authority generation is invalid');
  }
  ctx.state.facts.authority = {
    owner: preclearFact.authority.owner,
    generation: postRebindAuthorityGeneration,
    transitionState: preclearFact.authority.transition_state,
    candidateSha: String(preclearFact.authority.candidate_sha).toLowerCase(),
    deploymentId: preclearFact.authority.deployment_id,
  };
  ctx.save();

  if (!release) {
    ctx.state.status = 'ready_for_release';
    ctx.save();
    writeSummary(ctx);
    console.log('STAGED COMPLETE — owner halt remains set');
    console.log('Evidence: ' + ctx.evidenceDir);
    return;
  }

  const clear = runStep(
    ctx,
    'clear-owner-halt',
    'pnpm',
    [
      'halt:clear',
      '--environment',
      'production',
      '--expected-generation',
      String(initialHalt.generation),
      '--reason',
      'Production acceptance passed on exact candidate ' + headSha,
      '--apply',
      '--confirm',
      'xqueue-production-owner-clear',
    ],
    { mutation: true },
  );
  const clearPayload = parseJsonOutput(clear.stdout);
  const clearRows = Array.isArray(clearPayload)
    ? clearPayload.flatMap((item) => item?.results ?? [])
    : [];
  const clearRow = [...clearRows].reverse().find(
    (row) => row && Object.hasOwn(row, 'halted'),
  );
  if (!clearRow) fail('halt clear did not return final halt readback');

  const clearedHalt = {
    halted: Number(clearRow.halted),
    generation: Number(clearRow.generation),
    actorClass: clearRow.actor_class,
    reason: clearRow.reason,
    updatedAt: clearRow.updated_at,
  };
  if (
    clearedHalt.halted !== 0 ||
    clearedHalt.generation !== initialHalt.generation + 1 ||
    clearedHalt.actorClass !== 'owner'
  ) {
    fail('halt clear readback is not exact');
  }
  ctx.state.facts.clearAt = clearedHalt.updatedAt;
  ctx.state.facts.halt = clearedHalt;
  ctx.save();

  const postClearFact = await waitForDurablePostClear(
    ctx,
    {
      clearAt: clearedHalt.updatedAt,
      clearedGeneration: clearedHalt.generation,
      headSha,
      expectedDeploymentId,
      expectDeferral,
    },
  );
  ctx.state.facts.postClear = postClearFact;
  ctx.state.facts.postClearDurable = {
    heartbeat: postClearFact.heartbeat,
    pendingDeferrals: postClearFact.pendingDeferrals,
    publicationEventCount: postClearFact.publicationEventCount,
  };
  ctx.save();

  const health = runStep(ctx, 'production-health', 'curl', [
    '-sS',
    'https://xqueue-production.patrickcraven.workers.dev/health',
  ]);
  const healthJson = parseJsonOutput(health.stdout);
  ctx.state.facts.health = healthJson;
  ctx.save();
  if (healthJson?.status !== 'ok') {
    fail('production /health is not ok after post-clear scheduler observation');
  }

  const runtimeEvidence = join(ctx.evidenceDir, 'tsal-runtime-evidence.json');
  const runtime = runStep(ctx, 'tsal-runtime-evidence', 'node', [
    'scripts/tsal-runtime-evidence.mjs',
    '--output',
    runtimeEvidence,
    '--observer-commit',
    headSha,
  ]);
  void runtime;
  const runtimeJson = loadJson(runtimeEvidence);
  if (runtimeJson.result !== 'pass') {
    fail('TSAL runtime evidence did not pass');
  }
  ctx.state.facts.runtimeEvidence = runtimeEvidence;
  ctx.save();

  const deploymentEvidence = join(
    ctx.evidenceDir,
    'tsal-deployment-evidence.json',
  );
  runStep(ctx, 'tsal-deployment-evidence', 'node', [
    'scripts/tsal-deployment-evidence.mjs',
    '--output',
    deploymentEvidence,
    '--observer-commit',
    headSha,
  ]);
  const deploymentJson = loadJson(deploymentEvidence);
  if (deploymentJson.result !== 'pass') {
    fail('TSAL deployment evidence did not pass');
  }
  ctx.state.facts.deploymentEvidence = deploymentEvidence;
  ctx.save();

  const beforeCountRun = runStep(ctx, 'publication-event-count-before-backup', 'pnpm', [
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
    'SELECT COUNT(*) AS n FROM publication_events;',
  ]);
  const eventsBefore = countResult(beforeCountRun.stdout);
  if (eventsBefore < 0) fail('pre-backup publication event count is invalid');

  const backup = join(ctx.evidenceDir, 'production-backup.json');
  const backupEvidence = join(ctx.evidenceDir, 'production-backup-evidence.json');
  runStep(ctx, 'production-logical-backup', 'pnpm', [
    'd1:backup',
    '--environment',
    'production',
    '--output',
    backup,
    '--evidence',
    backupEvidence,
    '--confirm',
    'xqueue-production-backup',
  ]);
  ctx.state.facts.backupEvidence = backupEvidence;
  ctx.save();

  const restoreEvidence = join(ctx.evidenceDir, 'production-restore-proof.json');
  runStep(ctx, 'isolated-restore-proof', 'pnpm', [
    'd1:restore-proof',
    '--backup',
    backup,
    '--evidence',
    restoreEvidence,
  ]);
  ctx.state.facts.restoreEvidence = restoreEvidence;
  ctx.save();

  const afterCountRun = runStep(ctx, 'publication-event-count-after-backup', 'pnpm', [
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
    'SELECT COUNT(*) AS n FROM publication_events;',
  ]);
  const eventsAfter = countResult(afterCountRun.stdout);
  if (eventsAfter !== eventsBefore) {
    fail(
      'publication event count changed during backup/restore proof; ' +
      'do not accept this backup as final recovery evidence',
    );
  }

  ctx.state.facts.backupEventCount = eventsBefore;
  ctx.state.status = 'complete';
  ctx.state.completedAt = nowIso();
  ctx.save();
  writeSummary(ctx);

  console.log('');
  console.log('============================================================');
  console.log(' XQUEUE PRODUCTION ACCEPTANCE: READY=1');
  console.log('============================================================');
  console.log('head=' + headSha);
  console.log('version=' + newVersionId);
  console.log('halt_generation=' + clearedHalt.generation);
  console.log('authority_generation=' + postRebindAuthorityGeneration);
  console.log('evidence=' + ctx.evidenceDir);
  console.log('summary=' + join(ctx.evidenceDir, 'summary.json'));
}

if (import.meta.url === new URL(process.argv[1], 'file:').href) {
  main().catch((error) => {
    console.error('');
    console.error('XQUEUE PRODUCTION ACCEPTANCE: STOP');
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
