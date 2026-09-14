import { createHash } from 'node:crypto';

export const SOURCE_TYPES = Object.freeze([
  'owner_input',
  'conversation',
  'github',
  'document',
  'context_engine',
  'generated_content',
]);

export const TRUST_CLASSES = Object.freeze([
  'owner_attested',
  'authoritative_reference',
  'evidence',
  'generated',
  'unverified',
]);

export const CLAIM_CLASSES = Object.freeze([
  'conceptual',
  'experiential',
  'current_factual',
  'generated_assertion',
]);

export const SUPPORT_STATES = Object.freeze([
  'supported',
  'owner_attestation_required',
  'research_required',
  'hypothesis',
  'internal_only',
]);

export const ARTIFACT_KINDS = Object.freeze(['post', 'blog', 'lesson']);
export const CANDIDATE_STATES = Object.freeze(['draft', 'reviewable', 'rejected', 'approved', 'promoted']);

const DIGEST_RE = /^sha256:[a-f0-9]{64}$/;

export class AuthoringContractError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'AuthoringContractError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new AuthoringContractError(code, message);
}

function object(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('invalid_object', `${name} must be an object`);
  }
  return value;
}

function string(value, name) {
  if (typeof value !== 'string' || value.trim() === '') {
    fail('invalid_string', `${name} must be a non-empty string`);
  }
  return value;
}

function enumValue(value, allowed, name) {
  if (!allowed.includes(value)) {
    fail('invalid_enum', `${name} must be one of: ${allowed.join(', ')}`);
  }
  return value;
}

function stringArray(value, name, { min = 0 } = {}) {
  if (!Array.isArray(value) || value.length < min || value.some((entry) => typeof entry !== 'string' || !entry.trim())) {
    fail('invalid_array', `${name} must be an array of non-empty strings${min ? ` with at least ${min} item(s)` : ''}`);
  }
  return value;
}

function isoDate(value, name) {
  string(value, name);
  if (Number.isNaN(Date.parse(value))) fail('invalid_date', `${name} must be an ISO-compatible date-time`);
  return value;
}

function digest(value, name) {
  string(value, name);
  if (!DIGEST_RE.test(value)) fail('invalid_digest', `${name} must be a sha256:<64 lowercase hex> digest`);
  return value;
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonicalize(value[key])]),
  );
}

export function digestText(value) {
  return `sha256:${createHash('sha256').update(String(value), 'utf8').digest('hex')}`;
}

export function digestObject(value) {
  return digestText(JSON.stringify(canonicalize(value)));
}

export function candidateDigest(candidate) {
  object(candidate, 'candidate');
  return digestObject({
    candidate_id: candidate.candidate_id,
    artifact_kind: candidate.artifact_kind,
    title: candidate.title,
    body: candidate.body,
    pillar: candidate.pillar ?? null,
    figure: candidate.figure ?? null,
    knowledge_unit_refs: candidate.knowledge_unit_refs,
    source_refs: candidate.source_refs,
    created_at: candidate.created_at,
    generator: candidate.generator ?? null,
  });
}

export function assertSourceRecord(record) {
  object(record, 'source record');
  string(record.source_id, 'source_id');
  enumValue(record.source_type, SOURCE_TYPES, 'source_type');
  enumValue(record.trust_class, TRUST_CLASSES, 'trust_class');
  string(record.locator, 'locator');
  isoDate(record.observed_at, 'observed_at');
  digest(record.content_digest, 'content_digest');

  if (record.source_type === 'generated_content' && !['generated', 'unverified'].includes(record.trust_class)) {
    fail('generated_source_trust_escalation', 'generated_content cannot declare itself owner-attested, authoritative, or evidence');
  }

  return record;
}

export function sourceCanSupportClaim(record, claimClass) {
  assertSourceRecord(record);
  enumValue(claimClass, CLAIM_CLASSES, 'claim_class');

  if (['generated', 'unverified'].includes(record.trust_class)) return false;

  if (claimClass === 'experiential') {
    return ['owner_attested', 'authoritative_reference', 'evidence'].includes(record.trust_class);
  }

  if (claimClass === 'current_factual') {
    return ['authoritative_reference', 'evidence'].includes(record.trust_class);
  }

  if (claimClass === 'generated_assertion') {
    return ['owner_attested', 'authoritative_reference', 'evidence'].includes(record.trust_class);
  }

  return ['owner_attested', 'authoritative_reference', 'evidence'].includes(record.trust_class);
}

