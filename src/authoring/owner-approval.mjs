import {
  createHash,
  createPublicKey,
  verify as verifySignature,
} from 'node:crypto';

import {
  AuthoringContractError,
  assertApproval,
  assertApprovalForCandidate,
  assertArtifactCandidate,
  digestObject,
  digestText,
} from './contracts.mjs';

export const OWNER_APPROVAL_DOMAIN = 'xqueue-author-owner-approval';
export const OWNER_APPROVAL_VERSION = '1';
export const OWNER_APPROVAL_PROOF_TYPE = 'ed25519-detached';

function fail(code, message) {
  throw new AuthoringContractError(code, message);
}

function assertDecision(value) {
  if (!['approve', 'reject'].includes(value)) {
    fail('explicit_owner_decision_required', 'decision must be approve or reject');
  }
}

function assertDate(value) {
  if (typeof value !== 'string' || !value.trim() || Number.isNaN(Date.parse(value))) {
    fail('invalid_owner_decision_time', 'decided_at must be an ISO-compatible date-time');
  }
}

function assertDigest(value) {
  if (typeof value !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(value)) {
    fail('invalid_owner_candidate_digest', 'candidate_digest must be a sha256 digest');
  }
}

function normalizedPayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    fail('invalid_owner_approval_payload', 'owner approval payload must be an object');
  }

  const expectedKeys = [
    'candidate_digest',
    'candidate_id',
    'decided_at',
    'decision',
    'domain',
    'version',
  ];
  const actualKeys = Object.keys(payload).sort();
  if (JSON.stringify(actualKeys) !== JSON.stringify(expectedKeys)) {
    fail('invalid_owner_approval_payload', 'owner approval payload has unexpected or missing fields');
  }
  if (payload.domain !== OWNER_APPROVAL_DOMAIN || payload.version !== OWNER_APPROVAL_VERSION) {
    fail('owner_approval_domain_mismatch', 'owner approval payload domain/version is not authoritative');
  }
  if (typeof payload.candidate_id !== 'string' || !payload.candidate_id.trim()) {
    fail('invalid_owner_candidate_id', 'candidate_id is required');
  }
  assertDigest(payload.candidate_digest);
  assertDecision(payload.decision);
  assertDate(payload.decided_at);

  return Object.freeze({
    domain: OWNER_APPROVAL_DOMAIN,
    version: OWNER_APPROVAL_VERSION,
    candidate_id: payload.candidate_id,
    candidate_digest: payload.candidate_digest,
    decision: payload.decision,
    decided_at: payload.decided_at,
  });
}

function asEd25519PublicKey(publicKeyPem) {
  if (typeof publicKeyPem !== 'string' || !publicKeyPem.trim()) {
    fail('owner_public_key_required', 'owner approval public key is required');
  }
  let key;
  try {
    key = createPublicKey(publicKeyPem);
  } catch {
    fail('owner_public_key_invalid', 'owner approval public key could not be parsed');
  }
  if (key.asymmetricKeyType !== 'ed25519') {
    fail('owner_public_key_invalid', 'owner approval public key must be Ed25519');
  }
  return key;
}

function signatureBuffer(signatureBase64) {
  if (typeof signatureBase64 !== 'string' || !signatureBase64.trim()) {
    fail('owner_signature_required', 'detached owner signature is required');
  }
  let signature;
  try {
    signature = Buffer.from(signatureBase64, 'base64');
  } catch {
    fail('owner_signature_invalid', 'detached owner signature is not valid base64');
  }
  if (signature.length !== 64) {
    fail('owner_signature_invalid', 'Ed25519 detached owner signature must be 64 bytes');
  }
  return signature;
}

export function createOwnerApprovalPayload({ candidate, decision, decidedAt }) {
  assertArtifactCandidate(candidate);
  assertDecision(decision);
  assertDate(decidedAt);
  if (candidate.status !== 'reviewable') {
    fail('candidate_not_reviewable', 'only a reviewable candidate may enter owner decision');
  }
  return normalizedPayload({
    domain: OWNER_APPROVAL_DOMAIN,
    version: OWNER_APPROVAL_VERSION,
    candidate_id: candidate.candidate_id,
    candidate_digest: candidate.content_digest,
    decision,
    decided_at: decidedAt,
  });
}

export function serializeOwnerApprovalPayload(payload) {
  const value = normalizedPayload(payload);
  return `${JSON.stringify(value)}\n`;
}

