import {
  AuthoringContractError,
  assertApprovalForCandidate,
  assertKnowledgeUnit,
  digestObject,
} from './contracts.mjs';

export function createApprovedContextFeedback({
  candidate,
  approval,
  promotion,
  knowledgeUnits,
  createdAt,
}) {
  assertApprovalForCandidate(candidate, approval);
  if (!promotion || typeof promotion !== 'object') {
    throw new AuthoringContractError('promotion_required', 'approved context feedback requires a promotion record');
  }
  if (promotion.candidate_id !== candidate.candidate_id || promotion.candidate_digest !== candidate.content_digest) {
    throw new AuthoringContractError('promotion_candidate_mismatch', 'promotion does not match the exact approved candidate');
  }
  if (promotion.approval_id !== approval.approval_id) {
    throw new AuthoringContractError('promotion_approval_mismatch', 'promotion was not authorized by this approval');
  }
  if (!Array.isArray(knowledgeUnits)) {
    throw new AuthoringContractError('knowledge_units_required', 'knowledgeUnits must be an array');
  }

  const unitMap = new Map(knowledgeUnits.map((unit) => [unit.knowledge_unit_id, unit]));
  const units = candidate.knowledge_unit_refs.map((ref) => {
    const unit = unitMap.get(ref);
    if (!unit) throw new AuthoringContractError('feedback_knowledge_unit_missing', `missing knowledge unit ${ref}`);
    assertKnowledgeUnit(unit);
    return unit;
  });

  const core = {
    authority: 'supporting_context_only',
    candidate_digest: candidate.content_digest,
    artifact_kind: candidate.artifact_kind,
    artifact_ref: promotion.artifact_ref,
    promotion_id: promotion.promotion_id,
    source_refs: [...candidate.source_refs],
    knowledge_units: units.map((unit) => ({
      knowledge_unit_id: unit.knowledge_unit_id,
      kind: unit.kind,
      summary: unit.summary,
      claim_class: unit.claim_class,
      source_refs: [...unit.source_refs],
    })),
    created_at: createdAt,
  };

  return Object.freeze({
    feedback_id: `feedback:${digestObject(core).slice(-20)}`,
    ...core,
  });
}
