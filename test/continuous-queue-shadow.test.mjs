import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadLibrary, renderPost } from '../src/parse.mjs';
import { schedule } from '../src/schedule.mjs';
import {
  buildContinuousQueueShadow,
  renderShadowBackfillSql,
  renderShadowVerificationSql,
  shadowManifestJson,
  shadowManifestSha256,
} from '../src/continuous-queue-shadow.mjs';
import { buildProductionShadow } from '../scripts/build-continuous-queue-shadow.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const POLICY = join(ROOT, 'config', 'schedule-policy.json');
const CONTENT = join(ROOT, 'content');
const RECORDED_AT = '2026-09-19T13:00:00.000Z';

function sha256(text) {
  return createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');
}

function productionQueue() {
  const policy = JSON.parse(readFileSync(POLICY, 'utf8'));
  const posts = loadLibrary(CONTENT);
  return {
    policy,
    queue: schedule(posts, {
      start: policy.campaignStart,
      slots: policy.slots,
      daysOfWeek: policy.daysOfWeek,
      timezone: policy.timezone,
      deferToEnd: policy.deferToEnd ?? [],
    }),
  };
}

test('production shadow maps all 180 posts one-to-one with exact digest and UTC parity', () => {
  const { policy, queue } = productionQueue();
  const model = buildContinuousQueueShadow(queue, {
    policyVersion: policy.version,
    targetAccount: 'x-primary',
  });

  assert.equal(model.count, 180);
  assert.equal(model.content.length, 180);
  assert.equal(model.revisions.length, 180);
  assert.equal(model.assignments.length, 180);
  assert.equal(model.policy_version, policy.version);
  assert.equal(model.target_account, 'x-primary');

  const contentById = new Map(model.content.map((row) => [row.content_id, row]));
  const revisionById = new Map(model.revisions.map((row) => [row.content_id, row]));
  const assignmentById = new Map(model.assignments.map((row) => [row.content_id, row]));

  assert.equal(contentById.size, 180);
  assert.equal(revisionById.size, 180);
  assert.equal(assignmentById.size, 180);

  for (const post of queue) {
    const content = contentById.get(post.id);
    const revision = revisionById.get(post.id);
    const assignment = assignmentById.get(post.id);

    assert.ok(content, `${post.id}: content row missing`);
    assert.ok(revision, `${post.id}: revision row missing`);
    assert.ok(assignment, `${post.id}: assignment row missing`);

    const publicationText = renderPost(post);
    const digest = sha256(publicationText);

    assert.equal(content.current_revision, 1, `${post.id}: current revision`);
    assert.equal(content.status, 'active', `${post.id}: content status`);
    assert.equal(content.generation, 1, `${post.id}: content generation`);

    assert.equal(revision.revision, 1, `${post.id}: revision`);
    assert.equal(revision.body, post.body, `${post.id}: raw body drift`);
    assert.equal(
      revision.publication_text,
      publicationText,
      `${post.id}: publication text drift`,
    );
    assert.equal(revision.content_digest, digest, `${post.id}: digest drift`);

    assert.equal(assignment.assignment_id, post.id, `${post.id}: assignment id`);
    assert.equal(assignment.assignment_version, 1, `${post.id}: assignment version`);
    assert.equal(assignment.content_revision, 1, `${post.id}: content revision binding`);
    assert.equal(assignment.content_digest, digest, `${post.id}: assignment digest`);
    assert.equal(assignment.policy_version, policy.version, `${post.id}: policy version`);
    assert.equal(assignment.resolved_at, post.scheduledAt, `${post.id}: resolved UTC drift`);
    assert.equal(assignment.scheduled_date, post.scheduledDate, `${post.id}: local date drift`);
    assert.equal(assignment.scheduled_time, post.scheduledTime, `${post.id}: local time drift`);
    assert.equal(assignment.timezone, post.timezone, `${post.id}: timezone drift`);
    assert.equal(assignment.slot_label, post.slot ?? null, `${post.id}: slot drift`);
    assert.equal(assignment.status, 'active', `${post.id}: assignment status`);
    assert.equal(assignment.generation, 1, `${post.id}: assignment generation`);
  }
});

test('production shadow has no duplicate content ids, assignment ids, or active slots', () => {
  const model = buildProductionShadow();

  assert.equal(new Set(model.content.map((row) => row.content_id)).size, model.count);
  assert.equal(
    new Set(model.assignments.map((row) => row.assignment_id)).size,
    model.count,
  );
  assert.equal(
    new Set(
      model.assignments.map(
        (row) => `${row.target_account}\u0000${row.resolved_at}`,
      ),
    ).size,
    model.count,
  );
});

test('pillar B digest covers the exact publication text including disclaimer', () => {
  const model = buildProductionShadow();
  const row = model.revisions.find((revision) => revision.content_id === 'B1');

  assert.ok(row, 'B1 revision missing');
  assert.match(row.publication_text, /General information, not legal advice/i);
  assert.equal(row.content_digest, sha256(row.publication_text));
  assert.notEqual(row.content_digest, sha256(row.body));
});

test('shadow manifest is deterministic and stable for the same repository state', () => {
  const first = buildProductionShadow();
  const second = buildProductionShadow();

  assert.equal(shadowManifestJson(first), shadowManifestJson(second));
  assert.equal(shadowManifestSha256(first), shadowManifestSha256(second));
  assert.match(shadowManifestSha256(first), /^[a-f0-9]{64}$/);
});

