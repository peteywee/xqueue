ALTER TABLE queue_intake_operations
  ADD COLUMN expected_runtime_generation INTEGER
    CHECK (
      expected_runtime_generation IS NULL
      OR expected_runtime_generation >= 1
    );

ALTER TABLE queue_intake_operations
  ADD COLUMN expected_runtime_revision_digest TEXT
    CHECK (
      expected_runtime_revision_digest IS NULL
      OR length(expected_runtime_revision_digest) = 64
    );

ALTER TABLE queue_intake_operations
  ADD COLUMN resulting_runtime_generation INTEGER
    CHECK (
      resulting_runtime_generation IS NULL
      OR resulting_runtime_generation >= 1
    );

ALTER TABLE queue_intake_operations
  ADD COLUMN resulting_runtime_revision_digest TEXT
    CHECK (
      resulting_runtime_revision_digest IS NULL
      OR length(resulting_runtime_revision_digest) = 64
    );

CREATE TABLE queue_runtime_revisions (
    generation INTEGER PRIMARY KEY
      CHECK (generation >= 1),

    revision_digest TEXT NOT NULL UNIQUE
      CHECK (length(revision_digest) = 64),

    active_assignment_count INTEGER NOT NULL
      CHECK (active_assignment_count >= 0),

    approved_unscheduled_count INTEGER NOT NULL
      CHECK (approved_unscheduled_count >= 0),

    media_required_count INTEGER NOT NULL
      CHECK (media_required_count >= 0),

    media_ready_count INTEGER NOT NULL
      CHECK (media_ready_count >= 0),

    previous_revision_digest TEXT
      CHECK (
        previous_revision_digest IS NULL
        OR length(previous_revision_digest) = 64
      ),

    source_operation_id TEXT,
    created_at TEXT NOT NULL,

    CHECK (
      (generation = 1 AND previous_revision_digest IS NULL)
      OR
      (generation > 1 AND previous_revision_digest IS NOT NULL)
    )
);

CREATE UNIQUE INDEX queue_runtime_revisions_source_operation_uq
ON queue_runtime_revisions(source_operation_id)
WHERE source_operation_id IS NOT NULL;

-- Current runtime truth is the latest immutable row in queue_runtime_revisions.
-- No trigger/projection table is used: revision promotion is a single INSERT ... SELECT CAS.
CREATE TABLE queue_media_objects (
    content_id TEXT NOT NULL,
    content_revision INTEGER NOT NULL
      CHECK (content_revision >= 1),

    media_ordinal INTEGER NOT NULL DEFAULT 0
      CHECK (media_ordinal >= 0),

    figure INTEGER
      CHECK (figure IS NULL OR figure >= 1),

    logical_media_id TEXT NOT NULL,

    r2_key TEXT NOT NULL UNIQUE,

    extension TEXT NOT NULL
      CHECK (extension IN ('png', 'jpg', 'jpeg', 'gif', 'webp')),

    mime_type TEXT NOT NULL
      CHECK (mime_type IN (
        'image/png',
        'image/jpeg',
        'image/gif',
        'image/webp'
      )),

    byte_size INTEGER NOT NULL
      CHECK (byte_size > 0),

    sha256 TEXT NOT NULL
      CHECK (length(sha256) = 64),

    status TEXT NOT NULL
      CHECK (status IN ('pending', 'ready', 'retired')),

    generation INTEGER NOT NULL DEFAULT 1
      CHECK (generation >= 1),

    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,

    PRIMARY KEY (content_id, content_revision, media_ordinal),

    FOREIGN KEY (content_id, content_revision)
      REFERENCES queue_content_revisions(content_id, revision)
);

CREATE INDEX queue_media_objects_content_idx
ON queue_media_objects(content_id, content_revision, status);

CREATE TABLE queue_media_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,

    content_id TEXT NOT NULL,
    content_revision INTEGER NOT NULL,
    media_ordinal INTEGER NOT NULL,

    event_type TEXT NOT NULL,
    event_at TEXT NOT NULL,
    detail TEXT,

    FOREIGN KEY (content_id, content_revision, media_ordinal)
      REFERENCES queue_media_objects(content_id, content_revision, media_ordinal)
);

CREATE INDEX queue_media_events_content_idx
ON queue_media_events(content_id, content_revision, media_ordinal, id);
