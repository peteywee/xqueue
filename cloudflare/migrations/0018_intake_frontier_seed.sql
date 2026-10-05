-- 0007 seeds the intake frontier only when active assignments already exist.
-- A database whose assignments were loaded after 0007 ran (production) has no
-- frontier row, so guarded intake cannot plan. Seed it once at the last used
-- slot: the latest active assignment or publication_state row, because
-- publication_state.scheduled_at is unique across every status (a cancelled
-- post keeps its skipped row). An existing frontier is never touched, and an
-- empty queue seeds nothing.
INSERT INTO queue_intake_frontier (
    singleton_id,
    generation,
    resolved_at,
    pending_operation_id,
    last_completed_operation_id,
    updated_at
)
SELECT
    1,
    1,
    MAX(slot),
    NULL,
    NULL,
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM (
    SELECT resolved_at AS slot FROM queue_assignments WHERE status = 'active'
    UNION ALL
    SELECT scheduled_at AS slot FROM publication_state
)
WHERE NOT EXISTS (SELECT 1 FROM queue_intake_frontier WHERE singleton_id = 1)
HAVING COUNT(*) > 0;
