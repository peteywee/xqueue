import {
  decideIntakeMutationPreflight,
  intakeMutationCheckpointEvidence,
  verifyIntakeMutationCompletion,
} from './mutation-intake-adapter.mjs';
import {
  intakeCompletionEvidence,
  prepareIntakeAtomicApply,
  prepareIntakeAtomicFinalize,
  readIntakeMutationCompletion,
} from './mutation-intake-d1.mjs';
import {
  classifyD1TransportException,
} from './mutation-control-transport.mjs';
import {
  decideMutationError,
} from './mutation-control-plane.mjs';

function requiredTransport(transport) {
  if (!transport || typeof transport !== 'object') {
    throw new Error('mutation transport is required');
  }
  for (const name of [
    'prepare',
    'captureCheckpoint',
    'readHaltState',
    'readLaneState',
    'readRuntimeState',
    'readOperation',
    'batch',
  ]) {
    if (typeof transport[name] !== 'function') {
      throw new Error('mutation transport missing ' + name);
    }
  }
  return transport;
}

function decisionResult(status, phase, decision, extra = {}) {
  return Object.freeze({
    status,
    phase,
    decision,
    ...extra,
  });
}

function readbackKind(error) {
  return error?.readback === 'contradictory' ? 'contradictory' : 'unavailable';
}

function postDispatchReadbackBlocked(phase, recovered, readback = 'unavailable') {
  const errorClass = 'D1_READ_UNAVAILABLE';
  const decision = decideMutationError(errorClass, {
    postDispatch: true,
    readback,
  });
  return decisionResult('blocked', phase, decision, {
    error_class: errorClass,
    readback,
    recovered,
  });
}

async function exactCompletion({ transport, controlPlan, intakePlan }) {
  let observed;
  try {
    observed = await readIntakeMutationCompletion({
      db: transport,
      controlPlan,
      intakePlan,
    });
  } catch (cause) {
    const error = new Error(
      'mutation completion readback unavailable: ' +
        (cause instanceof Error ? cause.message : String(cause)),
    );
    error.readback = 'unavailable';
    throw error;
  }

  const verification = verifyIntakeMutationCompletion(controlPlan, observed);
  if (!verification.ok) {
    const error = new Error(
      'mutation completion readback contradicted canonical state: ' +
        verification.reason,
    );
    error.readback = 'contradictory';
    throw error;
  }
  return intakeCompletionEvidence(controlPlan, observed);
}

async function recoverOrFail({
  transport,
  intakePlan,
  controlPlan,
  runtimeRevision,
  recordedAt,
  errorClass,
  phase,
}) {
  let operation = null;
  try {
    operation = await transport.readOperation(controlPlan.operation_id);
  } catch {
    const decision = decideMutationError(errorClass, {
      postDispatch: true,
      readback: 'unavailable',
    });
    return decisionResult('blocked', phase, decision, {
      error_class: errorClass,
      recovered: false,
    });
  }

  if (
    operation?.state === 'VERIFYING' &&
    operation?.effect_state === 'applied'
  ) {
    return finalizeApplied({
      transport,
      intakePlan,
      controlPlan,
      runtimeRevision,
      recordedAt,
      recovered: true,
    });
  }

  if (
    operation?.state === 'COMPLETE' &&
    operation?.effect_state === 'applied'
  ) {
    let completion;
    try {
      completion = await exactCompletion({
        transport,
        controlPlan,
        intakePlan,
      });
    } catch (error) {
      return postDispatchReadbackBlocked(
        'complete_readback',
        true,
        readbackKind(error),
      );
    }
    return Object.freeze({
      status: 'already_applied',
      phase: 'complete_readback',
      recovered: true,
      operation_id: controlPlan.operation_id,
      evidence_digest: completion.evidence_digest,
      observed: completion.observed,
    });
  }

  const decision = decideMutationError(errorClass, {
    postDispatch: true,
    readback: operation ? 'contradictory' : 'unavailable',
  });
  return decisionResult('blocked', phase, decision, {
    error_class: errorClass,
    recovered: false,
  });
}

