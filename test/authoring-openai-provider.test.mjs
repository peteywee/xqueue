import test from 'node:test';
import assert from 'node:assert/strict';

import { generateBoundedCandidates } from '../src/authoring/generation-provider.mjs';
import { getPromptContract } from '../src/authoring/prompt-contract.mjs';
import { createOpenAIAuthoringProvider } from '../src/authoring/providers/openai.mjs';

// No test here reaches the network: every provider gets an injected fetch.

const when = '2026-09-14T19:00:00.000Z';
const KEY = 'sk-test-not-a-real-key';

function unit(overrides = {}) {
  return {
    knowledge_unit_id: 'ku-openai-1',
    kind: 'lesson',
    summary: 'Configured state is not runtime proof; runtime claims require evidence from actual execution.',
    claim_class: 'conceptual',
    support_state: 'supported',
    source_refs: ['src-1'],
    possible_outputs: ['post', 'blog', 'lesson'],
    sensitivity: 'public',
    ...overrides,
  };
}

const CANDIDATES = [
  { title: 'Configured is not running', body: 'A configured scheduler is not proof that it is running. Actual invocations are the evidence that closes the gap.' },
  { title: 'Configuration is intent', body: 'Configuration tells you what should happen. Runtime evidence tells you what actually happened.' },
];

function jsonResponse(payload, { ok = true, status = 200 } = {}) {
  return {
    ok,
    status,
    async json() {
      return payload;
    },
  };
}

function recordingFetch(response) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    return typeof response === 'function' ? response() : response;
  };
  return { calls, fetchImpl };
}

function minimalInput(overrides = {}) {
  return {
    prompt_contract: getPromptContract('author-v1'),
    candidate_count: 2,
    ...overrides,
  };
}

async function rejectsWithCode(promise, code) {
  await assert.rejects(promise, (error) => {
    assert.equal(error?.name, 'AuthoringContractError');
    assert.equal(error.code, code);
    return true;
  });
}

test('the adapter refuses to construct without a key, model, fetch, or a sane output budget', () => {
  const fetchImpl = async () => jsonResponse({});
  const cases = [
    ['openai_api_key_required', { apiKey: '' }],
    ['openai_api_key_required', { apiKey: '   ' }],
    ['openai_model_required', { apiKey: KEY, model: '  ' }],
    ['openai_fetch_required', { apiKey: KEY, fetchImpl: 'not-a-function' }],
    ['openai_output_budget_invalid', { apiKey: KEY, maxOutputTokens: 255 }],
    ['openai_output_budget_invalid', { apiKey: KEY, maxOutputTokens: 20001 }],
    ['openai_output_budget_invalid', { apiKey: KEY, maxOutputTokens: 1000.5 }],
  ];

  for (const [code, options] of cases) {
    assert.throws(
      () => createOpenAIAuthoringProvider({ fetchImpl, model: 'm', ...options }),
      (error) => error.code === code,
      code,
    );
  }
});

test('generation without the bounded prompt contract is refused before any request', async () => {
  const { calls, fetchImpl } = recordingFetch(jsonResponse({ output_text: '{"candidates":[]}' }));
  const provider = createOpenAIAuthoringProvider({ apiKey: KEY, model: 'm', fetchImpl });

  await rejectsWithCode(provider.generate({ candidate_count: 1 }), 'openai_generation_input_invalid');
  await rejectsWithCode(provider.generate(minimalInput({ candidate_count: '2' })), 'openai_generation_input_invalid');
  await rejectsWithCode(provider.generate(undefined), 'openai_generation_input_invalid');
  assert.equal(calls.length, 0);
});

test('one bounded, unstored, schema-constrained request flows through the generation boundary', async () => {
  const { calls, fetchImpl } = recordingFetch(jsonResponse({
    output_text: JSON.stringify({ candidates: CANDIDATES }),
    usage: { input_tokens: 812, output_tokens: 240 },
  }));
  const provider = createOpenAIAuthoringProvider({
    apiKey: `  ${KEY}  `,
    model: '  test-model  ',
    endpoint: 'https://example.invalid/v1/responses',
    fetchImpl,
    maxOutputTokens: 4000,
  });

  const candidates = await generateBoundedCandidates(provider, {
    unit: unit(),
    artifactKind: 'post',
    pillar: 'C',
    candidateCount: 2,
    createdAt: when,
    timeoutMs: 1000,
  });

  assert.equal(calls.length, 1);
  const [{ url, init, body }] = calls;
  assert.equal(url, 'https://example.invalid/v1/responses');
  assert.equal(init.method, 'POST');
  assert.equal(init.headers.Authorization, `Bearer ${KEY}`);
  assert.equal(init.headers['Content-Type'], 'application/json');

  assert.equal(body.model, 'test-model');
  assert.equal(body.store, false);
  assert.equal(body.max_output_tokens, 4000);
  assert.equal(body.text.format.type, 'json_schema');
  assert.equal(body.text.format.strict, true);
  assert.equal(body.text.format.schema.properties.candidates.maxItems, 2);

  const contract = getPromptContract('author-v1');
  assert.ok(body.instructions.startsWith(contract.purpose));
  contract.rules.forEach((rule, index) => assert.ok(body.instructions.includes(`${index + 1}. ${rule}`)));

  const sent = JSON.parse(body.input);
  assert.equal(sent.knowledge_unit.knowledge_unit_id, 'ku-openai-1');
  assert.equal(sent.artifact_kind, 'post');
  assert.equal(sent.pillar, 'C');
  assert.equal(sent.candidate_count, 2);
  assert.equal(sent.prompt_version, 'author-v1');
  assert.equal(sent.constraints.noPublicationAuthority, true);

  assert.equal(provider.name, 'openai-responses');
  assert.equal(provider.model, 'test-model');
  assert.equal(candidates.length, 2);
  assert.ok(candidates.every((candidate) => candidate.status === 'draft'));
  assert.ok(candidates.every((candidate) => candidate.generator.provider === 'openai-responses'));
  assert.ok(candidates.every((candidate) => candidate.generator.model === 'test-model'));
});

