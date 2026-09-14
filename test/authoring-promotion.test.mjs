import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';

import { candidateDigest, digestText } from '../src/authoring/contracts.mjs';
import {
  createAuthenticatedOwnerApproval,
  createOwnerApprovalPayload,
  serializeOwnerApprovalPayload,
} from '../src/authoring/owner-approval.mjs';
import {
  applyPostPromotionToMarkdown,
  planPostPromotion,
  renderPostMarkdown,
} from '../src/authoring/promotion.mjs';

const when = '2026-09-14T16:00:00.000Z';
const ownerKeys = generateKeyPairSync('ed25519');
const ownerPublicKeyPem = ownerKeys.publicKey.export({ type: 'spki', format: 'pem' });

function candidate(overrides = {}) {
  const value = {
    candidate_id: 'candidate-promote-1',
    artifact_kind: 'post',
    status: 'reviewable',
    title: 'Configured is not running',
    body: 'A configured scheduler is not proof that it is running. Runtime evidence has to come from actual invocations before the system can claim health.',
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

function approval(value) {
  const payload = createOwnerApprovalPayload({ candidate: value, decision: 'approve', decidedAt: when });
  const signatureBase64 = sign(null, Buffer.from(serializeOwnerApprovalPayload(payload), 'utf8'), ownerKeys.privateKey).toString('base64');
  return createAuthenticatedOwnerApproval({ candidate: value, payload, signatureBase64, publicKeyPem: ownerPublicKeyPem });
}

const existing = [
  { id: 'C35', pillar: 'C', seq: 35 },
  { id: 'C36', pillar: 'C', seq: 36 },
];

test('promotion allocates the next deterministic post id without writing content', () => {
  const value = candidate();
  const plan = planPostPromotion({
    candidate: value,
    approval: approval(value),
    ownerPublicKeyPem,
    existingPosts: existing,
    promotedAt: when,
  });

  assert.equal(plan.status, 'ready');
  assert.equal(plan.postId, 'C37');
  assert.equal(plan.targetPath, 'content/40-pillar-c.md');
  assert.match(plan.markdown, /\*\*C37 · Configured is not running\*\*/);
});

test('promotion is idempotent when the exact candidate was already promoted to the same destination', () => {
  const value = candidate();
  const signed = approval(value);
  const first = planPostPromotion({
    candidate: value,
    approval: signed,
    ownerPublicKeyPem,
    existingPosts: existing,
    promotedAt: when,
  });
  const second = planPostPromotion({
    candidate: value,
    approval: signed,
    ownerPublicKeyPem,
    existingPosts: existing,
    priorPromotions: [first.promotion],
    promotedAt: when,
  });

  assert.equal(second.status, 'already_promoted');
  assert.equal(second.postId, 'C37');
  assert.equal(second.markdown, null);
});

test('editing after approval invalidates promotion authority', () => {
  const value = candidate();
  const oldApproval = approval(value);
  const edited = { ...value, body: `${value.body} Edited after approval.` };
  edited.content_digest = candidateDigest(edited);

  assert.throws(
    () => planPostPromotion({ candidate: edited, approval: oldApproval, ownerPublicKeyPem, existingPosts: existing, promotedAt: when }),
    (error) => error?.code === 'approval_digest_mismatch',
  );
});

test('post promotion refuses non-post artifacts', () => {
  const value = candidate({ artifact_kind: 'blog', pillar: null });
  assert.throws(
    () => planPostPromotion({ candidate: value, approval: approval(value), ownerPublicKeyPem, existingPosts: existing, promotedAt: when }),
    (error) => error?.code === 'post_candidate_required',
  );
});

test('pure markdown application refuses post-id collisions', () => {
  const value = candidate();
  const plan = planPostPromotion({
    candidate: value,
    approval: approval(value),
    ownerPublicKeyPem,
    existingPosts: existing,
    promotedAt: when,
  });
  const initial = '### Pillar C — Building in public\n';
  const once = applyPostPromotionToMarkdown(initial, plan);
  assert.match(once, /\*\*C37 ·/);

  assert.throws(
    () => applyPostPromotionToMarkdown(once, plan),
    (error) => error?.code === 'post_id_collision',
  );
});

test('wrong digest cannot authorize promotion even when an approval object is present', () => {
  const value = candidate();
  const signed = approval(value);
  const tampered = { ...signed, candidate_digest: digestText('wrong') };
  assert.throws(
    () => planPostPromotion({
      candidate: value,
      approval: tampered,
      ownerPublicKeyPem,
      existingPosts: existing,
      promotedAt: when,
    }),
    (error) => error?.code === 'approval_digest_mismatch',
  );
});

test('unsigned owner-looking object cannot authorize promotion', () => {
  const value = candidate();
  const unsigned = {
    approval_id: 'fake',
    candidate_id: value.candidate_id,
    candidate_digest: value.content_digest,
    decision: 'approve',
    decided_by: 'Patrick Craven',
    decided_at: when,
  };
  assert.throws(
    () => planPostPromotion({ candidate: value, approval: unsigned, ownerPublicKeyPem, existingPosts: existing, promotedAt: when }),
    (error) => error?.code === 'owner_signature_required',
  );
});

test('post markdown preserves existing parser-compatible heading and fenced body shape', () => {
  const markdown = renderPostMarkdown({
    postId: 'C37',
    title: 'A title',
    body: 'A body long enough to represent a future approved post.',
  });
  assert.match(markdown, /\*\*C37 · A title\*\*/);
  assert.match(markdown, /```\nA body long enough/);
});
