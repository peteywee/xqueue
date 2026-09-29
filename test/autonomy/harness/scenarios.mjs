// Batch 0 chaos matrix. Pure data + builders. Expected values are hand-authored from the
// decision contract; they are the oracle the model is tested against, not derived from it.

import { fault, observe, observePost } from '../../../src/autonomy/fault-catalog.mjs';

export const REQUIRED_SCENARIOS = Object.freeze({
  input: ['valid_package', 'malformed_package', 'truncated_package', 'path_traversal', 'symlink', 'decompression_bomb',
    'unsupported_binary', 'duplicate_files', 'exact_duplicate_package', 'same_artifact_different_filename', 'nested_package',
    'partial_metadata', 'conflicting_metadata', 'input_disappears'],
  canonical: ['stale_runtime_generation', 'runtime_digest_mismatch', 'stale_assignment_version', 'duplicate_assignment_slot',
    'missing_referenced_record', 'conflicting_canonical_record', 'schema_version_mismatch', 'unexpected_migration_level',
    'state_read_failure', 'inconsistent_read_results'],
  concurrency: ['same_input_twice', 'two_operators_same_artifact', 'two_runs_same_assignment', 'runtime_gen_changes_after_plan',
    'halt_gen_changes_after_plan', 'authority_changes_after_plan', 'media_vs_metadata_writers', 'concurrent_retry_and_reconciliation'],
  external: ['not_sent', 'sent_success', 'sent_explicit_failure', 'response_disappeared', 'timeout_before_dispatch',
    'timeout_after_dispatch', 'readback_success', 'readback_failure', 'readback_unavailable', 'readback_contradictory'],
  storage: ['d1_fail_before_write', 'd1_success_response_lost', 'r2_upload_fails', 'r2_success_response_lost', 'content_hash_mismatch',
    'media_size_mismatch', 'metadata_without_media', 'media_without_metadata', 'backup_unavailable', 'verification_unavailable'],
  classification: ['deterministic_success', 'low_confidence', 'conflicting_classifications', 'changes_on_retry',
    'multiple_artifact_types', 'malicious_instructions', 'policy_override', 'unsupported_type', 'sensitive_material'],
  ai: ['provider_unavailable', 'timeout', 'malformed_response', 'nondeterministic_conflict', 'fabricated_claim',
    'unsupported_experiential', 'current_fact_no_evidence', 'sensitive_incorporated', 'meaning_modified', 'self_approve',
    'change_authority'],
  recovery: ['crash_before_mutation', 'crash_during_mutation', 'crash_after_mutation_before_ack', 'restart_after_completed_step',
    'resume_twice_concurrently', 'stale_checkpoint', 'corrupted_checkpoint', 'missing_evidence', 'duplicated_evidence'],
  compound: ['dup_package_concurrent_d1_lost_response', 'halt_runtime_change_retry', 'media_ok_metadata_lost_restart',
    'ai_conflict_stale_provenance_owner_unavailable', 'ambiguous_readback_unavailable_worker_retries',
    'malformed_item_with_valid_items', 'canonical_corruption_many_items'],
});

// Bullets that describe a normal (no injected fault) path.
export const HAPPY_REQUIRED = Object.freeze(['valid_package', 'sent_success', 'deterministic_success', 'multiple_artifact_types']);

const PRE = (state) => Object.freeze({ state, dispatched: false });
const POST = Object.freeze({ state: 'VERIFYING', dispatched: true });

const item = (observations, start, expect, extra = {}) => Object.freeze({ observations, start, expect: Object.freeze(expect), ...extra });

const scenarios = [];
const S = (id, family, polarity, covers, title, injected_fault, items, extra = {}) => {
  scenarios.push(Object.freeze({
    id, family, polarity, covers: Object.freeze(covers), title, injected_fault,
    items: Object.freeze(items), policy: extra.policy ?? null, fsmAttempts: Object.freeze(extra.fsmAttempts ?? []),
  }));
};

const Q = (final = 'QUARANTINED') => ({ outcome: 'QUARANTINE', final, unrelated: 'yes', notify: true });
const IGN = { outcome: 'AUTO_IGNORE', final: 'IGNORED', unrelated: 'yes', notify: false };
const HALT = (scope, final = 'HALTED') => ({
  outcome: 'SYSTEM_HALT', final, haltScope: scope, unrelated: scope === 'system' ? 'no' : 'other_lanes_only', notify: true,
});
const RETRY = (target, final = 'RETRY_WAIT') => ({ outcome: 'AUTO_RETRY', final, retryTarget: target, unrelated: 'yes', notify: false });
const DEFER = (final = 'DEFERRED') => ({ outcome: 'AUTO_DEFER', final, unrelated: 'yes', notify: false });
const RESOLVE = (final) => ({ outcome: 'AUTO_RESOLVE', final, unrelated: 'yes', notify: false });
const ATTEST = { outcome: 'OWNER_ATTESTATION_REQUIRED', final: 'WAITING_ATTESTATION', unrelated: 'yes', notify: true };
const APPROVE = { outcome: 'OWNER_APPROVAL_REQUIRED', final: 'WAITING_APPROVAL', unrelated: 'yes', notify: true };

// ---------------------------------------------------------------- input / archive model
S('IN-01', 'input', 'happy', ['valid_package'], 'Valid package passes structural inspection', 'none',
  [item(observe('staging'), PRE('RECEIVED'), RESOLVE('INSPECTED'))]);
S('IN-02', 'input', 'negative', ['malformed_package'], 'Malformed package', 'package_malformed',
  [item(observe('staging', fault('package_malformed')), PRE('RECEIVED'), Q())]);
S('IN-03', 'input', 'negative', ['truncated_package'], 'Truncated package', 'package_truncated',
  [item(observe('staging', fault('package_truncated')), PRE('RECEIVED'), Q())]);
S('IN-04', 'input', 'negative', ['path_traversal'], 'Entry path escapes extraction root', 'path_traversal_entry',
  [item(observe('staging', fault('path_traversal_entry')), PRE('RECEIVED'), Q())]);
S('IN-05', 'input', 'negative', ['symlink'], 'Archive contains symlink entry', 'symlink_entry',
  [item(observe('staging', fault('symlink_entry')), PRE('RECEIVED'), Q())]);
S('IN-06', 'input', 'negative', ['decompression_bomb'], 'Compression ratio/size exceeds bounds', 'decompression_bomb_ratio',
  [item(observe('staging', fault('decompression_bomb_ratio')), PRE('RECEIVED'), Q())]);
S('IN-07', 'input', 'negative', ['unsupported_binary'], 'Unsupported binary member', 'unsupported_binary',
  [item(observe('staging', fault('unsupported_binary')), PRE('INSPECTED'), Q())]);
S('IN-08', 'input', 'negative', ['duplicate_files'], 'Two members with identical digest: second is ignored', 'duplicate_member_same_digest',
  [item(observe('staging', fault('duplicate_member_same_digest')), PRE('INSPECTED'), IGN)]);
S('IN-09', 'input', 'negative', ['exact_duplicate_package'], 'Exact duplicate package already processed', 'exact_duplicate_package',
  [item(observe('staging', fault('exact_duplicate_package')), PRE('RECEIVED'), IGN)]);
