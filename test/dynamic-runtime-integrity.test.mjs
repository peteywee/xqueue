import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { MEDIA_MANIFEST } from '../cloudflare/generated/media-manifest.mjs';
import statusWorker from '../cloudflare/src/status-worker.mjs';
import compatibilityWorker from '../cloudflare/src/worker.mjs';
import {
  buildDynamicRuntimeSnapshot,
  publicationQueueFromSnapshot,
  readDynamicRuntimeRows,
  verifyDynamicRuntime,
} from '../cloudflare/src/dynamic-runtime-integrity.mjs';
import {
  hashAssignmentRows,
  normalizeIntakeInput,
  planIntake,
  renderFrontierClaimSql,
  renderFrontierReleaseSql,
  renderItemApplySql,
  renderOperationCreateSql,
  renderOperationRuntimeResultSql,
  renderOperationStatusSql,
} from '../src/continuous-queue-intake.mjs';
import {
  nextRuntimeRevision,
  renderMediaInsertSql,
  renderRuntimeRevisionInsertSql,
} from '../src/continuous-queue-runtime-write.mjs';
import {
  buildContinuousQueueShadow,
  renderShadowBackfillSql,
} from '../src/continuous-queue-shadow.mjs';
import { loadLibrary } from '../src/parse.mjs';
import { schedule } from '../src/schedule.mjs';
import {
  compileProductionAuthorityBootstrapSql,
  compileProductionNoneToCloudflareSql,
} from '../src/production-authority-sql.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const POLICY = join(ROOT, 'config', 'schedule-policy.json');
const CONTENT = join(ROOT, 'content');
const AT1 = '2026-09-19T18:45:00.000Z';
const AT2 = '2026-09-19T18:46:00.000Z';

function text(path) {
  return readFileSync(join(ROOT, path), 'utf8');
}

function sha256(value) {
  return createHash('sha256').update(Buffer.from(value, 'utf8')).digest('hex');
}

function hexToArrayBuffer(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes.buffer;
}

function productionShadow() {
  const policy = JSON.parse(readFileSync(POLICY, 'utf8'));
  const posts = loadLibrary(CONTENT);
  const queue = schedule(posts, {
    start: policy.campaignStart,
    slots: policy.slots,
    daysOfWeek: policy.daysOfWeek,
    timezone: policy.timezone,
    deferToEnd: policy.deferToEnd ?? [],
  });
  return {
    policy,
    model: buildContinuousQueueShadow(queue, {
      policyVersion: policy.version,
      targetAccount: 'x-primary',
    }),
  };
}

function runtimeMediaRows() {
  const mime = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
  };

  return MEDIA_MANIFEST.objects.map((object) => ({
    content_id: object.postId,
    content_revision: 1,
    media_ordinal: 0,
    figure: object.figure,
    logical_media_id: object.logicalMediaId,
    r2_key: object.r2Key,
    extension: object.extension,
    mime_type: mime[object.extension],
    byte_size: object.byteSize,
    sha256: object.sha256,
    status: 'ready',
    generation: 1,
  }));
}

class MediaStub {
  constructor(objects = MEDIA_MANIFEST.objects) {
    this.objects = new Map(objects.map((object) => [object.r2Key, object]));
    this.calls = [];
  }

  async head(key) {
    this.calls.push(['head', key]);
    const object = this.objects.get(key);
    if (!object) return null;
    const contentType =
      object.extension === 'png' ? 'image/png'
        : ['jpg', 'jpeg'].includes(object.extension) ? 'image/jpeg'
          : object.extension === 'gif' ? 'image/gif'
            : 'image/webp';
    return {
      key,
      size: object.byteSize,
      checksums: {
        sha256: hexToArrayBuffer(object.sha256),
      },
      httpMetadata: {
        contentType,
      },
    };
  }

  async get() {
    this.calls.push(['get']);
    throw new Error('body read should not be needed when R2 checksum exists');
  }

  async list() {
    this.calls.push(['list']);
    return {
      objects: [...this.objects.values()].map((object) => ({
        key: object.r2Key,
        size: object.byteSize,
      })),
      truncated: false,
      cursor: null,
    };
  }
}

function activeAssignmentRows(db) {
  return db.prepare(
    'SELECT assignment_id,assignment_version,content_id,content_revision,content_digest,' +
    'target_account,policy_version,resolved_at,scheduled_date,scheduled_time,timezone,' +
    'slot_label,status,superseded_by_version,generation,created_at,updated_at ' +
    "FROM queue_assignments WHERE status='active' ORDER BY target_account,resolved_at,content_id;",
  ).all();
}

