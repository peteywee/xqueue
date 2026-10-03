import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';

import {
  atomicIntakeEvidenceDigest,
  buildAtomicIntakeStatementSpecs,
  executeAtomicIntakeMutation,
  intakeItemReadbackDigest,
} from '../src/mutation-intake-execution.mjs';

const AT = '2026-09-29T10:00:00.000Z';
const RUNTIME = 'a'.repeat(64);
const NEXT = 'f'.repeat(64);
const EVIDENCE = 'e'.repeat(64);
const BASELINE = 'b'.repeat(64);
const BATCH = 'c'.repeat(64);
const INTAKE_PLAN = 'd'.repeat(64);
const CONTROL_DIGEST = '1'.repeat(64);
const CONTROL_PLAN = '2'.repeat(64);

function schema(db) {
  db.exec(`
    PRAGMA foreign_keys=ON;
    CREATE TABLE mutation_lane_halt_state(singleton_id INTEGER PRIMARY KEY, halted INTEGER NOT NULL, generation INTEGER NOT NULL, reason TEXT NOT NULL, actor_class TEXT NOT NULL, updated_at TEXT NOT NULL);
    INSERT INTO mutation_lane_halt_state VALUES(1,0,4,'ok','owner','${AT}');
    CREATE TABLE mutation_lane_state(singleton_id INTEGER PRIMARY KEY, generation INTEGER NOT NULL, active_operation_id TEXT, actor_class TEXT NOT NULL, updated_at TEXT NOT NULL);
    INSERT INTO mutation_lane_state VALUES(1,7,NULL,'owner','${AT}');
    CREATE TRIGGER mutation_lane_claim_guard BEFORE UPDATE ON mutation_lane_state WHEN OLD.active_operation_id IS NULL AND NEW.active_operation_id IS NOT NULL AND NEW.generation<>OLD.generation+1 BEGIN SELECT RAISE(ABORT,'bad claim'); END;
    CREATE TRIGGER mutation_lane_release_guard BEFORE UPDATE ON mutation_lane_state WHEN OLD.active_operation_id IS NOT NULL AND NEW.active_operation_id IS NULL AND NEW.generation<>OLD.generation BEGIN SELECT RAISE(ABORT,'bad release'); END;

    CREATE TABLE mutation_operations(
      operation_id TEXT PRIMARY KEY, operation_kind TEXT NOT NULL, operation_digest TEXT NOT NULL UNIQUE, plan_digest TEXT NOT NULL,
      state TEXT NOT NULL, outcome TEXT, expected_halt_generation INTEGER NOT NULL, lane_generation INTEGER,
      expected_runtime_generation INTEGER NOT NULL, expected_runtime_revision_digest TEXT NOT NULL,
      checkpoint_bookmark TEXT, checkpoint_verified_at TEXT,
      retry_plan_count INTEGER NOT NULL DEFAULT 0, retry_read_count INTEGER NOT NULL DEFAULT 0, retry_operation_count INTEGER NOT NULL DEFAULT 0,
      max_plan_retries INTEGER NOT NULL, max_read_retries INTEGER NOT NULL, max_operation_retries INTEGER NOT NULL,
      effect_state TEXT NOT NULL DEFAULT 'none', resulting_runtime_generation INTEGER, resulting_runtime_revision_digest TEXT,
      evidence_digest TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, completed_at TEXT
    );
    CREATE TRIGGER mutation_operations_checkpoint_guard BEFORE UPDATE ON mutation_operations
    WHEN (NEW.state IN ('EXECUTING','VERIFYING','COMPLETE') OR NEW.effect_state<>'none') AND
      (NEW.checkpoint_bookmark IS NULL OR NEW.checkpoint_verified_at IS NULL OR NEW.lane_generation IS NULL)
    BEGIN SELECT RAISE(ABORT,'checkpoint required'); END;
    CREATE TRIGGER mutation_operations_complete_guard BEFORE UPDATE ON mutation_operations
    WHEN NEW.state='COMPLETE' AND (NEW.outcome<>'AUTO_RESOLVE' OR NEW.effect_state<>'applied' OR NEW.resulting_runtime_generation IS NULL OR NEW.resulting_runtime_revision_digest IS NULL OR NEW.evidence_digest IS NULL OR NEW.completed_at IS NULL)
    BEGIN SELECT RAISE(ABORT,'completion evidence required'); END;
    CREATE TABLE mutation_operation_items(
      operation_id TEXT NOT NULL, item_key TEXT NOT NULL, expected_content_revision INTEGER, expected_assignment_version INTEGER,
      resulting_content_revision INTEGER, resulting_assignment_version INTEGER, readback_status TEXT NOT NULL DEFAULT 'pending', readback_digest TEXT,
      PRIMARY KEY(operation_id,item_key), FOREIGN KEY(operation_id) REFERENCES mutation_operations(operation_id)
    );
  `);
  db.exec(readFileSync(new URL('../cloudflare/migrations/0016_mutation_completion_item_guard.sql', import.meta.url),'utf8'));
  db.exec(readFileSync(new URL('../cloudflare/migrations/0017_publication_mutation_mutex.sql', import.meta.url),'utf8'));
  db.exec(`
    CREATE TABLE queue_content(content_id TEXT PRIMARY KEY,pillar TEXT NOT NULL,current_revision INTEGER NOT NULL,status TEXT NOT NULL,generation INTEGER NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,intake_state TEXT NOT NULL);
    CREATE TABLE queue_content_revisions(content_id TEXT NOT NULL,revision INTEGER NOT NULL,title TEXT NOT NULL,body TEXT NOT NULL,publication_text TEXT NOT NULL,content_digest TEXT NOT NULL,figure INTEGER,source_ref TEXT,created_at TEXT NOT NULL,PRIMARY KEY(content_id,revision),FOREIGN KEY(content_id) REFERENCES queue_content(content_id));
    CREATE TABLE queue_assignments(assignment_id TEXT NOT NULL,assignment_version INTEGER NOT NULL,content_id TEXT NOT NULL,content_revision INTEGER NOT NULL,content_digest TEXT NOT NULL,target_account TEXT NOT NULL,policy_version INTEGER NOT NULL,resolved_at TEXT NOT NULL,scheduled_date TEXT NOT NULL,scheduled_time TEXT NOT NULL,timezone TEXT NOT NULL,slot_label TEXT,status TEXT NOT NULL,superseded_by_version INTEGER,generation INTEGER NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY(assignment_id,assignment_version),FOREIGN KEY(content_id,content_revision) REFERENCES queue_content_revisions(content_id,revision));
    CREATE UNIQUE INDEX queue_assignments_active_content_uq ON queue_assignments(content_id) WHERE status='active';
    CREATE UNIQUE INDEX queue_assignments_active_slot_uq ON queue_assignments(target_account,resolved_at) WHERE status='active';
    CREATE TABLE queue_content_events(id INTEGER PRIMARY KEY AUTOINCREMENT,content_id TEXT NOT NULL,revision INTEGER,event_type TEXT NOT NULL,event_at TEXT NOT NULL,detail TEXT);
    CREATE TABLE queue_assignment_events(id INTEGER PRIMARY KEY AUTOINCREMENT,assignment_id TEXT NOT NULL,assignment_version INTEGER NOT NULL,event_type TEXT NOT NULL,event_at TEXT NOT NULL,detail TEXT);
    CREATE TABLE queue_intake_frontier(singleton_id INTEGER PRIMARY KEY,generation INTEGER NOT NULL,resolved_at TEXT NOT NULL,pending_operation_id TEXT,last_completed_operation_id TEXT,updated_at TEXT NOT NULL);
    INSERT INTO queue_intake_frontier VALUES(1,5,'2026-09-29T09:00:00.000Z',NULL,NULL,'${AT}');
    CREATE TABLE queue_intake_operations(operation_id TEXT PRIMARY KEY,plan_digest TEXT NOT NULL UNIQUE,batch_digest TEXT NOT NULL,item_count INTEGER NOT NULL,expected_frontier_generation INTEGER NOT NULL,expected_frontier_resolved_at TEXT NOT NULL,proposed_frontier_resolved_at TEXT NOT NULL,baseline_assignment_hash TEXT NOT NULL,expected_runtime_generation INTEGER,expected_runtime_revision_digest TEXT,resulting_runtime_generation INTEGER,resulting_runtime_revision_digest TEXT,target_account TEXT NOT NULL,policy_version INTEGER NOT NULL,status TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
    CREATE TABLE queue_intake_items(operation_id TEXT NOT NULL,ordinal INTEGER NOT NULL,content_id TEXT NOT NULL,content_digest TEXT NOT NULL,pillar TEXT NOT NULL,title TEXT NOT NULL,source_ref TEXT,resolved_at TEXT NOT NULL,scheduled_date TEXT NOT NULL,scheduled_time TEXT NOT NULL,timezone TEXT NOT NULL,slot_label TEXT,PRIMARY KEY(operation_id,ordinal));
    CREATE TABLE queue_runtime_revisions(generation INTEGER PRIMARY KEY,revision_digest TEXT NOT NULL UNIQUE,active_assignment_count INTEGER NOT NULL,approved_unscheduled_count INTEGER NOT NULL,media_required_count INTEGER NOT NULL,media_ready_count INTEGER NOT NULL,previous_revision_digest TEXT,source_operation_id TEXT UNIQUE,created_at TEXT NOT NULL);
    INSERT INTO queue_runtime_revisions VALUES(11,'${RUNTIME}',0,0,0,0,'${'9'.repeat(64)}',NULL,'${AT}');
  `);
}

