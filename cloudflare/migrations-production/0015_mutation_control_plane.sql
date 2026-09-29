CREATE TABLE mutation_lane_halt_state (
    singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
    halted INTEGER NOT NULL CHECK (halted IN (0, 1)),
    generation INTEGER NOT NULL CHECK (generation >= 1),
    reason TEXT NOT NULL CHECK (length(trim(reason)) >= 1),
    actor_class TEXT NOT NULL CHECK (actor_class IN ('migration', 'automation', 'owner')),
    updated_at TEXT NOT NULL
);

CREATE TABLE mutation_lane_halt_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    generation INTEGER NOT NULL UNIQUE CHECK (generation >= 1),
    action TEXT NOT NULL CHECK (action IN ('initialized', 'set', 'clear')),
    actor_class TEXT NOT NULL CHECK (actor_class IN ('migration', 'automation', 'owner')),
    reason TEXT NOT NULL CHECK (length(trim(reason)) >= 1),
    event_at TEXT NOT NULL
);

INSERT INTO mutation_lane_halt_state (
    singleton_id, halted, generation, reason, actor_class, updated_at
) VALUES (
    1, 0, 1, 'initial_unhalted', 'migration', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
);

INSERT INTO mutation_lane_halt_events (
    generation, action, actor_class, reason, event_at
)
SELECT generation, 'initialized', actor_class, reason, updated_at
FROM mutation_lane_halt_state WHERE singleton_id = 1;

CREATE TRIGGER mutation_lane_halt_generation_guard
BEFORE UPDATE ON mutation_lane_halt_state
WHEN NEW.generation <> OLD.generation + 1 OR NEW.halted = OLD.halted
BEGIN
    SELECT RAISE(ABORT, 'mutation halt transition must flip state and advance generation exactly once');
END;

CREATE TRIGGER mutation_lane_halt_set_guard
BEFORE UPDATE ON mutation_lane_halt_state
WHEN OLD.halted = 0 AND NEW.halted = 1 AND NEW.actor_class NOT IN ('automation', 'owner')
BEGIN
    SELECT RAISE(ABORT, 'mutation halt may only be set by automation or owner');
END;

CREATE TRIGGER mutation_lane_halt_owner_clear_guard
BEFORE UPDATE ON mutation_lane_halt_state
WHEN OLD.halted = 1 AND NEW.halted = 0 AND NEW.actor_class <> 'owner'
BEGIN
    SELECT RAISE(ABORT, 'mutation halt may only be cleared by owner');
END;

CREATE TRIGGER mutation_lane_halt_audit
AFTER UPDATE ON mutation_lane_halt_state
BEGIN
    INSERT INTO mutation_lane_halt_events (
        generation, action, actor_class, reason, event_at
    ) VALUES (
        NEW.generation,
        CASE WHEN NEW.halted = 1 THEN 'set' ELSE 'clear' END,
        NEW.actor_class,
        NEW.reason,
        NEW.updated_at
    );
END;

CREATE TRIGGER mutation_lane_halt_state_no_delete
BEFORE DELETE ON mutation_lane_halt_state
BEGIN
    SELECT RAISE(ABORT, 'mutation halt state cannot be deleted');
END;

CREATE TRIGGER mutation_lane_halt_events_immutable_update
BEFORE UPDATE ON mutation_lane_halt_events
BEGIN
    SELECT RAISE(ABORT, 'mutation halt events are immutable');
END;

CREATE TRIGGER mutation_lane_halt_events_immutable_delete
BEFORE DELETE ON mutation_lane_halt_events
BEGIN
    SELECT RAISE(ABORT, 'mutation halt events are immutable');
END;

CREATE TABLE mutation_lane_state (
    singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
    generation INTEGER NOT NULL CHECK (generation >= 1),
    active_operation_id TEXT CHECK (
      active_operation_id IS NULL OR length(trim(active_operation_id)) >= 8
    ),
    actor_class TEXT NOT NULL CHECK (actor_class IN ('migration', 'automation', 'owner')),
    updated_at TEXT NOT NULL
);

INSERT INTO mutation_lane_state (
    singleton_id, generation, active_operation_id, actor_class, updated_at
) VALUES (
    1, 1, NULL, 'migration', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
);

