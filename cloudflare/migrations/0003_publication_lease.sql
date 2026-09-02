CREATE TABLE publication_leases (
    lease_name TEXT PRIMARY KEY
      CHECK (lease_name = 'publisher'),

    owner_token TEXT NOT NULL
      CHECK (length(owner_token) >= 8),

    acquisition_id TEXT NOT NULL UNIQUE
      CHECK (length(acquisition_id) >= 8),

    generation INTEGER NOT NULL
      CHECK (generation >= 1),

    acquired_at_ms INTEGER NOT NULL
      CHECK (acquired_at_ms >= 0),

    expires_at_ms INTEGER NOT NULL,

    updated_at_ms INTEGER NOT NULL
      CHECK (updated_at_ms >= 0),

    CHECK (expires_at_ms > acquired_at_ms)
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
