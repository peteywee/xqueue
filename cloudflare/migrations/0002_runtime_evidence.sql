ALTER TABLE publication_state
  ADD COLUMN scheduled_date TEXT;

ALTER TABLE publication_state
  ADD COLUMN scheduled_time TEXT;

ALTER TABLE publication_state
  ADD COLUMN timezone TEXT;

ALTER TABLE publication_state
  ADD COLUMN slot TEXT;

ALTER TABLE publication_state
  ADD COLUMN deferred_to_end INTEGER
    NOT NULL DEFAULT 0
    CHECK (deferred_to_end IN (0, 1));

ALTER TABLE publication_state
  ADD COLUMN pinned INTEGER
    NOT NULL DEFAULT 0
    CHECK (pinned IN (0, 1));

ALTER TABLE publication_state
  ADD COLUMN title TEXT;

ALTER TABLE publication_state
  ADD COLUMN publication_cost REAL
    CHECK (
      publication_cost IS NULL OR
      publication_cost >= 0
    );

ALTER TABLE publication_state
  ADD COLUMN content_hash TEXT;

ALTER TABLE publication_state
  ADD COLUMN attempt_id TEXT;

ALTER TABLE publication_state
  ADD COLUMN reconciled INTEGER
    NOT NULL DEFAULT 0
    CHECK (reconciled IN (0, 1));

ALTER TABLE publication_state
  ADD COLUMN failed_at TEXT;

ALTER TABLE publication_state
  ADD COLUMN ledger_record_json TEXT;

CREATE UNIQUE INDEX
  publication_state_scheduled_at_uq
ON publication_state(scheduled_at);
