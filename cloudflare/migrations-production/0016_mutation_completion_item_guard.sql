CREATE TRIGGER mutation_operations_complete_items_guard
BEFORE UPDATE ON mutation_operations
WHEN NEW.state = 'COMPLETE' AND (
    NOT EXISTS (
      SELECT 1 FROM mutation_operation_items
      WHERE operation_id = NEW.operation_id
    ) OR
    EXISTS (
      SELECT 1 FROM mutation_operation_items
      WHERE operation_id = NEW.operation_id
        AND (
          readback_status <> 'applied' OR
          readback_digest IS NULL
        )
    )
)
BEGIN
    SELECT RAISE(ABORT, 'complete mutation requires applied item readback evidence');
END;
