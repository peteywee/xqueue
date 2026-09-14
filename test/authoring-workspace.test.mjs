import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { candidateDigest, digestText } from '../src/authoring/contracts.mjs';
import {
  createAuthenticatedOwnerApproval,
  createOwnerApprovalPayload,
  serializeOwnerApprovalPayload,
} from '../src/authoring/owner-approval.mjs';
import {
  createExplicitOwnerApproval,
  readAuthoringJson,
  saveApproval,
  saveAuthoringRun,
  savePromotionPlan,
  saveReviewPacket,
} from '../src/authoring/workspace.mjs';

const when = '2026-09-14T21:00:00.000Z';
const ownerKeys = generateKeyPairSync('ed25519');
const ownerPublicKeyPem = ownerKeys.publicKey.export({ type: 'spki', format: 'pem' });

function candidate() {
  const value = {
    candidate_id: 'workspace-candidate-1',
    artifact_kind: 'post',
    status: 'reviewable',
    title: 'Configured is not running',
    body: 'A configured scheduler is not proof that it is running. Actual invocation evidence is what closes the production-health claim.',
    pillar: 'C',
    knowledge_unit_refs: ['ku-1'],
    source_refs: ['src-1'],
    created_at: when,
    validation: { result: 'pass', findings: [] },
  };
  value.content_digest = candidateDigest(value);
  return value;
}

function signedApproval(value, decision = 'approve') {
  const payload = createOwnerApprovalPayload({ candidate: value, decision, decidedAt: when });
  const signatureBase64 = sign(null, Buffer.from(serializeOwnerApprovalPayload(payload), 'utf8'), ownerKeys.privateKey).toString('base64');
  return createAuthenticatedOwnerApproval({ candidate: value, payload, signatureBase64, publicKeyPem: ownerPublicKeyPem });
}

function run(value) {
  return {
    source: {
      source_id: 'src-1',
      source_type: 'owner_input',
      trust_class: 'owner_attested',
      locator: 'manual:test',
      observed_at: when,
      content_digest: digestText('source'),
      sensitivity: 'public',
    },
    segments: [],
    knowledgeUnits: [{
      knowledge_unit_id: 'ku-1',
      kind: 'principle',
      summary: 'Configured state is not runtime proof.',
      claim_class: 'conceptual',
      support_state: 'supported',
      source_refs: ['src-1'],
      possible_outputs: ['post'],
      sensitivity: 'public',
    }],
    plans: [],
    candidates: [value],
  };
}

test('local workspace persists run, review, signed approval, and promotion plan outside authoritative content', async () => {
  const root = await mkdtemp(join(tmpdir(), 'xqueue-author-test-'));
  try {
    const value = candidate();
    const savedRun = await saveAuthoringRun(run(value), { root });
    const loadedRun = await readAuthoringJson(savedRun.path);
    assert.equal(loadedRun.candidates[0].content_digest, value.content_digest);

    const reviewPath = await saveReviewPacket({
      candidate_id: value.candidate_id,
      candidate_digest: value.content_digest,
      ready_for_owner_decision: true,
    }, { root });
    assert.match(reviewPath, /reviews/);

    const approval = signedApproval(value);
    const approvalPath = await saveApproval(approval, { root });
    assert.match(approvalPath, /approvals/);

    const promotionPath = await savePromotionPlan({
      status: 'ready',
      postId: 'C37',
      targetPath: 'content/40-pillar-c.md',
      promotion: { promotion_id: 'promotion-test' },
    }, { root });
    assert.match(promotionPath, /promotion-plans/);

    const serialized = await readFile(approvalPath, 'utf8');
    assert.match(serialized, /ed25519-detached/);
    assert.match(serialized, new RegExp(value.content_digest.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('legacy unsigned approval constructor is disabled', () => {
  assert.throws(
    () => createExplicitOwnerApproval(),
    (error) => error?.code === 'owner_signature_required',
  );
});

test('workspace refuses to persist owner-looking unsigned approval', async () => {
  const root = await mkdtemp(join(tmpdir(), 'xqueue-author-test-'));
  try {
    const value = candidate();
    await assert.rejects(
      saveApproval({
        approval_id: 'fake',
        candidate_id: value.candidate_id,
        candidate_digest: value.content_digest,
        decision: 'approve',
        decided_by: 'Patrick Craven',
        decided_at: when,
      }, { root }),
      (error) => error?.code === 'owner_signature_required',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('signed rejection may be persisted but grants no promotion decision', async () => {
  const root = await mkdtemp(join(tmpdir(), 'xqueue-author-test-'));
  try {
    const value = candidate();
    const rejection = signedApproval(value, 'reject');
    assert.equal(rejection.decision, 'reject');
    assert.equal(rejection.decided_by, 'Patrick Craven');
    const path = await saveApproval(rejection, { root });
    assert.match(path, /approvals/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
