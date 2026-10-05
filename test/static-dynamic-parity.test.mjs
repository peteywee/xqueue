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
  traceGuardedIntakeRows,
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

// Option B: the accepted static baseline must be present unchanged, and every
// other active assignment must be the exact result of a COMPLETE guarded intake.
function guardedExtra(index, at) {
  const id = 'I-GUARDED-' + index;
  const digest = String(index).repeat(64).slice(0, 64).replace(/[^0-9a-f]/g, 'a');
  return {
    row: {
      assignment_id: id, assignment_version: 1, content_id: id, content_revision: 1, content_digest: digest,
      target_account: 'x-primary', policy_version: 1, resolved_at: at.resolved_at, scheduled_date: at.scheduled_date,
      scheduled_time: at.scheduled_time, timezone: at.timezone, slot_label: at.slot_label, lifecycle_state: 'scheduled',
    },
    item: {
      item_key: id, resulting_content_revision: 1, resulting_assignment_version: 1, readback_status: 'applied',
      readback_digest: 'e'.repeat(64), operation_id: 'mutation-intake-' + String(index).repeat(24).slice(0, 24),
      operation_kind: 'intake', operation_state: 'COMPLETE', effect_state: 'applied',
      intake_operation_id: 'intake-' + index, intake_status: 'complete', intake_content_digest: digest,
      intake_target_account: 'x-primary', intake_policy_version: 1,
      intake_resolved_at: at.resolved_at, intake_scheduled_date: at.scheduled_date, intake_scheduled_time: at.scheduled_time,
      intake_timezone: at.timezone, intake_slot_label: at.slot_label,
    },
  };
}

function guardedScenario() {
  const baseline = staticParityRows(buildProductionShadow());
  const last = baseline.at(-1);
  const policy = baseline[0].policy_version;
  const account = baseline[0].target_account;
  const slots = [1, 2].map((days) => {
    const at = new Date(Date.parse(last.resolved_at) + days * 86_400_000);
    return {
      resolved_at: at.toISOString(),
      scheduled_date: at.toISOString().slice(0, 10),
      scheduled_time: '05:00',
      timezone: last.timezone,
      slot_label: 'lull',
    };
  });
  const extras = slots.map((at, index) => {
    const { row, item } = guardedExtra(index + 1, at);
    return {
      row: { ...row, policy_version: policy, target_account: account },
      item: { ...item, intake_policy_version: policy, intake_target_account: account },
    };
  });
  const dynamicRows = dynamicFromStatic([...baseline, ...extras.map((extra) => extra.row)]);
  return { baseline, dynamicRows, items: extras.map((extra) => extra.item) };
}

test('guarded intake extras join the baseline as the expected set, and full parity holds', () => {
  const { baseline, dynamicRows, items } = guardedScenario();
  const trace = traceGuardedIntakeRows({ staticRows: baseline, dynamicRows, guardedItems: items });
  assert.equal(trace.staticCount, 180);
  assert.equal(trace.guardedIntakeCount, 2);
  assert.equal(trace.guardedOperations.length, 2);
  assert.equal(assertExactStaticDynamicRows(trace.expectedRows, dynamicRows).count, 182);
  const proof = proveBoundaryObservationParity({
    staticRows: trace.expectedRows,
    dynamicRows,
    publicationRows: scheduledPublicationRows(dynamicRows),
    deferralRows: [],
    graceMinutes: 20,
  });
  assert.equal(proof.assignmentCount, 182);
  // With no guarded intake, the expected set is exactly the baseline.
  const plain = traceGuardedIntakeRows({ staticRows: baseline, dynamicRows: dynamicFromStatic(baseline), guardedItems: [] });
  assert.equal(plain.expectedRows.length, 180);
});

