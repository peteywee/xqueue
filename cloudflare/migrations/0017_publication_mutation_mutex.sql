-- Mutual exclusion between the mutation lane and both the production publisher
-- lease and publication authority transitions.
-- Mutation claim already proves publication is idle. These reciprocal guards
-- prevent publication from acquiring or renewing its lease until finalization
-- releases the mutation lane.

CREATE TRIGGER publication_lease_mutation_lane_insert_guard
BEFORE INSERT ON publication_leases
WHEN
    NEW.owner_token IS NOT NULL AND
    EXISTS (
      SELECT 1
      FROM mutation_lane_state
      WHERE singleton_id = 1
        AND active_operation_id IS NOT NULL
    )
BEGIN
    SELECT RAISE(ABORT, 'publication lease acquisition blocked by active mutation lane');
END;

CREATE TRIGGER publication_lease_mutation_lane_update_guard
BEFORE UPDATE OF
    owner_token,
    acquisition_id,
    generation,
    acquired_at_ms,
    expires_at_ms
ON publication_leases
WHEN
    NEW.owner_token IS NOT NULL AND
    EXISTS (
      SELECT 1
      FROM mutation_lane_state
      WHERE singleton_id = 1
        AND active_operation_id IS NOT NULL
    )
BEGIN
    SELECT RAISE(ABORT, 'publication lease acquisition blocked by active mutation lane');
END;

-- Authority transitions are excluded the same way. A mutation binds the exact
-- authority it observed when it claimed the lane, and its recovery checkpoint
-- must stay a valid restore point until finalization releases the lane. The
-- event guard covers the production projection path; the state guard covers
-- lanes that update authority_state directly.
CREATE TRIGGER authority_event_mutation_lane_guard
BEFORE INSERT ON authority_events
WHEN
    EXISTS (
      SELECT 1
      FROM mutation_lane_state
      WHERE singleton_id = 1
        AND active_operation_id IS NOT NULL
    )
BEGIN
    SELECT RAISE(ABORT, 'authority transition blocked by active mutation lane');
END;

CREATE TRIGGER authority_state_mutation_lane_guard
BEFORE UPDATE ON authority_state
WHEN
    EXISTS (
      SELECT 1
      FROM mutation_lane_state
      WHERE singleton_id = 1
        AND active_operation_id IS NOT NULL
    )
BEGIN
    SELECT RAISE(ABORT, 'authority transition blocked by active mutation lane');
END;
