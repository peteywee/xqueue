import { validate as validatePosts } from '../validate.mjs';
import {
  AuthoringContractError,
  assertArtifactCandidate,
  assertKnowledgeUnit,
  assertSourceRecord,
} from './contracts.mjs';

function summarize(findings) {
  const errors = findings.filter((finding) => finding.level === 'error').length;
  const warnings = findings.filter((finding) => finding.level === 'warn').length;
  return {
    result: errors ? 'fail' : warnings ? 'warn' : 'pass',
    findings,
  };
}

function validateReferences(candidate, knowledgeUnits, sourceRecords) {
  const findings = [];
  const unitMap = new Map(knowledgeUnits.map((unit) => [unit.knowledge_unit_id, unit]));
  const sourceMap = new Map(sourceRecords.map((source) => [source.source_id, source]));

  for (const ref of candidate.knowledge_unit_refs) {
    const unit = unitMap.get(ref);
    if (!unit) {
      findings.push({ level: 'error', rule: 'missing-knowledge-unit', message: `Missing knowledge unit ${ref}` });
      continue;
    }
    assertKnowledgeUnit(unit);
    if (unit.support_state !== 'supported') {
      findings.push({ level: 'error', rule: 'unsupported-knowledge-unit', message: `${ref} support state is ${unit.support_state}` });
    }
    if (['sensitive', 'restricted'].includes(unit.sensitivity)) {
      findings.push({ level: 'error', rule: 'knowledge-unit-sensitivity', message: `${ref} sensitivity ${unit.sensitivity} blocks publication` });
    }
  }

  for (const ref of candidate.source_refs) {
    const source = sourceMap.get(ref);
    if (!source) {
      findings.push({ level: 'error', rule: 'missing-source', message: `Missing source ${ref}` });
      continue;
    }
    assertSourceRecord(source);
    if (source.sensitivity === 'restricted') {
      findings.push({ level: 'error', rule: 'source-restricted', message: `${ref} is restricted` });
    }
  }

  return findings;
}

export function validateArtifactForReview({
  candidate,
  knowledgeUnits,
  sourceRecords,
  libraryPosts = [],
  figuresAvailable = null,
  premium = true,
}) {
  assertArtifactCandidate(candidate);
  if (!Array.isArray(knowledgeUnits) || !Array.isArray(sourceRecords) || !Array.isArray(libraryPosts)) {
    throw new AuthoringContractError('invalid_validation_context', 'knowledgeUnits, sourceRecords, and libraryPosts must be arrays');
  }

  const findings = validateReferences(candidate, knowledgeUnits, sourceRecords);

  if (candidate.artifact_kind === 'post') {
    const draftPost = {
      id: candidate.candidate_id,
      pillar: candidate.pillar,
      title: candidate.title,
      body: candidate.body,
      figure: null,
      sourceFile: 'authoring/draft',
      sourceLine: 1,
    };
    const postFindings = validatePosts([...libraryPosts, draftPost], {
      premium,
      figuresAvailable,
      requireFigures: false,
    }).filter((finding) => finding.id === draftPost.id);
    findings.push(...postFindings);
  } else if (candidate.body.length < 120) {
    findings.push({
      level: 'error',
      rule: 'artifact-body',
      message: `${candidate.artifact_kind} body is too short to be reviewable`,
    });
  }

  return summarize(findings);
}
