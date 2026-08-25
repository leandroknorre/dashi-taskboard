PRAGMA recursive_triggers = ON;
CREATE TRIGGER IF NOT EXISTS workflow_ledger_events_prevent_replace_collision
BEFORE INSERT ON workflow_ledger_events
WHEN EXISTS (
  SELECT 1
  FROM workflow_ledger_events AS existing
  WHERE existing.sequence = NEW.sequence
    OR existing.event_id = NEW.event_id
    OR existing.idempotency_key = NEW.idempotency_key
    OR existing.event_hash = NEW.event_hash
)
BEGIN SELECT RAISE(ABORT, 'WORKFLOW_LEDGER_APPEND_ONLY'); END;