function runtimeState(db) {
  return db.prepare(
    'SELECT generation,revision_digest,active_assignment_count,' +
    'approved_unscheduled_count,media_required_count,media_ready_count,' +
    'source_operation_id,created_at AS updated_at ' +
    'FROM queue_runtime_revisions ORDER BY generation DESC LIMIT 1;',
  ).get() ?? null;
}

function seed180(db) {
  const { policy, model } = productionShadow();
  assert.equal(model.count, 180);

  db.exec(text('cloudflare/migrations/0006_continuous_queue_shadow.sql'));
  db.exec(renderShadowBackfillSql(model, { recordedAt: AT1 }));
  db.exec(text('cloudflare/migrations/0007_continuous_queue_intake.sql'));
  db.exec(text('cloudflare/migrations/0008_dynamic_runtime_integrity.sql'));
  db.exec(text('cloudflare/migrations/0009_deferred_lifecycle.sql'));
  db.exec(renderMediaInsertSql(runtimeMediaRows(), { recordedAt: AT1 }));

  return { policy, model };
}

test('dynamic runtime accepts canonical 180 and grows to 181 with a new revision, no Worker source edit', async () => {
  const db = new DatabaseSync(':memory:');
  const { policy } = seed180(db);

  const initialRows = await readDynamicRuntimeRows(db);
  const initialSnapshot = await buildDynamicRuntimeSnapshot(initialRows);

  assert.equal(initialSnapshot.active_assignment_count, 180);
  assert.equal(initialSnapshot.approved_unscheduled_count, 0);
  assert.equal(initialSnapshot.media_required_count, 4);
  assert.equal(initialSnapshot.media_ready_count, 4);

  const revision1 = nextRuntimeRevision({
    currentState: null,
    snapshot: initialSnapshot,
    recordedAt: AT1,
  });
  db.exec(renderRuntimeRevisionInsertSql(revision1));

  const env = {
    DB: db,
    MEDIA: new MediaStub(),
  };

  const first = await verifyDynamicRuntime(env, { includeSnapshot: true });
  assert.equal(first.ok, true);
  assert.equal(first.authoritative, false);
  assert.equal(first.generation, 1);
  assert.equal(first.activeAssignmentCount, 180);
  assert.equal(first.mediaRequiredCount, 4);
  assert.equal(first.media.verifiedCount, 4);
  assert.ok(first.snapshot);

  const publicationQueue = publicationQueueFromSnapshot(first.snapshot);
  assert.equal(publicationQueue.length, 180);
  assert.equal(publicationQueue[0].id, first.snapshot.assignments[0].content_id);
  assert.equal(
    publicationQueue[0].publicationText,
    first.snapshot.assignments[0].publication_text,
  );
  assert.equal(
    publicationQueue[0].scheduledAt,
    first.snapshot.assignments[0].resolved_at,
  );
  assert.equal(
    publicationQueue[0].assignmentVersion,
    Number(first.snapshot.assignments[0].assignment_version),
  );
  assert.equal(
    publicationQueue[0].policyVersion,
    Number(first.snapshot.assignments[0].policy_version),
  );
  assert.equal(
    publicationQueue[0].contentDigest,
    first.snapshot.assignments[0].content_digest,
  );

  const frontier = db.prepare(
    'SELECT * FROM queue_intake_frontier WHERE singleton_id=1;',
  ).get();
  const beforeAssignments = activeAssignmentRows(db);
  const baselineHash = hashAssignmentRows(beforeAssignments);

  const normalized = normalizeIntakeInput({
    content_id: 'CQ-RUNTIME-181',
    pillar: 'A',
    title: 'Runtime item 181',
    body: 'This is an exact approved runtime fixture proving item 181 needs no Worker source regeneration.',
    source_ref: 'test:#90',
  }, { mode: 'single' });

  const plan = planIntake({
    normalized,
    frontier,
    policy,
    baselineAssignmentHash: baselineHash,
    runtimeState: runtimeState(db),
  });

  db.exec(renderOperationCreateSql(plan, AT2));
  db.exec(renderFrontierClaimSql(plan, AT2));
  db.exec(renderItemApplySql(plan, plan.items[0], AT2));

  const priorRowsAfterAppend = activeAssignmentRows(db)
    .filter((row) => row.content_id !== 'CQ-RUNTIME-181');
  assert.equal(hashAssignmentRows(priorRowsAfterAppend), baselineHash);

  const rows181 = await readDynamicRuntimeRows(db);
  const snapshot181 = await buildDynamicRuntimeSnapshot(rows181);

  assert.equal(snapshot181.active_assignment_count, 181);
  assert.equal(snapshot181.media_required_count, 4);
  assert.notEqual(snapshot181.revision_digest, revision1.revision_digest);

  const revision2 = nextRuntimeRevision({
    currentState: runtimeState(db),
    snapshot: snapshot181,
    sourceOperationId: plan.operation_id,
    recordedAt: AT2,
  });
  db.exec(renderRuntimeRevisionInsertSql(revision2));
  db.exec(renderOperationRuntimeResultSql(plan.operation_id, revision2, AT2));
  db.exec(renderOperationStatusSql(plan.operation_id, 'complete', AT2));
  db.exec(renderFrontierReleaseSql(plan, AT2));

  const second = await verifyDynamicRuntime(env);
  assert.equal(second.ok, true);
  assert.equal(second.generation, 2);
  assert.equal(second.activeAssignmentCount, 181);
  assert.equal(second.mediaRequiredCount, 4);
  assert.equal(second.revisionDigest, revision2.revision_digest);

  const stale = await verifyDynamicRuntime(env, {
    expectedGeneration: 1,
    expectedRevisionDigest: revision1.revision_digest,
  });
  assert.equal(stale.ok, false);
  assert.equal(stale.reason, 'stale_runtime_revision');

  const history = db.prepare(
    'SELECT generation,revision_digest,previous_revision_digest,source_operation_id ' +
    'FROM queue_runtime_revisions ORDER BY generation;',
  ).all();

  assert.equal(history.length, 2);
  assert.equal(history[0].generation, 1);
  assert.equal(history[1].generation, 2);
  assert.equal(history[1].previous_revision_digest, history[0].revision_digest);
  assert.equal(history[1].source_operation_id, plan.operation_id);

  const source = text('cloudflare/src/dynamic-runtime-integrity.mjs');
  assert.equal(
    /EXPECTED_QUEUE_COUNT\s*=\s*180|expectedCount:\s*180/.test(source),
    false,
    'dynamic verifier must not pin lifetime queue capacity to 180',
  );
});