S('IN-10', 'input', 'negative', ['same_artifact_different_filename'], 'Same content digest under a different filename',
  'same_artifact_different_filename',
  [item(observe('staging', fault('same_artifact_different_filename')), PRE('INSPECTED'), IGN)]);
S('IN-10b', 'input', 'negative', ['same_artifact_different_filename'], 'Same logical identity, different digest', 'same_identity_different_digest',
  [item(observe('staging', fault('same_identity_different_digest')), PRE('INSPECTED'), Q())]);
S('IN-11', 'input', 'negative', ['nested_package'], 'Nested archive is not expanded', 'nested_package',
  [item(observe('staging', fault('nested_package')), PRE('INSPECTED'), Q())]);
S('IN-12', 'input', 'negative', ['partial_metadata'], 'Required metadata missing', 'required_metadata_missing',
  [item(observe('staging', fault('required_metadata_missing')), PRE('RECEIVED'), Q())]);
S('IN-12b', 'input', 'happy', ['partial_metadata'], 'Only optional metadata missing: defaults apply', 'none',
  [item(observe('staging', fault('optional_metadata_missing')), PRE('RECEIVED'), RESOLVE('INSPECTED'))]);
S('IN-13', 'input', 'negative', ['conflicting_metadata'], 'Conflicting metadata for one identity', 'conflicting_metadata',
  [item(observe('staging', fault('conflicting_metadata')), PRE('INSPECTED'), Q())]);
S('IN-14', 'input', 'negative', ['input_disappears'], 'Input disappears before durable capture', 'input_vanished_before_capture',
  [item(observe('staging', fault('input_vanished_before_capture')), PRE('RECEIVED'), Q())]);
S('IN-14b', 'input', 'negative', ['input_disappears'], 'Input disappears after capture: staged copy continues', 'input_vanished_after_capture',
  [item(observe('staging', fault('input_vanished_after_capture')), PRE('INSPECTED'), RESOLVE('CLASSIFIED'))]);
S('IN-15', 'input', 'negative', ['exact_duplicate_package'], 'Duplicate judged from an unreadable view is not trusted',
  'exact_duplicate_package+state_read_failure',
  [item(observe('staging', fault('exact_duplicate_package'), fault('state_read_failure')), PRE('RECEIVED'), RETRY('read'))]);

// ---------------------------------------------------------------- canonical state
S('CS-00', 'canonical', 'happy', [], 'Trusted canonical state and current fences authorize dispatch', 'none',
  [item(observe('publication'), PRE('PLANNED'), RESOLVE('EXECUTING'))]);
S('CS-01', 'canonical', 'negative', ['stale_runtime_generation'], 'Stale runtime generation before dispatch', 'stale_runtime_generation',
  [item(observe('canonical_mutation', fault('stale_runtime_generation')), PRE('PLANNED'), RETRY('plan'))]);
S('CS-01b', 'canonical', 'negative', ['stale_runtime_generation'], 'Stale runtime, retry budget exhausted', 'stale_runtime_generation+budget',
  [item(observe('canonical_mutation', fault('stale_runtime_generation'), { retryBudget: 'exhausted' }), PRE('PLANNED'), DEFER())]);
S('CS-02', 'canonical', 'negative', ['runtime_digest_mismatch'], 'Runtime revision digest mismatch', 'runtime_digest_mismatch',
  [item(observe('publication', fault('runtime_digest_mismatch')), PRE('PLANNED'), HALT('system'))]);
S('CS-03', 'canonical', 'negative', ['stale_assignment_version'], 'Assignment superseded by newer version', 'stale_assignment_version',
  [item(observe('publication', fault('stale_assignment_version')), PRE('PLANNED'), IGN)]);
S('CS-04', 'canonical', 'negative', ['duplicate_assignment_slot'], 'Two active assignments for one slot', 'duplicate_assignment_slot',
  [item(observe('publication', fault('duplicate_assignment_slot')), PRE('PLANNED'), HALT('system'))]);
S('CS-05', 'canonical', 'negative', ['missing_referenced_record'], 'Current assignment missing for this item', 'missing_referenced_record',
  [item(observe('publication', fault('missing_referenced_record')), PRE('PLANNED'), Q())]);
S('CS-05b', 'canonical', 'negative', ['missing_referenced_record', 'metadata_without_media'], 'Referenced media object missing for one item',
  'missing_media_for_one_item',
  [item(observe('publication', fault('missing_media_for_one_item')), PRE('PLANNED'), Q())]);
S('CS-06', 'canonical', 'negative', ['conflicting_canonical_record'], 'Conflicting canonical record, blast radius unknown',
  'conflicting_canonical_record',
  [item(observe('canonical_mutation', fault('conflicting_canonical_record')), PRE('PLANNED'), HALT('system'))]);
S('CS-07', 'canonical', 'negative', ['schema_version_mismatch'], 'Schema version mismatch', 'schema_version_mismatch',
  [item(observe('canonical_mutation', fault('schema_version_mismatch')), PRE('PLANNED'), HALT('system'))]);
S('CS-08', 'canonical', 'negative', ['unexpected_migration_level'], 'Unexpected migration level', 'unexpected_migration_level',
  [item(observe('publication', fault('unexpected_migration_level')), PRE('PLANNED'), HALT('system'))]);
S('CS-09', 'canonical', 'negative', ['state_read_failure'], 'Canonical read fails transiently', 'state_read_failure',
  [item(observe('publication', fault('state_read_failure')), PRE('PLANNED'), RETRY('read'))]);
S('CS-09b', 'canonical', 'negative', ['state_read_failure'], 'Canonical read keeps failing: budget exhausted', 'state_read_failure+budget',
  [item(observe('publication', fault('state_read_failure'), { retryBudget: 'exhausted' }), PRE('PLANNED'), HALT('lane'))]);
S('CS-10', 'canonical', 'negative', ['inconsistent_read_results'], 'Reads disagree with each other', 'inconsistent_read_results',
  [item(observe('publication', fault('inconsistent_read_results')), PRE('PLANNED'), HALT('system'))]);
S('CS-11', 'canonical', 'negative', ['conflicting_canonical_record'], 'Corruption proven item-local quarantines only that item',
  'conflicting_canonical_record(item-proven)',
  [item(observe('publication', { canonical: 'corrupt', faultScope: 'item' }), PRE('PLANNED'), Q())]);
S('CS-12', 'canonical', 'negative', ['inconsistent_read_results'], 'Status reader sees system corruption: stops itself, reports',
  'inconsistent_read_results(read_only)',
  [item(observe('read_only', fault('inconsistent_read_results')), PRE('RECEIVED'), HALT('component'))]);
S('CS-13', 'canonical', 'negative', ['inconsistent_read_results'], 'Fault scope asserted while canonical trusted is itself inconsistent',
  'inconsistent_observation',
  [item(observe('publication', { faultScope: 'item' }), PRE('PLANNED'), HALT('component'))]);

// ---------------------------------------------------------------- concurrency
S('CC-01', 'concurrency', 'negative', ['same_input_twice'], 'Second simultaneous submission contends for the lease', 'lease_contended',
  [item(observe('staging', fault('lease_contended')), PRE('PLANNED'), DEFER())]);