CREATE TABLE mutation_lane_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    generation INTEGER NOT NULL CHECK (generation >= 1),
    operation_id TEXT NOT NULL CHECK (length(trim(operation_id)) >= 8),
    event_type TEXT NOT NULL CHECK (event_type IN ('claimed', 'released')),
    actor_class TEXT NOT NULL CHECK (actor_class IN ('automation', 'owner')),
    event_at TEXT NOT NULL,
    detail TEXT
);

CREATE UNIQUE INDEX mutation_lane_claim_generation_uq
ON mutation_lane_events(generation)
WHERE event_type = 'claimed';

CREATE INDEX mutation_lane_events_operation_idx
ON mutation_lane_events(operation_id, id);

CREATE TRIGGER mutation_lane_claim_guard
BEFORE UPDATE ON mutation_lane_state
WHEN OLD.active_operation_id IS NULL AND NEW.active_operation_id IS NOT NULL AND (
    NEW.generation <> OLD.generation + 1 OR
    NEW.actor_class NOT IN ('automation', 'owner')
)
BEGIN
    SELECT RAISE(ABORT, 'mutation lane claim must advance generation exactly once');
END;

CREATE TRIGGER mutation_lane_release_guard
BEFORE UPDATE ON mutation_lane_state
WHEN OLD.active_operation_id IS NOT NULL AND NEW.active_operation_id IS NULL AND (
    NEW.generation <> OLD.generation OR
    NEW.actor_class NOT IN ('automation', 'owner')
)
BEGIN
    SELECT RAISE(ABORT, 'mutation lane release must preserve generation');
END;

CREATE TRIGGER mutation_lane_no_swap_guard
BEFORE UPDATE ON mutation_lane_state
WHEN OLD.active_operation_id IS NOT NULL AND NEW.active_operation_id IS NOT NULL
BEGIN
    SELECT RAISE(ABORT, 'mutation lane cannot swap active operations directly');
END;

CREATE TRIGGER mutation_lane_no_noop_guard
BEFORE UPDATE ON mutation_lane_state
WHEN OLD.active_operation_id IS NULL AND NEW.active_operation_id IS NULL
BEGIN
    SELECT RAISE(ABORT, 'mutation lane state no-op update is forbidden');
END;

CREATE TRIGGER mutation_lane_claim_audit
AFTER UPDATE ON mutation_lane_state
WHEN OLD.active_operation_id IS NULL AND NEW.active_operation_id IS NOT NULL
BEGIN
    INSERT INTO mutation_lane_events (
        generation, operation_id, event_type, actor_class, event_at, detail
    ) VALUES (
        NEW.generation, NEW.active_operation_id, 'claimed', NEW.actor_class, NEW.updated_at, NULL
    );
END;

CREATE TRIGGER mutation_lane_release_audit
AFTER UPDATE ON mutation_lane_state
WHEN OLD.active_operation_id IS NOT NULL AND NEW.active_operation_id IS NULL
BEGIN
    INSERT INTO mutation_lane_events (
        generation, operation_id, event_type, actor_class, event_at, detail
    ) VALUES (
        OLD.generation, OLD.active_operation_id, 'released', NEW.actor_class, NEW.updated_at, NULL
    );
END;

CREATE TRIGGER mutation_lane_state_no_delete
BEFORE DELETE ON mutation_lane_state
BEGIN
    SELECT RAISE(ABORT, 'mutation lane state cannot be deleted');
END;

CREATE TRIGGER mutation_lane_events_immutable_update
BEFORE UPDATE ON mutation_lane_events
BEGIN
    SELECT RAISE(ABORT, 'mutation lane events are immutable');
END;

CREATE TRIGGER mutation_lane_events_immutable_delete
BEFORE DELETE ON mutation_lane_events
BEGIN
    SELECT RAISE(ABORT, 'mutation lane events are immutable');
END;

