-- Mutual exclusion between the production publisher lease and mutation lane.
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
