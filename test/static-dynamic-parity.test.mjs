import test from 'node:test';
import assert from 'node:assert/strict';

import { buildProductionShadow } from '../scripts/build-continuous-queue-shadow.mjs';
import {
  assertExactStaticDynamicRows,
  assertLedgerStateParity,
  buildObservationInstants,
  compareProjectionAtInstant,
  dynamicParityRows,
  proveBoundaryObservationParity,
  proveLiveParity,
  staticParityRows,
} from '../src/static-dynamic-parity.mjs';

function dynamicFromStatic(rows) {
  return dynamicParityRows(rows.map((row) => ({
    ...row,
    assignment_status: 'active',
    lifecycle_state: row.lifecycle_state ?? 'scheduled',
    content_status: 'active',
    current_revision: row.content_revision,
    revision_digest: row.content_digest,
  })));
}

function scheduledPublicationRows(rows) {
  return rows.map((row) => ({
    post_id: row.content_id,
    status: 'scheduled',
    tweet_id: null,
    attempt_id: null,
    skipped_at: null,
    skip_reason: null,
  }));
}

function emptyLedger() {
  return {
    version: 1,
    posted: {},
    skipped: {},
    deferred: {},
    spend: 0,
    inflight: null,
  };
}

test('full production baseline has exact row parity and 722 deterministic boundary observations', () => {
  const staticRows = staticParityRows(buildProductionShadow());
  const dynamicRows = dynamicFromStatic(staticRows);

  const exact = assertExactStaticDynamicRows(staticRows, dynamicRows);
  assert.equal(exact.count, 180);
  assert.match(exact.canonicalRowsHash, /^[a-f0-9]{64}$/);

  const instants = buildObservationInstants(staticRows, { graceMinutes: 20 });
  assert.equal(instants.length, 722);
  assert.equal(new Set(instants.map((row) => row.at)).size, 722);

  const proof = proveBoundaryObservationParity({
    staticRows,
    dynamicRows,
    publicationRows: scheduledPublicationRows(dynamicRows),
    deferralRows: [],
    graceMinutes: 20,
  });

  assert.equal(proof.assignmentCount, 180);
  assert.equal(proof.observationCount, 722);
  assert.match(proof.observationDigest, /^[a-f0-9]{64}$/);
  assert.equal(proof.firstObservation.selected.length, 0);
  assert.equal(proof.lastObservation.selected.length, 0);
  assert.equal(proof.lastObservation.projectedDeferrals.length, 180);
});

test('exact parity refuses digest, slot, revision, and cardinality drift', () => {
  const staticRows = staticParityRows(buildProductionShadow()).slice(0, 3);
  const base = dynamicFromStatic(staticRows);

  for (const mutate of [
    (rows) => { rows[0].content_digest = 'f'.repeat(64); },
    (rows) => { rows[0].resolved_at = '2026-12-01T12:00:00.000Z'; },
    (rows) => { rows[0].assignment_version = 2; },
    (rows) => { rows[0].content_revision = 2; },
  ]) {
    const changed = base.map((row) => ({ ...row }));
    mutate(changed);
    assert.throws(
      () => assertExactStaticDynamicRows(staticRows, changed),
      /parity failed|canonical row hashes|count mismatch/,
    );
  }

  assert.throws(
    () => assertExactStaticDynamicRows(staticRows, base.slice(0, 2)),
    /count mismatch/,
  );
});

test('live parity uses actual ledger state and publication_state identity', () => {
  const staticRows = staticParityRows(buildProductionShadow()).slice(0, 3);
  const dynamicRows = dynamicFromStatic(staticRows);
  const ledger = emptyLedger();
  ledger.posted[staticRows[0].content_id] = {
    tweetId: 'tweet-123',
    at: '2026-09-01T00:00:00.000Z',
  };

  const publicationRows = scheduledPublicationRows(dynamicRows);
  publicationRows[0] = {
    ...publicationRows[0],
    status: 'posted',
    tweet_id: 'tweet-123',
  };

  const proof = proveLiveParity({
    staticRows,
    dynamicRows,
    ledger,
    publicationRows,
    deferralRows: [],
    now: new Date(staticRows[1].resolved_at),
  });

  assert.equal(proof.state.postedCount, 1);
  assert.equal(proof.state.skippedCount, 0);
  assert.equal(proof.state.deferredCount, 0);
  assert.equal(proof.state.inflight, null);
  assert.deepEqual(proof.observation.selected, [staticRows[1].content_id]);
});

test('ledger state parity rejects publication state divergence', () => {
  const staticRows = staticParityRows(buildProductionShadow()).slice(0, 2);
  const dynamicRows = dynamicFromStatic(staticRows);
  const ledger = emptyLedger();
  ledger.posted[staticRows[0].content_id] = {
    tweetId: 'tweet-123',
    at: '2026-09-01T00:00:00.000Z',
  };

  assert.throws(
    () => assertLedgerStateParity({
      ledger,
      dynamicRows,
      publicationRows: scheduledPublicationRows(dynamicRows),
      deferralRows: [],
    }),
    /scheduled publication_state is resolved|lacks matching publication_state/,
  );
});

