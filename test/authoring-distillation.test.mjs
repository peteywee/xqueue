import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeSourceInput, segmentSource } from '../src/authoring/intake.mjs';
import { distillSegments } from '../src/authoring/distiller.mjs';
import { createArtifactPlan } from '../src/authoring/planner.mjs';
import { createDeterministicCandidate, withCandidateValidation } from '../src/authoring/candidate.mjs';
import { validateArtifactForReview } from '../src/authoring/authoring-validator.mjs';
import { runDeterministicAuthoring } from '../src/authoring/pipeline.mjs';

const when = '2026-09-14T15:00:00.000Z';

function ownerSource(text) {
  return normalizeSourceInput({
    sourceId: 'owner-1',
    sourceType: 'owner_input',
    trustClass: 'owner_attested',
    locator: 'manual:owner-1',
    observedAt: when,
    text,
    project: 'xqueue',
    sensitivity: 'public',
  });
}

test('intake creates deterministic provenance and stable segments', () => {
  const source = ownerSource('I learned one important lesson.\n\nConfiguration is not runtime proof.');
  const again = ownerSource('I learned one important lesson.\n\nConfiguration is not runtime proof.');
  assert.equal(source.record.content_digest, again.record.content_digest);

  const segments = segmentSource(source, { maxChars: 300 });
  assert.equal(segments.length, 1);
  assert.equal(segments[0].source_id, 'owner-1');
  assert.match(segments[0].content_digest, /^sha256:/);
});

test('generated source distills to blocked hypothesis rather than supported truth', () => {
  const source = normalizeSourceInput({
    sourceId: 'ai-1',
    sourceType: 'generated_content',
    trustClass: 'generated',
    locator: 'conversation:ai-1',
    observedAt: when,
    text: 'Patrick lost three days debugging a scheduler incident and learned a lesson.',
    sensitivity: 'internal',
  });
  const units = distillSegments(source.record, segmentSource(source));
  assert.equal(units[0].claim_class, 'generated_assertion');
  assert.equal(units[0].support_state, 'hypothesis');
  assert.equal(createArtifactPlan(units[0]).status, 'blocked');
});

test('owner-attested failure becomes a supported reusable knowledge unit', () => {
  const source = ownerSource(
    'I thought scheduler configuration proved the scheduler was alive, but that assumption failed. I learned that runtime behavior needs independent runtime evidence.',
  );
  const [unit] = distillSegments(source.record, segmentSource(source));
  assert.equal(unit.kind, 'failure');
  assert.equal(unit.claim_class, 'experiential');
  assert.equal(unit.support_state, 'supported');

  const plan = createArtifactPlan(unit);
  assert.equal(plan.status, 'ready');
  assert.deepEqual(plan.eligibleKinds, ['post', 'blog', 'lesson']);
  assert.equal(plan.preserveFailureHistory, true);
});

test('deterministic candidate starts non-reviewable and only validation can make it reviewable', () => {
  const source = ownerSource(
    'I learned that a configured scheduler is not proof that it is running. Runtime evidence has to come from actual invocations, not configuration alone.',
  );
  const [unit] = distillSegments(source.record, segmentSource(source));
  const draft = createDeterministicCandidate({ unit, artifactKind: 'post', pillar: 'C', createdAt: when });
  assert.equal(draft.status, 'draft');
  assert.equal(draft.validation.result, 'fail');

  const validation = validateArtifactForReview({
    candidate: draft,
    knowledgeUnits: [unit],
    sourceRecords: [source.record],
    libraryPosts: [],
  });
  const reviewed = withCandidateValidation(draft, validation);
  assert.ok(['reviewable', 'draft'].includes(reviewed.status));
  assert.equal(reviewed.validation.findings.some((finding) => finding.rule === 'not-yet-validated'), false);
});

test('existing XQueue content validator is reused for post candidates', () => {
  const source = ownerSource(
    'I learned that a client deployment with Uncle Julio was the proof I needed, and this sentence is deliberately long enough to pass the body-length floor.',
  );
  const [unit] = distillSegments(source.record, segmentSource(source));
  const draft = createDeterministicCandidate({ unit, artifactKind: 'post', pillar: 'C', createdAt: when });
  const validation = validateArtifactForReview({
    candidate: draft,
    knowledgeUnits: [unit],
    sourceRecords: [source.record],
    libraryPosts: [],
  });
  assert.equal(validation.result, 'fail');
  assert.ok(validation.findings.some((finding) => finding.rule === 'employer-name'));
});

test('end-to-end deterministic pipeline works without network or AI credentials', () => {
  const result = runDeterministicAuthoring({
    source: {
      sourceId: 'owner-e2e',
      sourceType: 'owner_input',
      trustClass: 'owner_attested',
      locator: 'manual:e2e',
      observedAt: when,
      text: 'I learned that configured state is not runtime proof. A production system needs evidence from actual execution before it can claim the scheduler is healthy.',
      project: 'xqueue',
      sensitivity: 'public',
    },
    requestedKind: 'lesson',
    createdAt: when,
  });

  assert.equal(result.source.source_id, 'owner-e2e');
  assert.ok(result.knowledgeUnits.length >= 1);
  assert.ok(result.candidates.length >= 1);
  assert.ok(result.candidates.every((candidate) => candidate.artifact_kind === 'lesson'));
  assert.ok(result.candidates.every((candidate) => candidate.generator.provider === 'deterministic-local'));
});
