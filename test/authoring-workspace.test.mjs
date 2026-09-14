import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { candidateDigest, digestText } from '../src/authoring/contracts.mjs';
import {
  createExplicitOwnerApproval,
  readAuthoringJson,
  saveApproval,
  saveAuthoringRun,
  savePromotionPlan,
  saveReviewPacket,
} from '../src/authoring/workspace.mjs';

const when = '2026-09-14T21:00:00.000Z';

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

test('local workspace persists run, review, approval, and promotion plan outside authoritative content', async () => {
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

    const approval = createExplicitOwnerApproval({
      candidate: value,
      exactDigest: value.content_digest,
      decision: 'approve',
      decidedAt: when,
    });
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
    assert.match(serialized, new RegExp(value.content_digest.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('owner approval requires the exact candidate digest to be typed/supplied', () => {
  const value = candidate();
  assert.throws(
    () => createExplicitOwnerApproval({
      candidate: value,
      exactDigest: digestText('different'),
      decision: 'approve',
      decidedAt: when,
    }),
    (error) => error?.code === 'explicit_digest_mismatch',
  );
});

test('failing candidate validation cannot be approved through workspace helper', () => {
  const value = candidate();
  value.status = 'draft';
  value.validation = { result: 'fail', findings: [{ level: 'error', rule: 'blocked' }] };
  value.content_digest = candidateDigest(value);

  assert.throws(
    () => createExplicitOwnerApproval({
      candidate: value,
      exactDigest: value.content_digest,
      decision: 'approve',
      decidedAt: when,
    }),
    (error) => error?.code === 'candidate_not_reviewable',
  );
});

test('reject decision may be recorded for a reviewable candidate but grants no promotion authority', () => {
  const value = candidate();
  const rejection = createExplicitOwnerApproval({
    candidate: value,
    exactDigest: value.content_digest,
    decision: 'reject',
    decidedAt: when,
  });
  assert.equal(rejection.decision, 'reject');
  assert.equal(rejection.decided_by, 'Patrick Craven');
});