S('CC-01b', 'concurrency', 'negative', ['same_input_twice'], 'Second submission after the first committed', 'completed_elsewhere',
  [item(observe('staging', fault('completed_elsewhere')), PRE('PLANNED'), IGN)]);
S('CC-02', 'concurrency', 'negative', ['two_operators_same_artifact'], 'Operator B blocked by operator A lease', 'lease_contended',
  [item(observe('canonical_mutation', fault('lease_contended')), PRE('PLANNED'), DEFER())]);
S('CC-02b', 'concurrency', 'negative', ['two_operators_same_artifact'], 'Operator B after A committed: runtime advanced, re-plan',
  'stale_runtime_generation',
  [item(observe('canonical_mutation', fault('stale_runtime_generation')), PRE('PLANNED'), RETRY('plan'))]);
S('CC-03', 'concurrency', 'negative', ['two_runs_same_assignment'], 'Lease loser for the same assignment', 'lease_lost',
  [item(observe('publication', fault('lease_lost')), PRE('PLANNED'), RETRY('plan'))]);
S('CC-03b', 'concurrency', 'negative', ['two_runs_same_assignment'], 'Lease loser with budget exhausted defers', 'lease_lost+budget',
  [item(observe('publication', fault('lease_lost'), { retryBudget: 'exhausted' }), PRE('PLANNED'), DEFER())]);
S('CC-04', 'concurrency', 'negative', ['runtime_gen_changes_after_plan'], 'Runtime generation advanced after planning', 'stale_runtime_generation',
  [item(observe('publication', fault('stale_runtime_generation')), PRE('PLANNED'), RETRY('plan'))]);
S('CC-05', 'concurrency', 'negative', ['halt_gen_changes_after_plan'], 'Halt set+cleared after planning (now clear)', 'halt_generation_changed',
  [item(observe('publication', fault('halt_generation_changed')), PRE('PLANNED'), RETRY('plan'))]);
S('CC-05b', 'concurrency', 'negative', ['halt_gen_changes_after_plan'], 'Halt set after planning (now halted)', 'halt_set',
  [item(observe('publication', fault('halt_set')), PRE('PLANNED'), DEFER())]);
S('CC-05c', 'concurrency', 'negative', ['halt_gen_changes_after_plan'], 'Mutation halt window generation moved after planning',
  'halt_generation_changed(mutation)',
  [item(observe('canonical_mutation', fault('halt_generation_changed')), PRE('PLANNED'), RETRY('plan'))]);
S('CC-06', 'concurrency', 'negative', ['authority_changes_after_plan'], 'Authority rebind after planning', 'authority_changed',
  [item(observe('publication', fault('authority_changed')), PRE('PLANNED'), RETRY('plan'))]);
S('CC-06b', 'concurrency', 'negative', ['authority_changes_after_plan'], 'Authority keeps changing: budget exhausted', 'authority_changed+budget',
  [item(observe('publication', fault('authority_changed'), { retryBudget: 'exhausted' }), PRE('PLANNED'), HALT('lane'))]);
S('CC-07', 'concurrency', 'negative', ['media_vs_metadata_writers'], 'Metadata writer waits for media writer lease', 'lease_contended',
  [item(observe('canonical_mutation', fault('lease_contended')), PRE('PLANNED'), DEFER())]);
S('CC-07b', 'concurrency', 'negative', ['media_vs_metadata_writers'], 'Unleased race left media/metadata mismatched for one item',
  'missing_media_for_one_item',
  [item(observe('canonical_mutation', fault('missing_media_for_one_item')), PRE('PLANNED'), Q())]);
S('CC-08', 'concurrency', 'negative', ['concurrent_retry_and_reconciliation'],
  'Ambiguous item halted; a concurrent automated retry is rejected by the FSM', 'ambiguous+retry_attempt',
  [item(observePost('publication', { effect: 'ambiguous', readback: 'unavailable' }), POST, HALT('lane'))],
  { fsmAttempts: [
    { from: { state: 'HALTED', dispatched: true }, event: { type: 'AUTO_RETRY', actor: 'automation', retryTarget: 'operation' }, expectOk: false },
    { from: { state: 'HALTED', dispatched: true }, event: { type: 'RETRY_READY', actor: 'automation' }, expectOk: false },
    { from: { state: 'HALTED', dispatched: true }, event: { type: 'OWNER_CLEARED_HALT', actor: 'owner' }, expectOk: false },
    { from: { state: 'HALTED', dispatched: true }, event: { type: 'OWNER_RECONCILED_APPLIED', actor: 'owner' }, expectOk: true, expectTo: 'COMPLETE' },
  ] });
S('CC-09', 'concurrency', 'negative', ['two_runs_same_assignment'], 'Lease taken over during X request converts success to reconciliation',
  'lease_lost_after_dispatch',
  [item(observePost('publication', fault('lease_lost')), POST, HALT('lane'))]);
S('CC-10', 'concurrency', 'negative', ['same_input_twice'], 'Another run completed the same identity while this one dispatched',
  'completed_elsewhere_after_dispatch',
  [item(observePost('canonical_mutation', fault('completed_elsewhere')), POST, HALT('lane'))]);

// ---------------------------------------------------------------- external side effect
S('EX-01', 'external', 'negative', ['not_sent'], 'Transport reports request definitely not sent', 'known_not_dispatched',
  [item(observePost('publication', { effect: 'failure_transient' }), POST, DEFER())]);
S('EX-02', 'external', 'happy', ['sent_success'], 'Request sent, success with post id returned', 'none',
  [item(observePost('publication'), POST, RESOLVE('COMPLETE'))]);
S('EX-03', 'external', 'negative', ['sent_explicit_failure'], 'Explicit permanent rejection (content refused)', 'explicit_permanent_failure',
  [item(observePost('publication', { effect: 'failure_permanent' }), POST, Q())]);
S('EX-03b', 'external', 'negative', ['sent_explicit_failure'], 'Explicit transient rejection, not processed', 'explicit_transient_failure',
  [item(observePost('publication', { effect: 'failure_transient', readback: 'proves_not_applied' }), POST, DEFER())]);
S('EX-04', 'external', 'negative', ['response_disappeared'], 'Request may have succeeded; response lost', 'response_lost',
  [item(observePost('publication', { effect: 'ambiguous', readback: 'unavailable' }), POST, HALT('lane'))]);
S('EX-05', 'external', 'negative', ['timeout_before_dispatch'], 'Timeout before dispatch is conclusively not sent', 'timeout_before_dispatch',
  [item(observePost('publication', { effect: 'failure_transient' }), POST, DEFER())]);
S('EX-06', 'external', 'negative', ['timeout_after_dispatch'], 'Timeout after dispatch is ambiguous', 'timeout_after_dispatch',
  [item(observePost('publication', { effect: 'ambiguous', readback: 'not_performed' }), POST, HALT('lane'))]);
S('EX-07', 'external', 'negative', ['readback_success'], 'Automation readback proves posted; policy keeps owner reconciliation',
  'ambiguous+readback_applied',
  [item(observePost('publication', { effect: 'ambiguous', readback: 'proves_applied' }), POST, HALT('lane'))]);
