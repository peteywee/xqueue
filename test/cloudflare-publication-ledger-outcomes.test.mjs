import test from 'node:test';
import assert from 'node:assert/strict';

import {
  persistPublicationOutcome,
} from '../cloudflare/src/publication-ledger.mjs';

function prepared(sql, params = []) {
  return {
    sql,
    params,
    bind(...next) {
      return prepared(sql, next);
    },
  };
}

function fakeDb(onBatch) {
  return {
    prepare(sql) {
      return prepared(sql);
    },
    async batch(statements) {
      onBatch?.(statements);
      return [
        { success: true, results: [] },
        { success: true, results: [{ direct_changes: 1 }] },
        { success: true, results: [] },
        { success: true, results: [{ direct_changes: 1 }] },
        { success: true, results: [] },
        { success: true, results: [{ direct_changes: 1 }] },
      ];
    },
  };
}

function publishingSnapshot() {
  const ledger = {
    posted: {},
    spend: 0,
    inflight: {
      attemptId: 'attempt-12345678',
      postId: 'A1',
      title: 'A1',
      contentHash: 'abc123',
      cost: 0.01,
      startedAt: '2026-09-06T12:00:00.000Z',
      status: 'publishing',
      publishStartedAt: '2026-09-06T12:00:00.000Z',
    },
  };

  return {
    raw: JSON.stringify(ledger),
    ledger,
    publicationStateGeneration: 2,
  };
}

test('confirmed_not_posted remains distinct and returns content to scheduled state', async () => {
  let captured;
  const db = fakeDb((statements) => {
    captured = statements;
  });

  const result = await persistPublicationOutcome(
    db,
    publishingSnapshot(),
    {
      post: { id: 'A1' },
      outcome: {
        classification: 'confirmed_not_posted',
        reason: 'explicit_http_refusal_429',
      },
      now: new Date('2026-09-06T12:01:00.000Z'),
    },
  );

  assert.equal(result.classification, 'confirmed_not_posted');
  assert.equal(result.reconciliationRequired, false);
  assert.equal(result.publicationStateGeneration, 3);
  assert.equal(result.ledger.inflight, null);
  assert.match(captured[2].sql, /status = 'scheduled'/);
  assert.match(captured[2].sql, /generation = generation \+ 1/);
  assert.match(captured[2].sql, /generation = \?6/);
  assert.match(captured[2].sql, /changes\(\) = 1/);
  assert.match(captured[2].sql, /attempt_id = NULL/);
  assert.equal(captured[4].params[1], 'confirmed_not_posted');

  const detail = JSON.parse(captured[4].params[3]);
  assert.equal(detail.classification, 'confirmed_not_posted');
  assert.equal(detail.automaticRetryAllowed, false);
  assert.equal(detail.stateGeneration, 3);
});

test('ambiguous outcome remains needs_reconciliation and retains inflight evidence', async () => {
  let captured;
  const db = fakeDb((statements) => {
    captured = statements;
  });

  const result = await persistPublicationOutcome(
    db,
    publishingSnapshot(),
    {
      post: { id: 'A1' },
      outcome: {
        classification: 'needs_reconciliation',
        reason: 'transport_timeout_after_dispatch',
      },
      now: new Date('2026-09-06T12:01:00.000Z'),
    },
  );

  assert.equal(result.reconciliationRequired, true);
  assert.equal(result.publicationStateGeneration, 3);
  assert.equal(result.ledger.inflight.status, 'needs_reconciliation');
  assert.match(captured[2].sql, /status = 'needs_reconciliation'/);
  assert.match(captured[2].sql, /generation = generation \+ 1/);
  assert.equal(captured[4].params[1], 'needs_reconciliation');
  assert.equal(JSON.parse(captured[4].params[3]).stateGeneration, 3);
});

test('unknown classifier output fails closed to reconciliation', async () => {
  const db = fakeDb();

  const result = await persistPublicationOutcome(
    db,
    publishingSnapshot(),
    {
      post: { id: 'A1' },
      outcome: {
        classification: 'unexpected_value',
        reason: 'classifier_contract_violation',
      },
      now: new Date('2026-09-06T12:01:00.000Z'),
    },
  );

  assert.equal(result.reconciliationRequired, true);
  assert.equal(result.publicationStateGeneration, 3);
  assert.equal(result.ledger.inflight.status, 'needs_reconciliation');
});