function fixture() {
  const item = {
    ordinal:0, content_id:'I-1', assignment_id:'I-1', pillar:'A', title:'Semicolon proof', body:'alpha; beta; gamma', publication_text:'alpha; beta; gamma',
    content_digest:'3'.repeat(64), source_ref:'fixture', target_account:'x-primary', policy_version:2,
    resolved_at:'2026-09-30T10:00:00.000Z', scheduled_date:'2026-09-30', scheduled_time:'05:00', timezone:'America/Chicago', slot_label:'lull',
  };
  const intakePlan = {
    operation_id:'intake-'+INTAKE_PLAN.slice(0,24), plan_digest:INTAKE_PLAN, batch_digest:BATCH, count:1,
    expected_frontier_generation:5, expected_frontier_resolved_at:'2026-09-29T09:00:00.000Z', proposed_frontier_resolved_at:item.resolved_at,
    baseline_assignment_hash:BASELINE, expected_runtime_generation:11, expected_runtime_revision_digest:RUNTIME,
    target_account:'x-primary', policy_version:2, items:[item],
  };
  const controlPlan = {
    operation_id:'mutation-intake-'+CONTROL_DIGEST.slice(0,24), operation_kind:'intake', operation_digest:CONTROL_DIGEST, plan_digest:CONTROL_PLAN,
    expected_halt_generation:4, expected_lane_generation:7, expected_runtime_generation:11, expected_runtime_revision_digest:RUNTIME,
    retry_budgets:{plan:3,read:3,operation:2}, plan_context:{intake_operation_id:intakePlan.operation_id,intake_plan_digest:INTAKE_PLAN},
    items:[{item_key:'I-1',expected_content_revision:null,expected_assignment_version:null,resulting_content_revision:1,resulting_assignment_version:1}],
  };
  const checkpoint={operation_id:controlPlan.operation_id,checkpoint_bookmark:'bookmark_12345',checkpoint_verified_at:'2026-09-29T09:59:00.000Z',expected_lane_generation:7};
  const runtimeRevision={generation:12,revision_digest:NEXT,active_assignment_count:1,approved_unscheduled_count:0,media_required_count:0,media_ready_count:0,previous_revision_digest:RUNTIME,source_operation_id:intakePlan.operation_id};
  return {item,intakePlan,controlPlan,checkpoint,runtimeRevision};
}

