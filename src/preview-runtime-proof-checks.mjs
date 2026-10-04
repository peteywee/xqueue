// Pure checks for the preview dynamic runtime proof.
//
// The proof was written against a freshly bootstrapped preview: migrations
// ending at 0012, runtime generation exactly 1, 180 active assignments and the
// initial global halt state. Guarded mutation rehearsals and the preview owner
// tools legitimately advance preview after bootstrap, so those snapshot facts
// are pinned to where they are still true: the applied migrations must equal the
// repository preview lane, the 180-assignment static parity applies to the
// bootstrap revision, every later revision must chain to its predecessor and
// carry a source, guarded mutation evidence must agree with the chain in both
// directions, and the halt check binds to the migration initialization event.

import { MUTATION_KINDS } from './mutation-control-plane.mjs';

export const PREVIEW_DYNAMIC_RUNTIME_MIGRATIONS = Object.freeze([
  '0006_continuous_queue_shadow.sql',
  '0007_continuous_queue_intake.sql',
  '0008_dynamic_runtime_integrity.sql',
  '0009_deferred_lifecycle.sql',
  '0010_publication_fence_identity.sql',
  '0011_global_publication_halt.sql',
  '0012_reconciliation_determinations.sql',
]);

export const PREVIEW_BOOTSTRAP_ACTIVE_ASSIGNMENTS = 180;

// Guarded mutation operation ids are `mutation-<kind>-<24 hex>`
// (src/mutation-control-plane.mjs). The other preview revision writers stamp
// their own fixed formats; any other source fails the proof.
const GUARDED_SOURCE_RE = new RegExp(
  '^mutation-(?:' + MUTATION_KINDS.join('|') + ')-[0-9a-f]{24}$',
);
const OTHER_WRITER_SOURCE_RES = Object.freeze([
  /^deferred-lifecycle:[0-9a-f]{24}$/, // src/d1-deferred-lifecycle.mjs
  /^owner-[a-z_]+-[0-9a-f]{24}$/, // src/continuous-queue-owner-ops.mjs
  /^reschedule-[a-z_]+-[0-9a-f]{24}$/, // src/continuous-queue-reschedule.mjs
  /^intake-[0-9a-f]{24}$/, // src/continuous-queue-intake.mjs
]);

export const PREVIEW_REVISION_HISTORY_SQL =
  'SELECT generation,revision_digest,previous_revision_digest,active_assignment_count,' +
  'source_operation_id FROM queue_runtime_revisions ORDER BY generation ASC;';

// One read covers operations that revisions name, every operation that claims
// an applied effect, and every operation whose effect is unresolved.
export const PREVIEW_MUTATION_OPERATIONS_SQL =
  'SELECT operation_id,state,effect_state,expected_runtime_generation,' +
  'expected_runtime_revision_digest,resulting_runtime_generation,' +
  'resulting_runtime_revision_digest FROM mutation_operations ' +
  'WHERE effect_state IN (\'applied\',\'dispatched\',\'ambiguous\') ' +
  'OR operation_id IN (SELECT source_operation_id FROM queue_runtime_revisions ' +
  'WHERE source_operation_id IS NOT NULL) ORDER BY operation_id;';

export const PREVIEW_MUTATION_LANE_SQL =
  'SELECT active_operation_id FROM mutation_lane_state WHERE singleton_id=1;';

export const PREVIEW_HALT_EVENTS_SQL =
  'SELECT generation,action,actor_class,reason FROM publication_halt_events ' +
  'ORDER BY generation ASC;';

export function assertPreviewMigrationLane(applied, repository) {
  if (!Array.isArray(applied) || !Array.isArray(repository)) {
    throw new Error('preview migration lane check requires applied and repository lists');
  }
  // Application order follows d1_migrations ids, which need not be lexical when
  // a lower-numbered file is added later, so compare the lane as a set.
  const appliedSorted = [...applied].sort();
  const repositorySorted = [...repository].sort();
  if (JSON.stringify(appliedSorted) !== JSON.stringify(repositorySorted)) {
    throw new Error(
      'preview applied migrations do not exactly match the repository preview lane: applied=' +
      JSON.stringify(applied) + ' repository=' + JSON.stringify(repositorySorted),
    );
  }
  const start = appliedSorted.indexOf(PREVIEW_DYNAMIC_RUNTIME_MIGRATIONS[0]);
  const run = start < 0 ? [] : appliedSorted.slice(start, start + PREVIEW_DYNAMIC_RUNTIME_MIGRATIONS.length);
  if (JSON.stringify(run) !== JSON.stringify(PREVIEW_DYNAMIC_RUNTIME_MIGRATIONS)) {
    throw new Error(
      'preview dynamic runtime migrations 0006-0012 are not applied contiguously: ' +
      JSON.stringify(appliedSorted),
    );
  }
  return Object.freeze(appliedSorted);
}

export function assertPreviewHaltState({ state, events }) {
  if (!state || !Array.isArray(events) || events.length === 0) {
    throw new Error('preview global publication halt state or events are missing');
  }
  events.forEach((event, index) => {
    if (Number(event.generation) !== index + 1) {
      throw new Error('preview global publication halt events are not contiguous from generation 1');
    }
  });
  const [initialized] = events;
  if (
    Number(initialized.generation) !== 1 ||
    initialized.action !== 'initialized' ||
    initialized.actor_class !== 'migration' ||
    initialized.reason !== 'initial_unhalted'
  ) {
    throw new Error('preview global publication halt did not initialize fail-safe state exactly');
  }
  const latest = events[events.length - 1];
  if (
    Number(state.generation) !== Number(latest.generation) ||
    state.reason !== latest.reason ||
    state.actor_class !== latest.actor_class
  ) {
    throw new Error('preview global publication halt state does not match its latest event');
  }
  if (Number(state.halted) !== 0 || latest.action === 'set') {
    throw new Error('preview global publication halt is set; clear it before proving the runtime');
  }
  return Object.freeze({
    generation: Number(state.generation),
    events: events.length,
    lastAction: latest.action,
  });
}

