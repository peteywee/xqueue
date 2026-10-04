import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

import {
  assertPreviewHaltState,
  assertPreviewMigrationLane,
  assertPreviewRevisionChain,
  PREVIEW_BOOTSTRAP_ACTIVE_ASSIGNMENTS,
  PREVIEW_DYNAMIC_RUNTIME_MIGRATIONS,
} from '../src/preview-runtime-proof-checks.mjs';

const LANE = readdirSync(new URL('../cloudflare/migrations/', import.meta.url))
  .filter((name) => name.endsWith('.sql'))
  .sort();

const D = (c) => c.repeat(64);
const OP = (generation) => 'mutation-intake-' + String(generation).repeat(24).slice(0, 24);

// sources[i] is the source for generation i + 2; 'mutation' builds a guarded
// mutation operation, any other string is stamped as-is (other preview writers).
function chain(count, sources = []) {
  const revisions = [];
  const operations = [];
  for (let generation = 1; generation <= count; generation++) {
    const digest = D('abcdef'[generation - 1]);
    const predecessor = revisions[generation - 2];
    const kind = generation === 1 ? null : (sources[generation - 2] ?? 'mutation');
    const source = kind === null ? null : kind === 'mutation' ? OP(generation) : kind;
    revisions.push({
      generation,
      revision_digest: digest,
      previous_revision_digest: predecessor ? predecessor.revision_digest : null,
      active_assignment_count: PREVIEW_BOOTSTRAP_ACTIVE_ASSIGNMENTS + generation - 1,
      source_operation_id: source,
    });
    if (kind === 'mutation') {
      operations.push({
        operation_id: source,
        state: 'COMPLETE',
        effect_state: 'applied',
        expected_runtime_generation: predecessor.generation,
        expected_runtime_revision_digest: predecessor.revision_digest,
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

const INIT = { generation: 1, action: 'initialized', actor_class: 'migration', reason: 'initial_unhalted' };

test('migration lane must equal the repository preview lane as a set', () => {
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
});

test('a lower-numbered migration applied later still matches the lane', () => {
  const late = '0013_added_after_0017.sql';
  const applied = [...LANE, late];
  const repository = [...LANE, late].sort();
  assert.notDeepEqual(applied, repository);
  assert.deepEqual(assertPreviewMigrationLane(applied, repository), repository);
});

test('migration lane must contain 0006-0012 contiguously', () => {
  const gapped = LANE.filter((name) => name !== PREVIEW_DYNAMIC_RUNTIME_MIGRATIONS[3]);
  assert.throws(
    () => assertPreviewMigrationLane(gapped, gapped),
    /0006-0012 are not applied contiguously/,
  );
});

test('halt check binds to the migration initialization event and accepts later clears', () => {
  assert.deepEqual(
    { ...assertPreviewHaltState({ state: { halted: 0, generation: 1 }, events: [INIT] }) },
    { generation: 1, events: 1 },
  );
  const drilled = [
    INIT,
    { generation: 2, action: 'set', actor_class: 'owner', reason: 'drill' },
    { generation: 3, action: 'clear', actor_class: 'owner', reason: 'drill done' },
  ];
  assert.equal(assertPreviewHaltState({ state: { halted: 0, generation: 3 }, events: drilled }).generation, 3);
});

test('halt check rejects a wrong initialization, a stale state, or an active halt', () => {
  assert.throws(
    () => assertPreviewHaltState({ state: { halted: 0, generation: 1 }, events: [{ ...INIT, reason: 'other' }] }),
    /did not initialize fail-safe state exactly/,
  );
  assert.throws(
    () => assertPreviewHaltState({ state: { halted: 0, generation: 1 }, events: [{ ...INIT, action: 'clear' }] }),
    /did not initialize fail-safe state exactly/,
  );
  assert.throws(
    () => assertPreviewHaltState({ state: { halted: 0, generation: 1 }, events: [] }),
    /state or events are missing/,
  );
  const set = [INIT, { generation: 2, action: 'set', actor_class: 'owner', reason: 'drill' }];
  assert.throws(
    () => assertPreviewHaltState({ state: { halted: 0, generation: 1 }, events: set }),
    /not at its latest event generation/,
  );
  assert.throws(
    () => assertPreviewHaltState({ state: { halted: 1, generation: 2 }, events: set }),
    /halt is set/,
  );
  assert.throws(
    () => assertPreviewHaltState({ state: { halted: 0, generation: 2 }, events: set }),
    /halt is set/,
  );
});

test('a bootstrap-only preview passes and reports no later revisions', () => {
  assert.deepEqual(
    { ...assertPreviewRevisionChain(chain(1)) },
    {
      generation: 1,
      headRevisionDigest: D('a'),
      bootstrapRevisionDigest: D('a'),
      mutationRevisions: 0,
      otherRevisions: 0,
    },
  );
});

test('guarded mutation revisions pass when each is an exact completed result', () => {
  const result = assertPreviewRevisionChain(chain(4));
  assert.equal(result.generation, 4);
  assert.equal(result.mutationRevisions, 3);
  assert.equal(result.otherRevisions, 0);
  assert.equal(result.headRevisionDigest, D('d'));
});

test('revisions from other preview writers are accepted when they chain and carry a source', () => {
  const fx = chain(5, ['mutation', 'deferred-lifecycle:' + 'a'.repeat(24), 'queue-owner-revise-0123', 'mutation']);
  const result = assertPreviewRevisionChain(fx);
  assert.equal(result.mutationRevisions, 2);
  assert.equal(result.otherRevisions, 2);
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
  withSource.revisions[0].source_operation_id = OP(1);
  assert.throws(() => assertPreviewRevisionChain(withSource), /no predecessor and no source operation/);
});

test('revision generations must be contiguous from 1', () => {
  const fx = chain(3);
  fx.revisions.splice(1, 1);
  assert.throws(() => assertPreviewRevisionChain(fx), /not contiguous from 1/);
  assert.throws(() => assertPreviewRevisionChain({ ...chain(1), revisions: [] }), /history is empty/);
});

test('each later revision must chain to its predecessor digest and carry a source', () => {
  const broken = chain(3, ['other-writer', 'other-writer']);
  broken.revisions[2].previous_revision_digest = D('f');
  assert.throws(() => assertPreviewRevisionChain(broken), /revision 3 does not chain to its predecessor/);

  for (const missing of [null, '']) {
    const fx = chain(3, ['other-writer', 'other-writer']);
    fx.revisions[1].source_operation_id = missing;
    assert.throws(() => assertPreviewRevisionChain(fx), /revision 2 has no source operation/);
  }
});

test('a revision naming a guarded mutation must match that operation exactly', () => {
  const missing = chain(3);
  missing.operations.splice(0, 1);
  assert.throws(() => assertPreviewRevisionChain(missing), /names guarded mutation .* but no such operation exists/);

  const forged = chain(3);
  forged.revisions[1].source_operation_id = 'mutation-intake-' + 'f'.repeat(24);
  assert.throws(() => assertPreviewRevisionChain(forged), /no such operation exists/);

  const cases = [
    ['not applied', (fx) => { fx.operations[0].effect_state = 'ambiguous'; }],
    ['wrong resulting generation', (fx) => { fx.operations[0].resulting_runtime_generation = 3; }],
    ['wrong resulting digest', (fx) => { fx.operations[0].resulting_runtime_revision_digest = D('f'); }],
    ['wrong expected generation', (fx) => { fx.operations[0].expected_runtime_generation = 2; }],
    ['wrong expected digest', (fx) => { fx.operations[0].expected_runtime_revision_digest = D('f'); }],
  ];
  for (const [name, mutate] of cases) {
    const fx = chain(3);
    mutate(fx);
    assert.throws(
      () => assertPreviewRevisionChain(fx),
      /revision 2 is not the exact result of guarded mutation/,
      name,
    );
  }
});

test('an applied but unfinalized guarded mutation fails closed with its state', () => {
  for (const state of ['VERIFYING', 'RETRY_WAIT']) {
    const fx = chain(3);
    fx.operations[1].state = state;
    assert.throws(
      () => assertPreviewRevisionChain(fx),
      new RegExp('applied but not finalized \\(state ' + state + '\\)'),
    );
  }
});

test('every applied guarded mutation must appear as its own revision in the chain', () => {
  const beyond = chain(3);
  beyond.operations.push({
    operation_id: 'mutation-intake-' + 'e'.repeat(24),
    state: 'COMPLETE',
    effect_state: 'applied',
    expected_runtime_generation: 3,
    expected_runtime_revision_digest: D('c'),
    resulting_runtime_generation: 4,
    resulting_runtime_revision_digest: D('d'),
  });
  assert.throws(() => assertPreviewRevisionChain(beyond), /claims applied generation 4 that is not its revision/);

  const displaced = chain(3, ['other-writer', 'mutation']);
  displaced.operations.push({
    operation_id: 'mutation-intake-' + 'e'.repeat(24),
    state: 'COMPLETE',
    effect_state: 'applied',
    expected_runtime_generation: 1,
    expected_runtime_revision_digest: D('a'),
    resulting_runtime_generation: 2,
    resulting_runtime_revision_digest: D('b'),
  });
  assert.throws(() => assertPreviewRevisionChain(displaced), /claims applied generation 2 that is not its revision/);
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
  assert.match(source, /assertPreviewHaltState\(/);
  assert.match(source, /assertPreviewConfig\(previewConfig\)/);
  assert.match(source, /deferred: query\(DEFERRED_ASSIGNMENTS_SQL\)/);
  assert.doesNotMatch(source, /names\.slice\(-7\)/);
  assert.doesNotMatch(source, /not exact generation 1/);
  assert.doesNotMatch(source, /Number\(state\.generation\) !== 1/);
  assert.doesNotMatch(source, /Number\(halt\.generation\) !== 1/);
  assert.doesNotMatch(source, /migrationTail/);
  assert.match(source, /if \(!state\) \{\n    if \(computed\.active_assignment_count !== PREVIEW_BOOTSTRAP_ACTIVE_ASSIGNMENTS\)/);

  const workflow = readFileSync(new URL('../.github/workflows/preview-dynamic-runtime.yml', import.meta.url), 'utf8');
  assert.match(workflow, /- 'src\/preview-runtime-proof-checks\.mjs'/);
  assert.match(workflow, /node --test \\[\s\S]*test\/preview-runtime-proof-checks\.test\.mjs\n/);
});
