import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import {
  assertFutureOwnerMutable, classifyCancelReadback, classifyRebindReadback, classifyRevisionReadback,
  planAssignmentCancel, planAssignmentRebind, planContentRevision,
  projectOwnerRuntimeRows,
  renderCancelSql, renderRebindSql, renderRevisionCreateSql, sha256Hex,
} from '../src/continuous-queue-owner-ops.mjs';

const NOW='2026-09-21T12:00:00.000Z';
const SLOT='2026-09-22T19:30:00.000Z';
const RUNTIME={generation:1,revision_digest:'f'.repeat(64)};
const exec=(db,sql)=>db.exec(`BEGIN IMMEDIATE;\n${sql}\nCOMMIT;`);

function fixture() {
  const db=new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE queue_content(content_id TEXT PRIMARY KEY,pillar TEXT,current_revision INTEGER,status TEXT,generation INTEGER,created_at TEXT,updated_at TEXT,intake_state TEXT);
    CREATE TABLE queue_content_revisions(content_id TEXT,revision INTEGER,title TEXT,body TEXT,publication_text TEXT,content_digest TEXT,figure INTEGER,source_ref TEXT,created_at TEXT,PRIMARY KEY(content_id,revision));
    CREATE TABLE queue_assignments(assignment_id TEXT,assignment_version INTEGER,content_id TEXT,content_revision INTEGER,content_digest TEXT,target_account TEXT,policy_version INTEGER,resolved_at TEXT,scheduled_date TEXT,scheduled_time TEXT,timezone TEXT,slot_label TEXT,status TEXT,superseded_by_version INTEGER,generation INTEGER,created_at TEXT,updated_at TEXT,PRIMARY KEY(assignment_id,assignment_version));
    CREATE UNIQUE INDEX active_content ON queue_assignments(content_id) WHERE status='active';
    CREATE UNIQUE INDEX active_slot ON queue_assignments(target_account,resolved_at) WHERE status='active';
    CREATE TABLE queue_content_events(id INTEGER PRIMARY KEY,content_id TEXT,revision INTEGER,event_type TEXT,event_at TEXT,detail TEXT);
    CREATE TABLE queue_assignment_events(id INTEGER PRIMARY KEY,assignment_id TEXT,assignment_version INTEGER,event_type TEXT,event_at TEXT,detail TEXT);
    CREATE TABLE queue_media_objects(content_id TEXT,content_revision INTEGER,media_ordinal INTEGER,figure INTEGER,logical_media_id TEXT,r2_key TEXT,extension TEXT,mime_type TEXT,byte_size INTEGER,sha256 TEXT,status TEXT,generation INTEGER,created_at TEXT,updated_at TEXT,PRIMARY KEY(content_id,content_revision,media_ordinal));
    CREATE TABLE publication_state(post_id TEXT PRIMARY KEY,status TEXT,scheduled_at TEXT,tweet_id TEXT,prepared_at TEXT,publishing_at TEXT,posted_at TEXT,skipped_at TEXT,skip_reason TEXT,last_error TEXT,updated_at TEXT,attempt_id TEXT,generation INTEGER);
    CREATE TABLE publication_events(id INTEGER PRIMARY KEY,post_id TEXT,event_type TEXT,event_at TEXT,detail TEXT);
    CREATE TABLE queue_runtime_revisions(generation INTEGER PRIMARY KEY,revision_digest TEXT);
  `);
  db.prepare("INSERT INTO queue_runtime_revisions VALUES(1,?)").run(RUNTIME.revision_digest);
  const d=sha256Hex('original body');
  db.prepare("INSERT INTO queue_content VALUES('A1','A',1,'active',1,?,?, 'scheduled')").run(NOW,NOW);
  db.prepare("INSERT INTO queue_content_revisions VALUES('A1',1,'Original','original body','original body',?,NULL,'fixture',?)").run(d,NOW);
  db.prepare("INSERT INTO queue_assignments VALUES('A1',1,'A1',1,?,'x-primary',2,?,'2026-09-22','14:30','America/Chicago','lull','active',NULL,1,?,?)").run(d,SLOT,NOW,NOW);
  db.prepare("INSERT INTO publication_state(post_id,status,scheduled_at,updated_at,attempt_id,generation) VALUES('A1','scheduled',?,?,NULL,1)").run(SLOT,NOW);
  return db;
}
function snap(db){return{
  content:db.prepare("SELECT * FROM queue_content WHERE content_id='A1'").get(),
  revision:db.prepare("SELECT * FROM queue_content_revisions WHERE content_id='A1' AND revision=(SELECT MAX(revision) FROM queue_content_revisions WHERE content_id='A1')").get(),
  activeAssignment:db.prepare("SELECT * FROM queue_assignments WHERE content_id='A1' AND status='active'").get(),
  publicationState:db.prepare("SELECT * FROM publication_state WHERE post_id='A1'").get(),
};}
function revise(db,body='corrected body'){
  const s=snap(db); const p=planContentRevision({content:s.content,currentRevision:s.revision,latestRevision:{revision:s.revision.revision},activeAssignment:s.activeAssignment,publicationState:s.publicationState,body,reason:'owner correction',now:NOW});
  exec(db,renderRevisionCreateSql(p,{recordedAt:NOW})); return p;
}

test('revision is immutable and does not silently move the committed assignment',()=>{
  const db=fixture(), before=snap(db);
  const p=planContentRevision({content:before.content,currentRevision:before.revision,latestRevision:{revision:1},activeAssignment:before.activeAssignment,publicationState:before.publicationState,body:'corrected body',reason:'fix typo',now:NOW});
  exec(db,renderRevisionCreateSql(p,{recordedAt:NOW})); const after=snap(db);
  assert.equal(after.content.current_revision,1); assert.equal(after.activeAssignment.content_revision,1);
  assert.equal(after.revision.revision,2); assert.equal(after.revision.content_digest,sha256Hex('corrected body'));
  assert.equal(classifyRevisionReadback(p,{content:after.content,revision:after.revision,assignment:after.activeAssignment}),'complete');
  exec(db,renderRevisionCreateSql(p,{recordedAt:NOW}));
  assert.equal(db.prepare("SELECT COUNT(*) n FROM queue_content_events WHERE event_type='revision_created'").get().n,1);
});

test('explicit rebind versions the assignment and preserves superseded history',()=>{
  const db=fixture(); revise(db); const s=snap(db), target=s.revision;
  const p=planAssignmentRebind({content:s.content,activeAssignment:s.activeAssignment,targetRevision:target,publicationState:s.publicationState,runtimeState:RUNTIME,reason:'activate correction',now:NOW});
  exec(db,renderRebindSql(p,{recordedAt:NOW}));
  const old=db.prepare("SELECT * FROM queue_assignments WHERE assignment_id='A1' AND assignment_version=1").get();
  const cur=db.prepare("SELECT * FROM queue_assignments WHERE assignment_id='A1' AND assignment_version=2").get();
  const content=db.prepare("SELECT * FROM queue_content WHERE content_id='A1'").get();
  assert.equal(old.status,'superseded'); assert.equal(cur.status,'active'); assert.equal(cur.content_revision,2); assert.equal(content.current_revision,2);
  assert.equal(classifyRebindReadback(p,{priorAssignment:old,activeAssignment:cur,content}),'complete');
});

test('owner cancellation preserves evidence and aligns publication_state skip',()=>{
  const db=fixture(), s=snap(db);
  const p=planAssignmentCancel({content:s.content,activeAssignment:s.activeAssignment,publicationState:s.publicationState,runtimeState:RUNTIME,reason:'owner withdrew future post',now:NOW});
  exec(db,renderCancelSql(p,{recordedAt:NOW}));
  const assignment=db.prepare("SELECT * FROM queue_assignments WHERE assignment_id='A1' AND assignment_version=1").get();
  const content=db.prepare("SELECT * FROM queue_content WHERE content_id='A1'").get();
  const publicationState=db.prepare("SELECT * FROM publication_state WHERE post_id='A1'").get();
  assert.equal(publicationState.status,'skipped'); assert.equal(publicationState.skip_reason,p.reason); assert.equal(publicationState.generation,2);
  assert.equal(classifyCancelReadback(p,{assignment,content,publicationState}),'complete');
  assert.equal(db.prepare("SELECT COUNT(*) n FROM publication_events WHERE event_type='owner_cancelled'").get().n,1);
});

test('due and non-scheduled publication states fail closed',()=>{
  const db=fixture(), s=snap(db);
  assert.throws(()=>assertFutureOwnerMutable({content:s.content,activeAssignment:s.activeAssignment,publicationState:s.publicationState,now:SLOT}),/due or past due/);
  for(const status of ['prepared','publishing','posted','needs_reconciliation','skipped']){
    assert.throws(()=>assertFutureOwnerMutable({content:s.content,activeAssignment:s.activeAssignment,publicationState:{...s.publicationState,status},now:NOW}),/publication_state/);
  }
  assert.throws(()=>assertFutureOwnerMutable({content:s.content,activeAssignment:s.activeAssignment,publicationState:{...s.publicationState,attempt_id:'attempt'},now:NOW}),/attempt/);
});

test('publication-state CAS race causes zero owner-state mutation and zero false evidence',()=>{
  for(const kind of ['revise','rebind','cancel']){
    const db=fixture(); let s=snap(db), p, sql;
    if(kind==='revise'){
      p=planContentRevision({content:s.content,currentRevision:s.revision,latestRevision:{revision:1},activeAssignment:s.activeAssignment,publicationState:s.publicationState,body:'race body',reason:'race',now:NOW});
      sql=renderRevisionCreateSql(p,{recordedAt:NOW});
    } else if(kind==='rebind'){
      revise(db,'race body'); s=snap(db);
      p=planAssignmentRebind({content:s.content,activeAssignment:s.activeAssignment,targetRevision:s.revision,publicationState:s.publicationState,runtimeState:RUNTIME,reason:'race',now:NOW});
      sql=renderRebindSql(p,{recordedAt:NOW});
    } else {
      p=planAssignmentCancel({content:s.content,activeAssignment:s.activeAssignment,publicationState:s.publicationState,runtimeState:RUNTIME,reason:'race',now:NOW});
      sql=renderCancelSql(p,{recordedAt:NOW});
    }
    db.exec("UPDATE publication_state SET status='prepared',generation=2 WHERE post_id='A1'"); exec(db,sql);
    assert.equal(db.prepare("SELECT status FROM queue_assignments WHERE assignment_id='A1' AND assignment_version=1").get().status,'active');
    assert.equal(db.prepare("SELECT COUNT(*) n FROM queue_assignment_events WHERE event_type LIKE 'owner_%'").get().n,0);
    if(kind==='revise') assert.equal(db.prepare("SELECT COUNT(*) n FROM queue_content_revisions WHERE content_id='A1'").get().n,1);
    if(kind==='rebind') assert.equal(db.prepare("SELECT COUNT(*) n FROM queue_assignments WHERE assignment_version=2").get().n,0);
  }
});

test('stale competing cancel cannot overwrite the winning reason or append evidence',()=>{
  const db=fixture(), s=snap(db);
  const win=planAssignmentCancel({content:s.content,activeAssignment:s.activeAssignment,publicationState:s.publicationState,runtimeState:RUNTIME,reason:'winner',now:NOW});
  const stale=planAssignmentCancel({content:s.content,activeAssignment:s.activeAssignment,publicationState:s.publicationState,runtimeState:RUNTIME,reason:'stale',now:NOW});
  exec(db,renderCancelSql(win,{recordedAt:NOW})); exec(db,renderCancelSql(stale,{recordedAt:'2026-09-21T12:01:00.000Z'}));
  assert.equal(db.prepare("SELECT skip_reason FROM publication_state WHERE post_id='A1'").get().skip_reason,'winner');
  for(const table of ['queue_assignment_events','queue_content_events','publication_events']){
    assert.equal(db.prepare(`SELECT COUNT(*) n FROM ${table} WHERE event_type='owner_cancelled'`).get().n,1);
  }
});

test('media-bound rebind requires exact media and rechecks readiness at mutation time',()=>{
  const db=fixture();
  db.prepare("INSERT INTO queue_content_revisions VALUES('A1',2,'With image','new body','new body',?,22,'owner-edit',?)").run(sha256Hex('new body'),NOW);
  db.prepare("INSERT INTO queue_media_objects VALUES('A1',2,0,22,'figure-0022','media/figures/figure-0022.png','png','image/png',1234,?,'ready',1,?,?)").run('a'.repeat(64),NOW,NOW);
  const target=db.prepare("SELECT * FROM queue_content_revisions WHERE content_id='A1' AND revision=2").get();
  const media=db.prepare("SELECT * FROM queue_media_objects WHERE content_id='A1' AND content_revision=2").get();
  const s=snap(db);
  assert.throws(()=>planAssignmentRebind({content:s.content,activeAssignment:s.activeAssignment,targetRevision:target,publicationState:s.publicationState,runtimeState:RUNTIME,reason:'media',now:NOW}),/media is required/);
  const p=planAssignmentRebind({content:s.content,activeAssignment:s.activeAssignment,targetRevision:target,targetMedia:media,publicationState:s.publicationState,runtimeState:RUNTIME,reason:'media',now:NOW});
  db.exec("UPDATE queue_media_objects SET status='retired',generation=2 WHERE content_id='A1' AND content_revision=2");
  exec(db,renderRebindSql(p,{recordedAt:NOW}));
  assert.equal(db.prepare("SELECT status FROM queue_assignments WHERE assignment_version=1").get().status,'active');
  assert.equal(db.prepare("SELECT COUNT(*) n FROM queue_assignments WHERE assignment_version=2").get().n,0);
});


test('runtime-head CAS race refuses rebind and cancel before durable owner mutation',()=>{
  for(const kind of ['rebind','cancel']){
    const db=fixture(); let s=snap(db), p, sql;
    if(kind==='rebind'){
      revise(db,'runtime-race body'); s=snap(db);
      p=planAssignmentRebind({
        content:s.content,
        activeAssignment:s.activeAssignment,
        targetRevision:s.revision,
        publicationState:s.publicationState,
        runtimeState:RUNTIME,
        reason:'runtime race',
        now:NOW,
      });
      sql=renderRebindSql(p,{recordedAt:NOW});
    } else {
      p=planAssignmentCancel({
        content:s.content,
        activeAssignment:s.activeAssignment,
        publicationState:s.publicationState,
        runtimeState:RUNTIME,
        reason:'runtime race',
        now:NOW,
      });
      sql=renderCancelSql(p,{recordedAt:NOW});
    }

    db.prepare("INSERT INTO queue_runtime_revisions VALUES(2,?)").run('e'.repeat(64));
    exec(db,sql);

    assert.equal(
      db.prepare("SELECT status FROM queue_assignments WHERE assignment_id='A1' AND assignment_version=1").get().status,
      'active',
    );
    assert.equal(
      db.prepare("SELECT COUNT(*) n FROM queue_assignment_events WHERE event_type LIKE 'owner_%'").get().n,
      0,
    );
    if(kind==='rebind'){
      assert.equal(db.prepare("SELECT COUNT(*) n FROM queue_assignments WHERE assignment_version=2").get().n,0);
      assert.equal(db.prepare("SELECT current_revision FROM queue_content WHERE content_id='A1'").get().current_revision,1);
    } else {
      assert.equal(db.prepare("SELECT status FROM queue_content WHERE content_id='A1'").get().status,'active');
      assert.equal(db.prepare("SELECT status FROM publication_state WHERE post_id='A1'").get().status,'scheduled');
    }
  }
});

test('runtime projection deterministically models rebind and cancel before commit',()=>{
  const db=fixture();
  revise(db,'projected body');
  const s=snap(db);
  const rebind=planAssignmentRebind({
    content:s.content,
    activeAssignment:s.activeAssignment,
    targetRevision:s.revision,
    publicationState:s.publicationState,
    runtimeState:RUNTIME,
    reason:'project',
    now:NOW,
  });
  const rows={
    assignments:[{
      ...s.activeAssignment,
      assignment_generation:s.activeAssignment.generation,
      pillar:'A',
      intake_state:'scheduled',
      title:'Original',
      body:'original body',
      publication_text:'original body',
      revision_content_digest:sha256Hex('original body'),
      figure:null,
      source_ref:'fixture',
    }],
    approvedUnscheduled:[],
    media:[],
  };
  const projected=projectOwnerRuntimeRows(rebind,rows,{targetRevision:s.revision});
  assert.equal(projected.assignments.length,1);
  assert.equal(projected.assignments[0].assignment_version,2);
  assert.equal(projected.assignments[0].content_revision,2);
  assert.equal(projected.assignments[0].publication_text,'projected body');

  const cancel=planAssignmentCancel({
    content:s.content,
    activeAssignment:s.activeAssignment,
    publicationState:s.publicationState,
    runtimeState:RUNTIME,
    reason:'cancel projection',
    now:NOW,
  });
  const cancelled=projectOwnerRuntimeRows(cancel,rows);
  assert.equal(cancelled.assignments.length,0);
  assert.equal(cancelled.media.length,0);
});