async function finalizeApplied({
  transport,
  intakePlan,
  controlPlan,
  runtimeRevision,
  recordedAt,
  recovered,
}) {
  let completion;
  try {
    completion = await exactCompletion({
      transport,
      controlPlan,
      intakePlan,
    });
  } catch (error) {
    return postDispatchReadbackBlocked(
      'completion_readback',
      recovered,
      readbackKind(error),
    );
  }

  const finalize = prepareIntakeAtomicFinalize({
    db: transport,
    controlPlan,
    intakePlan,
    runtimeRevision,
    completionEvidence: completion,
    recordedAt,
  });

  try {
    await transport.batch(finalize.statements);
  } catch (error) {
    const errorClass = classifyD1TransportException(error);
    let operation = null;
    try {
      operation = await transport.readOperation(controlPlan.operation_id);
    } catch {
      // The Batch 0 decision below treats this as unavailable readback.
    }

    if (
      operation?.state === 'COMPLETE' &&
      operation?.effect_state === 'applied'
    ) {
      let completed;
      try {
        completed = await exactCompletion({
          transport,
          controlPlan,
          intakePlan,
        });
      } catch (error) {
        return postDispatchReadbackBlocked(
          'finalize_readback',
          true,
          readbackKind(error),
        );
      }
      return Object.freeze({
        status: 'applied',
        phase: 'finalize_readback',
        recovered: true,
        operation_id: controlPlan.operation_id,
        evidence_digest: completed.evidence_digest,
        observed: completed.observed,
      });
    }

    const decision = decideMutationError(errorClass, {
      postDispatch: true,
      readback: operation ? 'contradictory' : 'unavailable',
    });
    return decisionResult('blocked', 'finalize', decision, {
      error_class: errorClass,
      recovered,
    });
  }

  let completed;
  try {
    completed = await exactCompletion({
      transport,
      controlPlan,
      intakePlan,
    });
  } catch (error) {
    return postDispatchReadbackBlocked(
      'finalize_readback',
      recovered,
      readbackKind(error),
    );
  }

  return Object.freeze({
    status: 'applied',
    phase: 'complete',
    recovered,
    operation_id: controlPlan.operation_id,
    evidence_digest: completed.evidence_digest,
    observed: completed.observed,
  });
}

export async function runIntakeMutation({
  intakePlan,
  controlPlan,
  runtimeRevision,
  transport,
  authority = 'bound',
  publicationSafetyFence = null,
  recordedAt = new Date().toISOString(),
}) {
  const t = requiredTransport(transport);

  let existingOperation;
  try {
    existingOperation = await t.readOperation(controlPlan.operation_id);
  } catch (error) {
    const errorClass = classifyD1TransportException(error);
    const decision = decideMutationError(errorClass, {
      readback: 'unavailable',
    });
    return decisionResult('blocked', 'initial_readback', decision, {
      error_class: errorClass,
    });
  }

  if (
    existingOperation?.state === 'VERIFYING' &&
    existingOperation?.effect_state === 'applied'
  ) {
    return finalizeApplied({
      transport: t,
      intakePlan,
      controlPlan,
      runtimeRevision,
      recordedAt,
      recovered: true,
    });
  }

  if (
    existingOperation?.state === 'COMPLETE' &&
    existingOperation?.effect_state === 'applied'
  ) {
    let completion;
    try {
      completion = await exactCompletion({
        transport: t,
        controlPlan,
        intakePlan,
      });
    } catch (error) {
      return postDispatchReadbackBlocked(
        'complete_readback',
        true,
        readbackKind(error),
      );
    }
    return Object.freeze({
      status: 'already_applied',
      phase: 'complete_readback',
      recovered: true,
      operation_id: controlPlan.operation_id,
      evidence_digest: completion.evidence_digest,
      observed: completion.observed,
    });
  }

  if (existingOperation) {
    const decision = decideMutationError('UNMAPPED', {
      postDispatch: existingOperation.effect_state !== 'none',
      readback: 'contradictory',
    });
    return decisionResult('blocked', 'existing_operation', decision, {
      recovered: false,
    });
  }

  let haltState;
  let laneState;
  let runtimeState;
  try {
    [haltState, laneState, runtimeState] = await Promise.all([
      t.readHaltState(),
      t.readLaneState(),
      t.readRuntimeState(),
    ]);
  } catch (error) {
    const errorClass = classifyD1TransportException(error);
    const decision = decideMutationError(
      errorClass === 'UNMAPPED' ? 'D1_READ_UNAVAILABLE' : errorClass,
      { readback: 'unavailable' },
    );
    return decisionResult('blocked', 'preflight_read', decision, {
      error_class: errorClass,
    });
  }

  const preflight = decideIntakeMutationPreflight(controlPlan, {
    haltState,
    laneState,
    runtimeState,
    authority,
  });

  if (preflight.outcome !== 'AUTO_RESOLVE') {
    return decisionResult('blocked', 'preflight', preflight, {
      recovered: false,
    });
  }

  let bookmark;
  try {
    bookmark = await t.captureCheckpoint();
  } catch (error) {
    const errorClass = classifyD1TransportException(error);
    const decision = decideMutationError(errorClass);
    return decisionResult('blocked', 'checkpoint', decision, {
      error_class: errorClass,
      recovered: false,
    });
  }

  const checkpointEvidence = intakeMutationCheckpointEvidence(
    controlPlan,
    bookmark,
    recordedAt,
  );

  const apply = prepareIntakeAtomicApply({
    db: t,
    controlPlan,
    intakePlan,
    runtimeRevision,
    checkpointEvidence,
    publicationSafetyFence,
    recordedAt,
  });

  try {
    await t.batch(apply.statements);
  } catch (error) {
    const errorClass = classifyD1TransportException(error);
    return recoverOrFail({
      transport: t,
      intakePlan,
      controlPlan,
      runtimeRevision,
      recordedAt,
      errorClass,
      phase: 'apply',
    });
  }

  return finalizeApplied({
    transport: t,
    intakePlan,
    controlPlan,
    runtimeRevision,
    recordedAt,
    recovered: false,
  });
}