export function assertKnowledgeUnit(unit) {
  object(unit, 'knowledge unit');
  string(unit.knowledge_unit_id, 'knowledge_unit_id');
  enumValue(unit.kind, ['lesson', 'principle', 'failure', 'decision', 'example', 'question', 'claim', 'framework', 'observation'], 'kind');
  string(unit.summary, 'summary');
  enumValue(unit.claim_class, CLAIM_CLASSES, 'claim_class');
  enumValue(unit.support_state, SUPPORT_STATES, 'support_state');
  stringArray(unit.source_refs, 'source_refs', { min: 1 });
  stringArray(unit.possible_outputs, 'possible_outputs', { min: 1 });
  for (const kind of unit.possible_outputs) enumValue(kind, ARTIFACT_KINDS, 'possible_outputs item');
  return unit;
}

export function assertArtifactCandidate(candidate) {
  object(candidate, 'artifact candidate');
  string(candidate.candidate_id, 'candidate_id');
  enumValue(candidate.artifact_kind, ARTIFACT_KINDS, 'artifact_kind');
  enumValue(candidate.status, CANDIDATE_STATES, 'status');
  string(candidate.title, 'title');
  string(candidate.body, 'body');
  stringArray(candidate.knowledge_unit_refs, 'knowledge_unit_refs', { min: 1 });
  stringArray(candidate.source_refs, 'source_refs', { min: 1 });
  isoDate(candidate.created_at, 'created_at');
  digest(candidate.content_digest, 'content_digest');

  if (candidate.artifact_kind === 'post') {
    enumValue(candidate.pillar, ['A', 'B', 'C', 'D'], 'pillar');
  }
  if (candidate.figure != null && (!Number.isInteger(candidate.figure) || candidate.figure < 1)) {
    fail('invalid_figure', 'figure must be null or a positive integer');
  }
  if (candidate.generator != null) {
    object(candidate.generator, 'generator');
    string(candidate.generator.provider, 'generator.provider');
    string(candidate.generator.model, 'generator.model');
    string(candidate.generator.prompt_version, 'generator.prompt_version');
    digest(candidate.generator.input_digest, 'generator.input_digest');
  }

  object(candidate.validation, 'validation');
  enumValue(candidate.validation.result, ['pass', 'warn', 'fail'], 'validation.result');
  if (!Array.isArray(candidate.validation.findings)) {
    fail('invalid_validation_findings', 'validation.findings must be an array');
  }

  const expected = candidateDigest(candidate);
  if (candidate.content_digest !== expected) {
    fail('candidate_digest_mismatch', 'candidate content/provenance fields do not match content_digest');
  }

  return candidate;
}

export function assertApproval(approval) {
  object(approval, 'approval');
  string(approval.approval_id, 'approval_id');
  string(approval.candidate_id, 'candidate_id');
  digest(approval.candidate_digest, 'candidate_digest');
  enumValue(approval.decision, ['approve', 'reject'], 'decision');
  if (approval.decided_by !== 'Patrick Craven') {
    fail('owner_required', 'authoritative approval is owner-reserved to Patrick Craven');
  }
  isoDate(approval.decided_at, 'decided_at');
  return approval;
}

export function assertApprovalForCandidate(candidate, approval) {
  assertArtifactCandidate(candidate);
  assertApproval(approval);

  if (candidate.status !== 'reviewable') {
    fail('candidate_not_reviewable', 'only a reviewable candidate may receive authoritative approval');
  }
  if (approval.decision !== 'approve') {
    fail('approval_required', 'candidate is not approved');
  }
  if (approval.candidate_id !== candidate.candidate_id) {
    fail('approval_candidate_mismatch', 'approval is for a different candidate id');
  }
  if (approval.candidate_digest !== candidate.content_digest) {
    fail('approval_digest_mismatch', 'approval does not bind to the exact candidate digest');
  }
  if (!['pass', 'warn'].includes(candidate.validation.result)) {
    fail('validation_failed', 'a candidate with failing validation cannot be approved for promotion');
  }

  return true;
}