S('EX-07b', 'external', 'negative', ['readback_success'], 'Same, under an explicit future policy that trusts external readback',
  'ambiguous+readback_applied+policy',
  [item(observePost('publication', { effect: 'ambiguous', readback: 'proves_applied' }), POST, RESOLVE('COMPLETE'))],
  { policy: { externalReadbackAuthoritative: true } });
S('EX-07c', 'external', 'negative', ['readback_success'], 'Internal ambiguous write proven applied by readback', 'ambiguous_internal+readback_applied',
  [item(observePost('canonical_mutation', { effect: 'ambiguous', readback: 'proves_applied' }), POST, RESOLVE('COMPLETE'))]);
S('EX-08', 'external', 'negative', ['readback_failure'], 'Automation readback proves not posted; policy keeps owner reconciliation',
  'ambiguous+readback_not_applied',
  [item(observePost('publication', { effect: 'ambiguous', readback: 'proves_not_applied' }), POST, HALT('lane'))]);
S('EX-08b', 'external', 'negative', ['readback_failure'], 'Internal ambiguous write proven not applied: re-issue same idempotent op',
  'ambiguous_internal+readback_not_applied',
  [item(observePost('canonical_mutation', { effect: 'ambiguous', readback: 'proves_not_applied' }), POST, RETRY('operation'))]);
S('EX-08c', 'external', 'negative', ['readback_failure'], 'External not-applied under trusting policy defers (never in-flight retry)',
  'ambiguous+readback_not_applied+policy',
  [item(observePost('publication', { effect: 'ambiguous', readback: 'proves_not_applied' }), POST, DEFER())],
  { policy: { externalReadbackAuthoritative: true } });
S('EX-09', 'external', 'negative', ['readback_unavailable'], 'Readback unavailable after ambiguous dispatch', 'ambiguous+readback_unavailable',
  [item(observePost('canonical_mutation', { effect: 'ambiguous', readback: 'unavailable' }), POST, HALT('lane'))]);
S('EX-10', 'external', 'negative', ['readback_contradictory'], 'Readback contradicts itself', 'readback_contradictory',
  [item(observePost('publication', { effect: 'ambiguous', readback: 'contradictory' }), POST, HALT('lane'))]);
S('EX-10b', 'external', 'negative', ['readback_contradictory'], 'Success response contradicted by readback', 'success+readback_not_applied',
  [item(observePost('canonical_mutation', { readback: 'proves_not_applied' }), POST, HALT('lane'))]);
S('EX-11', 'external', 'negative', ['response_disappeared'], 'Ambiguous with retry budget available is still never retried',
  'ambiguous+budget_available',
  [item(observePost('publication', { effect: 'ambiguous', readback: 'unavailable', retryBudget: 'available' }), POST, HALT('lane'))]);

// ---------------------------------------------------------------- storage
S('ST-01', 'storage', 'negative', ['d1_fail_before_write'], 'D1 batch rejected; readback proves not applied', 'd1_explicit_failure',
  [item(observePost('canonical_mutation', { effect: 'failure_transient', readback: 'proves_not_applied' }), POST, RETRY('operation'))]);
S('ST-01b', 'storage', 'negative', ['d1_fail_before_write'], 'D1 keeps failing: budget exhausted halts mutation lane', 'd1_explicit_failure+budget',
  [item(observePost('canonical_mutation', { effect: 'failure_transient', readback: 'proves_not_applied', retryBudget: 'exhausted' }),
    POST, HALT('lane'))]);
S('ST-01c', 'storage', 'negative', ['d1_fail_before_write'], 'CAS rejected because another append advanced the runtime generation',
  'cas_conflict',
  [item(observePost('canonical_mutation', fault('stale_runtime_generation'), { effect: 'failure_transient', readback: 'proves_not_applied' }),
    POST, RETRY('plan'))]);
S('ST-01d', 'storage', 'negative', ['d1_fail_before_write'], 'Persistent CAS contention defers instead of halting the lane', 'cas_conflict+budget',
  [item(observePost('canonical_mutation', fault('stale_runtime_generation'),
    { effect: 'failure_transient', readback: 'proves_not_applied', retryBudget: 'exhausted' }), POST, DEFER())]);
S('ST-02', 'storage', 'negative', ['d1_success_response_lost'], 'D1 applied, response lost, readback proves applied', 'd1_response_lost',
  [item(observePost('canonical_mutation', { effect: 'ambiguous', readback: 'proves_applied' }), POST, RESOLVE('COMPLETE'))]);
S('ST-02b', 'storage', 'negative', ['d1_success_response_lost'], 'D1 response lost and readback unavailable', 'd1_response_lost+readback_unavailable',
  [item(observePost('canonical_mutation', { effect: 'ambiguous', readback: 'unavailable' }), POST, HALT('lane'))]);
S('ST-03', 'storage', 'negative', ['r2_upload_fails'], 'R2 upload explicit failure proven not applied', 'r2_explicit_failure',
  [item(observePost('canonical_mutation', { effect: 'failure_transient', readback: 'proves_not_applied' }), POST, RETRY('operation'))]);
S('ST-04', 'storage', 'negative', ['r2_success_response_lost'], 'R2 upload applied, response lost, HEAD proves digest/size', 'r2_response_lost',
  [item(observePost('canonical_mutation', { effect: 'ambiguous', readback: 'proves_applied' }), POST, RESOLVE('COMPLETE'))]);
S('ST-05', 'storage', 'negative', ['content_hash_mismatch'], 'Uploaded object digest differs from intended', 'readback_digest_mismatch',
  [item(observePost('canonical_mutation', { readback: 'contradictory' }), POST, HALT('lane'))]);
S('ST-05b', 'storage', 'negative', ['content_hash_mismatch'], 'Stored media digest differs from D1 metadata (pre-dispatch)', 'media_digest_mismatch',
  [item(observe('publication', fault('missing_media_for_one_item')), PRE('PLANNED'), Q())]);
S('ST-06', 'storage', 'negative', ['media_size_mismatch'], 'Stored media size differs from D1 metadata', 'media_size_mismatch',
  [item(observe('publication', { canonical: 'corrupt', faultScope: 'item' }), PRE('PLANNED'), Q())]);
S('ST-07', 'storage', 'negative', ['metadata_without_media'], 'D1 row references an absent R2 object', 'metadata_without_media',
  [item(observe('publication', fault('missing_media_for_one_item')), PRE('PLANNED'), Q())]);
S('ST-08', 'storage', 'negative', ['media_without_metadata'], 'Resume finds media step already applied; step ignored, not re-uploaded',
  'orphan_media_prior_run',
  [item(observe('canonical_mutation', { readback: 'proves_applied', checkpoint: 'valid' }), PRE('PLANNED'), IGN)]);
S('ST-09', 'storage', 'negative', ['backup_unavailable'], 'Logical backup read unavailable', 'backup_read_failure',
  [item(observe('read_only', fault('state_read_failure')), PRE('RECEIVED'), RETRY('read'))]);
S('ST-09b', 'storage', 'negative', ['backup_unavailable'], 'Backup still unavailable: backup job stops itself', 'backup_read_failure+budget',
  [item(observe('read_only', fault('state_read_failure'), { retryBudget: 'exhausted' }), PRE('RECEIVED'), HALT('component'))]);
