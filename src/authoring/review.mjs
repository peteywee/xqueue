import { assertArtifactCandidate, assertKnowledgeUnit, assertSourceRecord } from './contracts.mjs';
import { buildStyleProfile, evaluateCandidateStyle } from './style-profile.mjs';
import { analyzeAngleReuse } from './angle-analysis.mjs';
import { assessEvidenceRisk } from './evidence-risk.mjs';

export function createOwnerReviewPacket({
  candidate,
  knowledgeUnits,
  sourceRecords,
  validation,
  approvedCorpus = [],
  priorArtifacts = [],
  reviewedAt,
  currentFactMaxAgeDays = 30,
}) {
  assertArtifactCandidate(candidate);
  const unitMap = new Map(knowledgeUnits.map((unit) => [unit.knowledge_unit_id, unit]));
  const sourceMap = new Map(sourceRecords.map((source) => [source.source_id, source]));

  const units = candidate.knowledge_unit_refs.map((ref) => unitMap.get(ref)).filter(Boolean);
  const sources = candidate.source_refs.map((ref) => sourceMap.get(ref)).filter(Boolean);
  for (const unit of units) assertKnowledgeUnit(unit);
  for (const source of sources) assertSourceRecord(source);

  const evidenceFindings = assessEvidenceRisk({
    candidate,
    knowledgeUnits,
    sourceRecords,
    now: reviewedAt,
    currentFactMaxAgeDays,
  });
  const styleProfile = buildStyleProfile(approvedCorpus);
  const styleFindings = evaluateCandidateStyle(candidate, styleProfile);
  const angleFindings = analyzeAngleReuse(candidate, priorArtifacts);
  const allFindings = [
    ...(validation?.findings ?? candidate.validation?.findings ?? []),
    ...evidenceFindings,
    ...styleFindings,
    ...angleFindings,
  ];
  const blocking = allFindings.filter((finding) => finding.level === 'error');

  return Object.freeze({
    candidate_id: candidate.candidate_id,
    candidate_digest: candidate.content_digest,
    artifact_kind: candidate.artifact_kind,
    title: candidate.title,
    body: candidate.body,
    pillar: candidate.pillar ?? null,
    reviewed_at: reviewedAt,
    provenance: {
      knowledge_units: units.map((unit) => ({
        knowledge_unit_id: unit.knowledge_unit_id,
        kind: unit.kind,
        claim_class: unit.claim_class,
        support_state: unit.support_state,
        source_refs: [...unit.source_refs],
        sensitivity: unit.sensitivity ?? 'internal',
      })),
      sources: sources.map((source) => ({
        source_id: source.source_id,
        source_type: source.source_type,
        trust_class: source.trust_class,
        locator: source.locator,
        observed_at: source.observed_at,
        sensitivity: source.sensitivity ?? 'internal',
      })),
    },
    validation: validation ?? candidate.validation,
    style_profile: styleProfile,
    evidence_findings: evidenceFindings,
    style_findings: styleFindings,
    angle_findings: angleFindings,
    blocking_findings: blocking,
    ready_for_owner_decision: candidate.status === 'reviewable' && blocking.length === 0,
  });
}
