// Batch 0 — Fault catalog and observation baselines (pure data).
//
// Future adapters (#145 control plane, ZIP intake, media intake, XQueue Author) must map concrete
// failures onto these abstract observation values instead of inventing their own. The mapping from
// a concrete fault to an abstract value is the place where blast radius is decided, so it is
// centralized here and reviewed, not decided ad hoc per adapter.

const base = (overrides) => Object.freeze({
  opClass: 'publication',
  canonical: 'trusted',
  faultScope: 'none',
  haltFence: 'satisfied',
  authority: 'bound',
  checkpoint: 'none',
  versionFence: 'current',
  concurrency: 'none',
  effect: 'none',
  effectTarget: 'external',
  readback: 'not_performed',
  dispatchPreconditions: 'verified',
  idempotency: 'present',
  retryBudget: 'available',
  input: 'valid',
  classification: 'deterministic',
  claims: 'supported',
  sensitivity: 'none',
  generatedAuthorityClaim: 'none',
  meaningDrift: 'none',
  approval: 'owner_exact_digest',
  ...overrides,
});

// Every baseline is an all-pass observation for its lane (decide() => AUTO_RESOLVE).
export const BASELINES = Object.freeze({
  publication: base({}),
  canonical_mutation: base({ opClass: 'canonical_mutation', effectTarget: 'internal' }),
  staging: base({
    opClass: 'staging', effectTarget: 'internal', versionFence: 'not_applicable', claims: 'none', approval: 'not_required',
  }),
  read_only: base({
    opClass: 'read_only', effectTarget: 'internal', versionFence: 'not_applicable', claims: 'none', approval: 'not_required',
  }),
});

// Post-dispatch baselines: a proven successful effect for each lane that can dispatch.
export const POST_DISPATCH_BASELINES = Object.freeze({
  publication: Object.freeze({ ...BASELINES.publication, effect: 'success', readback: 'not_performed' }),
  canonical_mutation: Object.freeze({ ...BASELINES.canonical_mutation, effect: 'success', readback: 'proves_applied' }),
  staging: Object.freeze({ ...BASELINES.staging, effect: 'success', readback: 'proves_applied' }),
});

