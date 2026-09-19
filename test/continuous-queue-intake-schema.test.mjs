import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import {
  hashAssignmentRows,
  normalizeIntakeInput,
  planIntake,
  renderFrontierClaimSql,
  renderFrontierReleaseSql,
  renderItemApplySql,
  renderOperationCreateSql,
  renderOperationStatusSql,
} from '../src/continuous-queue-intake.mjs';

function text(path) {
  return readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
}

function rows(db, sql) {
  return db.prepare(sql).all();
}

test('0007 creates durable frontier and generated intake SQL appends without moving prior assignment', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(text('cloudflare/migrations/0006_continuous_queue_shadow.sql'));

  const oldDigest = '1'.repeat(64);
  const at = '2026-09-19T18:30:00.000Z';

  db.exec(`
    INSERT INTO queue_content
      (content_id,pillar,current_revision,status,generation,created_at,updated_at)
    VALUES ('OLD-1','A',1,'active',1,'${at}','${at}');

    INSERT INTO queue_content_revisions
      (content_id,revision,title,body,publication_text,content_digest,figure,source_ref,created_at)
    VALUES ('OLD-1',1,'old','old body','old body','${oldDigest}',NULL,'fixture','${at}');

    INSERT INTO queue_assignments
      (assignment_id,assignment_version,content_id,content_revision,content_digest,target_account,
       policy_version,resolved_at,scheduled_date,scheduled_time,timezone,slot_label,status,
       superseded_by_version,generation,created_at,updated_at)
    VALUES
      ('OLD-1',1,'OLD-1',1,'${oldDigest}','x-primary',2,
       '2027-01-07T20:30:00.000Z','2027-01-07','14:30','America/Chicago','lull',
       'active',NULL,1,'${at}','${at}');
  `);

  const before = rows(
    db,
    "SELECT * FROM queue_assignments WHERE content_id='OLD-1';",
  );

  db.exec(text('cloudflare/migrations/0007_continuous_queue_intake.sql'));
  db.exec(text('cloudflare/migrations/0008_dynamic_runtime_integrity.sql'));

  const [frontier] = rows(db, 'SELECT * FROM queue_intake_frontier;');
  assert.equal(frontier.generation, 1);
  assert.equal(frontier.resolved_at, '2027-01-07T20:30:00.000Z');
  assert.equal(frontier.pending_operation_id, null);

  const [oldContent] = rows(
    db,
    "SELECT intake_state FROM queue_content WHERE content_id='OLD-1';",
  );
  assert.equal(oldContent.intake_state, 'scheduled');

  db.exec(`
    INSERT INTO queue_content
      (content_id,pillar,current_revision,status,generation,created_at,updated_at,intake_state)
    VALUES ('UNSCHEDULED','A',1,'active',1,'${at}','${at}','approved_unscheduled');
  `);
  assert.equal(
    rows(db, "SELECT intake_state FROM queue_content WHERE content_id='UNSCHEDULED';")[0].intake_state,
    'approved_unscheduled',
  );
  db.exec("DELETE FROM queue_content WHERE content_id='UNSCHEDULED';");

  const normalized = normalizeIntakeInput({
    content_id: 'CQ-SQL-1',
    pillar: 'A',
    title: 'new',
    body: 'An exact approved intake body used to prove durable append semantics.',
    source_ref: 'test/sql',
  }, { mode: 'single' });

  const baselineRows = rows(
    db,
    "SELECT * FROM queue_assignments WHERE status='active' ORDER BY target_account,resolved_at,content_id;",
  );
  const plan = planIntake({
    normalized,
    frontier,
    policy: {
      version: 2,
      timezone: 'America/Chicago',
      slots: ['14:30', '22:15'],
      daysOfWeek: [1, 2, 3, 4, 5],
    },
    baselineAssignmentHash: hashAssignmentRows(baselineRows),
  });

  db.exec(renderOperationCreateSql(plan, at));
  db.exec(renderFrontierClaimSql(plan, at));

  let claimed = rows(db, 'SELECT * FROM queue_intake_frontier;')[0];
  assert.equal(claimed.generation, 2);
  assert.equal(claimed.pending_operation_id, plan.operation_id);
  assert.equal(claimed.resolved_at, '2027-01-08T04:15:00.000Z');

  db.exec(renderItemApplySql(plan, plan.items[0], at));

  const [content] = rows(
    db,
    "SELECT * FROM queue_content WHERE content_id='CQ-SQL-1';",
  );
  const [revision] = rows(
    db,
    "SELECT * FROM queue_content_revisions WHERE content_id='CQ-SQL-1';",
  );
  const [assignment] = rows(
    db,
    "SELECT * FROM queue_assignments WHERE content_id='CQ-SQL-1';",
  );

  assert.equal(content.intake_state, 'scheduled');
  assert.equal(revision.body, normalized.items[0].body);
  assert.equal(revision.publication_text, normalized.items[0].body);
  assert.equal(revision.content_digest, normalized.items[0].content_digest);
  assert.equal(assignment.resolved_at, '2027-01-08T04:15:00.000Z');
  assert.equal(assignment.policy_version, 2);

  db.exec(renderOperationStatusSql(plan.operation_id, 'complete', at));
  db.exec(renderFrontierReleaseSql(plan, at));

  claimed = rows(db, 'SELECT * FROM queue_intake_frontier;')[0];
  assert.equal(claimed.pending_operation_id, null);
  assert.equal(claimed.last_completed_operation_id, plan.operation_id);

  const after = rows(
    db,
    "SELECT * FROM queue_assignments WHERE content_id='OLD-1';",
  );
  assert.deepEqual(after, before);

  const existingHash = hashAssignmentRows(
    rows(
      db,
      "SELECT * FROM queue_assignments WHERE status='active' AND content_id<>'CQ-SQL-1' ORDER BY target_account,resolved_at,content_id;",
    ),
  );
  assert.equal(existingHash, plan.baseline_assignment_hash);
});
