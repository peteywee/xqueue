import {
  AuthoringContractError,
  assertKnowledgeUnit,
  assertSourceRecord,
  sourceCanSupportClaim,
} from './contracts.mjs';

const FIRST_PERSON_RE = /\b(?:i|i'm|i’ve|i've|my|me|mine|we|we're|we’ve|we've|our|ours)\b/i;
const CURRENT_FACT_RE = /\b(?:today|currently|current|latest|this (?:week|month|year)|now|as of|recently)\b/i;
const FAILURE_RE = /\b(?:fail(?:ed|ure)?|broke|broken|bug|incident|wrong|mistake|missed|outage|dead|stale)\b/i;
const LESSON_RE = /\b(?:learned|lesson|taught me|realized|understood|discovered)\b/i;
const DECISION_RE = /\b(?:decided|decision|chose|choose|selected|rejected)\b/i;
const FRAMEWORK_RE = /\b(?:framework|model|principle|rule|contract|pattern|invariant)\b/i;

function classifyClaimClass(text, sourceRecord) {
  if (sourceRecord.source_type === 'generated_content' || sourceRecord.trust_class === 'generated') {
    return 'generated_assertion';
  }
  if (sourceRecord.source_type === 'owner_input' && FIRST_PERSON_RE.test(text)) {
    return 'experiential';
  }
  if (CURRENT_FACT_RE.test(text)) return 'current_factual';
  return 'conceptual';
}

function classifyKind(text) {
  if (FAILURE_RE.test(text)) return 'failure';
  if (LESSON_RE.test(text)) return 'lesson';
  if (DECISION_RE.test(text)) return 'decision';
  if (FRAMEWORK_RE.test(text)) return 'principle';
  if (text.trim().endsWith('?')) return 'question';
  return 'observation';
}

function summarize(text, max = 280) {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= max) return collapsed;
  return `${collapsed.slice(0, max - 1).trimEnd()}…`;
}

function supportState(sourceRecord, claimClass) {
  if (sourceRecord.sensitivity === 'restricted') return 'internal_only';
  if (sourceRecord.trust_class === 'owner_attested') return 'supported';
  if (sourceCanSupportClaim(sourceRecord, claimClass)) return 'supported';
  if (claimClass === 'experiential') return 'owner_attestation_required';
  if (claimClass === 'current_factual') return 'research_required';
  return 'hypothesis';
}

function outputsFor(kind, text) {
  if (kind === 'question') return ['post', 'lesson'];
  if (['failure', 'lesson', 'principle', 'decision'].includes(kind)) return ['post', 'blog', 'lesson'];
  if (text.length > 900) return ['blog', 'lesson'];
  return ['post', 'blog'];
}

export function distillSegments(sourceRecord, segments) {
  assertSourceRecord(sourceRecord);
  if (!Array.isArray(segments) || !segments.length) {
    throw new AuthoringContractError('segments_required', 'distillation requires at least one segment');
  }

  return segments.map((segment, index) => {
    if (!segment || segment.source_id !== sourceRecord.source_id || typeof segment.text !== 'string' || !segment.text.trim()) {
      throw new AuthoringContractError('invalid_segment', 'every segment must belong to the source and contain text');
    }

    const claimClass = classifyClaimClass(segment.text, sourceRecord);
    const kind = classifyKind(segment.text);
    const unit = {
      knowledge_unit_id: `${sourceRecord.source_id}:ku:${String(index + 1).padStart(4, '0')}`,
      kind,
      summary: summarize(segment.text),
      claim_class: claimClass,
      support_state: supportState(sourceRecord, claimClass),
      source_refs: [sourceRecord.source_id],
      possible_outputs: outputsFor(kind, segment.text),
      sensitivity: sourceRecord.sensitivity ?? 'internal',
      failure_context: kind === 'failure' ? summarize(segment.text, 500) : null,
      used_artifact_refs: [],
      remaining_angles: [],
    };
    assertKnowledgeUnit(unit);
    return Object.freeze(unit);
  });
}