S('ST-10', 'storage', 'negative', ['verification_unavailable'], 'Success response but readback unavailable after inline attempts',
  'verification_unavailable',
  [item(observePost('canonical_mutation', { readback: 'unavailable' }), POST, HALT('lane'))]);

// ---------------------------------------------------------------- classification
S('CL-01', 'classification', 'happy', ['deterministic_success'], 'Deterministic classification succeeds', 'none',
  [item(observe('staging'), PRE('INSPECTED'), RESOLVE('CLASSIFIED'))]);
S('CL-02', 'classification', 'negative', ['low_confidence'], 'Classifier low confidence', 'classifier_low_confidence',
  [item(observe('staging', fault('classifier_low_confidence')), PRE('INSPECTED'), Q())]);
S('CL-03', 'classification', 'negative', ['conflicting_classifications'], 'Classifiers disagree', 'classifier_conflict',
  [item(observe('staging', fault('classifier_conflict')), PRE('INSPECTED'), Q())]);
S('CL-04', 'classification', 'negative', ['changes_on_retry'], 'Classification changes on retry', 'classifier_unstable_on_retry',
  [item(observe('staging', fault('classifier_unstable_on_retry')), PRE('INSPECTED'), Q())]);
S('CL-05', 'classification', 'happy', ['multiple_artifact_types'], 'Package with several artifact types fans out per member', 'none',
  [
    item(observe('staging'), PRE('INSPECTED'), RESOLVE('CLASSIFIED'), { label: 'package' }),
    item(observe('staging'), PRE('INSPECTED'), RESOLVE('CLASSIFIED'), { label: 'member-doc' }),
    item(observe('staging', fault('unsupported_binary')), PRE('INSPECTED'), Q(), { label: 'member-binary' }),
  ]);
S('CL-06', 'classification', 'negative', ['malicious_instructions'], 'Source data contains instructions aimed at the system',
  'embedded_prompt_injection',
  [item(observe('staging', fault('embedded_prompt_injection')), PRE('INSPECTED'), Q())]);
S('CL-07', 'classification', 'negative', ['policy_override'], 'Source metadata claims approval/authority', 'source_policy_override',
  [item(observe('staging', fault('source_policy_override')), PRE('INSPECTED'), Q())]);
S('CL-08', 'classification', 'negative', ['unsupported_type'], 'Unsupported artifact type', 'unsupported_binary',
  [item(observe('staging', fault('unsupported_binary')), PRE('INSPECTED'), Q())]);
S('CL-09', 'classification', 'negative', ['sensitive_material'], 'Sensitive material proposed for promotion', 'sensitive_material',
  [item(observe('canonical_mutation', fault('sensitive_material'), { approval: 'missing' }), PRE('CLASSIFIED'), APPROVE)]);
S('CL-09b', 'classification', 'negative', ['sensitive_material'], 'Restricted material', 'restricted_material',
  [item(observe('staging', fault('restricted_material')), PRE('INSPECTED'), Q())]);
S('CL-09c', 'classification', 'negative', ['sensitive_material'], 'Sensitive material with owner exact-digest approval proceeds',
  'sensitive_material+approved',
  [item(observe('canonical_mutation', fault('sensitive_material')), PRE('CLASSIFIED'), RESOLVE('PLANNED'))]);

// ---------------------------------------------------------------- AI / generation (modeled; no provider)
S('AI-00', 'ai', 'happy', [], 'Generated candidate with supported claims and owner approval promotes', 'none',
  [item(observe('canonical_mutation'), PRE('CLASSIFIED'), RESOLVE('PLANNED'))]);
S('AI-01', 'ai', 'negative', ['provider_unavailable'], 'Provider unavailable: staging write never happened', 'provider_unavailable',
  [item(observePost('staging', { effect: 'failure_transient', readback: 'proves_not_applied' }), POST, RETRY('operation'))]);
S('AI-01b', 'ai', 'negative', ['provider_unavailable'], 'Provider outage persists: staging lane halts, publication unaffected',
  'provider_unavailable+budget',
  [
    item(observePost('staging', { effect: 'failure_transient', readback: 'proves_not_applied', retryBudget: 'exhausted' }), POST,
      HALT('lane'), { label: 'staging-generation' }),
    item(observe('publication'), PRE('PLANNED'), RESOLVE('EXECUTING'), { label: 'already-ingested-publication' }),
  ]);
S('AI-02', 'ai', 'negative', ['timeout'], 'Generation timeout, staging write proven absent', 'provider_timeout',
  [item(observePost('staging', { effect: 'ambiguous', readback: 'proves_not_applied' }), POST, RETRY('operation'))]);
S('AI-02b', 'ai', 'negative', ['timeout'], 'Generation timeout, staging write proven present', 'provider_timeout+applied',
  [item(observePost('staging', { effect: 'ambiguous', readback: 'proves_applied' }), POST, RESOLVE('COMPLETE'))]);
S('AI-03', 'ai', 'negative', ['malformed_response'], 'Malformed structured response', 'malformed_structured_response',
  [item(observe('staging', { input: 'malformed' }), PRE('RECEIVED'), Q())]);
S('AI-04', 'ai', 'negative', ['nondeterministic_conflict'], 'Repeated generations conflict', 'nondeterministic_conflict',
  [item(observe('staging', fault('classifier_conflict')), PRE('INSPECTED'), Q())]);
S('AI-05', 'ai', 'negative', ['fabricated_claim'], 'Claim contradicted by evidence', 'fabricated_claim',
  [item(observe('canonical_mutation', fault('fabricated_claim')), PRE('CLASSIFIED'), Q())]);
S('AI-06', 'ai', 'negative', ['unsupported_experiential'], 'Unsupported experiential claim', 'unsupported_experiential_claim',
  [item(observe('canonical_mutation', fault('unsupported_experiential_claim')), PRE('CLASSIFIED'), ATTEST)]);
S('AI-07', 'ai', 'negative', ['current_fact_no_evidence'], 'Current fact without fresh evidence', 'stale_current_fact',
  [item(observe('canonical_mutation', fault('stale_current_fact')), PRE('CLASSIFIED'), ATTEST)]);
S('AI-07b', 'ai', 'negative', ['current_fact_no_evidence'], 'Unsupported factual claim', 'unsupported_factual_claim',
  [item(observe('canonical_mutation', fault('unsupported_factual_claim')), PRE('PLANNED'), ATTEST)]);
S('AI-08', 'ai', 'negative', ['sensitive_incorporated'], 'Sensitive material appears in generated draft', 'sensitive_material',
  [item(observe('canonical_mutation', fault('sensitive_material'), { approval: 'missing' }), PRE('CLASSIFIED'), APPROVE)]);
S('AI-08b', 'ai', 'negative', ['sensitive_incorporated'], 'Restricted/private material appears in generated draft', 'restricted_material',
  [item(observe('canonical_mutation', fault('restricted_material')), PRE('CLASSIFIED'), Q())]);
S('AI-09', 'ai', 'negative', ['meaning_modified'], 'Generated text drifts from intended meaning', 'meaning_drift',
  [item(observe('canonical_mutation', fault('meaning_drift'), { approval: 'missing' }), PRE('CLASSIFIED'), APPROVE)]);