function execute(db, specs) {
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const s of specs) db.prepare(s.sql).run(...s.args);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function counts(db) {
  const n=(table)=>db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n;
  return {content:n('queue_content'),assignments:n('queue_assignments'),operations:n('mutation_operations'),intake:n('queue_intake_operations'),runtime:n('queue_runtime_revisions')};
}

test('statement specs keep semicolon-bearing content exclusively in bound arguments', () => {
  const f=fixture();
  const specs=buildAtomicIntakeStatementSpecs({...f,recordedAt:AT});
  assert.ok(specs.length > 10);
  assert.equal(specs.some((s)=>s.sql.includes(f.item.body)),false);
  assert.equal(specs.some((s)=>s.args.includes(f.item.body)),true);
  assert.equal(specs.every((s)=>!s.sql.includes('BEGIN') && !s.sql.includes('COMMIT')),true);
});

test('atomic intake commits canonical state, exact item proof, runtime successor and releases both fences', () => {
  const db=new DatabaseSync(':memory:'); schema(db); const f=fixture();
  execute(db,buildAtomicIntakeStatementSpecs({...f,recordedAt:AT}));
  assert.deepEqual(counts(db),{content:1,assignments:1,operations:1,intake:1,runtime:2});
  const op=db.prepare('SELECT state,outcome,effect_state,resulting_runtime_generation,resulting_runtime_revision_digest,evidence_digest FROM mutation_operations').get();
  assert.deepEqual({...op},{state:'COMPLETE',outcome:'AUTO_RESOLVE',effect_state:'applied',resulting_runtime_generation:12,resulting_runtime_revision_digest:NEXT,evidence_digest:atomicIntakeEvidenceDigest(f)});
  const item=db.prepare('SELECT readback_status,readback_digest FROM mutation_operation_items').get();
  assert.equal(item.readback_status,'applied');
  assert.equal(item.readback_digest,intakeItemReadbackDigest(f.item));
  assert.equal(db.prepare('SELECT active_operation_id,generation FROM mutation_lane_state').get().active_operation_id,null);
  assert.equal(db.prepare('SELECT pending_operation_id,last_completed_operation_id FROM queue_intake_frontier').get().pending_operation_id,null);
});

