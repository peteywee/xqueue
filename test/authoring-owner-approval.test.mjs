import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';

import { candidateDigest } from '../src/authoring/contracts.mjs';
import {
  assertAuthenticatedOwnerApprovalForCandidate,
  createAuthenticatedOwnerApproval,
  createOwnerApprovalPayload,
  ownerPublicKeyFingerprint,
  parseCanonicalOwnerApprovalPayload,
  serializeOwnerApprovalPayload,
} from '../src/authoring/owner-approval.mjs';

const when = '2026-09-14T21:00:00.000Z';
const ownerKeys = generateKeyPairSync('ed25519');
const otherKeys = generateKeyPairSync('ed25519');
const ownerPublicKeyPem = ownerKeys.publicKey.export({ type: 'spki', format: 'pem' });
const otherPublicKeyPem = otherKeys.publicKey.export({ type: 'spki', format: 'pem' });

function candidate(overrides = {}) {
  const value = {
    candidate_id: 'signed-candidate-1',
    artifact_kind: 'post',
    status: 'reviewable',
    title: 'Configured is not running',
    body: 'A configured scheduler is not proof that it is running. Runtime evidence closes that gap.',
    pillar: 'C',
    knowledge_unit_refs: ['ku-1'],
    source_refs: ['src-1'],
    created_at: when,
    validation: { result: 'pass', findings: [] },
    ...overrides,
  };
  value.content_digest = candidateDigest(value);
  return value;
}

function signedApproval(value, { decision = 'approve', decidedAt = when, privateKey = ownerKeys.privateKey, publicKeyPem = ownerPublicKeyPem } = {}) {
  const payload = createOwnerApprovalPayload({ candidate: value, decision, decidedAt });
  const signatureBase64 = sign(null, Buffer.from(serializeOwnerApprovalPayload(payload), 'utf8'), privateKey).toString('base64');
  return createAuthenticatedOwnerApproval({
    candidate: value,
    payload,
    signatureBase64,
    publicKeyPem,
  });
}

test('valid detached owner signature authorizes only the exact candidate', () => {
  const value = candidate();
  const approval = signedApproval(value);
  assert.equal(assertAuthenticatedOwnerApprovalForCandidate(value, approval, ownerPublicKeyPem), true);
  assert.equal(approval.owner_proof.public_key_fingerprint, ownerPublicKeyFingerprint(ownerPublicKeyPem));
});

test('candidate data alone is insufficient to create authenticated approval', () => {
  const value = candidate();
  const payload = createOwnerApprovalPayload({ candidate: value, decision: 'approve', decidedAt: when });
  assert.throws(
    () => createAuthenticatedOwnerApproval({
      candidate: value,
      payload,
      signatureBase64: Buffer.alloc(64).toString('base64'),
      publicKeyPem: ownerPublicKeyPem,
    }),
    (error) => error?.code === 'owner_signature_invalid',
  );
});

test('altering candidate after signature invalidates approval authority', () => {
  const value = candidate();
  const approval = signedApproval(value);
  const edited = { ...value, body: `${value.body} Changed.` };
  edited.content_digest = candidateDigest(edited);
  assert.throws(
    () => assertAuthenticatedOwnerApprovalForCandidate(edited, approval, ownerPublicKeyPem),
    (error) => ['approval_digest_mismatch', 'owner_signature_invalid'].includes(error?.code),
  );
});

test('altering signed decision or timestamp invalidates detached signature', () => {
  const value = candidate();
  const approval = signedApproval(value);

  assert.throws(
    () => assertAuthenticatedOwnerApprovalForCandidate(value, { ...approval, decision: 'reject' }, ownerPublicKeyPem),
    (error) => ['approval_required', 'owner_payload_digest_mismatch', 'owner_signature_invalid'].includes(error?.code),
  );

  assert.throws(
    () => assertAuthenticatedOwnerApprovalForCandidate(value, { ...approval, decided_at: '2026-09-14T21:01:00.000Z' }, ownerPublicKeyPem),
    (error) => ['owner_payload_digest_mismatch', 'owner_signature_invalid'].includes(error?.code),
  );
});

test('signature from a different private key is rejected by owner authority', () => {
  const value = candidate();
  const payload = createOwnerApprovalPayload({ candidate: value, decision: 'approve', decidedAt: when });
  const wrongSignature = sign(null, Buffer.from(serializeOwnerApprovalPayload(payload), 'utf8'), otherKeys.privateKey).toString('base64');
  assert.throws(
    () => createAuthenticatedOwnerApproval({
      candidate: value,
      payload,
      signatureBase64: wrongSignature,
      publicKeyPem: ownerPublicKeyPem,
    }),
    (error) => error?.code === 'owner_signature_invalid',
  );
});

test('approval verified under another public key cannot be replayed under owner key', () => {
  const value = candidate();
  const foreign = signedApproval(value, { privateKey: otherKeys.privateKey, publicKeyPem: otherPublicKeyPem });
  assert.throws(
    () => assertAuthenticatedOwnerApprovalForCandidate(value, foreign, ownerPublicKeyPem),
    (error) => error?.code === 'owner_public_key_mismatch',
  );
});

test('canonical payload bytes are enforced before signature import', () => {
  const value = candidate();
  const payload = createOwnerApprovalPayload({ candidate: value, decision: 'approve', decidedAt: when });
  const canonical = serializeOwnerApprovalPayload(payload);
  assert.deepEqual(parseCanonicalOwnerApprovalPayload(canonical), payload);
  assert.throws(
    () => parseCanonicalOwnerApprovalPayload(`${JSON.stringify(payload, null, 2)}\n`),
    (error) => error?.code === 'owner_approval_payload_not_canonical',
  );
});
