import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

import {
  assertPreviewMigrationLane,
  assertPreviewRevisionChain,
  PREVIEW_BOOTSTRAP_ACTIVE_ASSIGNMENTS,
  PREVIEW_DYNAMIC_RUNTIME_MIGRATIONS,
} from '../src/preview-runtime-proof-checks.mjs';

const LANE = readdirSync(new URL('../cloudflare/migrations/', import.meta.url))
  .filter((name) => name.endsWith('.sql'))
  .sort();

const D = (c) => c.repeat(64);

function chain(count) {
  const revisions = [];
  const operations = [];
  for (let generation = 1; generation <= count; generation++) {
    const digest = D('abcdef'[generation - 1]);
    const operationId = generation === 1 ? null : 'op-' + generation;
    revisions.push({
      generation,
      revision_digest: digest,
      previous_revision_digest: generation === 1 ? null : revisions[generation - 2].revision_digest,
      active_assignment_count: PREVIEW_BOOTSTRAP_ACTIVE_ASSIGNMENTS + generation - 1,
      source_operation_id: operationId,
    });
    if (operationId) {
      operations.push({
        operation_id: operationId,
        state: 'COMPLETE',
        effect_state: 'applied',
        resulting_runtime_generation: generation,
        resulting_runtime_revision_digest: digest,
      });
    }
  }
  const head = revisions[revisions.length - 1];
  return {
    revisions,
    operations,
    state: { generation: head.generation, revision_digest: head.revision_digest },
  };
}

test('migration lane must equal the repository preview lane exactly', () => {
  assert.deepEqual(assertPreviewMigrationLane([...LANE], [...LANE]), LANE);
  assert.ok(LANE.includes('0017_publication_mutation_mutex.sql'));

  assert.throws(
    () => assertPreviewMigrationLane(LANE.slice(0, -1), LANE),
    /do not exactly match the repository preview lane/,
  );
  assert.throws(
    () => assertPreviewMigrationLane([...LANE, '9999_unknown.sql'], LANE),
    /do not exactly match the repository preview lane/,
  );
  assert.throws(
    () => assertPreviewMigrationLane([...LANE].reverse(), LANE),
    /do not exactly match the repository preview lane/,
  );
});

test('migration lane must contain 0006-0012 contiguously', () => {
  const gapped = LANE.filter((name) => name !== PREVIEW_DYNAMIC_RUNTIME_MIGRATIONS[3]);
  assert.throws(
    () => assertPreviewMigrationLane(gapped, gapped),
    /0006-0012 are not applied contiguously/,
  );
});

test('a bootstrap-only preview passes and reports no mutation revisions', () => {
  const fx = chain(1);
  assert.deepEqual(
    { ...assertPreviewRevisionChain(fx) },
    {
      generation: 1,
      headRevisionDigest: D('a'),
      bootstrapRevisionDigest: D('a'),
      mutationRevisions: 0,
    },
  );
});

test('guarded mutation revisions after bootstrap pass when each is an exact completed result', () => {
  const fx = chain(4);
  const result = assertPreviewRevisionChain(fx);
  assert.equal(result.generation, 4);
  assert.equal(result.mutationRevisions, 3);
  assert.equal(result.bootstrapRevisionDigest, D('a'));
  assert.equal(result.headRevisionDigest, D('d'));
});

test('the 180-assignment static parity still binds the bootstrap revision', () => {
  const fx = chain(4);
  fx.revisions[0].active_assignment_count = 179;
  assert.throws(() => assertPreviewRevisionChain(fx), /bootstrap revision expected 180 active assignments, got 179/);
});

test('bootstrap revision may not have a predecessor or source operation', () => {
  const withPrevious = chain(1);
  withPrevious.revisions[0].previous_revision_digest = D('f');
  assert.throws(() => assertPreviewRevisionChain(withPrevious), /no predecessor and no source operation/);

  const withSource = chain(1);
  withSource.revisions[0].source_operation_id = 'op-1';
  assert.throws(() => assertPreviewRevisionChain(withSource), /no predecessor and no source operation/);
});

test('revision generations must be contiguous from 1', () => {
  const fx = chain(3);
  fx.revisions.splice(1, 1);
  assert.throws(() => assertPreviewRevisionChain(fx), /not contiguous from 1/);
  assert.throws(() => assertPreviewRevisionChain({ ...chain(1), revisions: [] }), /history is empty/);
});

test('each later revision must chain to its predecessor digest', () => {
  const fx = chain(3);
  fx.revisions[2].previous_revision_digest = D('f');
  assert.throws(() => assertPreviewRevisionChain(fx), /revision 3 does not chain to its predecessor/);
});

test('each later revision must be the exact result of a completed applied operation', () => {
  const cases = [
    ['missing operation', (fx) => { fx.operations.splice(0, 1); }],
    ['unknown source id', (fx) => { fx.revisions[1].source_operation_id = 'op-forged'; }],
    ['not complete', (fx) => { fx.operations[0].state = 'VERIFYING'; }],
    ['not applied', (fx) => { fx.operations[0].effect_state = 'ambiguous'; }],
    ['wrong generation', (fx) => { fx.operations[0].resulting_runtime_generation = 3; }],
    ['wrong digest', (fx) => { fx.operations[0].resulting_runtime_revision_digest = D('f'); }],
    ['no source on later revision', (fx) => { fx.revisions[1].source_operation_id = null; }],
  ];
  for (const [name, mutate] of cases) {
    const fx = chain(3);
    mutate(fx);
    assert.throws(
      () => assertPreviewRevisionChain(fx),
      /revision 2 is not the exact result of a completed guarded mutation/,
      name,
    );
  }
});

test('runtime state must be the head of the revision history', () => {
  const behind = chain(3);
  behind.state = { generation: 2, revision_digest: D('b') };
  assert.throws(() => assertPreviewRevisionChain(behind), /not the head of its revision history/);

  const forked = chain(3);
  forked.state = { generation: 3, revision_digest: D('f') };
  assert.throws(() => assertPreviewRevisionChain(forked), /not the head of its revision history/);

  const wrongGeneration = chain(3);
  wrongGeneration.state = { generation: 2, revision_digest: D('c') };
  assert.throws(() => assertPreviewRevisionChain(wrongGeneration), /not the head of its revision history/);

  assert.throws(() => assertPreviewRevisionChain({ ...chain(2), state: null }), /not the head of its revision history/);
});

test('proof script uses the post-mutation checks instead of fresh-preview snapshot facts', () => {
  const source = readFileSync(new URL('../scripts/preview-dynamic-runtime-proof.mjs', import.meta.url), 'utf8');
  assert.match(source, /assertPreviewMigrationLane\(/);
  assert.match(source, /assertPreviewRevisionChain\(/);
  assert.doesNotMatch(source, /names\.slice\(-7\)/);
  assert.doesNotMatch(source, /not exact generation 1/);
  assert.doesNotMatch(source, /Number\(state\.generation\) !== 1/);
  assert.match(source, /if \(!state\) \{\n    if \(computed\.active_assignment_count !== PREVIEW_BOOTSTRAP_ACTIVE_ASSIGNMENTS\)/);

  const workflow = readFileSync(new URL('../.github/workflows/preview-dynamic-runtime.yml', import.meta.url), 'utf8');
  assert.match(workflow, /- 'src\/preview-runtime-proof-checks\.mjs'/);
});
