// Evidence validation only: use the existing guarded intake completion contract.
// This module never dispatches, retries, or changes a mutation decision.
import { intakeCompletionEvidence } from './mutation-intake-d1.mjs';

const SHA256 = /^[a-f0-9]{64}$/;

export function verifyPreviewIntakeEvidence(evidence) {
  const mutation = evidence?.mutation;
  const planned = evidence?.planned;
  const canonical = evidence?.canonicalReadback;
  const before = evidence?.before;
  const after = evidence?.after;
  if (
    evidence?.ok !== true ||
    evidence.publicationCapable !== false ||
    evidence.schedulerAuthority !== false ||
    evidence.recoveryCheckpointCaptured !== true ||
    !['applied', 'already_applied'].includes(mutation?.status) ||
    !/^mutation-intake-[a-f0-9]{24}$/.test(mutation?.operationId ?? '') ||
    !/^intake-[a-f0-9]{24}$/.test(mutation?.intakeOperationId ?? '') ||
    typeof mutation?.contentId !== 'string' || !mutation.contentId ||
    planned?.operationId !== mutation.operationId ||
    planned?.intakeOperationId !== mutation.intakeOperationId ||
    planned?.contentId !== mutation.contentId ||
    typeof planned?.assignmentId !== 'string' || !planned.assignmentId ||
    planned.assignmentId !== planned.contentId ||
    !SHA256.test(planned?.contentDigest ?? '') ||
    !Number.isSafeInteger(before?.generation) || before.generation < 1 ||
    !Number.isSafeInteger(after?.generation) ||
    after.generation !== before.generation + 1 ||
    !SHA256.test(before?.revisionDigest ?? '') ||
    !SHA256.test(after?.revisionDigest ?? '') ||
    canonical?.contentId !== planned.contentId ||
    canonical?.assignmentId !== planned.assignmentId ||
    canonical?.contentRevision !== 1 ||
    canonical?.assignmentVersion !== 1 ||
    canonical?.contentDigest !== planned.contentDigest ||
    canonical?.intakeState !== 'scheduled' ||
    canonical?.lifecycleState !== 'scheduled'
  ) {
    throw new Error('preview mutation rehearsal evidence is incomplete or contradictory');
  }

  // Reuse the same verifier and digest computation as the runner. The expected
  // single-item versions come from intake's existing revision-1 contract.
  const completion = intakeCompletionEvidence({
    operation_id: mutation.operationId,
    expected_runtime_generation: before.generation,
    items: [{
      item_key: mutation.contentId,
      resulting_content_revision: canonical.contentRevision,
      resulting_assignment_version: canonical.assignmentVersion,
    }],
  }, mutation.observed);
  if (
    completion.observed.runtime_revision_digest !== after.revisionDigest ||
    mutation.evidence_digest !== completion.evidence_digest
  ) {
    throw new Error('preview mutation completion evidence digest/readback mismatch');
  }
  return completion;
}