test('a generation timeout cancels the in-flight OpenAI request', async () => {
  let signal;
  let aborted = false;
  const fetchImpl = (url, init) => new Promise((resolve, reject) => {
    signal = init.signal;
    const timer = setTimeout(() => resolve(jsonResponse({ output_text: JSON.stringify({ candidates: CANDIDATES }) })), 5000);
    init.signal?.addEventListener('abort', () => {
      aborted = true;
      clearTimeout(timer);
      reject(new DOMException('This operation was aborted', 'AbortError'));
    });
  });
  const provider = createOpenAIAuthoringProvider({ apiKey: KEY, model: 'm', fetchImpl });

  const started = Date.now();
  await rejectsWithCode(
    generateBoundedCandidates(provider, {
      unit: unit(), artifactKind: 'lesson', candidateCount: 1, createdAt: when, timeoutMs: 20,
    }),
    'generation_timeout',
  );

  assert.ok(signal instanceof AbortSignal, 'fetch received the abort signal');
  assert.equal(aborted, true, 'the request was cancelled, not abandoned');
  assert.ok(Date.now() - started < 1000, 'cancelled near the 20ms deadline, not when the request would finish');
});

test('text output is read from output_text or assembled from output_text content parts', async () => {
  // Parts are joined with '\n'; splitting between JSON tokens keeps the joined text valid JSON.
  const head = '{"candidates":';
  const tail = `${JSON.stringify(CANDIDATES)}}`;
  const parts = [
    { type: 'reasoning', content: [] },
    { content: [{ type: 'output_text', text: head }] },
    { content: [{ type: 'refusal', refusal: 'not text output' }, { type: 'output_text', text: tail }] },
  ];
  const responses = [
    { output_text: JSON.stringify({ candidates: CANDIDATES }) },
    { output: parts },
    { output_text: '   ', output: parts },
  ];

  for (const payload of responses) {
    const { fetchImpl } = recordingFetch(jsonResponse(payload));
    const provider = createOpenAIAuthoringProvider({ apiKey: KEY, model: 'm', fetchImpl });
    assert.deepEqual(await provider.generate(minimalInput()), CANDIDATES);
  }
});

test('every failed exchange fails closed with a distinct code', async () => {
  const cases = [
    ['openai_transport_failure', async () => { throw new TypeError('fetch failed'); }],
    ['openai_http_failure', async () => jsonResponse({ error: { message: 'bad key' } }, { ok: false, status: 401 })],
    ['openai_response_invalid', async () => ({ ok: true, status: 200, async json() { throw new SyntaxError('Unexpected token'); } })],
    ['openai_output_missing', async () => jsonResponse({ output: [] })],
    ['openai_output_missing', async () => jsonResponse({ output_text: '   ' })],
    ['openai_output_invalid_json', async () => jsonResponse({ output_text: '{"candidates": [' })],
    ['openai_output_invalid_shape', async () => jsonResponse({ output_text: '{"drafts": []}' })],
  ];

  for (const [code, fetchImpl] of cases) {
    const provider = createOpenAIAuthoringProvider({ apiKey: KEY, model: 'm', fetchImpl });
    await rejectsWithCode(provider.generate(minimalInput()), code);
    assert.equal(provider.getLastUsage(), null, `${code} records no usage on a fresh provider`);
  }
});

test('an HTTP failure reports only the status, never the response body or the key', async () => {
  const provider = createOpenAIAuthoringProvider({
    apiKey: KEY,
    model: 'm',
    fetchImpl: async () => jsonResponse({ error: { message: `invalid key ${KEY}` } }, { ok: false, status: 401 }),
  });

  await assert.rejects(provider.generate(minimalInput()), (error) => {
    assert.equal(error.message, 'OpenAI Responses API returned HTTP 401');
    return true;
  });
});

test('usage is recorded only after a successful parse and is returned as a copy', async () => {
  const payloads = [
    { output_text: JSON.stringify({ candidates: CANDIDATES }), usage: { input_tokens: 10, output_tokens: 20 } },
    { output_text: JSON.stringify({ candidates: CANDIDATES }), usage: { input_tokens: '10', output_tokens: null } },
  ];
  let index = 0;
  const provider = createOpenAIAuthoringProvider({
    apiKey: KEY,
    model: 'm',
    fetchImpl: async () => jsonResponse(payloads[index++]),
  });

  assert.equal(provider.getLastUsage(), null);

  await provider.generate(minimalInput());
  const usage = provider.getLastUsage();
  assert.deepEqual(usage, { inputTokens: 10, outputTokens: 20, estimatedCostUsd: null, latencyMs: null });
  usage.inputTokens = 999;
  assert.equal(provider.getLastUsage().inputTokens, 10, 'callers cannot mutate recorded usage');

  await provider.generate(minimalInput());
  assert.deepEqual(provider.getLastUsage(), { inputTokens: null, outputTokens: null, estimatedCostUsd: null, latencyMs: null });
});
