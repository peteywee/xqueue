import {
  AuthoringContractError,
  assertArtifactCandidate,
  assertKnowledgeUnit,
  candidateDigest,
  digestObject,
} from './contracts.mjs';
import { createArtifactPlan } from './planner.mjs';

function titleFrom(unit) {
  const summary = unit.summary.replace(/\s+/g, ' ').trim();
  const sentence = summary.split(/[.!?](?:\s|$)/)[0] || summary;
  return sentence.slice(0, 90).trim();
}

function lessonBody(unit) {
  if (['failure', 'lesson'].includes(unit.kind)) {
    return [
      'Objective', unit.summary, '',
      'Original model / assumption', '[Review source evidence and state the original assumption.]', '',
      'Failure / contradiction', unit.failure_context || unit.summary, '',
      'Diagnosis', '[Explain why the original model failed.]', '',
      'Underlying principle', '[State the transferable principle.]', '',
      'Rebuild', '[Describe the corrected design or behavior.]', '',
      'Verification', '[Record the negative tests or evidence that proved the correction.]', '',
      'Transfer', '[Where else does this principle apply?]',
    ].join('\n');
  }

  return [
    'Concept', unit.summary, '',
    'Example', '[Add a source-backed example.]', '',
    'Exercise', '[Apply the concept to a new situation.]', '',
    'Verification', '[Explain how to know the reasoning is correct.]',
  ].join('\n');
}

function blogBody(unit) {
  return [
    `# ${titleFrom(unit)}`, '', unit.summary, '',
    '## Why it matters', '[Develop the argument using only supported source material.]', '',
    '## Evidence / example', '[Attach the relevant source-backed evidence.]', '',
    '## General principle', '[State the transferable principle without overstating the evidence.]',
  ].join('\n');
}

export function createDeterministicCandidate({
  unit,
  artifactKind,
  pillar = null,
  figure = null,
  createdAt,
  candidateId = null,
}) {
  assertKnowledgeUnit(unit);
  const plan = createArtifactPlan(unit, { requestedKind: artifactKind });
  if (plan.status !== 'ready') {
    throw new AuthoringContractError('knowledge_unit_blocked', `knowledge unit is blocked: ${plan.reason}`);
  }
  if (artifactKind === 'post' && !['A', 'B', 'C', 'D'].includes(pillar)) {
    throw new AuthoringContractError('pillar_required', 'post candidates require pillar A, B, C, or D');
  }

  const body = artifactKind === 'post' ? unit.summary : artifactKind === 'blog' ? blogBody(unit) : lessonBody(unit);
  const value = {
    candidate_id: candidateId || `candidate:${digestObject({ unit: unit.knowledge_unit_id, artifactKind, pillar, figure }).slice(-16)}`,
    artifact_kind: artifactKind,
    status: 'draft',
    title: titleFrom(unit),
    body,
    pillar: artifactKind === 'post' ? pillar : null,
    figure: artifactKind === 'post' ? figure : null,
    knowledge_unit_refs: [unit.knowledge_unit_id],
    source_refs: [...unit.source_refs],
    created_at: createdAt,
    generator: {
      provider: 'deterministic-local',
      model: 'none',
      prompt_version: 'phase2-template-v1',
      input_digest: digestObject(unit),
    },
    validation: {
      result: 'fail',
      findings: [{ level: 'error', rule: 'not-yet-validated', message: 'candidate has not passed artifact validation' }],
    },
  };
  value.content_digest = candidateDigest(value);
  assertArtifactCandidate(value);
  return value;
}

export function withCandidateValidation(candidate, validation) {
  const next = {
    ...candidate,
    validation: {
      result: validation?.result,
      findings: Array.isArray(validation?.findings) ? validation.findings : [],
    },
  };
  if (!['pass', 'warn', 'fail'].includes(next.validation.result)) {
    throw new AuthoringContractError('invalid_validation_result', 'validation result must be pass, warn, or fail');
  }
  next.status = ['pass', 'warn'].includes(next.validation.result) ? 'reviewable' : 'draft';
  next.content_digest = candidateDigest(next);
  assertArtifactCandidate(next);
  return next;
}