S('AI-10', 'ai', 'negative', ['self_approve'], 'Generated output contains self-approval text', 'self_approval_text',
  [item(observe('canonical_mutation', fault('self_approval_text')), PRE('CLASSIFIED'), Q())]);
S('AI-10b', 'ai', 'negative', ['self_approve'], 'An approval record exists that the owner never signed', 'approval_forged',
  [item(observe('canonical_mutation', fault('approval_forged')), PRE('PLANNED'), HALT('system'))]);
S('AI-11', 'ai', 'negative', ['change_authority'], 'Generated output instructs an authority change', 'authority_change_text',
  [item(observe('canonical_mutation', fault('authority_change_text')), PRE('CLASSIFIED'), Q())]);
S('AI-12', 'ai', 'negative', ['self_approve'], 'Candidate edited after approval', 'approval_digest_mismatch',
  [item(observe('canonical_mutation', fault('approval_digest_mismatch')), PRE('PLANNED'), APPROVE)]);

// ---------------------------------------------------------------- resume / recovery
S('RR-01', 'recovery', 'negative', ['crash_before_mutation'], 'Crash before mutation: valid checkpoint, nothing dispatched', 'crash_pre_dispatch',
  [item(observe('canonical_mutation', { checkpoint: 'valid', readback: 'proves_not_applied' }), PRE('PLANNED'), RESOLVE('EXECUTING'))]);
S('RR-02', 'recovery', 'negative', ['crash_during_mutation'], 'Crash during mutation; readback proves not applied', 'crash_mid_dispatch',
  [item(observePost('canonical_mutation', { effect: 'ambiguous', readback: 'proves_not_applied', checkpoint: 'valid' }), POST, RETRY('operation'))]);
S('RR-02b', 'recovery', 'negative', ['crash_during_mutation'], 'Crash during mutation; readback unavailable', 'crash_mid_dispatch+readback_unavailable',
  [item(observePost('canonical_mutation', { effect: 'ambiguous', readback: 'unavailable', checkpoint: 'valid' }), POST, HALT('lane'))]);
S('RR-03', 'recovery', 'negative', ['crash_after_mutation_before_ack'], 'Crash after apply, before ack; readback proves applied',
  'crash_post_apply',
  [item(observePost('canonical_mutation', { effect: 'ambiguous', readback: 'proves_applied', checkpoint: 'valid' }), POST, RESOLVE('COMPLETE'))]);
S('RR-04', 'recovery', 'negative', ['restart_after_completed_step'], 'Restart after a completed step does not replay it', 'restart_after_success',
  [item(observe('canonical_mutation', { checkpoint: 'valid', readback: 'proves_applied' }), PRE('PLANNED'), IGN)]);
S('RR-05', 'recovery', 'negative', ['resume_twice_concurrently'], 'Second concurrent resumer contends for the lease', 'double_resume',
  [item(observe('canonical_mutation', { checkpoint: 'valid', concurrency: 'contended' }), PRE('PLANNED'), DEFER())]);
S('RR-06', 'recovery', 'negative', ['stale_checkpoint'], 'Stale checkpoint before any dispatch: re-plan', 'checkpoint_stale',
  [item(observe('canonical_mutation', fault('checkpoint_stale')), PRE('PLANNED'), RETRY('plan'))]);
S('RR-06b', 'recovery', 'negative', ['stale_checkpoint'], 'Stale checkpoint that recorded a dispatch', 'checkpoint_stale+dispatch',
  [item(observePost('canonical_mutation', fault('checkpoint_stale'), { effect: 'ambiguous', readback: 'proves_applied' }), POST, HALT('lane'))]);
S('RR-07', 'recovery', 'negative', ['corrupted_checkpoint'], 'Corrupt checkpoint on a mutating lane', 'checkpoint_corrupt',
  [item(observe('canonical_mutation', fault('checkpoint_corrupt')), PRE('PLANNED'), HALT('lane'))]);
S('RR-07b', 'recovery', 'negative', ['corrupted_checkpoint'], 'Corrupt checkpoint on staging restarts from scratch', 'checkpoint_corrupt(staging)',
  [item(observe('staging', fault('checkpoint_corrupt')), PRE('PLANNED'), RETRY('plan'))]);
S('RR-08', 'recovery', 'negative', ['missing_evidence'], 'Step marked done without evidence; readback regenerates proof', 'evidence_missing',
  [item(observePost('canonical_mutation', { effect: 'ambiguous', readback: 'proves_applied' }), POST, RESOLVE('COMPLETE'))]);
S('RR-08b', 'recovery', 'negative', ['missing_evidence'], 'Step marked done without evidence; readback unavailable', 'evidence_missing+readback_unavailable',
  [item(observePost('canonical_mutation', { effect: 'success', readback: 'unavailable' }), POST, HALT('lane'))]);
S('RR-09', 'recovery', 'negative', ['duplicated_evidence'], 'Identical duplicated evidence record for one identity', 'evidence_duplicated',
  [item(observe('canonical_mutation', fault('completed_elsewhere')), PRE('PLANNED'), IGN)]);
S('RR-09b', 'recovery', 'negative', ['duplicated_evidence'], 'Duplicated evidence records disagree', 'evidence_conflicting',
  [item(observePost('canonical_mutation', { effect: 'ambiguous', readback: 'contradictory' }), POST, HALT('lane'))]);

// ---------------------------------------------------------------- compound chaos
S('CP-01', 'compound', 'negative', ['dup_package_concurrent_d1_lost_response'],
  'Same package twice + concurrent D1 mutation + one lost response', 'duplicate+concurrent+response_lost',
  [
    item(observePost('canonical_mutation', { effect: 'ambiguous', readback: 'proves_applied' }), POST, RESOLVE('COMPLETE'), { label: 'submission-A' }),
    item(observe('canonical_mutation', fault('exact_duplicate_package'), fault('completed_elsewhere')), PRE('PLANNED'), IGN, { label: 'submission-B' }),
  ]);
S('CP-01b', 'compound', 'negative', ['dup_package_concurrent_d1_lost_response'],
  'Same, but A cannot read back: A halts the mutation lane; B cannot trust its duplicate view', 'duplicate+concurrent+response_lost+readback_unavailable',
  [
    item(observePost('canonical_mutation', { effect: 'ambiguous', readback: 'unavailable' }), POST, HALT('lane'), { label: 'submission-A' }),
    item(observe('canonical_mutation', fault('exact_duplicate_package'), fault('lease_contended')), PRE('PLANNED'), DEFER(), { label: 'submission-B' }),
  ]);
S('CP-02', 'compound', 'negative', ['halt_runtime_change_retry'], 'Halt generation + runtime generation change + retry available',
  'halt_generation_changed+stale_runtime',
  [item(observe('publication', fault('halt_generation_changed'), fault('stale_runtime_generation')), PRE('PLANNED'), RETRY('plan'))]);
S('CP-02b', 'compound', 'negative', ['halt_runtime_change_retry'], 'Same with retry budget exhausted: halt reason dominates defer',
  'halt_generation_changed+stale_runtime+budget',
  [item(observe('publication', fault('halt_generation_changed'), fault('stale_runtime_generation'), { retryBudget: 'exhausted' }),
    PRE('PLANNED'), HALT('lane'))]);
