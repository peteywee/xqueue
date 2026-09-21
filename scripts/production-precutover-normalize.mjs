#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  ACTIVE_ASSIGNMENTS_SQL,
  APPROVED_UNSCHEDULED_SQL,
  buildDynamicRuntimeSnapshot,
  CURRENT_MEDIA_SQL,
  DEFERRED_ASSIGNMENTS_SQL,
  RUNTIME_STATE_SQL,
} from '../cloudflare/src/dynamic-runtime-integrity.mjs';
import { decodeBundledQueue } from '../cloudflare/src/queue-integrity.mjs';
import { nextRuntimeRevision, renderRuntimeRevisionInsertSql } from '../src/continuous-queue-runtime-write.mjs';
import {
  planPrecutoverStaleNormalization,
  renderPrecutoverStaleNormalizationSql,
  verifyPrecutoverNormalizationReadback,
} from '../src/precutover-stale-normalization.mjs';

const DB='xqueue-production';
const CONFIG='wrangler.prep.jsonc';
const APPROVAL='PREPARE_XQUEUE_PRODUCTION';

function run(args){
  const r=spawnSync('pnpm',args,{cwd:process.cwd(),env:process.env,encoding:'utf8',stdio:['ignore','pipe','pipe']});
  if(r.error) throw r.error;
  if(r.status!==0) throw new Error([r.stderr,r.stdout].filter(Boolean).join('\n')||'wrangler failed');
  return r.stdout||'';
}
function parse(stdout){
  const p=JSON.parse(stdout); const rows=[];
  for(const s of p){ if(s?.success!==true) throw new Error('D1 statement failed'); if(Array.isArray(s.results)) rows.push(...s.results); }
  return rows;
}
function query(sql){return parse(run(['wrangler','d1','execute',DB,'--config',CONFIG,'--remote','--yes','--json','--command',sql]));}
function execute(sql){
  const d=mkdtempSync(join(tmpdir(),'xqueue-precutover-normalize-')); const f=join(d,'op.sql');
  try{writeFileSync(f,sql,'utf8');run(['wrangler','d1','execute',DB,'--config',CONFIG,'--remote','--yes','--file',f]);}
  finally{rmSync(d,{recursive:true,force:true});}
}

async function main(){
  if(process.env.XQUEUE_PRODUCTION_PREP_APPROVED!==APPROVAL) throw new Error('explicit production prep approval required');

  const snapshot=query("SELECT value FROM runtime_metadata WHERE key='state.snapshot_json' LIMIT 1;")[0];
  if(!snapshot?.value) throw new Error('mirrored ledger missing');
  const ledger=JSON.parse(snapshot.value);

  const candidateSql=[
    'SELECT',
    ' a.assignment_id,a.assignment_version,a.content_id,a.content_revision,a.content_digest,',
    ' a.target_account,a.policy_version,a.resolved_at,a.scheduled_date,a.scheduled_time,',
    ' a.timezone,a.slot_label,a.status AS assignment_status,a.lifecycle_state,',
    ' a.generation AS assignment_generation,p.status AS publication_status,',
    ' p.generation AS publication_generation,d.state AS deferral_state',
    'FROM queue_assignments a',
    'LEFT JOIN publication_state p ON p.post_id=a.content_id',
    'LEFT JOIN queue_deferrals d ON d.content_id=a.content_id',
    "WHERE a.status='active' AND a.lifecycle_state='scheduled'",
    'ORDER BY a.resolved_at,a.content_id,a.assignment_version;'
  ].join(' ');
  const candidates=query(candidateSql);

  const now=new Date();
  const plan=planPrecutoverStaleNormalization({
    queue:decodeBundledQueue(),ledger,candidates,now,graceMinutes:20,policyVersion:2
  });

  if(plan.items.length===0){
    console.log('XQUEUE PRE-CUTOVER STALE NORMALIZATION: NOOP');
    return;
  }

  execute(renderPrecutoverStaleNormalizationSql(plan));

  const assignmentReadback=query([
    'SELECT assignment_id,assignment_version,content_id,policy_version,resolved_at,',
    ' lifecycle_state,generation AS assignment_generation',
    'FROM queue_assignments',
    "WHERE lifecycle_state='deferred'",
    'ORDER BY resolved_at,content_id;'
  ].join(' '));
  const deferralReadback=query('SELECT * FROM queue_deferrals ORDER BY content_id;');
  const snapshotReadback=query("SELECT value FROM runtime_metadata WHERE key='state.snapshot_json' LIMIT 1;")[0]?.value??null;

  if(!verifyPrecutoverNormalizationReadback(plan,{snapshotRaw:snapshotReadback,assignments:assignmentReadback,deferrals:deferralReadback}))
    throw new Error('stale normalization readback mismatch');

  const current=query(RUNTIME_STATE_SQL)[0]??null;
  const dynamic=await buildDynamicRuntimeSnapshot({
    assignments:query(ACTIVE_ASSIGNMENTS_SQL),
    approvedUnscheduled:query(APPROVED_UNSCHEDULED_SQL),
    media:query(CURRENT_MEDIA_SQL),
    deferred:query(DEFERRED_ASSIGNMENTS_SQL),
  });
  if(!current) throw new Error('runtime head missing');

  if(dynamic.revision_digest!==current.revision_digest){
    const rev=nextRuntimeRevision({
      currentState:current,snapshot:dynamic,sourceOperationId:'precutover-stale-normalization',recordedAt:plan.observedAt
    });
    execute(renderRuntimeRevisionInsertSql(rev));
    const observed=query(RUNTIME_STATE_SQL)[0];
    if(Number(observed?.generation)!==rev.generation||observed?.revision_digest!==rev.revision_digest)
      throw new Error('runtime revision promotion readback mismatch');
  }

  console.log('XQUEUE PRE-CUTOVER STALE NORMALIZATION: PASS');
  console.log('  deferred ' + plan.items.map(x=>x.contentId).join(','));
}
main().catch(e=>{console.error(e?.stack||String(e));process.exitCode=1;});