CREATE TABLE mutation_operations (
    operation_id TEXT PRIMARY KEY CHECK (length(trim(operation_id)) >= 8),
    operation_kind TEXT NOT NULL CHECK (
      operation_kind IN ('intake', 'revise', 'rebind', 'cancel', 'reschedule', 'foundation_probe')
    ),
    operation_digest TEXT NOT NULL CHECK (length(operation_digest) = 64),
    plan_digest TEXT NOT NULL CHECK (length(plan_digest) = 64),
    state TEXT NOT NULL CHECK (state IN (
      'RECEIVED', 'INSPECTED', 'CLASSIFIED', 'PLANNED', 'EXECUTING', 'VERIFYING',
      'COMPLETE', 'RETRY_WAIT', 'DEFERRED', 'QUARANTINED', 'WAITING_ATTESTATION',
      'WAITING_APPROVAL', 'HALTED', 'IGNORED', 'DISCARDED'
    )),
    outcome TEXT CHECK (outcome IS NULL OR outcome IN (
      'AUTO_RESOLVE', 'AUTO_RETRY', 'AUTO_DEFER', 'AUTO_IGNORE', 'QUARANTINE',
      'OWNER_ATTESTATION_REQUIRED', 'OWNER_APPROVAL_REQUIRED', 'SYSTEM_HALT'
    )),
    expected_halt_generation INTEGER NOT NULL CHECK (expected_halt_generation >= 1),
    lane_generation INTEGER CHECK (lane_generation IS NULL OR lane_generation >= 1),
    expected_runtime_generation INTEGER NOT NULL CHECK (expected_runtime_generation >= 1),
    expected_runtime_revision_digest TEXT NOT NULL CHECK (length(expected_runtime_revision_digest) = 64),
    checkpoint_bookmark TEXT CHECK (
      checkpoint_bookmark IS NULL OR length(trim(checkpoint_bookmark)) >= 8
    ),
    checkpoint_verified_at TEXT,
    retry_plan_count INTEGER NOT NULL DEFAULT 0 CHECK (retry_plan_count >= 0),
    retry_read_count INTEGER NOT NULL DEFAULT 0 CHECK (retry_read_count >= 0),
    retry_operation_count INTEGER NOT NULL DEFAULT 0 CHECK (retry_operation_count >= 0),
    max_plan_retries INTEGER NOT NULL CHECK (max_plan_retries >= 0),
    max_read_retries INTEGER NOT NULL CHECK (max_read_retries >= 0),
    max_operation_retries INTEGER NOT NULL CHECK (max_operation_retries >= 0),
    effect_state TEXT NOT NULL DEFAULT 'none' CHECK (
      effect_state IN ('none', 'dispatched', 'applied', 'not_applied', 'ambiguous')
    ),
    resulting_runtime_generation INTEGER CHECK (
      resulting_runtime_generation IS NULL OR resulting_runtime_generation >= 1
    ),
    resulting_runtime_revision_digest TEXT CHECK (
      resulting_runtime_revision_digest IS NULL OR length(resulting_runtime_revision_digest) = 64
    ),
    evidence_digest TEXT CHECK (evidence_digest IS NULL OR length(evidence_digest) = 64),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    completed_at TEXT
);

CREATE UNIQUE INDEX mutation_operations_digest_uq
ON mutation_operations(operation_digest);

CREATE INDEX mutation_operations_state_idx
ON mutation_operations(state, updated_at);

CREATE TRIGGER mutation_operations_identity_immutable
BEFORE UPDATE ON mutation_operations
WHEN
    NEW.operation_kind <> OLD.operation_kind OR
    NEW.operation_digest <> OLD.operation_digest OR
    NEW.max_plan_retries <> OLD.max_plan_retries OR
    NEW.max_read_retries <> OLD.max_read_retries OR
    NEW.max_operation_retries <> OLD.max_operation_retries
BEGIN
    SELECT RAISE(ABORT, 'mutation operation identity and retry budgets are immutable');
END;

CREATE TRIGGER mutation_operations_replan_guard
BEFORE UPDATE ON mutation_operations
WHEN
    (
      NEW.plan_digest <> OLD.plan_digest OR
      NEW.expected_halt_generation <> OLD.expected_halt_generation OR
      NEW.expected_runtime_generation <> OLD.expected_runtime_generation OR
      NEW.expected_runtime_revision_digest <> OLD.expected_runtime_revision_digest
    ) AND (
      OLD.effect_state <> 'none' OR
      OLD.state NOT IN ('PLANNED', 'RETRY_WAIT', 'DEFERRED') OR
      NEW.lane_generation IS NOT NULL OR
      NEW.checkpoint_bookmark IS NOT NULL OR
      NEW.checkpoint_verified_at IS NOT NULL
    )
BEGIN
    SELECT RAISE(ABORT, 'mutation re-plan requires pre-dispatch state and cleared lane/checkpoint evidence');
END;

CREATE TRIGGER mutation_operations_retry_guard
BEFORE UPDATE ON mutation_operations
WHEN
    NEW.retry_plan_count < OLD.retry_plan_count OR
    NEW.retry_read_count < OLD.retry_read_count OR
    NEW.retry_operation_count < OLD.retry_operation_count OR
    NEW.retry_plan_count > NEW.max_plan_retries OR
    NEW.retry_read_count > NEW.max_read_retries OR
    NEW.retry_operation_count > NEW.max_operation_retries
