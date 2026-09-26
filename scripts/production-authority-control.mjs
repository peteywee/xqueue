#!/usr/bin/env node

import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  compileProductionAuthorityBootstrapSql,
  compileProductionCloudflareRebindSql,
  compileProductionNoneToCloudflareSql,
  parseProductionPublisherDeploymentId,
} from '../src/production-authority-sql.mjs';

const DB = 'xqueue-production';
const CONFIG = 'wrangler.prep.jsonc';
const AUTHORITY_CONFIG = 'wrangler.authority.jsonc';
const CONFIRM_BOOTSTRAP = 'xqueue-production-authority-bootstrap';
const CONFIRM_TRANSFER = 'xqueue-production-authority-transfer';
const CONFIRM_REBIND = 'xqueue-production-authority-rebind';

function run(invocation) {
  return new Promise((resolvePromise) => {
    execFile(invocation.command, invocation.args, {
      encoding: 'utf8',
      maxBuffer: 4 * 1024 * 1024,
      windowsHide: true,
      env: process.env,
    }, (error, stdout, stderr) => {
      resolvePromise({
        exitCode: error ? (Number.isSafeInteger(error.code) ? error.code : 1) : 0,
        stdout: typeof stdout === 'string' ? stdout : '',
        stderr: typeof stderr === 'string' ? stderr : '',
      });
    });
  });
}

async function checked(invocation, label) {
  const result = await run(invocation);
  if (result.exitCode !== 0) {
    throw new Error(`${label} failed: ${(result.stderr || result.stdout).trim()}`);
  }
  return result.stdout;
}

function d1(sql) {
  return checked({
    command: 'pnpm',
    args: [
      'wrangler','d1','execute',DB,
      '--config',CONFIG,
      '--remote','--yes','--json',
      '--command',sql,
    ],
  }, 'production D1 command');
}

function parseRows(stdout) {
  const parsed = JSON.parse(stdout);
  const statements = Array.isArray(parsed) ? parsed : [parsed];
  const rows = [];
  for (const statement of statements) {
    if (statement?.success !== true || !Array.isArray(statement.results)) {
      throw new Error('Wrangler D1 statement did not report success');
    }
    rows.push(statement.results);
  }
  return rows;
}

function argsMap(argv) {
  const out = new Map();
  for (const arg of argv) {
    const i = arg.indexOf('=');
    if (i > 0 && arg.startsWith('--')) out.set(arg.slice(2, i), arg.slice(i + 1));
    else if (!out.has('action')) out.set('action', arg);
  }
  return out;
}

async function git(args) {
  return (await checked({ command:'git', args }, 'git check')).trim();
}

