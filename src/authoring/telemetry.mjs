import { AuthoringContractError, assertArtifactCandidate, digestObject } from './contracts.mjs';

function nonNegativeNumber(value, name) {
  if (value == null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new AuthoringContractError('invalid_generation_usage', `${name} must be a non-negative finite number or null`);
  }
  return value;
}

export function createGenerationTelemetry({ candidates, usage = {}, completedAt }) {
  if (!Array.isArray(candidates) || candidates.length < 1) {
    throw new AuthoringContractError('telemetry_candidates_required', 'generation telemetry requires at least one candidate');
  }
  const validated = candidates.map((candidate) => assertArtifactCandidate(candidate));
  const first = validated[0];
  if (!first.generator) {
    throw new AuthoringContractError('telemetry_generator_required', 'generation telemetry requires generated candidates');
  }
  for (const candidate of validated) {
    if (!candidate.generator || candidate.generator.provider !== first.generator.provider || candidate.generator.model !== first.generator.model || candidate.generator.prompt_version !== first.generator.prompt_version || candidate.generator.input_digest !== first.generator.input_digest) {
      throw new AuthoringContractError('telemetry_generation_mismatch', 'all candidates in one telemetry event must come from the same generation input');
    }
  }

  const inputTokens = nonNegativeNumber(usage.inputTokens, 'usage.inputTokens');
  const outputTokens = nonNegativeNumber(usage.outputTokens, 'usage.outputTokens');
  const estimatedCostUsd = nonNegativeNumber(usage.estimatedCostUsd, 'usage.estimatedCostUsd');
  const latencyMs = nonNegativeNumber(usage.latencyMs, 'usage.latencyMs');

  const event = {
    event_type: 'authoring_generation',
    completed_at: completedAt,
    provider: first.generator.provider,
    model: first.generator.model,
    prompt_version: first.generator.prompt_version,
    input_digest: first.generator.input_digest,
    candidate_count: validated.length,
    candidate_refs: validated.map((candidate) => ({
      candidate_id: candidate.candidate_id,
      candidate_digest: candidate.content_digest,
      artifact_kind: candidate.artifact_kind,
    })),
    usage: {
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      estimated_cost_usd: estimatedCostUsd,
      latency_ms: latencyMs,
    },
  };
  event.event_id = `generation:${digestObject(event).slice(-20)}`;
  return Object.freeze(event);
}
