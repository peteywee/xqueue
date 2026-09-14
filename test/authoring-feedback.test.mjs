import test from 'node:test';
import assert from 'node:assert/strict';

import { candidateDigest } from '../src/authoring/contracts.mjs';
import { planNonPostPromotion } from '../src/authoring/promotion.mjs';
import { createApprovedContextFeedback } from '../src/authoring/context-feedback.mjs';

const when = '2026-09-14T20:00:00.000Z';

function candidate(kind = 'lesson') {
  const value = {
    candidate_id: `candidate-${kind}-1`,
    artifact_kind: kind,
    status: 'reviewable',
    title: 'Configured is not running',
    body: 'Objective\nConfigured state is not runtime proof.\n\nEvidence\nA production claim should rely on actual execution rather than configuration intent alone.',
    pillar: null,
    knowledge_unit_refs: ['ku-1'],
    source_refs: ['src-1'],
    created_at: when,
    validation: { result: 'pass', findings: [] },
  };
  value.content_digest = candidateDigest(value);
  return value;
}

function approval(value) {
  return {
    approval_id: `approval-${value.artifact_kind}-1`,
    candidate_id: value.candidate_id,
    candidate_digest: value.content_digest,
    decision: 'approve',
    decided_by: 'Patrick Craven',
    decided_at: when,
  };
}

function unit() {
  return {
    knowledge_unit_id: 'ku-1',
    kind: 'lesson',
    summary: 'Configured state is not runtime proof.',
    claim_class: 'conceptual',
    support_state: 'supported',
    source_refs: ['src-1'],
    possible_outputs: ['post', 'blog', 'lesson'],
    sensitivity: 'public',
  };
}

test('blog and lesson promotions go to separate non-X artifact domains', () => {
  const lesson = candidate('lesson');
  const lessonPlan = planNonPostPromotion({ candidate: lesson, approval: approval(lesson), promotedAt: when });
  assert.equal(lessonPlan.status, 'ready');
  assert.match(lessonPlan.destination, /^authoring\/approved\/lessons\//);

  const blog = candidate('blog');
  const blogPlan = planNonPostPromotion({ candidate: blog, approval: approval(blog), promotedAt: when });
  assert.equal(blogPlan.status, 'ready');
  assert.match(blogPlan.destination, /^authoring\/approved\/blogs\//);
  assert.notEqual(blogPlan.destination, lessonPlan.destination);
});

test('non-post promotion is idempotent for exact candidate and destination', () => {
  const value = candidate('lesson');
  const first = planNonPostPromotion({ candidate: value, approval: approval(value), promotedAt: when });
  const second = planNonPostPromotion({
    candidate: value,
    approval: approval(value),
    priorPromotions: [first.promotion],
    promotedAt: when,
  });
  assert.equal(second.status, 'already_promoted');
  assert.equal(second.bundle, null);
});

test('Context Engine feedback can only be derived from an approved promoted candidate', () => {
  const value = candidate('lesson');
  const approved = approval(value);
  const plan = planNonPostPromotion({ candidate: value, approval: approved, promotedAt: when });
  const feedback = createApprovedContextFeedback({
    candidate: value,
    approval: approved,
    promotion: plan.promotion,
    knowledgeUnits: [unit()],
    createdAt: when,
  });

  assert.equal(feedback.authority, 'supporting_context_only');
  assert.equal(feedback.candidate_digest, value.content_digest);
  assert.equal(feedback.artifact_ref, plan.promotion.artifact_ref);
  assert.equal(feedback.knowledge_units[0].knowledge_unit_id, 'ku-1');
  assert.equal('body' in feedback, false);
});

test('feedback refuses promotion records for a different candidate', () => {
  const value = candidate('lesson');
  const approved = approval(value);
  const plan = planNonPostPromotion({ candidate: value, approval: approved, promotedAt: when });
  assert.throws(
    () => createApprovedContextFeedback({
      candidate: value,
      approval: approved,
      promotion: { ...plan.promotion, candidate_digest: 'sha256:' + '0'.repeat(64) },
      knowledgeUnits: [unit()],
      createdAt: when,
    }),
    (error) => error?.code === 'promotion_candidate_mismatch',
  );
});