async function assertStaticSafety({ expectedHaltGeneration }) {
  const branch = await git(['branch','--show-current']);
  if (branch !== 'main') throw new Error('production authority control requires branch main');

  const status = await git(['status','--porcelain','--untracked-files=all']);
  if (status.length !== 0) throw new Error('production authority control requires a clean worktree');

  const head = await git(['rev-parse','HEAD']);
  if (!/^[0-9a-f]{40}$/i.test(head)) throw new Error('git HEAD is invalid');

  const safetySql = `
SELECT type,name FROM sqlite_master
WHERE
  (type='table' AND name IN ('authority_events','authority_state'))
  OR (type='trigger' AND name='authority_events_project_state')
ORDER BY type,name;
SELECT halted,generation,actor_class FROM publication_halt_state WHERE singleton_id=1;
SELECT COUNT(*) AS unresolved FROM publication_state
WHERE status IN ('prepared','publishing','needs_reconciliation');
SELECT COUNT(*) AS active_leases FROM publication_leases
WHERE owner_token IS NOT NULL AND expires_at_ms > ${Date.now()};
SELECT value FROM runtime_metadata WHERE key='state.snapshot_json' LIMIT 1;
`;
  const [schemaRows, haltRows, unresolvedRows, leaseRows, mirrorRows] =
    parseRows(await d1(safetySql));

  const schema = schemaRows
    .map((row) => `${row.type}:${row.name}`)
    .sort();
  const expectedSchema = [
    'table:authority_events',
    'table:authority_state',
    'trigger:authority_events_project_state',
  ].sort();

  if (JSON.stringify(schema) !== JSON.stringify(expectedSchema)) {
    throw new Error(`authority schema is not exact: ${JSON.stringify(schema)}`);
  }

  const halt = haltRows[0];
  if (
    Number(halt?.halted) !== 1 ||
    Number(halt?.generation) !== Number(expectedHaltGeneration) ||
    halt?.actor_class !== 'owner'
  ) throw new Error('global publication halt proof failed');

  if (Number(unresolvedRows[0]?.unresolved ?? -1) !== 0) {
    throw new Error('unresolved publication attempt exists');
  }
  if (Number(leaseRows[0]?.active_leases ?? -1) !== 0) {
    throw new Error('active publication lease exists');
  }

  const mirrorRaw = mirrorRows[0]?.value;
  if (typeof mirrorRaw !== 'string' || mirrorRaw.length === 0) {
    throw new Error('production mirror is missing');
  }
  const mirror = JSON.parse(mirrorRaw);
  if (mirror?.inflight !== null) {
    throw new Error('production mirror has inflight publication');
  }

  return {
    head: head.toLowerCase(),
    mirrorRaw,
    haltGeneration:Number(halt.generation),
  };
}

async function readAuthority() {
  const sql = `
SELECT singleton_id,owner,generation,transition_state,transition_id,previous_owner,
candidate_sha,deployment_id,transitioned_at,updated_at
FROM authority_state WHERE singleton_id=1;
SELECT generation,transition_id,previous_owner,next_owner,transition_state,
candidate_sha,deployment_id,event_at,detail
FROM authority_events ORDER BY generation DESC LIMIT 1;
`;
  const [stateRows,eventRows] = parseRows(await d1(sql));
  return { state: stateRows[0] ?? null, event: eventRows[0] ?? null };
}

async function executeOneStatement(sql) {
  const rows = parseRows(await d1(sql));
  if (rows.length !== 1) {
    throw new Error('authority mutation returned unexpected statement count');
  }
  if (rows[0].length !== 1) {
    throw new Error('authority mutation did not append exactly one event');
  }
  return rows[0][0];
}

function exactBootstrap(authority, head, transitionId, eventAt) {
  const s=authority.state, e=authority.event;
  return Boolean(
    s && e &&
    s.owner==='none' && Number(s.generation)===1 && s.transition_state==='stable' &&
    s.transition_id===transitionId && s.previous_owner===null &&
    String(s.candidate_sha).toLowerCase()===head && s.deployment_id===null &&
    s.transitioned_at===eventAt &&
    Number(e.generation)===1 && e.transition_id===transitionId &&
    e.previous_owner===null && e.next_owner==='none' && e.transition_state==='stable' &&
    String(e.candidate_sha).toLowerCase()===head && e.deployment_id===null &&
    e.event_at===eventAt
  );
}

function exactTransfer(authority, head, deploymentId, transitionId, eventAt) {
  const s=authority.state, e=authority.event;
  return Boolean(
    s && e &&
    s.owner==='cloudflare' && Number(s.generation)===2 && s.transition_state==='stable' &&
    s.transition_id===transitionId && s.previous_owner==='none' &&
    String(s.candidate_sha).toLowerCase()===head && s.deployment_id===deploymentId &&
    s.transitioned_at===eventAt &&
    Number(e.generation)===2 && e.transition_id===transitionId &&
    e.previous_owner==='none' && e.next_owner==='cloudflare' && e.transition_state==='stable' &&
    String(e.candidate_sha).toLowerCase()===head && e.deployment_id===deploymentId &&
    e.event_at===eventAt
  );
}

