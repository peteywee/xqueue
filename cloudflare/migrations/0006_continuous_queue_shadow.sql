CREATE TABLE queue_content (
    content_id TEXT PRIMARY KEY,
    pillar TEXT NOT NULL
      CHECK (pillar IN ('A', 'B', 'C', 'D')),
    current_revision INTEGER NOT NULL
      CHECK (current_revision >= 1),
    status TEXT NOT NULL
      CHECK (status IN ('active', 'retired')),
    generation INTEGER NOT NULL DEFAULT 1
      CHECK (generation >= 1),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE queue_content_revisions (
    content_id TEXT NOT NULL,
    revision INTEGER NOT NULL
      CHECK (revision >= 1),
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    publication_text TEXT NOT NULL,
    content_digest TEXT NOT NULL
      CHECK (length(content_digest) = 64),
    figure INTEGER
      CHECK (figure IS NULL OR figure >= 1),
    source_ref TEXT,
    created_at TEXT NOT NULL,

    PRIMARY KEY (content_id, revision),

    FOREIGN KEY (content_id)
      REFERENCES queue_content(content_id)
);

CREATE INDEX queue_content_revision_digest_idx
ON queue_content_revisions(content_digest);

CREATE TABLE queue_assignments (
    assignment_id TEXT NOT NULL,
    assignment_version INTEGER NOT NULL
      CHECK (assignment_version >= 1),

    content_id TEXT NOT NULL,
    content_revision INTEGER NOT NULL
      CHECK (content_revision >= 1),
    content_digest TEXT NOT NULL
      CHECK (length(content_digest) = 64),

    target_account TEXT NOT NULL,
    policy_version INTEGER NOT NULL
      CHECK (policy_version >= 1),

    resolved_at TEXT NOT NULL,
    scheduled_date TEXT NOT NULL,
    scheduled_time TEXT NOT NULL,
    timezone TEXT NOT NULL,
    slot_label TEXT,

    status TEXT NOT NULL
      CHECK (status IN ('active', 'superseded', 'cancelled')),

    superseded_by_version INTEGER
      CHECK (
        superseded_by_version IS NULL
        OR superseded_by_version > assignment_version
      ),

    generation INTEGER NOT NULL DEFAULT 1
      CHECK (generation >= 1),

    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,

    PRIMARY KEY (assignment_id, assignment_version),

    FOREIGN KEY (content_id, content_revision)
      REFERENCES queue_content_revisions(content_id, revision)
);

CREATE UNIQUE INDEX queue_assignments_active_content_uq
ON queue_assignments(content_id)
WHERE status = 'active';

CREATE UNIQUE INDEX queue_assignments_active_slot_uq
ON queue_assignments(target_account, resolved_at)
WHERE status = 'active';

CREATE INDEX queue_assignments_resolved_at_idx
ON queue_assignments(resolved_at);

CREATE INDEX queue_assignments_content_idx
ON queue_assignments(content_id, content_revision);

CREATE TABLE queue_content_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    content_id TEXT NOT NULL,
    revision INTEGER,
    event_type TEXT NOT NULL,
    event_at TEXT NOT NULL,
    detail TEXT,

    FOREIGN KEY (content_id)
      REFERENCES queue_content(content_id)
);

CREATE INDEX queue_content_events_content_idx
ON queue_content_events(content_id, id);

CREATE TABLE queue_assignment_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    assignment_id TEXT NOT NULL,
    assignment_version INTEGER NOT NULL,
    event_type TEXT NOT NULL,
    event_at TEXT NOT NULL,
    detail TEXT,

    FOREIGN KEY (assignment_id, assignment_version)
      REFERENCES queue_assignments(assignment_id, assignment_version)
);

CREATE INDEX queue_assignment_events_assignment_idx
ON queue_assignment_events(assignment_id, assignment_version, id);
