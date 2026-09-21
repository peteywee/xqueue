CREATE TABLE publication_halt_state (
    singleton_id INTEGER PRIMARY KEY
      CHECK (singleton_id = 1),

    halted INTEGER NOT NULL
      CHECK (halted IN (0, 1)),

    generation INTEGER NOT NULL
      CHECK (generation >= 1),

    reason TEXT NOT NULL
      CHECK (length(trim(reason)) >= 1),

    actor_class TEXT NOT NULL
      CHECK (actor_class IN ('migration', 'automation', 'owner')),

    updated_at TEXT NOT NULL
);

CREATE TABLE publication_halt_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,

    generation INTEGER NOT NULL UNIQUE
      CHECK (generation >= 1),

    action TEXT NOT NULL
      CHECK (action IN ('initialized', 'set', 'clear')),

    actor_class TEXT NOT NULL
      CHECK (actor_class IN ('migration', 'automation', 'owner')),

    reason TEXT NOT NULL
      CHECK (length(trim(reason)) >= 1),

    event_at TEXT NOT NULL
);

INSERT INTO publication_halt_state (
    singleton_id,
    halted,
    generation,
    reason,
    actor_class,
    updated_at
)
VALUES (
    1,
    0,
    1,
    'initial_unhalted',
    'migration',
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
);

INSERT INTO publication_halt_events (
    generation,
    action,
    actor_class,
    reason,
    event_at
)
SELECT
    generation,
    'initialized',
    actor_class,
    reason,
    updated_at
FROM publication_halt_state
WHERE singleton_id = 1;

CREATE TRIGGER publication_halt_generation_guard
BEFORE UPDATE ON publication_halt_state
WHEN
    NEW.generation <> OLD.generation + 1 OR
    NEW.halted = OLD.halted
BEGIN
    SELECT RAISE(ABORT, 'publication halt transition must flip state and advance generation exactly once');
END;

CREATE TRIGGER publication_halt_set_guard
BEFORE UPDATE ON publication_halt_state
WHEN
    OLD.halted = 0 AND
    NEW.halted = 1 AND
    NEW.actor_class NOT IN ('automation', 'owner')
BEGIN
    SELECT RAISE(ABORT, 'publication halt may only be set by automation or owner');
END;

CREATE TRIGGER publication_halt_owner_clear_guard
BEFORE UPDATE ON publication_halt_state
WHEN
    OLD.halted = 1 AND
    NEW.halted = 0 AND
    NEW.actor_class <> 'owner'
BEGIN
    SELECT RAISE(ABORT, 'publication halt may only be cleared by owner');
END;

CREATE TRIGGER publication_halt_audit
AFTER UPDATE ON publication_halt_state
BEGIN
    INSERT INTO publication_halt_events (
        generation,
        action,
        actor_class,
        reason,
        event_at
    )
    VALUES (
        NEW.generation,
        CASE WHEN NEW.halted = 1 THEN 'set' ELSE 'clear' END,
        NEW.actor_class,
        NEW.reason,
        NEW.updated_at
    );
END;

CREATE TRIGGER publication_halt_state_no_delete
BEFORE DELETE ON publication_halt_state
BEGIN
    SELECT RAISE(ABORT, 'publication halt state cannot be deleted');
END;

CREATE TRIGGER publication_halt_events_immutable_update
BEFORE UPDATE ON publication_halt_events
BEGIN
    SELECT RAISE(ABORT, 'publication halt events are immutable');
END;

CREATE TRIGGER publication_halt_events_immutable_delete
BEFORE DELETE ON publication_halt_events
BEGIN
    SELECT RAISE(ABORT, 'publication halt events are immutable');
END;
