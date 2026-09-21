ALTER TABLE queue_assignments
  ADD COLUMN lifecycle_state TEXT NOT NULL DEFAULT 'scheduled'
    CHECK (lifecycle_state IN ('scheduled', 'deferred'));

DROP INDEX queue_assignments_active_content_uq;
CREATE UNIQUE INDEX queue_assignments_dispatchable_content_uq
ON queue_assignments(content_id)
WHERE status = 'active' AND lifecycle_state = 'scheduled';

DROP INDEX queue_assignments_active_slot_uq;
CREATE UNIQUE INDEX queue_assignments_dispatchable_slot_uq
ON queue_assignments(target_account, resolved_at)
WHERE status = 'active' AND lifecycle_state = 'scheduled';

CREATE INDEX queue_assignments_lifecycle_idx
ON queue_assignments(lifecycle_state, resolved_at);

CREATE TABLE queue_deferrals (
    content_id TEXT PRIMARY KEY,
    content_revision INTEGER NOT NULL
      CHECK (content_revision >= 1),

    assignment_id TEXT NOT NULL,
    assignment_version INTEGER NOT NULL
      CHECK (assignment_version >= 1),
    assignment_generation INTEGER NOT NULL
      CHECK (assignment_generation >= 1),
    policy_version INTEGER NOT NULL
      CHECK (policy_version >= 1),
    content_digest TEXT NOT NULL
      CHECK (length(content_digest) = 64),

    target_account TEXT NOT NULL,
    prior_resolved_at TEXT NOT NULL,
    prior_scheduled_date TEXT NOT NULL,
    prior_scheduled_time TEXT NOT NULL,
    prior_timezone TEXT NOT NULL,
    prior_slot_label TEXT,

    reason TEXT NOT NULL,
    deferred_at TEXT NOT NULL,

    state TEXT NOT NULL DEFAULT 'pending_replacement'
      CHECK (state IN ('pending_replacement', 'replaced', 'cancelled')),
    generation INTEGER NOT NULL DEFAULT 1
      CHECK (generation >= 1),

    replacement_assignment_version INTEGER
      CHECK (
        replacement_assignment_version IS NULL
        OR replacement_assignment_version > assignment_version
      ),

    FOREIGN KEY (assignment_id, assignment_version)
      REFERENCES queue_assignments(assignment_id, assignment_version),
    FOREIGN KEY (content_id, content_revision)
      REFERENCES queue_content_revisions(content_id, revision)
);

CREATE INDEX queue_deferrals_state_idx
ON queue_deferrals(state, prior_resolved_at, content_id);

CREATE TABLE queue_deferral_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,

    content_id TEXT NOT NULL,
    assignment_id TEXT NOT NULL,
    assignment_version INTEGER NOT NULL,
    event_type TEXT NOT NULL,
    event_at TEXT NOT NULL,
    detail TEXT NOT NULL,

    FOREIGN KEY (content_id)
      REFERENCES queue_deferrals(content_id)
);

CREATE INDEX queue_deferral_events_content_idx
ON queue_deferral_events(content_id, id);

CREATE TRIGGER queue_deferral_events_no_update
BEFORE UPDATE ON queue_deferral_events
BEGIN
  SELECT RAISE(ABORT, 'queue_deferral_events is append-only');
END;

CREATE TRIGGER queue_deferral_events_no_delete
BEFORE DELETE ON queue_deferral_events
BEGIN
  SELECT RAISE(ABORT, 'queue_deferral_events is append-only');
END;
