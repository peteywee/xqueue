CREATE TABLE publication_fences (
    attempt_id TEXT PRIMARY KEY
      CHECK (length(attempt_id) >= 8),

    post_id TEXT NOT NULL,

    state_generation INTEGER NOT NULL
      CHECK (state_generation >= 1),

    lease_name TEXT NOT NULL
      CHECK (lease_name = 'publisher'),
    lease_generation INTEGER NOT NULL
      CHECK (lease_generation >= 1),
    lease_owner_token TEXT NOT NULL
      CHECK (length(lease_owner_token) >= 8),
    lease_acquisition_id TEXT NOT NULL
      CHECK (length(lease_acquisition_id) >= 8),
    lease_acquired_at_ms INTEGER NOT NULL
      CHECK (lease_acquired_at_ms >= 0),
    lease_expires_at_ms INTEGER NOT NULL
      CHECK (lease_expires_at_ms > lease_acquired_at_ms),

    assignment_id TEXT NOT NULL,
    assignment_version INTEGER NOT NULL
      CHECK (assignment_version >= 1),
    policy_version INTEGER NOT NULL
      CHECK (policy_version >= 1),
    content_digest TEXT NOT NULL
      CHECK (length(content_digest) = 64),

    recorded_at TEXT NOT NULL,

    FOREIGN KEY (post_id)
      REFERENCES publication_state(post_id),

    FOREIGN KEY (assignment_id, assignment_version)
      REFERENCES queue_assignments(assignment_id, assignment_version)
);

CREATE UNIQUE INDEX publication_fences_lease_acquisition_uq
ON publication_fences(lease_acquisition_id, attempt_id);

CREATE INDEX publication_fences_post_idx
ON publication_fences(post_id, state_generation);

CREATE INDEX publication_fences_assignment_idx
ON publication_fences(assignment_id, assignment_version);

CREATE TRIGGER publication_fences_immutable_update
BEFORE UPDATE ON publication_fences
BEGIN
  SELECT RAISE(ABORT, 'publication_fences are immutable');
END;

CREATE TRIGGER publication_fences_immutable_delete
BEFORE DELETE ON publication_fences
BEGIN
  SELECT RAISE(ABORT, 'publication_fences are immutable');
END;