test('public health endpoints report runtime integrity without exposing queued content', async () => {
  const db = new DatabaseSync(':memory:');
  try {
    seed180(db);
    db.exec(text('cloudflare/migrations/0001_xqueue_runtime.sql'));
    db.exec(text('cloudflare/migrations/0003_publication_lease.sql'));
    db.exec(text('cloudflare/migrations/0011_global_publication_halt.sql'));
    db.exec(text('cloudflare/migrations-production/0013_authority_ownership.sql'));
    db.exec(text('cloudflare/migrations-production/0014_authority_event_projection.sql'));
    db.exec(compileProductionAuthorityBootstrapSql({
      candidateSha: 'a'.repeat(40), transitionId: 'bootstrap', eventAt: AT1,
    }));
    db.exec(compileProductionNoneToCloudflareSql({
      candidateSha: 'a'.repeat(40), transitionId: 'transfer', eventAt: AT2,
      deploymentId: 'cloudflare-worker:xqueue-publisher-production:version:22222222-2222-2222-2222-222222222222',
    }));
    const snapshot = await buildDynamicRuntimeSnapshot(await readDynamicRuntimeRows(db));
    db.exec(renderRuntimeRevisionInsertSql(nextRuntimeRevision({
      currentState: null,
      snapshot,
      recordedAt: AT1,
    })));
    const now = new Date().toISOString();
    const posted = Object.fromEntries(snapshot.assignments.map((row) => [row.content_id, {
      tweetId: `test-${row.content_id}`, at: now,
    }]));
    const metadata = db.prepare('INSERT INTO runtime_metadata (key,value,updated_at) VALUES (?,?,?)');
    metadata.run('state.snapshot_json', JSON.stringify({
      version: 1, posted, skipped: {}, spend: 0, inflight: null,
    }), now);
    metadata.run('scheduler.last_invocation', JSON.stringify({ observedAt: now }), now);

    const env = {
      DB: {
        async batch(statements) { return Promise.all(statements.map((statement) => statement.all())); },
        prepare(sql) {
          const statement = db.prepare(sql);
          let params = [];
          return {
            bind(...values) { params = values; return this; },
            async first() { return statement.get(...params) ?? null; },
            async all() { return { results: statement.all(...params) }; },
          };
        },
      },
      MEDIA: new MediaStub(),
    };

    for (const worker of [statusWorker, compatibilityWorker]) {
      const response = await worker.fetch(new Request('https://x/health'), env);
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.dynamicRuntimeReadiness.ok, true);
      assert.equal(body.dynamicRuntimeReadiness.activeAssignmentCount, 180);
      assert.equal(body.dynamicRuntimeReadiness.snapshot, null);
      const serialized = JSON.stringify(body);
      assert.equal(serialized.includes('publication_text'), false);
      assert.equal(serialized.includes(snapshot.assignments[0].body), false);
    }

    db.prepare("UPDATE runtime_metadata SET value=? WHERE key='scheduler.last_invocation'")
      .run(JSON.stringify({ observedAt: new Date(Date.now() - 46 * 60_000).toISOString() }));
    const staleResponse = await statusWorker.fetch(new Request('https://x/health'), env);
    assert.equal(staleResponse.status, 503);
    const stale = await staleResponse.json();
    assert.equal(stale.schedulerLiveness.required, true);
    assert.equal(stale.schedulerLiveness.state, 'stale');
    assert.equal(stale.publisherAuthority.owner, 'cloudflare');
    assert.equal(stale.livePublication, false);
    assert.equal(stale.publicationCapable, false);
  } finally {
    db.close();
  }
});

