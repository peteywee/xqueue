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

CREATE TABLE queue_runtime_state (
    singleton_id INTEGER PRIMARY KEY
      CHECK (singleton_id = 1),

    generation INTEGER NOT NULL
      CHECK (generation >= 1),

    revision_digest TEXT NOT NULL
      CHECK (length(revision_digest) = 64),

    active_assignment_count INTEGER NOT NULL
      CHECK (active_assignment_count >= 0),

    approved_unscheduled_count INTEGER NOT NULL
      CHECK (approved_unscheduled_count >= 0),

    media_required_count INTEGER NOT NULL
      CHECK (media_required_count >= 0),

    media_ready_count INTEGER NOT NULL
      CHECK (media_ready_count >= 0),

    source_operation_id TEXT,
    updated_at TEXT NOT NULL
);

CREATE TRIGGER queue_runtime_revision_promote
AFTER INSERT ON queue_runtime_revisions
BEGIN
    INSERT INTO queue_runtime_state (
        singleton_id,
        generation,
        revision_digest,
        active_assignment_count,
        approved_unscheduled_count,
        media_required_count,
        media_ready_count,
        source_operation_id,
        updated_at
    )
    SELECT
        1,
        NEW.generation,
        NEW.revision_digest,
        NEW.active_assignment_count,
        NEW.approved_unscheduled_count,
        NEW.media_required_count,
        NEW.media_ready_count,
        NEW.source_operation_id,
        NEW.created_at
    WHERE
        NEW.generation = 1
        AND NEW.previous_revision_digest IS NULL
        AND NOT EXISTS (
            SELECT 1
            FROM queue_runtime_state
            WHERE singleton_id = 1
        );

    UPDATE queue_runtime_state
    SET
        generation = NEW.generation,
        revision_digest = NEW.revision_digest,
        active_assignment_count = NEW.active_assignment_count,
        approved_unscheduled_count = NEW.approved_unscheduled_count,
        media_required_count = NEW.media_required_count,
        media_ready_count = NEW.media_ready_count,
        source_operation_id = NEW.source_operation_id,
        updated_at = NEW.created_at
    WHERE
        singleton_id = 1
        AND NEW.generation > 1
        AND generation = NEW.generation - 1
        AND revision_digest = NEW.previous_revision_digest;

    SELECT CASE
        WHEN EXISTS (
            SELECT 1
            FROM queue_runtime_state
            WHERE
                singleton_id = 1
                AND generation = NEW.generation
                AND revision_digest = NEW.revision_digest
        )
        THEN 1
        ELSE RAISE(ABORT, 'runtime_revision_cas_failed')
    END;
END;

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
