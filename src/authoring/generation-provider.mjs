import {
  AuthoringContractError,
  assertArtifactCandidate,
  assertKnowledgeUnit,
  candidateDigest,
  digestObject,
} from './contracts.mjs';
import { createArtifactPlan } from './planner.mjs';
import { getPromptContract, promptContractDigest } from './prompt-contract.mjs';

const FORBIDDEN_OUTPUT_KEYS = new Set([
  'approval',
  'approved',
  'status',
  'promotion',
  'publish',
  'publication',
  'scheduled_at',
  'authority',
]);

function positiveInt(value, name, min, max) {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new AuthoringContractError('invalid_generation_budget', `${name} must be an integer from ${min} to ${max}`);
  }
  return value;
}

function text(value, name, maxChars) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new AuthoringContractError('invalid_generated_text', `${name} must be a non-empty string`);
  }
  if (value.length > maxChars) {
    throw new AuthoringContractError('generation_output_too_large', `${name} exceeds ${maxChars} characters`);
  }
  return value.trim();
}

export function createGenerationProvider({ name, model, generate }) {
  if (typeof name !== 'string' || !name.trim() || typeof model !== 'string' || !model.trim()) {
    throw new AuthoringContractError('invalid_generation_provider', 'provider name and model are required');
  }
  if (typeof generate !== 'function') {
    throw new AuthoringContractError('invalid_generation_provider', 'provider generate function is required');
  }
  return Object.freeze({ name: name.trim(), model: model.trim(), generate });
}

export async function generateBoundedCandidates(provider, {
  unit,
  artifactKind,
  pillar = null,
  candidateCount = 3,
  promptVersion = 'author-v1',
  createdAt,
  maxInputChars = 12000,
  maxOutputCharsPerCandidate = 12000,
  timeoutMs = 30000,
}) {
  if (!provider || typeof provider.generate !== 'function' || !provider.name || !provider.model) {
    throw new AuthoringContractError('generation_provider_required', 'a valid generation provider is required');
  }
  assertKnowledgeUnit(unit);
  const plan = createArtifactPlan(unit, { requestedKind: artifactKind });
  if (plan.status !== 'ready') {
    throw new AuthoringContractError('knowledge_unit_blocked', `knowledge unit is blocked: ${plan.reason}`);
  }
  if (artifactKind === 'post' && !['A', 'B', 'C', 'D'].includes(pillar)) {
    throw new AuthoringContractError('pillar_required', 'post generation requires pillar A, B, C, or D');
  }

  positiveInt(candidateCount, 'candidateCount', 1, 5);
  positiveInt(maxInputChars, 'maxInputChars', 500, 50000);
  positiveInt(maxOutputCharsPerCandidate, 'maxOutputCharsPerCandidate', 100, 50000);
  positiveInt(timeoutMs, 'timeoutMs', 10, 120000);

  const promptContract = getPromptContract(promptVersion);
  if (!promptContract.outputs.includes(artifactKind)) {
    throw new AuthoringContractError('prompt_output_not_allowed', `${artifactKind} is not allowed by prompt contract ${promptVersion}`);
  }
  const promptDigest = promptContractDigest(promptVersion);

  const input = {
    unit,
    artifact_kind: artifactKind,
    pillar: artifactKind === 'post' ? pillar : null,
    candidate_count: candidateCount,
    prompt_version: promptVersion,
    prompt_contract_digest: promptDigest,
  };
  const serialized = JSON.stringify(input);
  if (serialized.length > maxInputChars) {
    throw new AuthoringContractError('generation_input_too_large', `generation input exceeds ${maxInputChars} characters`);
  }
  const inputDigest = digestObject(input);

  let timer;
  try {
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new AuthoringContractError('generation_timeout', `provider exceeded ${timeoutMs}ms timeout`)), timeoutMs);
    });
    const raw = await Promise.race([
      Promise.resolve(provider.generate(Object.freeze({
        ...input,
        prompt_contract: promptContract,
        constraints: Object.freeze({
          maxCandidates: candidateCount,
          maxOutputCharsPerCandidate,
          noApprovalAuthority: true,
          noPublicationAuthority: true,
        }),
      }))),
      timeout,
    ]);

    if (!Array.isArray(raw)) {
      throw new AuthoringContractError('malformed_generation_output', 'provider must return an array of candidate objects');
    }
    if (raw.length < 1 || raw.length > candidateCount) {
      throw new AuthoringContractError('generation_candidate_count', `provider returned ${raw.length}; expected 1-${candidateCount}`);
    }

    return raw.map((item, index) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        throw new AuthoringContractError('malformed_generation_output', `candidate ${index + 1} must be an object`);
      }
      for (const key of Object.keys(item)) {
        if (FORBIDDEN_OUTPUT_KEYS.has(key)) {
          throw new AuthoringContractError('provider_authority_injection', `provider candidate contains forbidden authority field: ${key}`);
        }
      }

      const value = {
        candidate_id: `candidate:${inputDigest.slice(-12)}:${String(index + 1).padStart(2, '0')}`,
        artifact_kind: artifactKind,
        status: 'draft',
        title: text(item.title, 'generated title', 160),
        body: text(item.body, 'generated body', maxOutputCharsPerCandidate),
        pillar: artifactKind === 'post' ? pillar : null,
        knowledge_unit_refs: [unit.knowledge_unit_id],
        source_refs: [...unit.source_refs],
        created_at: createdAt,
        generator: {
          provider: provider.name,
          model: provider.model,
          prompt_version: promptVersion,
          input_digest: inputDigest,
        },
        validation: {
          result: 'fail',
          findings: [{ level: 'error', rule: 'not-yet-validated', message: 'generated candidate has not passed artifact validation' }],
        },
      };
      value.content_digest = candidateDigest(value);
      assertArtifactCandidate(value);
      return Object.freeze(value);
    });
  } catch (error) {
    if (error instanceof AuthoringContractError) throw error;
    throw new AuthoringContractError('generation_provider_failure', `provider generation failed: ${error?.message ?? 'unknown error'}`);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
