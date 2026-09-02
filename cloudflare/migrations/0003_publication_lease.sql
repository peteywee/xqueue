CREATE TABLE publication_leases (
    lease_name TEXT PRIMARY KEY
      CHECK (lease_name = 'publisher'),

    owner_token TEXT
      CHECK (
        owner_token IS NULL OR
        length(owner_token) >= 8
      ),

    acquisition_id TEXT UNIQUE
      CHECK (
        acquisition_id IS NULL OR
        length(acquisition_id) >= 8
      ),

    generation INTEGER NOT NULL
      CHECK (generation >= 1),

    acquired_at_ms INTEGER NOT NULL
      CHECK (acquired_at_ms >= 0),

    expires_at_ms INTEGER NOT NULL
      CHECK (expires_at_ms >= acquired_at_ms),

    updated_at_ms INTEGER NOT NULL
      CHECK (updated_at_ms >= acquired_at_ms),

    CHECK (
      (
        owner_token IS NULL AND
        acquisition_id IS NULL
      ) OR
      (
        owner_token IS NOT NULL AND
        acquisition_id IS NOT NULL AND
        expires_at_ms > acquired_at_ms
      )
    )
);

CREATE TABLE publication_lease_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,

    lease_name TEXT NOT NULL
      CHECK (lease_name = 'publisher'),

    generation INTEGER NOT NULL
      CHECK (generation >= 1),

    owner_token TEXT NOT NULL,
    acquisition_id TEXT NOT NULL,

    event_type TEXT NOT NULL
      CHECK (event_type IN ('acquired', 'released')),

    event_at_ms INTEGER NOT NULL
      CHECK (event_at_ms >= 0),

    detail TEXT
);

CREATE INDEX publication_lease_events_generation_idx
ON publication_lease_events(lease_name, generation);

CREATE INDEX publication_lease_events_time_idx
ON publication_lease_events(event_at_ms);

CREATE TRIGGER publication_lease_initial_acquire_audit
AFTER INSERT ON publication_leases
WHEN NEW.owner_token IS NOT NULL
BEGIN
    INSERT INTO publication_lease_events (
        lease_name,
        generation,
        owner_token,
        acquisition_id,
        event_type,
        event_at_ms,
        detail
    )
    VALUES (
        NEW.lease_name,
        NEW.generation,
        NEW.owner_token,
        NEW.acquisition_id,
        'acquired',
        NEW.acquired_at_ms,
        'initial-acquisition'
    );
END;

CREATE TRIGGER publication_lease_takeover_audit
AFTER UPDATE OF
    owner_token,
    acquisition_id,
    generation,
    acquired_at_ms,
    expires_at_ms
ON publication_leases
WHEN
    NEW.owner_token IS NOT NULL AND
    NEW.acquisition_id IS NOT NULL AND
    (
      OLD.owner_token IS NULL OR
      OLD.acquisition_id <> NEW.acquisition_id
    )
BEGIN
    INSERT INTO publication_lease_events (
        lease_name,
        generation,
        owner_token,
        acquisition_id,
        event_type,
        event_at_ms,
        detail
    )
    VALUES (
        NEW.lease_name,
        NEW.generation,
        NEW.owner_token,
        NEW.acquisition_id,
        'acquired',
        NEW.acquired_at_ms,
        CASE
          WHEN OLD.owner_token IS NULL
            THEN 'released-lease-acquisition'
          ELSE 'expired-lease-takeover'
        END
    );
END;

CREATE TRIGGER publication_lease_release_audit
AFTER UPDATE OF
    owner_token,
    acquisition_id,
    expires_at_ms,
    updated_at_ms
ON publication_leases
WHEN
    OLD.owner_token IS NOT NULL AND
    NEW.owner_token IS NULL
BEGIN
    INSERT INTO publication_lease_events (
        lease_name,
        generation,
        owner_token,
        acquisition_id,
        event_type,
        event_at_ms,
        detail
    )
    VALUES (
        OLD.lease_name,
        OLD.generation,
        OLD.owner_token,
        OLD.acquisition_id,
        'released',
        NEW.updated_at_ms,
        'owner-release'
    );
END;
