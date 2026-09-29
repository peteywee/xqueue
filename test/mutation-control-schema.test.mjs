import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const MIGRATION = readFileSync(new URL('../cloudflare/migrations/0015_mutation_control_plane.sql', import.meta.url), 'utf8');
const NOW = '2026-09-29T08:30:00.000Z';
const DIGEST = 'a'.repeat(64);
const RUNTIME = 'b'.repeat(64);
const EVIDENCE = 'c'.repeat(64);

function fixture() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys=ON;');
  db.exec(MIGRATION);
  return db;
}

function seedOperation(db, id = 'mutation-op-0001') {
  db.prepare(`
    INSERT INTO mutation_operations (
      operation_id,operation_kind,operation_digest,plan_digest,state,outcome,
      expected_halt_generation,lane_generation,
      expected_runtime_generation,expected_runtime_revision_digest,
      checkpoint_bookmark,checkpoint_verified_at,
      retry_plan_count,retry_read_count,retry_operation_count,
      max_plan_retries,max_read_retries,max_operation_retries,
      effect_state,created_at,updated_at
    ) VALUES (?, 'foundation_probe', ?, ?, 'PLANNED', NULL, 1, NULL, 7, ?, NULL, NULL, 0,0,0,3,3,2,'none',?,?)
  `).run(id, DIGEST, 'd'.repeat(64), RUNTIME, NOW, NOW);
  return id;
}

test('mutation halt is generation-CAS shaped and owner-only on clear', () => {
  const db = fixture();
  const initial = db.prepare('SELECT * FROM mutation_lane_halt_state WHERE singleton_id=1').get();
  assert.equal(initial.halted, 0);
  assert.equal(initial.generation, 1);

  db.prepare(`UPDATE mutation_lane_halt_state SET halted=1,generation=2,reason='test halt',actor_class='automation',updated_at=? WHERE singleton_id=1 AND generation=1 AND halted=0`).run(NOW);
  assert.throws(() => db.prepare(`UPDATE mutation_lane_halt_state SET halted=0,generation=3,reason='bad clear',actor_class='automation',updated_at=? WHERE singleton_id=1`).run(NOW), /only be cleared by owner/);
  db.prepare(`UPDATE mutation_lane_halt_state SET halted=0,generation=3,reason='owner clear',actor_class='owner',updated_at=? WHERE singleton_id=1 AND generation=2 AND halted=1`).run(NOW);

  const state = db.prepare('SELECT halted,generation FROM mutation_lane_halt_state WHERE singleton_id=1').get();
  assert.equal(state.halted, 0);
  assert.equal(state.generation, 3);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM mutation_lane_halt_events').get().n, 3);
});

test('mutation lane claim advances generation, release preserves it, and direct swap is rejected', () => {
  const db = fixture();
  db.prepare(`UPDATE mutation_lane_state SET generation=2,active_operation_id='mutation-op-0001',actor_class='automation',updated_at=? WHERE singleton_id=1 AND generation=1 AND active_operation_id IS NULL`).run(NOW);
  assert.throws(() => db.prepare(`UPDATE mutation_lane_state SET generation=3,active_operation_id='mutation-op-0002',actor_class='automation',updated_at=? WHERE singleton_id=1`).run(NOW), /cannot swap active operations directly/);
  db.prepare(`UPDATE mutation_lane_state SET generation=2,active_operation_id=NULL,actor_class='automation',updated_at=? WHERE singleton_id=1 AND generation=2 AND active_operation_id='mutation-op-0001'`).run(NOW);
  db.prepare(`UPDATE mutation_lane_state SET generation=3,active_operation_id='mutation-op-0002',actor_class='automation',updated_at=? WHERE singleton_id=1 AND generation=2 AND active_operation_id IS NULL`).run(NOW);
  const state = db.prepare('SELECT generation,active_operation_id FROM mutation_lane_state WHERE singleton_id=1').get();
  assert.equal(state.generation, 3);
  assert.equal(state.active_operation_id, 'mutation-op-0002');
});

test('execution requires verified recovery bookmark and lane generation', () => {
  const db = fixture();
  const id = seedOperation(db);
  assert.throws(() => db.prepare(`UPDATE mutation_operations SET state='EXECUTING',updated_at=? WHERE operation_id=?`).run(NOW,id), /verified recovery checkpoint/);

  db.prepare(`UPDATE mutation_operations SET checkpoint_bookmark='00000085-0000024c',checkpoint_verified_at=?,lane_generation=2,updated_at=? WHERE operation_id=?`).run(NOW,NOW,id);
  db.prepare(`UPDATE mutation_operations SET state='EXECUTING',effect_state='dispatched',updated_at=? WHERE operation_id=?`).run(NOW,id);
  assert.equal(db.prepare('SELECT state FROM mutation_operations WHERE operation_id=?').get(id).state, 'EXECUTING');
});

test('retry counters are durable, monotonic, and bounded', () => {
  const db = fixture();
  const id = seedOperation(db);
  db.prepare(`UPDATE mutation_operations SET retry_plan_count=3,updated_at=? WHERE operation_id=?`).run(NOW,id);
  assert.throws(() => db.prepare(`UPDATE mutation_operations SET retry_plan_count=4,updated_at=? WHERE operation_id=?`).run(NOW,id), /within durable budgets/);
  assert.throws(() => db.prepare(`UPDATE mutation_operations SET retry_plan_count=2,updated_at=? WHERE operation_id=?`).run(NOW,id), /monotonic/);
});

test('complete requires exact runtime/readback evidence', () => {
  const db = fixture();
  const id = seedOperation(db);
  db.prepare(`UPDATE mutation_operations SET checkpoint_bookmark='00000085-0000024c',checkpoint_verified_at=?,lane_generation=2,state='VERIFYING',effect_state='applied',updated_at=? WHERE operation_id=?`).run(NOW,NOW,id);
  assert.throws(() => db.prepare(`UPDATE mutation_operations SET state='COMPLETE',outcome='AUTO_RESOLVE',completed_at=?,updated_at=? WHERE operation_id=?`).run(NOW,NOW,id), /exact readback and evidence/);
  db.prepare(`UPDATE mutation_operations SET state='COMPLETE',outcome='AUTO_RESOLVE',resulting_runtime_generation=8,resulting_runtime_revision_digest=?,evidence_digest=?,completed_at=?,updated_at=? WHERE operation_id=?`).run(RUNTIME,EVIDENCE,NOW,NOW,id);
  assert.equal(db.prepare('SELECT state FROM mutation_operations WHERE operation_id=?').get(id).state, 'COMPLETE');
});

test('expected item versions and operation events are immutable', () => {
  const db = fixture();
  const id = seedOperation(db);
  db.prepare(`INSERT INTO mutation_operation_items (operation_id,item_key,expected_content_revision,expected_assignment_version) VALUES (?,?,1,2)`).run(id,'content-1');
  assert.throws(() => db.prepare(`UPDATE mutation_operation_items SET expected_assignment_version=3 WHERE operation_id=? AND item_key='content-1'`).run(id), /expected versions are immutable/);
  db.prepare(`INSERT INTO mutation_operation_events (operation_id,event_type,event_at,detail) VALUES (?, 'planned', ?, '{}')`).run(id,NOW);
  assert.throws(() => db.prepare(`UPDATE mutation_operation_events SET detail='changed' WHERE operation_id=?`).run(id), /events are immutable/);
});
