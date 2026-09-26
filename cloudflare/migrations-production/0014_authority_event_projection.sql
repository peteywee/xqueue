-- Make authority event append + singleton projection atomic.
--
-- Authority mutations append exactly one immutable authority_events row. This
-- trigger advances authority_state in the same SQLite statement transaction.
-- If the previous projection/event pair is not exact, the trigger aborts and
-- the new event is rolled back with it.

CREATE TRIGGER authority_events_project_state
AFTER INSERT ON authority_events
BEGIN
  INSERT INTO authority_state (
    singleton_id,
    owner,
    generation,
    transition_state,
    transition_id,
    previous_owner,
    candidate_sha,
    deployment_id,
    transitioned_at,
    updated_at
  )
  SELECT
    1,
    NEW.next_owner,
    NEW.generation,
    NEW.transition_state,
    NEW.transition_id,
    NEW.previous_owner,
    NEW.candidate_sha,
    NEW.deployment_id,
    NEW.event_at,
    NEW.event_at
  WHERE NEW.generation = 1
    AND NEW.previous_owner IS NULL
    AND NOT EXISTS (SELECT 1 FROM authority_state);

  UPDATE authority_state
  SET
    owner = NEW.next_owner,
    generation = NEW.generation,
    transition_state = NEW.transition_state,
    transition_id = NEW.transition_id,
    previous_owner = NEW.previous_owner,
    candidate_sha = NEW.candidate_sha,
    deployment_id = NEW.deployment_id,
    transitioned_at = NEW.event_at,
    updated_at = NEW.event_at
  WHERE NEW.generation > 1
    AND singleton_id = 1
    AND generation = NEW.generation - 1
    AND owner IS NEW.previous_owner
    AND transition_state = 'stable'
    AND EXISTS (
      SELECT 1
      FROM authority_events prior
      WHERE prior.generation = authority_state.generation
        AND prior.transition_id = authority_state.transition_id
        AND prior.next_owner = authority_state.owner
        AND prior.transition_state = authority_state.transition_state
        AND lower(prior.candidate_sha) = lower(authority_state.candidate_sha)
        AND prior.deployment_id IS authority_state.deployment_id
        AND prior.event_at = authority_state.transitioned_at
    );

  SELECT CASE
    WHEN NOT EXISTS (
      SELECT 1
      FROM authority_state
      WHERE singleton_id = 1
        AND owner = NEW.next_owner
        AND generation = NEW.generation
        AND transition_state = NEW.transition_state
        AND transition_id = NEW.transition_id
        AND previous_owner IS NEW.previous_owner
        AND lower(candidate_sha) = lower(NEW.candidate_sha)
        AND deployment_id IS NEW.deployment_id
        AND transitioned_at = NEW.event_at
        AND updated_at = NEW.event_at
    )
    THEN RAISE(ABORT, 'authority event projection failed')
  END;
END;
