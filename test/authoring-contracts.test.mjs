import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AuthoringContractError,
  assertApprovalForCandidate,
  assertArtifactCandidate,
  assertSourceRecord,
  candidateDigest,
  digestText,
  sourceCanSupportClaim,
} from '../src/authoring/contracts.mjs';
import { createContextSourceAdapter, retrieveContext } from '../src/authoring/context-source.mjs';
import { createArtifactPlan } from '../src/authoring/planner.mjs';

function source(overrides = {}) {
  return {
    source_id: 'src-1',
    source_type: 'github',
    trust_class: 'evidence',
    locator: 'github:peteywee/xqueue#56',
    observed_at: '2026-09-14T12:00:00.000Z',
    content_digest: digestText('source body'),
    ...overrides,
  };
}

function unit(overrides = {}) {
  return {
    knowledge_unit_id: 'ku-1',
    kind: 'failure',
    summary: 'Configured state is not runtime proof.',
    claim_class: 'conceptual',
    support_state: 'supported',
    source_refs: ['src-1'],
    possible_outputs: ['post', 'blog', 'lesson'],
    ...overrides,
  };
}

function candidate(overrides = {}) {
  const value = {
    candidate_id: 'candidate-1',
    artifact_kind: 'post',
    status: 'reviewable',
    title: 'Configured is not running',
    body: 'A configured scheduler is not proof that a scheduled invocation actually occurred. Runtime evidence closes that gap.',
    pillar: 'C',
    knowledge_unit_refs: ['ku-1'],
    source_refs: ['src-1'],
    created_at: '2026-09-14T12:30:00.000Z',
    validation: { result: 'pass', findings: [] },
    ...overrides,
  };
  value.content_digest = candidateDigest(value);
  return value;
}

function approval(forCandidate, overrides = {}) {
  return {
    approval_id: 'approval-1',
    candidate_id: forCandidate.candidate_id,
    candidate_digest: forCandidate.content_digest,
    decision: 'approve',
    decided_by: 'Patrick Craven',
    decided_at: '2026-09-14T12:45:00.000Z',
    ...overrides,
  };
}

test('generated content cannot self-elevate to evidence or owner-attested truth', () => {
  assert.throws(
    () => assertSourceRecord(source({ source_type: 'generated_content', trust_class: 'evidence' })),
    (error) => error instanceof AuthoringContractError && error.code === 'generated_source_trust_escalation',
  );
});

test('generated and unverified sources cannot independently support experiential/current claims', () => {
  const generated = source({ source_type: 'generated_content', trust_class: 'generated' });
  assert.equal(sourceCanSupportClaim(generated, 'experiential'), false);
  assert.equal(sourceCanSupportClaim(generated, 'current_factual'), false);
  assert.equal(sourceCanSupportClaim(generated, 'generated_assertion'), false);
});

test('context source adapter is read-only, forces provenance, and returns validated source records', async () => {
  let captured;
  const adapter = createContextSourceAdapter({
    name: 'fake-context-engine',
    async retrieve(query) {
      captured = query;
      return [source({ source_type: 'context_engine' })];
    },
  });

  assert.deepEqual(Object.keys(adapter).sort(), ['mode', 'name', 'retrieve']);
  assert.equal(adapter.mode, 'read_only');

  const records = await retrieveContext(adapter, { query: 'scheduler liveness', maxResults: 5 });
  assert.equal(records.length, 1);
  assert.equal(captured.readOnly, true);
  assert.equal(captured.requireProvenance, true);
  assert.equal(captured.maxResults, 5);
});

test('context retrieval fails closed when returned records lack provenance', async () => {
  const adapter = createContextSourceAdapter({
    name: 'bad-context-engine',
    async retrieve() {
      return [{ source_id: 'missing-provenance' }];
    },
  });

  await assert.rejects(
    retrieveContext(adapter, { query: 'anything' }),
    (error) => error instanceof AuthoringContractError,
  );
});

test('artifact planner exposes only post/blog/lesson and blocks unresolved support states', () => {
  const ready = createArtifactPlan(unit());
  assert.equal(ready.status, 'ready');
  assert.deepEqual(ready.eligibleKinds, ['post', 'blog', 'lesson']);
  assert.equal(ready.preserveFailureHistory, true);

  const blocked = createArtifactPlan(unit({ support_state: 'research_required' }));
  assert.equal(blocked.status, 'blocked');
  assert.equal(blocked.reason, 'research_required');
});

test('candidate digest binds content, artifact type, pillar, knowledge refs, and source refs', () => {
  const value = candidate();
  assert.doesNotThrow(() => assertArtifactCandidate(value));

  const modified = { ...value, body: `${value.body} Changed after review.` };
  assert.throws(
    () => assertArtifactCandidate(modified),
    (error) => error instanceof AuthoringContractError && error.code === 'candidate_digest_mismatch',
  );
});

test('approval is owner-reserved and bound to the exact candidate digest', () => {
  const value = candidate();
  assert.equal(assertApprovalForCandidate(value, approval(value)), true);

  assert.throws(
    () => assertApprovalForCandidate(value, approval(value, { decided_by: 'generator-agent' })),
    (error) => error instanceof AuthoringContractError && error.code === 'owner_required',
  );

  assert.throws(
    () => assertApprovalForCandidate(value, approval(value, { candidate_digest: digestText('different candidate') })),
    (error) => error instanceof AuthoringContractError && error.code === 'approval_digest_mismatch',
  );
});

test('failing validation cannot be approved for promotion', () => {
  const value = candidate({ validation: { result: 'fail', findings: [{ rule: 'unsupported-claim' }] } });
  assert.throws(
    () => assertApprovalForCandidate(value, approval(value)),
    (error) => error instanceof AuthoringContractError && error.code === 'validation_failed',
  );
});
