import test from 'node:test';
import assert from 'node:assert/strict';

import { getPromptContract, listPromptVersions, promptContractDigest } from '../src/authoring/prompt-contract.mjs';
import { createGenerationProvider, generateBoundedCandidates } from '../src/authoring/generation-provider.mjs';

const when = '2026-09-14T17:10:00.000Z';

const unit = {
  knowledge_unit_id: 'ku-prompt-1',
  kind: 'lesson',
  summary: 'Configured state is not runtime proof.',
  claim_class: 'conceptual',
  support_state: 'supported',
  source_refs: ['src-1'],
  possible_outputs: ['post', 'blog', 'lesson'],
  sensitivity: 'internal',
  failure_context: 'The scheduler configuration existed while invocations were absent.',
};

test('author-v1 prompt contract is versioned, draft-only, and digestible', () => {
  const contract = getPromptContract('author-v1');
  assert.equal(contract.version, 'author-v1');
  assert.equal(contract.authority, 'draft_only');
  assert.deepEqual(listPromptVersions(), ['author-v1']);
  assert.match(promptContractDigest('author-v1'), /^sha256:[a-f0-9]{64}$/);
});

test('unsupported prompt versions fail closed before provider execution', async () => {
  let called = false;
  const provider = createGenerationProvider({
    name: 'fake',
    model: 'fake-model',
    generate: async () => {
      called = true;
      return [{ title: 'Should not run', body: 'Should not run.' }];
    },
  });

  await assert.rejects(
    () => generateBoundedCandidates(provider, {
      unit,
      artifactKind: 'post',
      pillar: 'C',
      promptVersion: 'author-v999',
      candidateCount: 1,
      createdAt: when,
    }),
    (error) => error?.code === 'unsupported_prompt_version',
  );
  assert.equal(called, false);
});

test('provider receives prompt contract and its digest is bound into candidate input identity', async () => {
  let received;
  const provider = createGenerationProvider({
    name: 'fake',
    model: 'fake-model',
    generate: async (input) => {
      received = input;
      return [{
        title: 'Configured is not running',
        body: 'A configured scheduler is not proof of runtime health. Real health evidence has to come from observed invocations.',
      }];
    },
  });

  const [candidate] = await generateBoundedCandidates(provider, {
    unit,
    artifactKind: 'post',
    pillar: 'C',
    promptVersion: 'author-v1',
    candidateCount: 1,
    createdAt: when,
  });

  assert.equal(received.prompt_contract.version, 'author-v1');
  assert.equal(received.prompt_contract.authority, 'draft_only');
  assert.equal(received.prompt_contract_digest, promptContractDigest('author-v1'));
  assert.equal(received.constraints.noApprovalAuthority, true);
  assert.equal(received.constraints.noPublicationAuthority, true);
  assert.equal(candidate.status, 'draft');
  assert.equal(candidate.generator.prompt_version, 'author-v1');
  assert.match(candidate.generator.input_digest, /^sha256:[a-f0-9]{64}$/);
});