test('an extra assignment without exact applied guarded intake evidence fails the proof', () => {
  const cases = [
    ['no evidence', (items) => items.slice(1), /has no guarded intake evidence/],
    ['not COMPLETE', (items) => [{ ...items[0], operation_state: 'VERIFYING' }, items[1]], /is not COMPLETE\/applied/],
    ['ambiguous effect', (items) => [{ ...items[0], effect_state: 'ambiguous' }, items[1]], /is not COMPLETE\/applied/],
    ['dispatched effect', (items) => [{ ...items[0], effect_state: 'dispatched' }, items[1]], /is not COMPLETE\/applied/],
    ['readback not applied', (items) => [{ ...items[0], readback_status: 'conflict' }, items[1]], /readback is not applied/],
    ['readback digest missing', (items) => [{ ...items[0], readback_digest: null }, items[1]], /readback is not applied/],
    ['intake incomplete', (items) => [{ ...items[0], intake_status: 'claimed' }, items[1]], /complete intake operation/],
    ['intake item missing', (items) => [{ ...items[0], intake_content_digest: null }, items[1]], /complete intake operation/],
    ['duplicate evidence', (items) => [...items, items[0]], /duplicate guarded intake item/],
  ];
  for (const [name, mutate, pattern] of cases) {
    const { baseline, dynamicRows, items } = guardedScenario();
    assert.throws(
      () => traceGuardedIntakeRows({ staticRows: baseline, dynamicRows, guardedItems: mutate(items) }),
      pattern,
      name,
    );
  }
});

test('reconstructed rows must match the runtime exactly, field by field', () => {
  for (const [field, value] of [
    ['intake_resolved_at', '2030-01-01T00:00:00.000Z'],
    ['intake_slot_label', 'rush'],
    ['intake_content_digest', 'f'.repeat(64)],
    ['resulting_assignment_version', 2],
    ['resulting_content_revision', 2],
    ['intake_target_account', 'x-secondary'],
    ['intake_policy_version', (item) => item.intake_policy_version + 1],
  ]) {
    const { baseline, dynamicRows, items } = guardedScenario();
    const changed = typeof value === 'function' ? value(items[0]) : value;
    const trace = traceGuardedIntakeRows({
      staticRows: baseline, dynamicRows, guardedItems: [{ ...items[0], [field]: changed }, items[1]],
    });
    assert.throws(() => assertExactStaticDynamicRows(trace.expectedRows, dynamicRows), /exact row parity failed/, field);
  }
});

test('only an operation proven to have changed nothing is set aside', () => {
  const { baseline, dynamicRows, items } = guardedScenario();
  const discarded = { ...items[0], item_key: 'I-NEVER-APPLIED', operation_id: 'mutation-intake-discarded', operation_state: 'DISCARDED', effect_state: 'not_applied', intake_status: null, intake_content_digest: null };
  const retried = { ...items[0], operation_id: 'mutation-intake-first-try', operation_state: 'DEFERRED', effect_state: 'none', readback_status: 'pending', readback_digest: null };
  const trace = traceGuardedIntakeRows({ staticRows: baseline, dynamicRows, guardedItems: [discarded, retried, ...items] });
  assert.equal(trace.guardedIntakeCount, 2);
  assert.equal(trace.guardedNotAppliedCount, 2);
  assert.equal(assertExactStaticDynamicRows(trace.expectedRows, dynamicRows).count, 182);
  // Setting aside never stands in for evidence of an active assignment.
  assert.throws(
    () => traceGuardedIntakeRows({ staticRows: baseline, dynamicRows, guardedItems: [{ ...items[0], effect_state: 'not_applied' }, items[1]] }),
    /has no guarded intake evidence/,
  );
});

test('the static baseline must be present unchanged and guarded intake cannot replace it', () => {
  const { baseline, dynamicRows, items } = guardedScenario();
  const missing = dynamicRows.filter((row) => row.content_id !== baseline[5].content_id);
  assert.throws(
    () => traceGuardedIntakeRows({ staticRows: baseline, dynamicRows: missing, guardedItems: items }),
    new RegExp('static assignments missing from the dynamic runtime: ' + baseline[5].content_id),
  );
  assert.throws(
    () => traceGuardedIntakeRows({
      staticRows: baseline, dynamicRows, guardedItems: [...items, { ...items[0], item_key: baseline[0].content_id }],
    }),
    /shadows a static assignment/,
  );
  // An applied guarded intake whose assignment vanished fails too.
  const vanished = dynamicRows.filter((row) => row.content_id !== items[1].item_key);
  assert.throws(
    () => traceGuardedIntakeRows({ staticRows: baseline, dynamicRows: vanished, guardedItems: items }),
    /applied guarded intake item is not an active assignment/,
  );
  // A drifted baseline row still fails exact parity.
  const drifted = dynamicFromStatic([
    { ...baseline[0], slot_label: 'drift' },
    ...baseline.slice(1),
    ...dynamicRows.slice(180),
  ]);
  const trace = traceGuardedIntakeRows({ staticRows: baseline, dynamicRows: drifted, guardedItems: items });
  assert.throws(() => assertExactStaticDynamicRows(trace.expectedRows, drifted), /exact row parity failed/);
});