function exactRebind(
  authority,
  head,
  deploymentId,
  transitionId,
  eventAt,
  generation,
) {
  const s=authority.state, e=authority.event;
  return Boolean(
    s && e &&
    s.owner==='cloudflare' && Number(s.generation)===generation &&
    s.transition_state==='stable' &&
    s.transition_id===transitionId && s.previous_owner==='cloudflare' &&
    String(s.candidate_sha).toLowerCase()===head && s.deployment_id===deploymentId &&
    s.transitioned_at===eventAt &&
    Number(e.generation)===generation && e.transition_id===transitionId &&
    e.previous_owner==='cloudflare' && e.next_owner==='cloudflare' &&
    e.transition_state==='stable' &&
    String(e.candidate_sha).toLowerCase()===head && e.deployment_id===deploymentId &&
    e.event_at===eventAt
  );
}

async function assertPublisherVersion(deploymentId, head) {
  const parsedIdentity = parseProductionPublisherDeploymentId(deploymentId);
  const stdout = await checked({
    command:'pnpm',
    args:[
      'wrangler','versions','view',parsedIdentity.versionId,
      '--config',AUTHORITY_CONFIG,'--json',
    ],
  }, 'publisher Worker version inspection');

  let version;
  try {
    version = JSON.parse(stdout);
  } catch {
    throw new Error('publisher Worker version inspection did not return JSON');
  }

  if (String(version?.id ?? '').toLowerCase() !== parsedIdentity.versionId) {
    throw new Error('publisher Worker version ID does not match deployment identity');
  }
  if (String(version?.annotations?.['workers/tag'] ?? '').toLowerCase() !== head) {
    throw new Error('publisher Worker version tag does not match exact git HEAD');
  }

  const bindings = Array.isArray(version?.resources?.bindings)
    ? version.resources.bindings
    : [];

  const authorityBinding = bindings.find(
    (binding) => binding?.name === 'XQUEUE_PUBLISH_AUTHORITY',
  );
  if (
    authorityBinding?.type !== 'plain_text' ||
    authorityBinding?.text !== 'enabled'
  ) {
    throw new Error('publisher Worker version is not authority-enabled');
  }

  const metadataBinding = bindings.find(
    (binding) => binding?.name === 'CF_VERSION_METADATA',
  );
  if (!metadataBinding) {
    throw new Error('publisher Worker version lacks CF_VERSION_METADATA binding');
  }

  return parsedIdentity.versionId;
}

