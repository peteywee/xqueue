import {
  ARTIFACT_KINDS,
  AuthoringContractError,
  assertKnowledgeUnit,
} from './contracts.mjs';

export function createArtifactPlan(unit, { requestedKind = 'auto' } = {}) {
  assertKnowledgeUnit(unit);

  if (unit.support_state === 'internal_only') {
    return {
      knowledgeUnitId: unit.knowledge_unit_id,
      status: 'blocked',
      reason: 'internal_only',
      eligibleKinds: [],
      preserveFailureHistory: false,
    };
  }

  if (['owner_attestation_required', 'research_required', 'hypothesis'].includes(unit.support_state)) {
    return {
      knowledgeUnitId: unit.knowledge_unit_id,
      status: 'blocked',
      reason: unit.support_state,
      eligibleKinds: [...unit.possible_outputs],
      preserveFailureHistory: ['failure', 'lesson'].includes(unit.kind),
    };
  }

  const eligibleKinds = [...new Set(unit.possible_outputs)].filter((kind) => ARTIFACT_KINDS.includes(kind));

  if (requestedKind !== 'auto') {
    if (!ARTIFACT_KINDS.includes(requestedKind)) {
      throw new AuthoringContractError('invalid_requested_kind', `requestedKind must be auto or one of: ${ARTIFACT_KINDS.join(', ')}`);
    }
    if (!eligibleKinds.includes(requestedKind)) {
      throw new AuthoringContractError('output_not_allowed', `${requestedKind} is not permitted by this knowledge unit`);
    }
  }

  return {
    knowledgeUnitId: unit.knowledge_unit_id,
    status: 'ready',
    requestedKind,
    eligibleKinds: requestedKind === 'auto' ? eligibleKinds : [requestedKind],
    preserveFailureHistory: ['failure', 'lesson'].includes(unit.kind),
  };
}
