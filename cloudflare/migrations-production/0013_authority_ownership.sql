CREATE TABLE authority_state (
    singleton_id INTEGER PRIMARY KEY
      CHECK (singleton_id = 1),

    owner TEXT NOT NULL
      CHECK (owner IN ('local-systemd', 'cloudflare', 'none')),

    generation INTEGER NOT NULL
      CHECK (generation >= 1),

    transition_state TEXT NOT NULL
      CHECK (transition_state IN ('stable', 'transitioning')),

    transition_id TEXT NOT NULL,

    previous_owner TEXT
      CHECK (
        previous_owner IS NULL OR
        previous_owner IN ('local-systemd', 'cloudflare', 'none')
      ),

    candidate_sha TEXT NOT NULL
      CHECK (length(candidate_sha) = 40),

    deployment_id TEXT,
    transitioned_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE authority_events (
    generation INTEGER PRIMARY KEY
      CHECK (generation >= 1),

    transition_id TEXT NOT NULL UNIQUE,

    previous_owner TEXT
      CHECK (
        previous_owner IS NULL OR
        previous_owner IN ('local-systemd', 'cloudflare', 'none')
      ),

    next_owner TEXT NOT NULL
      CHECK (next_owner IN ('local-systemd', 'cloudflare', 'none')),

    transition_state TEXT NOT NULL
      CHECK (transition_state IN ('stable', 'transitioning')),

    candidate_sha TEXT NOT NULL
      CHECK (length(candidate_sha) = 40),

    deployment_id TEXT,
    event_at TEXT NOT NULL,
    detail TEXT
);

CREATE INDEX authority_events_time_idx
ON authority_events(event_at);

-- Intentionally no seed row.
-- A missing authority_state is fail-closed and must not fabricate ownership.
-- Issue #46 bootstraps owner=none under the global publication halt before
-- any production ownership transfer is permitted.