test('generated SQL contains exactly one shadow seed per content/revision/assignment', () => {
  const model = buildProductionShadow();
  const sqlA = renderShadowBackfillSql(model, { recordedAt: RECORDED_AT });
  const sqlB = renderShadowBackfillSql(model, { recordedAt: RECORDED_AT });

  assert.equal(sqlA, sqlB);
  assert.match(sqlA, /Non-authoritative #88 seed/);
  assert.match(sqlA, new RegExp(shadowManifestSha256(model)));

  assert.equal(
    (sqlA.match(/INSERT OR ABORT INTO queue_content \(/g) ?? []).length,
    180,
  );
  assert.equal(
    (sqlA.match(/INSERT OR ABORT INTO queue_content_revisions /g) ?? []).length,
    180,
  );
  assert.equal(
    (sqlA.match(/INSERT OR ABORT INTO queue_assignments /g) ?? []).length,
    180,
  );
  assert.equal(
    (sqlA.match(/INSERT INTO queue_content_events /g) ?? []).length,
    180,
  );
  assert.equal(
    (sqlA.match(/INSERT INTO queue_assignment_events /g) ?? []).length,
    180,
  );
});

test('shadow builder fails closed on duplicate ids, duplicate slots, missing UTC, and UTC drift', () => {
  const { policy, queue } = productionQueue();
  const options = {
    policyVersion: policy.version,
    targetAccount: 'x-primary',
  };

  const duplicateId = queue.map((post) => ({ ...post }));
  duplicateId[1].id = duplicateId[0].id;
  assert.throws(
    () => buildContinuousQueueShadow(duplicateId, options),
    /duplicate post id/,
  );

  const duplicateSlot = queue.map((post) => ({ ...post }));
  duplicateSlot[1].scheduledAt = duplicateSlot[0].scheduledAt;
  duplicateSlot[1].scheduledDate = duplicateSlot[0].scheduledDate;
  duplicateSlot[1].scheduledTime = duplicateSlot[0].scheduledTime;
  duplicateSlot[1].timezone = duplicateSlot[0].timezone;
  assert.throws(
    () => buildContinuousQueueShadow(duplicateSlot, options),
    /duplicate active slot/,
  );

  const missingUtc = queue.map((post) => ({ ...post }));
  delete missingUtc[0].scheduledAt;
  assert.throws(
    () => buildContinuousQueueShadow(missingUtc, options),
    /scheduledAt is required/,
  );

  const utcDrift = queue.map((post) => ({ ...post }));
  utcDrift[0].scheduledAt = '2026-08-31T19:31:00.000Z';
  assert.throws(
    () => buildContinuousQueueShadow(utcDrift, options),
    /resolved UTC mismatch/,
  );
});

test('read-only verification SQL checks publication_state ID coverage without using legacy scheduled_at as the schedule oracle', () => {
  const model = buildProductionShadow();
  const sql = renderShadowVerificationSql(model);

  assert.match(sql, /READ-ONLY #88 SHADOW VERIFICATION/);
  assert.match(sql, /content_count/);
  assert.match(sql, /revision_count/);
  assert.match(sql, /active_assignment_count/);
  assert.match(sql, /duplicate_active_content/);
  assert.match(sql, /duplicate_active_slots/);
  assert.match(sql, /assignment_digest_mismatch/);
  assert.match(sql, /publication_state_missing_shadow/);
  assert.match(sql, /shadow_missing_publication_state/);
  assert.doesNotMatch(sql, /publication_state_slot_mismatch/);
  assert.doesNotMatch(sql, /a\.resolved_at\s*<>\s*p\.scheduled_at/);
  assert.match(sql, /static queue remains schedule-authoritative/i);
  assert.match(sql, /FROM publication_state/);
  assert.doesNotMatch(sql, /\b(?:INSERT|UPDATE|DELETE|ALTER|DROP)\b/i);
});

test('shadow SQL requires an explicit truthful recording instant', () => {
  const model = buildProductionShadow();

  assert.throws(
    () => renderShadowBackfillSql(model),
    /recordedAt/,
  );
  assert.throws(
    () => renderShadowBackfillSql(model, { recordedAt: 'today' }),
    /canonical ISO-8601 UTC/,
  );
});

test('0006 is shadow-only schema and does not mutate current publication authority/state', () => {
  const sql = readFileSync(
    join(ROOT, 'cloudflare', 'migrations', '0006_continuous_queue_shadow.sql'),
    'utf8',
  );

  for (const forbidden of [
    /ALTER\s+TABLE\s+publication_state/i,
    /UPDATE\s+publication_state/i,
    /DELETE\s+FROM\s+publication_state/i,
    /INSERT\s+INTO\s+publication_state/i,
    /UPDATE\s+runtime_metadata/i,
    /INSERT\s+INTO\s+runtime_metadata/i,
    /publication_authority/i,
    /authority_state/i,
  ]) {
    assert.equal(forbidden.test(sql), false, `forbidden live-state mutation: ${forbidden}`);
  }

  assert.match(sql, /CREATE TABLE queue_content/);
  assert.match(sql, /CREATE TABLE queue_content_revisions/);
  assert.match(sql, /CREATE TABLE queue_assignments/);
  assert.match(sql, /queue_assignments_active_content_uq/);
  assert.match(sql, /queue_assignments_active_slot_uq/);
});