test('stale frontier aborts and rolls back the entire mutation', () => {
  const db=new DatabaseSync(':memory:'); schema(db); const f=fixture();
  db.prepare('UPDATE queue_intake_frontier SET generation=6').run();
  const before=counts(db);
  assert.throws(()=>execute(db,buildAtomicIntakeStatementSpecs({...f,recordedAt:AT})));
  assert.deepEqual(counts(db),before);
  assert.equal(db.prepare('SELECT active_operation_id FROM mutation_lane_state').get().active_operation_id,null);
});

test('canonical item collision aborts and rolls back operation/lane/frontier changes', () => {
  const db=new DatabaseSync(':memory:'); schema(db); const f=fixture();
  db.prepare("INSERT INTO queue_content VALUES('I-1','A',1,'active',1,?,?, 'scheduled')").run(AT,AT);
  db.prepare("INSERT INTO queue_content_revisions VALUES('I-1',1,'old','old','old',?,NULL,'old',?)").run('4'.repeat(64),AT);
  const before=counts(db);
  assert.throws(()=>execute(db,buildAtomicIntakeStatementSpecs({...f,recordedAt:AT})));
  assert.deepEqual(counts(db),before);
  assert.equal(db.prepare('SELECT active_operation_id FROM mutation_lane_state').get().active_operation_id,null);
});

function d1Adapter(db) {
  return {
    prepare(sql) {
      let args = [];
      return {
        bind(...values) { args = values; return this; },
        run() { return db.prepare(sql).run(...args); },
        first() { return db.prepare(sql).get(...args) ?? null; },
        all() { return db.prepare(sql).all(...args); },
      };
    },
  };
}

function sqliteTransport(db, { throwAfterCommit = false } = {}) {
  return {
    async readOperation(operationId) {
      return db.prepare('SELECT * FROM mutation_operations WHERE operation_id=?').get(operationId) ?? null;
    },
    async readOperationItems(operationId) {
      return db.prepare('SELECT * FROM mutation_operation_items WHERE operation_id=? ORDER BY item_key').all(operationId);
    },
    async batch(statements) {
      db.exec('BEGIN IMMEDIATE');
      try {
        for (const statement of statements) statement.run();
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
      if (throwAfterCommit) throw new Error('network response lost after commit');
      return statements.map(() => ({ success: true }));
    },
  };
}

function verifyFixtureCompletion(controlPlan, observed) {
  if (!observed || observed.operation_id !== controlPlan.operation_id) return { ok: false };
  if (Number(observed.runtime_generation) !== 12 || observed.runtime_revision_digest !== NEXT) return { ok: false };
  if (observed.items.length !== 1) return { ok: false };
  const item = observed.items[0];
  return { ok: item.item_key === 'I-1' && item.readback_status === 'applied' && item.resulting_content_revision === 1 && item.resulting_assignment_version === 1 };
}

test('executor resolves a lost response by exact committed readback and never replays', async () => {
  const db=new DatabaseSync(':memory:'); schema(db); const f=fixture();
  const transport=sqliteTransport(db,{throwAfterCommit:true});
  const result=await executeAtomicIntakeMutation({
    transport, db:d1Adapter(db),
    inputs:{...f,recordedAt:AT},
    verifyCompletion:(observed)=>verifyFixtureCompletion(f.controlPlan,observed),
  });
  assert.equal(result.status,'applied_after_ambiguous_response');
  assert.equal(counts(db).content,1);
  const replay=await executeAtomicIntakeMutation({
    transport:sqliteTransport(db), db:d1Adapter(db),
    inputs:{...f,recordedAt:AT},
    verifyCompletion:(observed)=>verifyFixtureCompletion(f.controlPlan,observed),
  });
  assert.equal(replay.status,'already_applied');
  assert.equal(counts(db).content,1);
});

test('executor does not retry a rolled-back failed batch', async () => {
  const db=new DatabaseSync(':memory:'); schema(db); const f=fixture();
  db.prepare('UPDATE queue_intake_frontier SET generation=6').run();
  const result=await executeAtomicIntakeMutation({
    transport:sqliteTransport(db), db:d1Adapter(db),
    inputs:{...f,recordedAt:AT},
    verifyCompletion:(observed)=>verifyFixtureCompletion(f.controlPlan,observed),
  });
  assert.equal(result.status,'requires_reconciliation');
  assert.equal(result.observed,null);
  assert.deepEqual(counts(db),{content:0,assignments:0,operations:0,intake:0,runtime:1});
});
