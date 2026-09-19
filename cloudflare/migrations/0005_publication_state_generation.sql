ALTER TABLE publication_state
  ADD COLUMN generation INTEGER
    NOT NULL DEFAULT 1
    CHECK (generation >= 1);
