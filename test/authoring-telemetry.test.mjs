import test from 'node:test';
import assert from 'node:assert/strict';

import { candidateDigest } from '../src/authoring/contracts.mjs';
import { createGenerationTelemetry } from '../src/authoring/telemetry.mjs';

const when = '2026-09-14T17:20:00.000Z';

function generatedCandidate(id, overrides = {}) {
  const value = {
    candidate_id: id,
    artifact_kind: 'post',
    status: 'draft',
    title: 'Private draft title',
    body: 'Private generated draft body that must never appear in telemetry output.',
    pillar: 'C',
    figure: null,
    knowledge_unit_refs: ['ku-1'],
    source_refs: ['src-secret'],
    created_at: when,
    generator: {
      provider: 'fake',
      model: 'fake-model',
      prompt_version: 'author-v1',
      input_digest: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    },
    validation: { result: 'fail', findings: [{ level: 'error', rule: 'not-yet-validated', message: 'not validated' }] },
    ...overrides,
  };
  value.content_digest = candidateDigest(value);
  return value;
}

test('generation telemetry records usage and identity without draft or source content', () => {
  const event = createGenerationTelemetry({
    candidates: [generatedCandidate('candidate-1'), generatedCandidate('candidate-2')],
    usage: { inputTokens: 1200, outputTokens: 500, estimatedCostUsd: 0.0123, latencyMs: 842 },
    completedAt: when,
  });

  assert.equal(event.provider, 'fake');
  assert.equal(event.candidate_count, 2);
  assert.equal(event.usage.input_tokens, 1200);
  assert.equal(event.usage.estimated_cost_usd, 0.0123);
  assert.match(event.event_id, /^generation:/);

  const serialized = JSON.stringify(event);
  assert.doesNotMatch(serialized, /Private draft title/);
  assert.doesNotMatch(serialized, /Private generated draft body/);
  assert.doesNotMatch(serialized, /src-secret/);
});

test('telemetry refuses to mix candidates from different generation inputs', () => {
  const first = generatedCandidate('candidate-1');
  const second = generatedCandidate('candidate-2', {
    generator: {
      provider: 'fake',
      model: 'fake-model',
      prompt_version: 'author-v1',
      input_digest: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    },
  });

  assert.throws(
    () => createGenerationTelemetry({ candidates: [first, second], completedAt: when }),
    (error) => error?.code === 'telemetry_generation_mismatch',
  );
});

test('telemetry refuses negative token, latency, or cost counters', () => {
  assert.throws(
    () => createGenerationTelemetry({
      candidates: [generatedCandidate('candidate-1')],
      usage: { estimatedCostUsd: -1 },
      completedAt: when,
    }),
    (error) => error?.code === 'invalid_generation_usage',
  );
});
