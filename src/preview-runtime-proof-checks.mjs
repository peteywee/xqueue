// Pure checks for the preview dynamic runtime proof.
//
// The proof was written against a freshly bootstrapped preview: migrations
// ending at 0012, runtime generation exactly 1, and 180 active assignments.
// Guarded mutation rehearsals legitimately advance preview after bootstrap, so
// those snapshot facts are pinned to where they are still true: the applied
// migrations must equal the repository preview lane, the 180-assignment static
// parity applies to the bootstrap revision, and every later revision must be
// the exact result of a completed guarded mutation.

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

export const PREVIEW_REVISION_HISTORY_SQL =
  'SELECT generation,revision_digest,previous_revision_digest,active_assignment_count,' +
  'source_operation_id FROM queue_runtime_revisions ORDER BY generation ASC;';

export const PREVIEW_REVISION_SOURCE_OPERATIONS_SQL =
  'SELECT operation_id,state,effect_state,resulting_runtime_generation,' +
  'resulting_runtime_revision_digest FROM mutation_operations WHERE operation_id IN (' +
  'SELECT source_operation_id FROM queue_runtime_revisions WHERE source_operation_id IS NOT NULL);';

export function assertPreviewMigrationLane(applied, repository) {
  if (!Array.isArray(applied) || !Array.isArray(repository)) {
    throw new Error('preview migration lane check requires applied and repository lists');
  }
  if (JSON.stringify(applied) !== JSON.stringify(repository)) {
    throw new Error(
      'preview applied migrations do not exactly match the repository preview lane: applied=' +
      JSON.stringify(applied) + ' repository=' + JSON.stringify(repository),
    );
  }
  const start = applied.indexOf(PREVIEW_DYNAMIC_RUNTIME_MIGRATIONS[0]);
  const run = start < 0 ? [] : applied.slice(start, start + PREVIEW_DYNAMIC_RUNTIME_MIGRATIONS.length);
  if (JSON.stringify(run) !== JSON.stringify(PREVIEW_DYNAMIC_RUNTIME_MIGRATIONS)) {
    throw new Error(
      'preview dynamic runtime migrations 0006-0012 are not applied contiguously: ' +
      JSON.stringify(applied),
    );
  }
  return Object.freeze([...applied]);
}

export function assertPreviewRevisionChain({ revisions, operations, state }) {
  if (!Array.isArray(revisions) || revisions.length === 0) {
    throw new Error('preview runtime revision history is empty');
  }
  const operationsById = new Map(
    (Array.isArray(operations) ? operations : []).map((operation) => [operation.operation_id, operation]),
  );

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

    if (revision.previous_revision_digest !== revisions[index - 1].revision_digest) {
      throw new Error('preview runtime revision ' + generation + ' does not chain to its predecessor');
    }
    const operation = operationsById.get(revision.source_operation_id);
    if (
      !operation ||
      operation.state !== 'COMPLETE' ||
      operation.effect_state !== 'applied' ||
      Number(operation.resulting_runtime_generation) !== generation ||
      operation.resulting_runtime_revision_digest !== revision.revision_digest
    ) {
      throw new Error(
        'preview runtime revision ' + generation + ' is not the exact result of a completed guarded mutation',
      );
    }
  });

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
    mutationRevisions: revisions.length - 1,
  });
}