test('dynamic snapshot fails closed on duplicate active content, duplicate slot, digest drift, and missing media', async () => {
  const base = {
    assignment_id: 'A1',
    assignment_version: 1,
    content_id: 'A1',
    content_revision: 1,
    content_digest: sha256('exact'),
    target_account: 'x-primary',
    policy_version: 2,
    resolved_at: '2027-01-08T20:30:00.000Z',
    scheduled_date: '2027-01-08',
    scheduled_time: '14:30',
    timezone: 'America/Chicago',
    slot_label: 'lull',
    status: 'active',
    superseded_by_version: null,
    assignment_generation: 1,
    pillar: 'A',
    intake_state: 'scheduled',
    title: 'x',
    body: 'exact',
    publication_text: 'exact',
    revision_content_digest: sha256('exact'),
    figure: null,
    source_ref: null,
  };

  await assert.rejects(
    buildDynamicRuntimeSnapshot({
      assignments: [base, {
        ...base,
        assignment_id: 'A1-v2',
        resolved_at: '2027-01-09T04:15:00.000Z',
      }],
      approvedUnscheduled: [],
      media: [],
    }),
    /duplicate active content/,
  );

  await assert.rejects(
    buildDynamicRuntimeSnapshot({
      assignments: [base, {
        ...base,
        assignment_id: 'A2',
        content_id: 'A2',
      }],
      approvedUnscheduled: [],
      media: [],
    }),
    /duplicate active slot/,
  );

  await assert.rejects(
    buildDynamicRuntimeSnapshot({
      assignments: [{
        ...base,
        revision_content_digest: 'f'.repeat(64),
      }],
      approvedUnscheduled: [],
      media: [],
    }),
    /publication text digest mismatch/,
  );

  await assert.rejects(
    buildDynamicRuntimeSnapshot({
      assignments: [{
        ...base,
        figure: 999,
      }],
      approvedUnscheduled: [],
      media: [],
    }),
    /media binding multiplicity/,
  );
});

test('publication queue projection refuses malformed authoritative rows', () => {
  assert.throws(
    () => publicationQueueFromSnapshot(null),
    /verified dynamic runtime snapshot is required/,
  );

  assert.throws(
    () => publicationQueueFromSnapshot({
      assignments: [{
        content_id: 'A1',
        pillar: 'A',
        title: 'A1',
        body: 'body',
        publication_text: 'body',
        content_digest: 'a'.repeat(64),
        revision_content_digest: 'b'.repeat(64),
        content_revision: 1,
        resolved_at: '2027-01-08T20:30:00.000Z',
        scheduled_date: '2027-01-08',
        scheduled_time: '14:30',
        timezone: 'America/Chicago',
        assignment_id: 'A1',
        assignment_version: 1,
        policy_version: 1,
      }],
    }),
    /assignment\/content digest mismatch/,
  );
});

test('single-statement runtime revision CAS refuses a stale predecessor', async () => {
  const db = new DatabaseSync(':memory:');
  seed180(db);

  const snapshot = await buildDynamicRuntimeSnapshot(
    await readDynamicRuntimeRows(db),
  );
  const first = nextRuntimeRevision({
    currentState: null,
    snapshot,
    recordedAt: AT1,
  });
  db.exec(renderRuntimeRevisionInsertSql(first));

  const bad = {
    ...first,
    generation: 2,
    revision_digest: 'b'.repeat(64),
    previous_revision_digest: 'c'.repeat(64),
    created_at: AT2,
  };

  db.exec(renderRuntimeRevisionInsertSql(bad));

  const history = db.prepare(
    'SELECT generation,revision_digest FROM queue_runtime_revisions ORDER BY generation;',
  ).all();
  assert.equal(history.length, 1);
  assert.equal(history[0].generation, 1);
  assert.equal(history[0].revision_digest, first.revision_digest);

  const state = runtimeState(db);
  assert.equal(state.generation, 1);
  assert.equal(state.revision_digest, first.revision_digest);
});
