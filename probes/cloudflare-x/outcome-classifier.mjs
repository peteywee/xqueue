const CONFIRMED_POSTED = 'confirmed_posted';
const CONFIRMED_NOT_POSTED = 'confirmed_not_posted';
const NEEDS_RECONCILIATION = 'needs_reconciliation';

function statusFrom(input) {
  const status = input?.response?.status ?? input?.status;
  return Number.isInteger(status) ? status : null;
}

function postIdFrom(input) {
  const value = input?.response?.data?.id ?? input?.data?.id ?? input?.postId;
  if (value === undefined || value === null) return null;
  const id = String(value).trim();
  return id || null;
}

function result(classification, reason, extras = {}) {
  return Object.freeze({
    classification,
    reason,
    automaticRetryAllowed: false,
    reconciliationRequired: classification === NEEDS_RECONCILIATION,
    ...extras,
  });
}

export function classifyPublicationOutcome(input = {}) {
  const phase = input.phase ?? 'unknown';
  const status = statusFrom(input);
  const postId = postIdFrom(input);
  const errorCode = typeof input?.error?.code === 'string' ? input.error.code : null;

  if (phase === 'pre_dispatch') {
    return result(CONFIRMED_NOT_POSTED, 'pre_dispatch_failure');
  }

  if (status !== null && status >= 200 && status < 300) {
    if (postId) {
      return result(CONFIRMED_POSTED, 'explicit_success', { postId });
    }
    return result(NEEDS_RECONCILIATION, 'successful_response_without_post_id');
  }

  if (status !== null && [400, 401, 403, 404, 409, 422, 429].includes(status)) {
    return result(CONFIRMED_NOT_POSTED, `explicit_http_refusal_${status}`, {
      retryableLater: status === 429,
    });
  }

  if (status !== null && status >= 500) {
    return result(NEEDS_RECONCILIATION, `server_error_${status}`);
  }

  if (phase === 'dispatched') {
    if (['ETIMEDOUT', 'ECONNRESET', 'EPIPE', 'UND_ERR_CONNECT_TIMEOUT'].includes(errorCode)) {
      return result(NEEDS_RECONCILIATION, `transport_${errorCode.toLowerCase()}`);
    }
    return result(NEEDS_RECONCILIATION, 'dispatched_outcome_unknown');
  }

  if (phase === 'not_dispatched') {
    return result(CONFIRMED_NOT_POSTED, 'request_not_dispatched');
  }

  return result(NEEDS_RECONCILIATION, 'insufficient_outcome_evidence');
}

export const OUTCOME_CLASSIFICATIONS = Object.freeze({
  CONFIRMED_POSTED,
  CONFIRMED_NOT_POSTED,
  NEEDS_RECONCILIATION,
});
