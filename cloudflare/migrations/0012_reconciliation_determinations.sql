CREATE TABLE publication_reconciliation_determinations (
    determination_id TEXT PRIMARY KEY
      CHECK (length(determination_id) >= 16),

    post_id TEXT NOT NULL,
    attempt_id TEXT NOT NULL,
    expected_state_generation INTEGER NOT NULL
      CHECK (expected_state_generation >= 1),

    outcome TEXT NOT NULL
      CHECK (outcome IN ('confirmed_posted', 'confirmed_not_posted')),

    tweet_id TEXT,
    reason TEXT NOT NULL
      CHECK (length(trim(reason)) >= 1),

    actor_class TEXT NOT NULL
      CHECK (actor_class = 'owner'),

    determined_at TEXT NOT NULL,

    CHECK (
      (outcome = 'confirmed_posted' AND tweet_id IS NOT NULL AND length(trim(tweet_id)) >= 1)
      OR
      (outcome = 'confirmed_not_posted' AND tweet_id IS NULL)
    ),

    UNIQUE (post_id, attempt_id),

    FOREIGN KEY (post_id)
      REFERENCES publication_state(post_id),

    FOREIGN KEY (attempt_id)
      REFERENCES publication_fences(attempt_id)
);

CREATE INDEX publication_reconciliation_post_idx
ON publication_reconciliation_determinations(post_id, determined_at);

CREATE TRIGGER publication_reconciliation_determinations_immutable_update
BEFORE UPDATE ON publication_reconciliation_determinations
BEGIN
  SELECT RAISE(ABORT, 'publication reconciliation determinations are immutable');
END;

CREATE TRIGGER publication_reconciliation_determinations_immutable_delete
BEFORE DELETE ON publication_reconciliation_determinations
BEGIN
  SELECT RAISE(ABORT, 'publication reconciliation determinations are immutable');
END;