S('CP-03', 'compound', 'negative', ['media_ok_metadata_lost_restart'], 'Media upload ok + D1 metadata response lost + restart',
  'media_applied+metadata_response_lost+restart',
  [
    item(observe('canonical_mutation', { checkpoint: 'valid', readback: 'proves_applied' }), PRE('PLANNED'), IGN, { label: 'media-step' }),
    item(observePost('canonical_mutation', { effect: 'ambiguous', readback: 'proves_applied', checkpoint: 'valid' }), POST,
      RESOLVE('COMPLETE'), { label: 'metadata-step' }),
  ]);
S('CP-03b', 'compound', 'negative', ['media_ok_metadata_lost_restart'], 'Same but metadata readback unavailable after restart',
  'media_applied+metadata_response_lost+restart+readback_unavailable',
  [item(observePost('canonical_mutation', { effect: 'ambiguous', readback: 'unavailable', checkpoint: 'valid' }), POST, HALT('lane'))]);
S('CP-04', 'compound', 'negative', ['ai_conflict_stale_provenance_owner_unavailable'],
  'Classifier conflict + stale provenance + owner unavailable', 'classifier_conflict+stale_current_fact',
  [item(observe('canonical_mutation', fault('classifier_conflict'), fault('stale_current_fact')), PRE('CLASSIFIED'), Q())],
  { fsmAttempts: [
    { from: { state: 'QUARANTINED', dispatched: false }, event: { type: 'DEFER_ELAPSED', actor: 'automation' }, expectOk: false },
    { from: { state: 'QUARANTINED', dispatched: false }, event: { type: 'AUTO_RESOLVE', actor: 'automation' }, expectOk: false },
    { from: { state: 'QUARANTINED', dispatched: false }, event: { type: 'OWNER_RELEASED', actor: 'generator' }, expectOk: false },
  ] });
S('CP-05', 'compound', 'negative', ['ambiguous_readback_unavailable_worker_retries'],
  'External ambiguous + readback temporarily unavailable + worker retries', 'ambiguous+readback_unavailable+retry',
  [item(observePost('publication', { effect: 'ambiguous', readback: 'unavailable' }), POST, HALT('lane'))],
  { fsmAttempts: [
    { from: { state: 'HALTED', dispatched: true }, event: { type: 'AUTO_RETRY', actor: 'automation', retryTarget: 'operation' }, expectOk: false },
    { from: { state: 'VERIFYING', dispatched: true }, event: { type: 'AUTO_RETRY', actor: 'automation', retryTarget: 'operation' },
      evidenceOmit: ['readback_not_applied'], expectOk: false },
  ] });
S('CP-06', 'compound', 'negative', ['malformed_item_with_valid_items'], 'One malformed artifact among valid artifacts', 'package_malformed(one)',
  [
    item(observe('staging', fault('package_malformed')), PRE('RECEIVED'), Q(), { label: 'bad-member' }),
    item(observe('staging'), PRE('RECEIVED'), RESOLVE('INSPECTED'), { label: 'good-member-1' }),
    item(observe('staging'), PRE('RECEIVED'), RESOLVE('INSPECTED'), { label: 'good-member-2' }),
  ]);
S('CP-07', 'compound', 'negative', ['canonical_corruption_many_items'], 'Canonical corruption with many otherwise valid items',
  'runtime_digest_mismatch(many)',
  [
    item(observe('publication', fault('runtime_digest_mismatch')), PRE('PLANNED'), HALT('system'), { label: 'item-1' }),
    item(observe('canonical_mutation', fault('runtime_digest_mismatch')), PRE('PLANNED'), HALT('system'), { label: 'item-2' }),
    item(observe('staging', fault('runtime_digest_mismatch')), PRE('PLANNED'), HALT('system'), { label: 'item-3' }),
  ]);
// Repo-specific compound faults discovered during baseline investigation.
S('CP-08', 'compound', 'negative', [], 'Owner halt set during X request + explicit success: outcome recorded, halt applies next',
  'halt_set_mid_flight+success',
  [item(observePost('publication', fault('halt_set')), POST, RESOLVE('COMPLETE'))]);
S('CP-09', 'compound', 'negative', [], 'Evidence persistence failure after dispatch', 'state_read_failure_after_dispatch',
  [item(observePost('publication', fault('state_read_failure')), POST, HALT('lane'))]);
S('CP-10', 'compound', 'negative', [], 'Worker version is not the durable authority + eligible post', 'worker_version_not_authority',
  [
    item(observe('publication', fault('worker_version_not_authority')), PRE('PLANNED'), HALT('component'), { label: 'mismatched-runtime' }),
    item(observe('staging'), PRE('RECEIVED'), RESOLVE('INSPECTED'), { label: 'staging-lane' }),
  ]);
S('CP-11', 'compound', 'negative', [], '#145: mutation lane is halted before canonical mutation', 'mutation_lane_halted',
  [item(observe('canonical_mutation', fault('halt_set')), PRE('PLANNED'), DEFER())]);
S('CP-11b', 'compound', 'negative', [], '#145: mutation lane halts after dispatch but proven applied result is still recorded', 'mutation_lane_halted_after_dispatch',
  [item(observePost('canonical_mutation', fault('halt_set')), POST, RESOLVE('COMPLETE'))]);
S('CP-12', 'compound', 'negative', [], 'Missed slot while halted: no catch-up, deferred', 'halt_set+stale_runtime',
  [item(observe('publication', fault('halt_set'), fault('stale_runtime_generation')), PRE('PLANNED'), DEFER())]);
S('CP-13', 'compound', 'negative', [], 'Approval mismatch + meaning drift + sensitive: one owner approval request', 'approval_mismatch+drift+sensitive',
  [item(observe('canonical_mutation', fault('approval_digest_mismatch'), fault('meaning_drift'), fault('sensitive_material')), PRE('PLANNED'), APPROVE)]);
S('CP-14', 'compound', 'negative', [], 'Dispatch happened with a forged approval', 'approval_forged+success',
  [item(observePost('publication', fault('approval_forged')), POST, HALT('system'))]);
S('CP-15', 'compound', 'negative', [], 'Naive-composition trap: approval missing observed after a successful dispatch',
  'approval_missing_after_dispatch',
  [item(observePost('publication', fault('approval_missing')), POST, HALT('lane'))]);
S('CP-16', 'compound', 'negative', [], 'Effect observed but dispatch preconditions were never verified', 'unverified_dispatch',
  [item(observePost('publication', { dispatchPreconditions: 'unverified' }), POST, HALT('lane'))]);
S('CP-17', 'compound', 'negative', [], 'Unknown blast radius + corruption + valid work', 'conflicting_canonical_record+valid',
  [item(observe('staging', fault('conflicting_canonical_record')), PRE('RECEIVED'), HALT('system'))]);
S('CP-18', 'compound', 'negative', [], 'Hostile input that is also a duplicate stays quarantined', 'path_traversal+duplicate',
  [item(observe('staging', { input: 'hostile' }, fault('completed_elsewhere')), PRE('RECEIVED'), Q())]);
S('CP-19', 'compound', 'negative', [], 'Mutation lane given an external capability', 'capability_violation',
  [item(observe('canonical_mutation', { effectTarget: 'external' }), PRE('PLANNED'), HALT('component'))]);
