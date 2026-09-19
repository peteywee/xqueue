ALTER TABLE queue_content
  ADD COLUMN intake_state TEXT NOT NULL DEFAULT 'scheduled'
    CHECK (intake_state IN ('approved_unscheduled', 'scheduled'));

CREATE TABLE queue_intake_frontier (
    singleton_id INTEGER PRIMARY KEY
      CHECK (singleton_id = 1),
    generation INTEGER NOT NULL
      CHECK (generation >= 1),
    resolved_at TEXT NOT NULL,
    pending_operation_id TEXT,
    last_completed_operation_id TEXT,
    updated_at TEXT NOT NULL
);

INSERT INTO queue_intake_frontier (
    singleton_id,
    generation,
    resolved_at,
    pending_operation_id,
    last_completed_operation_id,
    updated_at
)
SELECT
    1,
    1,
    MAX(resolved_at),
    NULL,
    NULL,
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM queue_assignments
WHERE status = 'active'
HAVING COUNT(*) > 0;

CREATE TABLE queue_intake_operations (
    operation_id TEXT PRIMARY KEY,
    plan_digest TEXT NOT NULL UNIQUE
      CHECK (length(plan_digest) = 64),
    batch_digest TEXT NOT NULL
      CHECK (length(batch_digest) = 64),
    item_count INTEGER NOT NULL
      CHECK (item_count >= 1),
    expected_frontier_generation INTEGER NOT NULL
      CHECK (expected_frontier_generation >= 1),
    expected_frontier_resolved_at TEXT NOT NULL,
    proposed_frontier_resolved_at TEXT NOT NULL,
    baseline_assignment_hash TEXT NOT NULL
      CHECK (length(baseline_assignment_hash) = 64),
    target_account TEXT NOT NULL,
    policy_version INTEGER NOT NULL
      CHECK (policy_version >= 1),
    status TEXT NOT NULL
      CHECK (status IN (
        'planned',
        'claimed',
        'needs_reconciliation',
        'stale',
        'complete'
      )),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE INDEX queue_intake_operations_batch_idx
ON queue_intake_operations(batch_digest, status, created_at);

CREATE TABLE queue_intake_items (
    operation_id TEXT NOT NULL,
    ordinal INTEGER NOT NULL
      CHECK (ordinal >= 0),
    content_id TEXT NOT NULL,
    content_digest TEXT NOT NULL
      CHECK (length(content_digest) = 64),
    pillar TEXT NOT NULL
      CHECK (pillar IN ('A', 'B', 'C', 'D')),
    title TEXT NOT NULL,
    source_ref TEXT,
    resolved_at TEXT NOT NULL,
    scheduled_date TEXT NOT NULL,
    scheduled_time TEXT NOT NULL,
    timezone TEXT NOT NULL,
    slot_label TEXT,

    PRIMARY KEY (operation_id, ordinal),
    UNIQUE (operation_id, content_id),

    FOREIGN KEY (operation_id)
      REFERENCES queue_intake_operations(operation_id)
);

CREATE INDEX queue_intake_items_content_idx
ON queue_intake_items(content_id);

CREATE INDEX queue_intake_items_digest_idx
ON queue_intake_items(content_digest);
