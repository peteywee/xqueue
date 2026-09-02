CREATE TABLE publication_state (
    post_id TEXT PRIMARY KEY,

    status TEXT NOT NULL
      CHECK (
        status IN (
          'scheduled',
          'prepared',
          'publishing',
          'posted',
          'needs_reconciliation',
          'skipped'
        )
      ),

    scheduled_at TEXT NOT NULL,

    tweet_id TEXT,

    prepared_at TEXT,
    publishing_at TEXT,
    posted_at TEXT,

    skipped_at TEXT,
    skip_reason TEXT,

    last_error TEXT,

    updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX publication_state_tweet_id_uq
ON publication_state(tweet_id);


CREATE INDEX publication_state_status_idx
ON publication_state(status);

CREATE INDEX publication_state_schedule_idx
ON publication_state(scheduled_at);


CREATE TABLE publication_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,

    post_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    event_at TEXT NOT NULL,
    detail TEXT,

    FOREIGN KEY (post_id)
      REFERENCES publication_state(post_id)
);


CREATE INDEX publication_events_post_idx
ON publication_events(post_id);

CREATE INDEX publication_events_time_idx
ON publication_events(event_at);


CREATE TABLE runtime_metadata (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