S('CP-20', 'compound', 'negative', [], 'Unsupported experiential claim + missing approval: attestation first', 'experiential+approval_missing',
  [item(observe('canonical_mutation', fault('unsupported_experiential_claim'), fault('approval_missing')), PRE('CLASSIFIED'), ATTEST)]);

// ---------------------------------------------------------------- post-dispatch fence breaches and edge semantics
// Added after mutation run 1 exposed these as untested (see evidence/mutation-results.json).
S('PD-01', 'concurrency', 'negative', ['authority_changes_after_plan'], 'Authority rebind observed after dispatch', 'authority_changed_after_dispatch',
  [item(observePost('publication', fault('authority_changed')), POST, HALT('lane'))]);
S('PD-02', 'concurrency', 'negative', [], 'Runtime no longer bound to authority after dispatch', 'worker_version_not_authority_after_dispatch',
  [item(observePost('publication', fault('worker_version_not_authority')), POST, HALT('component'))]);
S('PD-03', 'canonical', 'negative', ['stale_assignment_version'], 'Assignment superseded while the publication was in flight', 'stale_assignment_after_dispatch',
  [item(observePost('publication', fault('stale_assignment_version')), POST, HALT('lane'))]);
S('PD-04', 'canonical', 'negative', ['runtime_gen_changes_after_plan'], 'Unrelated append advanced runtime during flight; proven outcome still recorded',
  'stale_runtime_after_dispatch',
  [item(observePost('canonical_mutation', fault('stale_runtime_generation')), POST, RESOLVE('COMPLETE'))]);
S('PD-05', 'recovery', 'negative', ['corrupted_checkpoint'], 'Corrupt checkpoint discovered after dispatch (mutating lane)', 'checkpoint_corrupt_after_dispatch',
  [item(observePost('canonical_mutation', fault('checkpoint_corrupt'), { effect: 'ambiguous', readback: 'proves_applied' }), POST, HALT('lane'))]);
S('PD-06', 'recovery', 'negative', ['corrupted_checkpoint'], 'Corrupt checkpoint discovered after a staging write', 'checkpoint_corrupt_after_dispatch(staging)',
  [item(observePost('staging', fault('checkpoint_corrupt')), POST, HALT('lane'))]);
S('PD-07', 'canonical', 'negative', ['inconsistent_read_results'], 'Inconsistent fault scope reported after dispatch', 'inconsistent_observation_after_dispatch',
  [item(observePost('publication', { faultScope: 'system' }), POST, HALT('component'))]);
S('PD-08', 'compound', 'negative', [], 'Halt store unreadable after a proven success: outcome still recorded', 'halt_unreadable_after_dispatch',
  [item(observePost('publication', fault('halt_unreadable')), POST, RESOLVE('COMPLETE'))]);
S('PD-09', 'concurrency', 'negative', ['halt_gen_changes_after_plan'], 'Halt store unreadable before dispatch', 'halt_unreadable',
  [item(observe('publication', fault('halt_unreadable')), PRE('PLANNED'), HALT('lane'))]);
S('PD-10', 'recovery', 'negative', ['missing_evidence'], 'Resume cannot read back whether a prior run applied', 'resume_readback_unavailable',
  [item(observe('canonical_mutation', { checkpoint: 'valid', readback: 'unavailable' }), PRE('PLANNED'), RETRY('read'))]);
S('PD-10b', 'recovery', 'negative', ['missing_evidence'], 'Resume readback still unavailable: budget exhausted', 'resume_readback_unavailable+budget',
  [item(observe('canonical_mutation', { checkpoint: 'valid', readback: 'unavailable', retryBudget: 'exhausted' }), PRE('PLANNED'), HALT('lane'))]);
S('PD-11', 'recovery', 'negative', ['duplicated_evidence'], 'Resume readback contradictory before dispatch', 'resume_readback_contradictory',
  [item(observe('canonical_mutation', { checkpoint: 'valid', readback: 'contradictory' }), PRE('PLANNED'), HALT('lane'))]);
S('PD-12', 'compound', 'negative', [], 'Read-only component observed producing an effect', 'read_only_effect',
  [item(observe('read_only', { effect: 'success', readback: 'proves_applied' }), PRE('RECEIVED'), HALT('component', 'HALTED'))]);
S('PD-13', 'compound', 'negative', [], 'Mutation lane effect observed against an external target', 'capability_violation_after_dispatch',
  [item(observePost('canonical_mutation', { effectTarget: 'external' }), POST, HALT('lane'))]);
S('PD-14', 'compound', 'happy', [], 'Dispatch-precondition field is ignored before any dispatch', 'none',
  [item(observe('publication', { dispatchPreconditions: 'unverified' }), PRE('PLANNED'), RESOLVE('EXECUTING'))]);
S('PD-15', 'storage', 'negative', ['d1_success_response_lost'], 'Effect without idempotency identity after dispatch', 'no_idempotency_after_dispatch',
  [item(observePost('canonical_mutation', { idempotency: 'missing' }), POST, HALT('lane'))]);
S('PD-16', 'compound', 'happy', [], 'Read-only reader ignores verification-only dimensions', 'none',
  [item(observe('read_only', { readback: 'contradictory', dispatchPreconditions: 'unverified' }), PRE('RECEIVED'), RESOLVE('INSPECTED'))]);
S('PD-17', 'storage', 'negative', ['d1_fail_before_write'], 'Explicit internal failure but readback never performed', 'failure_without_readback',
  [item(observePost('canonical_mutation', { effect: 'failure_transient', readback: 'not_performed' }), POST, HALT('lane'))]);
S('PD-18', 'input', 'negative', ['conflicting_metadata'], 'Item identity changed after dispatch', 'input_changed_after_dispatch',
  [item(observePost('staging', { input: 'conflicting' }), POST, HALT('lane'))]);
S('PD-19', 'canonical', 'negative', ['missing_referenced_record'], 'Mutation plan carries no fence evidence', 'fence_evidence_missing',
  [item(observe('publication', { versionFence: 'not_applicable' }), PRE('PLANNED'), Q())]);
S('PD-20', 'compound', 'negative', [], 'Staging lane planning an external effect', 'staging_external_capability',
  [item(observe('staging', { effectTarget: 'external' }), PRE('PLANNED'), HALT('component'))]);

export const SCENARIOS = Object.freeze(scenarios);

export const ALL_EVIDENCE = Object.freeze({
  input_digest: 'sha256:input', classification_record: 'cls-1', plan_digest: 'sha256:plan', idempotency_key: 'op-1',
  fence_snapshot: 'halt=7;auth=3;runtime=42;assignment=2', dispatch_record: 'dispatch-1', outcome_evidence: 'readback-1',
  retry_reason: 'r', retry_target: 't', readback_not_applied: 'rb-0', fresh_fence_read: 'fence-2', deferral_reason: 'd',
  conclusive_not_applied: 'cna-1', ignore_basis: 'dup-op-1', quarantine_record: 'q-1', owner_request_id: 'req-1',
  halt_record: 'halt-8', attestation_signature: 'sig-a', approval_exact_digest: 'sig-b', rejection_record: 'rej-1',
  release_record: 'rel-1', discard_record: 'tomb-1', halt_clear_generation: 'gen-9', reconciliation_record: 'rec-1',
});