BEGIN
    SELECT RAISE(ABORT, 'mutation retry counters must be monotonic and within durable budgets');
END;

CREATE TRIGGER mutation_operations_checkpoint_guard
BEFORE UPDATE ON mutation_operations
WHEN
    (
      NEW.state IN ('EXECUTING', 'VERIFYING', 'COMPLETE') OR
      NEW.effect_state <> 'none'
    ) AND (
      NEW.checkpoint_bookmark IS NULL OR
      NEW.checkpoint_verified_at IS NULL OR
      NEW.lane_generation IS NULL
    )
BEGIN
    SELECT RAISE(ABORT, 'verified recovery checkpoint and lane generation required before mutation execution');
END;

CREATE TRIGGER mutation_operations_complete_guard
BEFORE UPDATE ON mutation_operations
WHEN NEW.state = 'COMPLETE' AND (
    NEW.outcome <> 'AUTO_RESOLVE' OR
    NEW.effect_state <> 'applied' OR
    NEW.resulting_runtime_generation IS NULL OR
    NEW.resulting_runtime_revision_digest IS NULL OR
    NEW.evidence_digest IS NULL OR
    NEW.completed_at IS NULL
)
BEGIN
    SELECT RAISE(ABORT, 'complete mutation requires exact readback and evidence');
END;

CREATE TABLE mutation_operation_items (
    operation_id TEXT NOT NULL,
    item_key TEXT NOT NULL CHECK (length(trim(item_key)) >= 1),
    expected_content_revision INTEGER CHECK (
      expected_content_revision IS NULL OR expected_content_revision >= 1
    ),
    expected_assignment_version INTEGER CHECK (
      expected_assignment_version IS NULL OR expected_assignment_version >= 1
    ),
    resulting_content_revision INTEGER CHECK (
      resulting_content_revision IS NULL OR resulting_content_revision >= 1
    ),
    resulting_assignment_version INTEGER CHECK (
      resulting_assignment_version IS NULL OR resulting_assignment_version >= 1
    ),
    readback_status TEXT NOT NULL DEFAULT 'pending' CHECK (
      readback_status IN ('pending', 'applied', 'not_applied', 'conflict')
    ),
    readback_digest TEXT CHECK (readback_digest IS NULL OR length(readback_digest) = 64),
    PRIMARY KEY (operation_id, item_key),
    FOREIGN KEY (operation_id) REFERENCES mutation_operations(operation_id) ON DELETE RESTRICT
);

CREATE TRIGGER mutation_operation_items_expected_immutable
BEFORE UPDATE ON mutation_operation_items
WHEN
    NEW.item_key <> OLD.item_key OR
    NEW.expected_content_revision IS NOT OLD.expected_content_revision OR
    NEW.expected_assignment_version IS NOT OLD.expected_assignment_version
BEGIN
    SELECT RAISE(ABORT, 'mutation item identity and expected versions are immutable');
END;

CREATE TABLE mutation_operation_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    operation_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    outcome TEXT CHECK (outcome IS NULL OR outcome IN (
      'AUTO_RESOLVE', 'AUTO_RETRY', 'AUTO_DEFER', 'AUTO_IGNORE', 'QUARANTINE',
      'OWNER_ATTESTATION_REQUIRED', 'OWNER_APPROVAL_REQUIRED', 'SYSTEM_HALT'
    )),
    fault_name TEXT,
    evidence_digest TEXT CHECK (evidence_digest IS NULL OR length(evidence_digest) = 64),
    event_at TEXT NOT NULL,
    detail TEXT,
    FOREIGN KEY (operation_id) REFERENCES mutation_operations(operation_id) ON DELETE RESTRICT
);

CREATE INDEX mutation_operation_events_operation_idx
ON mutation_operation_events(operation_id, id);

CREATE TRIGGER mutation_operation_events_immutable_update
BEFORE UPDATE ON mutation_operation_events
BEGIN
    SELECT RAISE(ABORT, 'mutation operation events are immutable');
END;

CREATE TRIGGER mutation_operation_events_immutable_delete
BEFORE DELETE ON mutation_operation_events
BEGIN
    SELECT RAISE(ABORT, 'mutation operation events are immutable');
END;