export async function main(argv = process.argv.slice(2)) {
  const args=argsMap(argv);
  const action=args.get('action');
  const expectedHaltGeneration=Number(args.get('expected-halt-generation'));
  const confirm=args.get('confirm');
  if (!Number.isSafeInteger(expectedHaltGeneration) || expectedHaltGeneration < 1) {
    throw new Error('--expected-halt-generation=<n> is required');
  }

  const safety=await assertStaticSafety({ expectedHaltGeneration });
  const before=await readAuthority();

  if (action==='bootstrap') {
    if (confirm!==CONFIRM_BOOTSTRAP) {
      throw new Error(`--confirm=${CONFIRM_BOOTSTRAP} is required`);
    }
    if (before.state || before.event) {
      throw new Error('production authority bootstrap requires empty tables');
    }

    const eventAt=new Date().toISOString();
    const transitionId=`production-bootstrap-none-${safety.head}`;
    await executeOneStatement(compileProductionAuthorityBootstrapSql({
      candidateSha:safety.head, transitionId, eventAt,
    }));

    const after=await readAuthority();
    if (!exactBootstrap(after,safety.head,transitionId,eventAt)) {
      throw new Error('production authority bootstrap readback mismatch');
    }

    console.log(JSON.stringify({
      ok:true,status:'confirmed_seeded_unowned',owner:'none',generation:1,
      candidateSha:safety.head,transitionId,eventAt,
      haltGeneration:safety.haltGeneration,
    },null,2));
    return;
  }

  if (action==='transfer') {
    if (confirm!==CONFIRM_TRANSFER) {
      throw new Error(`--confirm=${CONFIRM_TRANSFER} is required`);
    }
    const deploymentId=args.get('deployment-id');
    parseProductionPublisherDeploymentId(deploymentId);
    if (
      before.state?.owner!=='none' || Number(before.state?.generation)!==1 ||
      before.state?.transition_state!=='stable' ||
      before.event?.next_owner!=='none' || Number(before.event?.generation)!==1 ||
      String(before.state?.candidate_sha ?? '').toLowerCase()!==safety.head
    ) {
      throw new Error('production authority is not exact stable owner=none generation 1 at HEAD');
    }

    const eventAt=new Date().toISOString();
    const transitionId=`production-none-to-cloudflare-${safety.head}`;
    await executeOneStatement(compileProductionNoneToCloudflareSql({
      candidateSha:safety.head,deploymentId,transitionId,eventAt,
    }));

    const after=await readAuthority();
    if (!exactTransfer(after,safety.head,deploymentId,transitionId,eventAt)) {
      throw new Error('production authority transfer readback mismatch');
    }

    console.log(JSON.stringify({
      ok:true,status:'confirmed_cloudflare',owner:'cloudflare',generation:2,
      candidateSha:safety.head,deploymentId,transitionId,eventAt,
      haltGeneration:safety.haltGeneration,
    },null,2));
    return;
  }

  if (action==='rebind') {
    if (confirm!==CONFIRM_REBIND) {
      throw new Error(`--confirm=${CONFIRM_REBIND} is required`);
    }

    const deploymentId=args.get('deployment-id');
    parseProductionPublisherDeploymentId(deploymentId);

    const currentGeneration=Number(before.state?.generation);
    if (
      before.state?.owner!=='cloudflare' ||
      !Number.isSafeInteger(currentGeneration) ||
      currentGeneration < 2 ||
      before.state?.transition_state!=='stable' ||
      before.event?.next_owner!=='cloudflare' ||
      Number(before.event?.generation)!==currentGeneration ||
      before.event?.transition_id!==before.state?.transition_id ||
      String(before.event?.candidate_sha ?? '').toLowerCase() !==
        String(before.state?.candidate_sha ?? '').toLowerCase() ||
      before.event?.deployment_id!==before.state?.deployment_id
    ) {
      throw new Error('production authority is not an exact stable Cloudflare projection');
    }

    if (before.state?.deployment_id===deploymentId) {
      throw new Error(
        'production authority rebind requires a different publisher version identity',
      );
    }

    await assertPublisherVersion(deploymentId, safety.head);

    const previousCandidateSha=String(before.state.candidate_sha).toLowerCase();
    const previousDeploymentId=before.state.deployment_id;
    parseProductionPublisherDeploymentId(
      previousDeploymentId,
      'previousDeploymentId',
    );

    const nextGeneration=currentGeneration+1;
    const eventAt=new Date().toISOString();
    const transitionId=
      `production-cloudflare-rebind-g${nextGeneration}-${safety.head}`;

    await executeOneStatement(compileProductionCloudflareRebindSql({
      candidateSha:safety.head,
      deploymentId,
      previousCandidateSha,
      previousDeploymentId,
      expectedGeneration:currentGeneration,
      transitionId,
      eventAt,
    }));

    const after=await readAuthority();
    if (!exactRebind(
      after,
      safety.head,
      deploymentId,
      transitionId,
      eventAt,
      nextGeneration,
    )) {
      throw new Error('production authority rebind readback mismatch');
    }

    console.log(JSON.stringify({
      ok:true,
      status:'confirmed_cloudflare_rebound',
      owner:'cloudflare',
      generation:nextGeneration,
      previousGeneration:currentGeneration,
      previousCandidateSha,
      candidateSha:safety.head,
      previousDeploymentId,
      deploymentId,
      transitionId,
      eventAt,
      haltGeneration:safety.haltGeneration,
    },null,2));
    return;
  }

  throw new Error('action must be bootstrap, transfer, or rebind');
}

function isDirect() {
  return process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url);
}

if (isDirect()) {
  main().catch((error)=>{
    console.error('XQUEUE PRODUCTION AUTHORITY CONTROL: FAIL');
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode=1;
  });
}