// A held lane blocks preview publication leases under 0017, and an unresolved
// effect leaves preview state uncertain, so neither may be proven over.
export function assertPreviewMutationLaneIdle({ lane, operations }) {
  if (!lane) {
    throw new Error('preview mutation lane state is missing');
  }
  if (lane.active_operation_id !== null) {
    throw new Error(
      'preview mutation lane is held by ' + lane.active_operation_id +
      '; finalize or reconcile it before proving the runtime',
    );
  }
  for (const operation of Array.isArray(operations) ? operations : []) {
    if (operation.effect_state === 'dispatched' || operation.effect_state === 'ambiguous') {
      throw new Error(
        'preview guarded mutation ' + operation.operation_id + ' has an unresolved ' +
        operation.effect_state + ' effect; reconcile it before proving the runtime',
      );
    }
  }
}

function mutationOperationMatches(operation, revision, predecessor) {
  return (
    Number(operation.resulting_runtime_generation) === Number(revision.generation) &&
    operation.resulting_runtime_revision_digest === revision.revision_digest &&
    Number(operation.expected_runtime_generation) === Number(predecessor.generation) &&
    operation.expected_runtime_revision_digest === predecessor.revision_digest
  );
}

export function assertPreviewRevisionChain({ revisions, operations, state }) {
  if (!Array.isArray(revisions) || revisions.length === 0) {
    throw new Error('preview runtime revision history is empty');
  }
  const operationsById = new Map(
    (Array.isArray(operations) ? operations : []).map((operation) => [operation.operation_id, operation]),
  );
  let mutationRevisions = 0;

  revisions.forEach((revision, index) => {
    const generation = Number(revision.generation);
    if (generation !== index + 1) {
      throw new Error(
        'preview runtime revision generations are not contiguous from 1: ' +
        JSON.stringify(revisions.map((row) => Number(row.generation))),
      );
    }

    if (index === 0) {
      if (revision.previous_revision_digest !== null || revision.source_operation_id !== null) {
        throw new Error('preview bootstrap revision must have no predecessor and no source operation');
      }
      if (Number(revision.active_assignment_count) !== PREVIEW_BOOTSTRAP_ACTIVE_ASSIGNMENTS) {
        throw new Error(
          'preview bootstrap revision expected ' + PREVIEW_BOOTSTRAP_ACTIVE_ASSIGNMENTS +
          ' active assignments, got ' + revision.active_assignment_count,
        );
      }
      return;
    }

    const predecessor = revisions[index - 1];
    if (revision.previous_revision_digest !== predecessor.revision_digest) {
      throw new Error('preview runtime revision ' + generation + ' does not chain to its predecessor');
    }
    const source = revision.source_operation_id;
    if (typeof source !== 'string' || source.length === 0) {
      throw new Error('preview runtime revision ' + generation + ' has no source operation');
    }
    if (!operationsById.has(source) && !GUARDED_SOURCE_RE.test(source)) {
      if (!OTHER_WRITER_SOURCE_RES.some((pattern) => pattern.test(source))) {
        throw new Error(
          'preview runtime revision ' + generation + ' source ' + JSON.stringify(source) +
          ' is not a recognized preview revision writer',
        );
      }
      return;
    }

    mutationRevisions += 1;
    const operation = operationsById.get(source);
    if (!operation) {
      throw new Error(
        'preview runtime revision ' + generation + ' names guarded mutation ' + source +
        ' but no such operation exists',
      );
    }
    if (operation.effect_state !== 'applied' || !mutationOperationMatches(operation, revision, predecessor)) {
      throw new Error(
        'preview runtime revision ' + generation + ' is not the exact result of guarded mutation ' + source,
      );
    }
    if (operation.state !== 'COMPLETE') {
      throw new Error(
        'preview guarded mutation ' + source + ' is applied but not finalized (state ' +
        operation.state + '); reconcile it before proving the runtime',
      );
    }
  });

  for (const operation of operationsById.values()) {
    if (operation.effect_state !== 'applied') continue;
    const generation = Number(operation.resulting_runtime_generation);
    const revision = revisions[generation - 1];
    if (!revision || revision.source_operation_id !== operation.operation_id) {
      throw new Error(
        'preview guarded mutation ' + operation.operation_id + ' claims applied generation ' +
        operation.resulting_runtime_generation + ' that is not its revision in the chain',
      );
    }
  }

  // RUNTIME_STATE_SQL reads the head of the same table, so this guards against
  // a write landing between the proof's separate reads.
  const head = revisions[revisions.length - 1];
  if (
    !state ||
    Number(state.generation) !== Number(head.generation) ||
    state.revision_digest !== head.revision_digest
  ) {
    throw new Error('preview runtime state is not the head of its revision history');
  }

  return Object.freeze({
    generation: Number(head.generation),
    headRevisionDigest: head.revision_digest,
    bootstrapRevisionDigest: revisions[0].revision_digest,
    mutationRevisions,
    otherRevisions: revisions.length - 1 - mutationRevisions,
  });
}
