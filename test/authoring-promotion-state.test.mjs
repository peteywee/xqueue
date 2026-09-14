import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';

import { candidateDigest } from '../src/authoring/contracts.mjs';
import {
  createAuthenticatedOwnerApproval,
  createOwnerApprovalPayload,
  serializeOwnerApprovalPayload,
} from '../src/authoring/owner-approval.mjs';
import {
  applyStateBoundPostPromotion,
  planStateBoundPostPromotion,
} from '../src/authoring/promotion-state.mjs';

const when = '2026-09-14T17:00:00.000Z';
const ownerKeys = generateKeyPairSync('ed25519');
const ownerPublicKeyPem = ownerKeys.publicKey.export({ type: 'spki', format: 'pem' });

function candidate() {
  const value = {
    candidate_id: 'candidate-state-1',
    artifact_kind: 'post',
    status: 'reviewable',
    title: 'Configured is not running',
    body: 'A configured scheduler is not proof that it is running. Runtime evidence has to come from actual invocations before the system can claim health.',
    pillar: 'C',
    figure: null,
    knowledge_unit_refs: ['ku-1'],
    source_refs: ['src-1'],
    created_at: when,
    validation: { result: 'pass', findings: [] },
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

const target = '### Pillar C — Building in public\n\n**C36 · Existing**\n```\nExisting body.\n```\n';

test('state-bound promotion records the exact target markdown digest', () => {
  const value = candidate();
  const plan = planStateBoundPostPromotion({
    candidate: value,
    approval: approval(value),
    ownerPublicKeyPem,
    existingPosts: existing,
    targetMarkdown: target,
    promotedAt: when,
  });

  assert.equal(plan.status, 'ready');
  assert.match(plan.targetBaseDigest, /^sha256:[a-f0-9]{64}$/);
  assert.equal(plan.postId, 'C37');
});

test('state-bound promotion applies only when target content is unchanged', () => {
  const value = candidate();
  const plan = planStateBoundPostPromotion({
    candidate: value,
    approval: approval(value),
    ownerPublicKeyPem,
    existingPosts: existing,
    targetMarkdown: target,
    promotedAt: when,
  });

  const next = applyStateBoundPostPromotion(target, plan);
  assert.match(next, /\*\*C37 · Configured is not running\*\*/);
});

test('state-bound promotion fails closed when target changes after planning', () => {
  const value = candidate();
  const plan = planStateBoundPostPromotion({
    candidate: value,
    approval: approval(value),
    ownerPublicKeyPem,
    existingPosts: existing,
    targetMarkdown: target,
    promotedAt: when,
  });

  assert.throws(
    () => applyStateBoundPostPromotion(`${target}\nConcurrent edit.\n`, plan),
    (error) => error?.code === 'stale_promotion_target',
  );
});

test('already-promoted exact candidate remains idempotent but still requires valid owner proof', () => {
  const value = candidate();
  const signed = approval(value);
  const first = planStateBoundPostPromotion({
    candidate: value,
    approval: signed,
    ownerPublicKeyPem,
    existingPosts: existing,
    targetMarkdown: target,
    promotedAt: when,
  });
  const second = planStateBoundPostPromotion({
    candidate: value,
    approval: signed,
    ownerPublicKeyPem,
    existingPosts: existing,
    targetMarkdown: `${target}\nLater harmless change.\n`,
    priorPromotions: [first.promotion],
    promotedAt: when,
  });

  assert.equal(second.status, 'already_promoted');
  assert.equal(second.targetBaseDigest, null);
  assert.equal(applyStateBoundPostPromotion('anything', second), 'anything');
});
