import { AuthoringContractError } from '../contracts.mjs';

const DEFAULT_ENDPOINT = 'https://api.openai.com/v1/responses';
const DEFAULT_MODEL = 'gpt-5.6-luna';

function responseOutputText(payload) {
  if (typeof payload?.output_text === 'string' && payload.output_text.trim()) return payload.output_text.trim();
  const parts = [];
  for (const item of Array.isArray(payload?.output) ? payload.output : []) {
    for (const content of Array.isArray(item?.content) ? item.content : []) {
      if (content?.type === 'output_text' && typeof content.text === 'string') parts.push(content.text);
    }
  }
  return parts.join('\n').trim();
}

function candidateSchema(maxCandidates) {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['candidates'],
    properties: {
      candidates: {
        type: 'array',
        minItems: 1,
        maxItems: maxCandidates,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['title', 'body'],
          properties: {
            title: { type: 'string', minLength: 1, maxLength: 160 },
            body: { type: 'string', minLength: 1 },
          },
        },
      },
    },
  };
}

export function createOpenAIAuthoringProvider({
  apiKey = process.env.OPENAI_API_KEY,
  model = process.env.OPENAI_AUTHOR_MODEL || DEFAULT_MODEL,
  endpoint = DEFAULT_ENDPOINT,
  fetchImpl = globalThis.fetch,
  maxOutputTokens = 5000,
} = {}) {
  if (typeof apiKey !== 'string' || !apiKey.trim()) {
    throw new AuthoringContractError('openai_api_key_required', 'OPENAI_API_KEY is required for live OpenAI generation');
  }
  if (typeof model !== 'string' || !model.trim()) {
    throw new AuthoringContractError('openai_model_required', 'OpenAI authoring model is required');
  }
  if (typeof fetchImpl !== 'function') {
    throw new AuthoringContractError('openai_fetch_required', 'a fetch implementation is required');
  }
  if (!Number.isInteger(maxOutputTokens) || maxOutputTokens < 256 || maxOutputTokens > 20000) {
    throw new AuthoringContractError('openai_output_budget_invalid', 'maxOutputTokens must be an integer from 256 to 20000');
  }

  let lastUsage = null;

  return Object.freeze({
    name: 'openai-responses',
    model: model.trim(),
    getLastUsage() {
      return lastUsage ? { ...lastUsage } : null;
    },
    async generate(input) {
      const promptContract = input?.prompt_contract;
      const candidateCount = input?.candidate_count;
      if (!promptContract || !Array.isArray(promptContract.rules) || !Number.isInteger(candidateCount)) {
        throw new AuthoringContractError('openai_generation_input_invalid', 'OpenAI adapter requires the bounded prompt contract input');
      }

      const instructions = [
        promptContract.purpose,
        ...promptContract.rules.map((rule, index) => `${index + 1}. ${rule}`),
        'Return only the structured candidate payload required by the response schema.',
      ].join('\n');

      const body = {
        model: model.trim(),
        store: false,
        instructions,
        input: JSON.stringify({
          knowledge_unit: input.unit,
          artifact_kind: input.artifact_kind,
          pillar: input.pillar,
          candidate_count: candidateCount,
          prompt_version: input.prompt_version,
          prompt_contract_digest: input.prompt_contract_digest,
          constraints: input.constraints,
        }),
        max_output_tokens: maxOutputTokens,
        text: {
          format: {
            type: 'json_schema',
            name: 'xqueue_author_candidates',
            strict: true,
            schema: candidateSchema(candidateCount),
          },
        },
      };

      let response;
      try {
        response = await fetchImpl(endpoint, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey.trim()}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(body),
        });
      } catch (error) {
        throw new AuthoringContractError('openai_transport_failure', `OpenAI request failed: ${error?.message ?? 'transport error'}`);
      }

      if (!response?.ok) {
        throw new AuthoringContractError('openai_http_failure', `OpenAI Responses API returned HTTP ${response?.status ?? 'unknown'}`);
      }

      let payload;
      try {
        payload = await response.json();
      } catch {
        throw new AuthoringContractError('openai_response_invalid', 'OpenAI response was not valid JSON');
      }

      const outputText = responseOutputText(payload);
      if (!outputText) {
        throw new AuthoringContractError('openai_output_missing', 'OpenAI response contained no text output');
      }

      let parsed;
      try {
        parsed = JSON.parse(outputText);
      } catch {
        throw new AuthoringContractError('openai_output_invalid_json', 'OpenAI structured output could not be parsed as JSON');
      }
      if (!Array.isArray(parsed?.candidates)) {
        throw new AuthoringContractError('openai_output_invalid_shape', 'OpenAI structured output did not contain candidates');
      }

      lastUsage = {
        inputTokens: Number.isFinite(payload?.usage?.input_tokens) ? payload.usage.input_tokens : null,
        outputTokens: Number.isFinite(payload?.usage?.output_tokens) ? payload.usage.output_tokens : null,
        estimatedCostUsd: null,
        latencyMs: null,
      };

      return parsed.candidates;
    },
  });
}
