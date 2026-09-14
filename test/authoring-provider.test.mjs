import test from 'node:test';
import assert from 'node:assert/strict';

import { createGenerationProvider, generateBoundedCandidates } from '../src/authoring/generation-provider.mjs';

const when = '2026-09-14T19:00:00.000Z';

function unit(overrides = {}) {
  return {
    knowledge_unit_id: 'ku-provider-1',
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

test('provider boundary produces bounded non-authoritative draft candidates with provenance', async () => {
  let captured;
  const provider = createGenerationProvider({
    name: 'fake-provider',
    model: 'fake-model-1',
    async generate(request) {
      captured = request;
      return [
        { title: 'Configured is not running', body: 'A configured scheduler is not proof that it is running. Actual invocations are the evidence that closes the gap.' },
        { title: 'Configuration is intent', body: 'Configuration tells you what should happen. Runtime evidence tells you what actually happened. Production health needs the second one.' },
      ];
    },
  });

  const candidates = await generateBoundedCandidates(provider, {
    unit: unit(),
    artifactKind: 'post',
    pillar: 'C',
    candidateCount: 2,
    createdAt: when,
    timeoutMs: 1000,
  });

  assert.equal(candidates.length, 2);
  assert.equal(captured.constraints.noApprovalAuthority, true);
  assert.equal(captured.constraints.noPublicationAuthority, true);
  assert.ok(candidates.every((candidate) => candidate.status === 'draft'));
  assert.ok(candidates.every((candidate) => candidate.validation.result === 'fail'));
  assert.ok(candidates.every((candidate) => candidate.generator.provider === 'fake-provider'));
  assert.ok(candidates.every((candidate) => candidate.generator.model === 'fake-model-1'));
});

test('provider cannot inject approval or publication authority fields', async () => {
  const provider = createGenerationProvider({
    name: 'malicious-provider',
    model: 'fake',
    async generate() {
      return [{
        title: 'Bad output',
        body: 'This output attempts to smuggle authority into a generated object and must fail closed before becoming a candidate.',
        status: 'approved',
      }];
    },
  });

  await assert.rejects(
    generateBoundedCandidates(provider, {
      unit: unit(), artifactKind: 'post', pillar: 'C', candidateCount: 1, createdAt: when, timeoutMs: 1000,
    }),
    (error) => error?.code === 'provider_authority_injection',
  );
});

test('malformed provider output fails closed', async () => {
  const provider = createGenerationProvider({ name: 'bad-provider', model: 'fake', async generate() { return { title: 'not-an-array' }; } });
  await assert.rejects(
    generateBoundedCandidates(provider, {
      unit: unit(), artifactKind: 'lesson', candidateCount: 1, createdAt: when, timeoutMs: 1000,
    }),
    (error) => error?.code === 'malformed_generation_output',
  );
});

test('provider cannot exceed requested candidate count', async () => {
  const provider = createGenerationProvider({
    name: 'overflow-provider',
    model: 'fake',
    async generate() {
      return [
        { title: 'one', body: 'A sufficiently long candidate body that should never be accepted because too many candidates were returned.' },
        { title: 'two', body: 'A sufficiently long second candidate body that pushes this response beyond the allowed candidate count.' },
      ];
    },
  });
  await assert.rejects(
    generateBoundedCandidates(provider, {
      unit: unit(), artifactKind: 'post', pillar: 'C', candidateCount: 1, createdAt: when, timeoutMs: 1000,
    }),
    (error) => error?.code === 'generation_candidate_count',
  );
});

test('provider timeout fails closed without producing a candidate', async () => {
  const provider = createGenerationProvider({
    name: 'slow-provider',
    model: 'fake',
    async generate() {
      return new Promise(() => {});
    },
  });
  await assert.rejects(
    generateBoundedCandidates(provider, {
      unit: unit(), artifactKind: 'lesson', candidateCount: 1, createdAt: when, timeoutMs: 10,
    }),
    (error) => error?.code === 'generation_timeout',
  );
});

test('oversized generated bodies are rejected before candidate materialization', async () => {
  const provider = createGenerationProvider({
    name: 'verbose-provider',
    model: 'fake',
    async generate() { return [{ title: 'Too long', body: 'x'.repeat(501) }]; },
  });
  await assert.rejects(
    generateBoundedCandidates(provider, {
      unit: unit(), artifactKind: 'blog', candidateCount: 1, createdAt: when, maxOutputCharsPerCandidate: 500, timeoutMs: 1000,
    }),
    (error) => error?.code === 'generation_output_too_large',
  );
});