test('pending deferral must have exact ledger and assignment lifecycle identity', () => {
  const staticRows = staticParityRows(buildProductionShadow()).slice(0, 2);
  const rawDynamic = staticRows.map((row) => ({
    ...row,
    assignment_status: 'active',
    lifecycle_state: row.content_id === staticRows[0].content_id
      ? 'deferred'
      : 'scheduled',
    content_status: 'active',
    current_revision: row.content_revision,
    revision_digest: row.content_digest,
  }));
  const dynamicRows = dynamicParityRows(rawDynamic);

  const ledger = emptyLedger();
  ledger.deferred[staticRows[0].content_id] = {
    at: '2026-09-21T12:00:00.000Z',
    reason: 'missed_slot_grace_expired',
    assignmentId: staticRows[0].assignment_id,
    assignmentVersion: staticRows[0].assignment_version,
    policyVersion: staticRows[0].policy_version,
    resolvedAt: staticRows[0].resolved_at,
    scheduledDate: staticRows[0].scheduled_date,
    scheduledTime: staticRows[0].scheduled_time,
    timezone: staticRows[0].timezone,
    slot: staticRows[0].slot_label,
  };

  const deferralRows = [{
    content_id: staticRows[0].content_id,
    assignment_id: staticRows[0].assignment_id,
    assignment_version: staticRows[0].assignment_version,
    policy_version: staticRows[0].policy_version,
    prior_resolved_at: staticRows[0].resolved_at,
    reason: 'missed_slot_grace_expired',
    state: 'pending_replacement',
  }];

  const state = assertLedgerStateParity({
    ledger,
    dynamicRows,
    publicationRows: scheduledPublicationRows(dynamicRows),
    deferralRows,
  });

  assert.equal(state.deferredCount, 1);

  const broken = structuredClone(ledger);
  broken.deferred[staticRows[0].content_id].assignmentVersion += 1;

  assert.throws(
    () => assertLedgerStateParity({
      ledger: broken,
      dynamicRows,
      publicationRows: scheduledPublicationRows(dynamicRows),
      deferralRows,
    }),
    /deferral identity mismatch/,
  );
});

test('static and dynamic paths agree exactly across due and grace boundaries', () => {
  const staticRows = staticParityRows(buildProductionShadow()).slice(0, 2);
  const dynamicRows = dynamicFromStatic(staticRows);
  const publicationRows = scheduledPublicationRows(dynamicRows);
  const slotMs = Date.parse(staticRows[0].resolved_at);

  const beforeDue = compareProjectionAtInstant({
    staticRows,
    dynamicRows,
    ledger: emptyLedger(),
    publicationRows,
    deferralRows: [],
    at: new Date(slotMs - 1).toISOString(),
  });
  assert.deepEqual(beforeDue.selected, []);

  const due = compareProjectionAtInstant({
    staticRows,
    dynamicRows,
    ledger: emptyLedger(),
    publicationRows,
    deferralRows: [],
    at: new Date(slotMs).toISOString(),
  });
  assert.deepEqual(due.selected, [staticRows[0].content_id]);
  assert.deepEqual(due.overdue, []);

  const grace = compareProjectionAtInstant({
    staticRows,
    dynamicRows,
    ledger: emptyLedger(),
    publicationRows,
    deferralRows: [],
    at: new Date(slotMs + 20 * 60_000).toISOString(),
  });
  assert.deepEqual(grace.selected, [staticRows[0].content_id]);
  assert.deepEqual(grace.projectedDeferrals, []);

  const missed = compareProjectionAtInstant({
    staticRows,
    dynamicRows,
    ledger: emptyLedger(),
    publicationRows,
    deferralRows: [],
    at: new Date(slotMs + 20 * 60_000 + 1).toISOString(),
  });
  assert.deepEqual(missed.selected, []);
  assert.deepEqual(missed.projectedDeferrals, [staticRows[0].content_id]);
});

test('matching inflight reconciliation blocks both paths without auto-deferral', () => {
  const staticRows = staticParityRows(buildProductionShadow()).slice(0, 2);
  const dynamicRows = dynamicFromStatic(staticRows);
  const ledger = emptyLedger();
  const postId = staticRows[0].content_id;
  ledger.inflight = {
    attemptId: 'attempt-12345678',
    postId,
    status: 'needs_reconciliation',
  };

  const publicationRows = scheduledPublicationRows(dynamicRows);
  publicationRows[0] = {
    ...publicationRows[0],
    status: 'needs_reconciliation',
    attempt_id: 'attempt-12345678',
  };

  const at = new Date(
    Date.parse(staticRows[0].resolved_at) + 20 * 60_000 + 1,
  ).toISOString();

  const proof = proveLiveParity({
    staticRows,
    dynamicRows,
    ledger,
    publicationRows,
    deferralRows: [],
    now: new Date(at),
  });

  assert.equal(proof.observation.safeToPublish, false);
  assert.deepEqual(proof.observation.selected, []);
  assert.deepEqual(proof.observation.projectedDeferrals, []);
  assert.deepEqual(proof.state.inflight, {
    postId,
    status: 'needs_reconciliation',
  });
});