export function parseCanonicalOwnerApprovalPayload(text) {
  if (typeof text !== 'string' || !text.trim()) {
    fail('invalid_owner_approval_payload', 'owner approval payload text is required');
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    fail('invalid_owner_approval_payload', 'owner approval payload is not valid JSON');
  }
  const value = normalizedPayload(parsed);
  if (text !== serializeOwnerApprovalPayload(value)) {
    fail('owner_approval_payload_not_canonical', 'owner approval payload bytes are not canonical');
  }
  return value;
}

export function ownerPublicKeyFingerprint(publicKeyPem) {
  const key = asEd25519PublicKey(publicKeyPem);
  const der = key.export({ type: 'spki', format: 'der' });
  return `sha256:${createHash('sha256').update(der).digest('hex')}`;
}

export function verifyOwnerApprovalSignature({ payload, signatureBase64, publicKeyPem }) {
  const value = normalizedPayload(payload);
  const serialized = serializeOwnerApprovalPayload(value);
  const key = asEd25519PublicKey(publicKeyPem);
  const signature = signatureBuffer(signatureBase64);
  return verifySignature(null, Buffer.from(serialized, 'utf8'), key, signature);
}

export function createAuthenticatedOwnerApproval({
  candidate,
  payload,
  signatureBase64,
  publicKeyPem,
  attestations = [],
  notes = null,
}) {
  assertArtifactCandidate(candidate);
  const value = normalizedPayload(payload);
  if (value.candidate_id !== candidate.candidate_id) {
    fail('approval_candidate_mismatch', 'signed owner payload is for a different candidate id');
  }
  if (value.candidate_digest !== candidate.content_digest) {
    fail('approval_digest_mismatch', 'signed owner payload does not bind to the exact candidate digest');
  }
  if (!verifyOwnerApprovalSignature({ payload: value, signatureBase64, publicKeyPem })) {
    fail('owner_signature_invalid', 'detached owner signature does not verify');
  }

  const serialized = serializeOwnerApprovalPayload(value);
  const approval = {
    approval_id: `approval:${digestObject({ payload: value, signature: signatureBase64 }).slice(-20)}`,
    candidate_id: value.candidate_id,
    candidate_digest: value.candidate_digest,
    decision: value.decision,
    decided_by: 'Patrick Craven',
    decided_at: value.decided_at,
    owner_proof: {
      type: OWNER_APPROVAL_PROOF_TYPE,
      public_key_fingerprint: ownerPublicKeyFingerprint(publicKeyPem),
      payload_digest: digestText(serialized),
      signature_base64: signatureBase64,
    },
    attestations,
    notes,
  };
  assertApproval(approval);
  if (approval.decision === 'approve') assertApprovalForCandidate(candidate, approval);
  return Object.freeze({ ...approval, owner_proof: Object.freeze({ ...approval.owner_proof }) });
}

export function assertAuthenticatedOwnerApprovalForCandidate(candidate, approval, publicKeyPem) {
  assertApprovalForCandidate(candidate, approval);
  const proof = approval?.owner_proof;
  if (!proof || typeof proof !== 'object' || Array.isArray(proof)) {
    fail('owner_signature_required', 'authoritative promotion requires detached owner signature proof');
  }
  if (proof.type !== OWNER_APPROVAL_PROOF_TYPE) {
    fail('owner_signature_type_invalid', 'unsupported owner approval proof type');
  }

  const expectedFingerprint = ownerPublicKeyFingerprint(publicKeyPem);
  if (proof.public_key_fingerprint !== expectedFingerprint) {
    fail('owner_public_key_mismatch', 'approval proof was not signed under the configured owner authority key');
  }

  const payload = normalizedPayload({
    domain: OWNER_APPROVAL_DOMAIN,
    version: OWNER_APPROVAL_VERSION,
    candidate_id: approval.candidate_id,
    candidate_digest: approval.candidate_digest,
    decision: approval.decision,
    decided_at: approval.decided_at,
  });
  const serialized = serializeOwnerApprovalPayload(payload);
  if (proof.payload_digest !== digestText(serialized)) {
    fail('owner_payload_digest_mismatch', 'approval proof payload digest does not match authoritative approval fields');
  }
  if (!verifyOwnerApprovalSignature({
    payload,
    signatureBase64: proof.signature_base64,
    publicKeyPem,
  })) {
    fail('owner_signature_invalid', 'detached owner signature does not verify');
  }
  return true;
}
