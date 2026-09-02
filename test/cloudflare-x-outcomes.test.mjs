import test from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyPublicationOutcome,
  OUTCOME_CLASSIFICATIONS,
} from '../probes/cloudflare-x/outcome-classifier.mjs';

const {
  CONFIRMED_POSTED,
  CONFIRMED_NOT_POSTED,
  NEEDS_RECONCILIATION,
} = OUTCOME_CLASSIFICATIONS;

function expect(input, classification, reason) {
  const result = classifyPublicationOutcome(input);
  assert.equal(result.classification, classification);
  assert.equal(result.reason, reason);
  assert.equal(result.automaticRetryAllowed, false);
  assert.equal(result.reconciliationRequired, classification === NEEDS_RECONCILIATION);
  return result;
}

test('2xx with exact post ID is confirmed posted', () => {
  const result = expect(
    { phase: 'dispatched', response: { status: 201, data: { id: '2099' } } },
    CONFIRMED_POSTED,
    'explicit_success',
  );
  assert.equal(result.postId, '2099');
});

test('2xx without usable post ID is ambiguous', () => {
  expect(
    { phase: 'dispatched', response: { status: 201, data: {} } },
    NEEDS_RECONCILIATION,
    'successful_response_without_post_id',
  );
  expect(
    { phase: 'dispatched', response: { status: 200, data: { id: '   ' } } },
    NEEDS_RECONCILIATION,
    'successful_response_without_post_id',
  );
});

test('pre-dispatch validation/auth setup failure is confirmed not posted', () => {
  expect({ phase: 'pre_dispatch', error: { message: 'bad input' } }, CONFIRMED_NOT_POSTED, 'pre_dispatch_failure');
});

test('contradictory pre-dispatch/not-dispatched evidence is reconciliation-required', () => {
  for (const phase of ['pre_dispatch', 'not_dispatched']) {
    expect(
      { phase, response: { status: 201, data: { id: 'could-have-posted' } } },
      NEEDS_RECONCILIATION,
      'contradictory_dispatch_evidence',
    );
    expect(
      { phase, response: { status: 401 } },
      NEEDS_RECONCILIATION,
      'contradictory_dispatch_evidence',
    );
  }
});

test('explicit client-side HTTP refusals are confirmed not posted', () => {
  for (const status of [400, 401, 403, 404, 409, 422]) {
    expect(
      { phase: 'dispatched', response: { status } },
      CONFIRMED_NOT_POSTED,
      `explicit_http_refusal_${status}`,
    );
  }
});

test('429 is confirmed refused but never automatically retried', () => {
  const result = expect(
    { phase: 'dispatched', response: { status: 429 } },
    CONFIRMED_NOT_POSTED,
    'explicit_http_refusal_429',
  );
  assert.equal(result.retryableLater, true);
  assert.equal(result.automaticRetryAllowed, false);
});

test('5xx after dispatch is reconciliation-required', () => {
  for (const status of [500, 502, 503, 504]) {
    expect(
      { phase: 'dispatched', response: { status } },
      NEEDS_RECONCILIATION,
      `server_error_${status}`,
    );
  }
});

test('timeout/reset/pipe failure after dispatch is reconciliation-required', () => {
  for (const code of ['ETIMEDOUT', 'ECONNRESET', 'EPIPE', 'UND_ERR_CONNECT_TIMEOUT']) {
    expect(
      { phase: 'dispatched', error: { code } },
      NEEDS_RECONCILIATION,
      `transport_${code.toLowerCase()}`,
    );
  }
});

test('known request-not-dispatched transport failure is confirmed not posted', () => {
  expect(
    { phase: 'not_dispatched', error: { code: 'ENOTFOUND' } },
    CONFIRMED_NOT_POSTED,
    'request_not_dispatched',
  );
});

test('unknown evidence fails closed to reconciliation', () => {
  expect({}, NEEDS_RECONCILIATION, 'insufficient_outcome_evidence');
  expect(
    { phase: 'dispatched', error: { code: 'SOMETHING_NEW' } },
    NEEDS_RECONCILIATION,
    'dispatched_outcome_unknown',
  );
});

test('classifier output contains no raw response or error objects', () => {
  const secret = 'credential-like-sensitive-value';
  const result = classifyPublicationOutcome({
    phase: 'dispatched',
    response: { status: 500, body: secret },
    error: { message: secret },
  });
  assert.equal(JSON.stringify(result).includes(secret), false);
});