// Concrete fault -> abstract observation patch. `scope` documents the blast-radius ruling.
export const FAULT_CATALOG = Object.freeze({
  // input / archive model
  package_malformed: { patch: { input: 'malformed' }, scope: 'item' },
  package_truncated: { patch: { input: 'malformed' }, scope: 'item' },
  path_traversal_entry: { patch: { input: 'hostile' }, scope: 'item' },
  symlink_entry: { patch: { input: 'hostile' }, scope: 'item' },
  decompression_bomb_ratio: { patch: { input: 'hostile' }, scope: 'item' },
  unsupported_binary: { patch: { input: 'unsupported' }, scope: 'item' },
  nested_package: { patch: { input: 'unsupported' }, scope: 'item', note: 'nested archives are never expanded recursively' },
  duplicate_member_same_digest: { patch: { input: 'duplicate' }, scope: 'item' },
  exact_duplicate_package: { patch: { input: 'duplicate' }, scope: 'item' },
  same_artifact_different_filename: { patch: { input: 'duplicate' }, scope: 'item', note: 'identity is content digest, not filename' },
  same_identity_different_digest: { patch: { input: 'conflicting' }, scope: 'item' },
  required_metadata_missing: { patch: { input: 'malformed' }, scope: 'item' },
  optional_metadata_missing: { patch: {}, scope: 'none', note: 'defaults apply; recorded, not a fault' },
  conflicting_metadata: { patch: { input: 'conflicting' }, scope: 'item' },
  input_vanished_before_capture: { patch: { input: 'vanished' }, scope: 'item' },
  input_vanished_after_capture: { patch: {}, scope: 'none', note: 'staged copy + digest already durable' },
  embedded_prompt_injection: { patch: { input: 'hostile' }, scope: 'item' },
  source_policy_override: { patch: { generatedAuthorityClaim: 'attempted' }, scope: 'item' },

  // canonical state
  stale_runtime_generation: { patch: { versionFence: 'stale_runtime' }, scope: 'item' },
  runtime_digest_mismatch: { patch: { canonical: 'corrupt', faultScope: 'system' }, scope: 'system' },
  stale_assignment_version: { patch: { versionFence: 'stale_assignment' }, scope: 'item' },
  duplicate_assignment_slot: { patch: { versionFence: 'assignment_multiplicity' }, scope: 'system' },
  missing_referenced_record: { patch: { versionFence: 'assignment_missing' }, scope: 'item' },
  missing_media_for_one_item: { patch: { canonical: 'corrupt', faultScope: 'item' }, scope: 'item' },
  conflicting_canonical_record: { patch: { canonical: 'corrupt', faultScope: 'unknown' }, scope: 'unknown' },
  schema_version_mismatch: { patch: { canonical: 'corrupt', faultScope: 'system' }, scope: 'system' },
  unexpected_migration_level: { patch: { canonical: 'corrupt', faultScope: 'system' }, scope: 'system' },
  state_read_failure: { patch: { canonical: 'unreadable' }, scope: 'unknown' },
  inconsistent_read_results: { patch: { canonical: 'corrupt', faultScope: 'unknown' }, scope: 'unknown' },

  // concurrency / fences
  lease_contended: { patch: { concurrency: 'contended' }, scope: 'item' },
  lease_lost: { patch: { concurrency: 'lease_lost' }, scope: 'item' },
  completed_elsewhere: { patch: { concurrency: 'completed_elsewhere' }, scope: 'item' },
  halt_generation_changed: { patch: { haltFence: 'generation_changed' }, scope: 'lane' },
  halt_set: { patch: { haltFence: 'blocking' }, scope: 'lane' },
  halt_unreadable: { patch: { haltFence: 'unreadable' }, scope: 'lane' },
  authority_changed: { patch: { authority: 'changed' }, scope: 'lane' },
  authority_unknown: { patch: { authority: 'unknown' }, scope: 'system' },
  worker_version_not_authority: { patch: { authority: 'not_bound' }, scope: 'component' },

  // checkpoint / recovery
  checkpoint_stale: { patch: { checkpoint: 'stale' }, scope: 'item' },
  checkpoint_corrupt: { patch: { checkpoint: 'corrupt' }, scope: 'lane' },

  // generation / classification
  classifier_low_confidence: { patch: { classification: 'uncertain' }, scope: 'item' },
  classifier_conflict: { patch: { classification: 'uncertain' }, scope: 'item' },
  classifier_unstable_on_retry: { patch: { classification: 'uncertain' }, scope: 'item' },
  fabricated_claim: { patch: { claims: 'contradicted' }, scope: 'item' },
  unsupported_experiential_claim: { patch: { claims: 'unsupported_experiential' }, scope: 'item' },
  unsupported_factual_claim: { patch: { claims: 'unsupported_factual' }, scope: 'item' },
  stale_current_fact: { patch: { claims: 'stale_current_fact' }, scope: 'item' },
  sensitive_material: { patch: { sensitivity: 'sensitive' }, scope: 'item' },
  restricted_material: { patch: { sensitivity: 'restricted' }, scope: 'item' },
  meaning_drift: { patch: { meaningDrift: 'detected' }, scope: 'item' },
  self_approval_text: { patch: { generatedAuthorityClaim: 'attempted' }, scope: 'item' },
  authority_change_text: { patch: { generatedAuthorityClaim: 'attempted' }, scope: 'item' },
  approval_forged: { patch: { approval: 'synthesized' }, scope: 'system' },
  approval_missing: { patch: { approval: 'missing' }, scope: 'item' },
  approval_digest_mismatch: { patch: { approval: 'digest_mismatch' }, scope: 'item' },
});

export function observe(lane, ...patches) {
  const start = BASELINES[lane];
  if (!start) throw new Error(`unknown lane ${lane}`);
  return Object.freeze(Object.assign({}, start, ...patches));
}

export function observePost(lane, ...patches) {
  const start = POST_DISPATCH_BASELINES[lane];
  if (!start) throw new Error(`no post-dispatch baseline for lane ${lane}`);
  return Object.freeze(Object.assign({}, start, ...patches));
}

export function fault(name) {
  const entry = FAULT_CATALOG[name];
  if (!entry) throw new Error(`unknown fault ${name}`);
  return entry.patch;
}
