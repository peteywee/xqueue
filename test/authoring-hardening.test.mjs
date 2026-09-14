import test from 'node:test';
import assert from 'node:assert/strict';

import { candidateDigest, digestText } from '../src/authoring/contracts.mjs';
import { assessEvidenceRisk } from '../src/authoring/evidence-risk.mjs';
import { buildStyleProfile, evaluateCandidateStyle } from '../src/authoring/style-profile.mjs';
import { analyzeAngleReuse } from '../src/authoring/angle-analysis.mjs';
import { createOwnerReviewPacket } from '../src/authoring/review.mjs';

const reviewedAt = '2026-09-14T18:00:00.000Z';

function source(overrides = {}) {
  return {
    source_id: 'src-1',
    source_type: 'github',
    trust_class: 'evidence',
    locator: 'github:peteywee/xqueue#56',
    observed_at: '2026-09-14T17:00:00.000Z',
    content_digest: digestText('evidence'),
    sensitivity: 'public',
    ...overrides,
  };
}

function unit(overrides = {}) {
  return {
    knowledge_unit_id: 'ku-1',
    kind: 'principle',
    summary: 'Configured state is not runtime proof; health needs evidence from actual execution.',
    claim_class: 'conceptual',
    support_state: 'supported',
    source_refs: ['src-1'],
    possible_outputs: ['post', 'blog', 'lesson'],
    sensitivity: 'public',
    ...overrides,
  };
}

function candidate(overrides = {}) {
  const value = {
    candidate_id: 'cand-1',
    artifact_kind: 'post',
    status: 'reviewable',
    title: 'Configured is not running',
    body: 'Configured state is not runtime proof. Health needs evidence from actual execution before a production system can call a scheduler healthy.',
    pillar: 'C',
    knowledge_unit_refs: ['ku-1'],
    source_refs: ['src-1'],
    created_at: reviewedAt,
    validation: { result: 'pass', findings: [] },
    ...overrides,
  };
  value.content_digest = candidateDigest(value);
  return value;
}

test('stale current-factual evidence blocks reviewability', () => {
  const findings = assessEvidenceRisk({
    candidate: candidate(),
    knowledgeUnits: [unit({ claim_class: 'current_factual' })],
    sourceRecords: [source({ observed_at: '2026-01-01T00:00:00.000Z' })],
    now: reviewedAt,
    currentFactMaxAgeDays: 30,
  });
  assert.ok(findings.some((finding) => finding.rule === 'current-fact-stale' && finding.level === 'error'));
});

test('generated assertions require independent support', () => {
  const generated = source({ source_type: 'generated_content', trust_class: 'generated' });
  const findings = assessEvidenceRisk({
    candidate: candidate(),
    knowledgeUnits: [unit({ claim_class: 'generated_assertion', source_refs: ['src-1'] })],
    sourceRecords: [generated],
    now: reviewedAt,
  });
  assert.ok(findings.some((finding) => finding.rule === 'generated-assertion-unverified'));
});

test('sensitive sources require a redacted or derived source before publication', () => {
  const findings = assessEvidenceRisk({
    candidate: candidate(),
    knowledgeUnits: [unit()],
    sourceRecords: [source({ sensitivity: 'sensitive' })],
    now: reviewedAt,
  });
  assert.ok(findings.some((finding) => finding.rule === 'sensitive-source-redaction-required'));
});

test('style profile is derived from approved corpus instead of a hard-coded persona prompt', () => {
  const profile = buildStyleProfile([
    { body: 'I learned this by building it and then testing the failure path.' },
    { body: 'My rule now is simple: prove runtime behavior with runtime evidence.' },
  ]);
  assert.equal(profile.sampleSize, 2);
  assert.ok(profile.firstPersonRate > 0);
  const findings = evaluateCandidateStyle(candidate({ body: 'A short neutral statement.' }), profile);
  assert.ok(Array.isArray(findings));
});

test('angle reuse works across artifact types, not only X posts', () => {
  const findings = analyzeAngleReuse(candidate(), [{
    artifact_ref: 'lesson-17',
    artifact_kind: 'lesson',
    title: 'Configured state is not runtime proof',
    body: 'A production scheduler needs evidence from actual execution before health can be claimed.',
  }], { threshold: 0.3 });
  assert.ok(findings.some((finding) => finding.rule === 'angle-reuse'));
});

test('owner review packet exposes provenance, risks, and exact candidate digest', () => {
  const value = candidate();
  const packet = createOwnerReviewPacket({
    candidate: value,
    knowledgeUnits: [unit()],
    sourceRecords: [source()],
    validation: value.validation,
    approvedCorpus: [{ body: 'I build, fail, diagnose, rebuild, and verify.' }],
    priorArtifacts: [],
    reviewedAt,
  });

  assert.equal(packet.candidate_digest, value.content_digest);
  assert.equal(packet.provenance.knowledge_units[0].knowledge_unit_id, 'ku-1');
  assert.equal(packet.provenance.sources[0].source_id, 'src-1');
  assert.equal(packet.blocking_findings.length, 0);
  assert.equal(packet.ready_for_owner_decision, true);
});
