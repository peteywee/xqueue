CREATE TRIGGER publication_events_append_only_update
BEFORE UPDATE ON publication_events
BEGIN
  SELECT RAISE(ABORT, 'publication_events is append-only');
END;

CREATE TRIGGER publication_events_append_only_delete
BEFORE DELETE ON publication_events
BEGIN
  SELECT RAISE(ABORT, 'publication_events is append-only');
END;

CREATE TRIGGER publication_lease_events_append_only_update
BEFORE UPDATE ON publication_lease_events
BEGIN
  SELECT RAISE(ABORT, 'publication_lease_events is append-only');
END;

CREATE TRIGGER publication_lease_events_append_only_delete
BEFORE DELETE ON publication_lease_events
BEGIN
  SELECT RAISE(ABORT, 'publication_lease_events is append-only');
END;
