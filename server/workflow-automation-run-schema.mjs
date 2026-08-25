/**
 * Local migration 0016. Cloud is intentionally untouched: this first slice
 * only records local run intent and exposes no executor.
 */
export const LOCAL_AUTOMATION_RUN_MIGRATION_ID = "0016_workflow_automation_runs";

export const WORKFLOW_AUTOMATION_RUN_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS workflow_automation_runs (
    run_id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    transition_event_id TEXT NOT NULL UNIQUE REFERENCES workflow_ledger_events(event_id) DEFERRABLE INITIALLY DEFERRED,
    transition_event_hash TEXT NOT NULL,
    workflow_id TEXT NOT NULL REFERENCES workflow_definitions(workflow_id),
    revision_id TEXT NOT NULL REFERENCES workflow_revisions(revision_id),
    task_stage_id TEXT NOT NULL REFERENCES workflow_stages(id),
    contract_stage_id TEXT NOT NULL,
    agent_profile_revision_id TEXT NOT NULL,
    mode TEXT NOT NULL CHECK (mode IN ('disabled', 'manual', 'shadow')),
    status TEXT NOT NULL CHECK (status IN ('pending', 'dispatched', 'succeeded', 'failed', 'cancelled')),
    payload_json TEXT NOT NULL,
    result_json TEXT,
    version INTEGER NOT NULL CHECK (version > 0),
    dispatch_attempt INTEGER NOT NULL DEFAULT 0 CHECK (dispatch_attempt >= 0),
    lease_token TEXT UNIQUE,
    lease_expires_at TEXT,
    dispatched_by_actor_type TEXT,
    dispatched_by_actor_id TEXT,
    dispatched_at TEXT,
    completed_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (task_id, transition_event_id)
  );
  CREATE INDEX IF NOT EXISTS workflow_automation_runs_task_created
    ON workflow_automation_runs(task_id, created_at DESC, run_id);
  CREATE INDEX IF NOT EXISTS workflow_automation_runs_status_created
    ON workflow_automation_runs(status, created_at, run_id);
  CREATE TRIGGER IF NOT EXISTS workflow_automation_runs_prevent_replace_collision
  BEFORE INSERT ON workflow_automation_runs
  WHEN EXISTS (
    SELECT 1 FROM workflow_automation_runs
    WHERE run_id = NEW.run_id
      OR transition_event_id = NEW.transition_event_id
      OR (NEW.lease_token IS NOT NULL AND lease_token = NEW.lease_token)
      OR (task_id = NEW.task_id AND transition_event_id = NEW.transition_event_id)
  )
  BEGIN SELECT RAISE(ABORT, 'WORKFLOW_AUTOMATION_RUN_IMMUTABLE'); END;

  CREATE TABLE IF NOT EXISTS workflow_automation_run_events (
    event_id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES workflow_automation_runs(run_id) ON DELETE CASCADE,
    version INTEGER NOT NULL CHECK (version > 0),
    event_type TEXT NOT NULL CHECK (event_type IN ('run.created', 'run.dispatched', 'run.succeeded', 'run.failed', 'run.cancelled')),
    status TEXT NOT NULL CHECK (status IN ('pending', 'dispatched', 'succeeded', 'failed', 'cancelled')),
    payload_json TEXT NOT NULL,
    actor_type TEXT,
    actor_id TEXT,
    created_at TEXT NOT NULL,
    UNIQUE (run_id, version)
  );
  CREATE INDEX IF NOT EXISTS workflow_automation_run_events_run_version
    ON workflow_automation_run_events(run_id, version);
  CREATE TRIGGER IF NOT EXISTS workflow_automation_run_events_prevent_replace_collision
  BEFORE INSERT ON workflow_automation_run_events
  WHEN EXISTS (
    SELECT 1 FROM workflow_automation_run_events
    WHERE event_id = NEW.event_id OR (run_id = NEW.run_id AND version = NEW.version)
  )
  BEGIN SELECT RAISE(ABORT, 'WORKFLOW_AUTOMATION_RUN_EVENT_IMMUTABLE'); END;
  CREATE TRIGGER IF NOT EXISTS workflow_automation_run_events_immutable_update
  BEFORE UPDATE ON workflow_automation_run_events
  BEGIN SELECT RAISE(ABORT, 'WORKFLOW_AUTOMATION_RUN_EVENT_IMMUTABLE'); END;
  CREATE TRIGGER IF NOT EXISTS workflow_automation_run_events_immutable_delete
  BEFORE DELETE ON workflow_automation_run_events
  WHEN EXISTS (SELECT 1 FROM workflow_automation_runs WHERE run_id = OLD.run_id)
  BEGIN SELECT RAISE(ABORT, 'WORKFLOW_AUTOMATION_RUN_EVENT_IMMUTABLE'); END;

  CREATE TABLE IF NOT EXISTS workflow_automation_run_requests (
    idempotency_key TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES workflow_automation_runs(run_id) ON DELETE CASCADE,
    operation TEXT NOT NULL CHECK (operation IN ('dispatch', 'result')),
    request_fingerprint TEXT NOT NULL,
    lease_token TEXT,
    actor_type TEXT,
    actor_id TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS workflow_automation_run_requests_run
    ON workflow_automation_run_requests(run_id, operation, created_at);
  CREATE TRIGGER IF NOT EXISTS workflow_automation_run_requests_prevent_replace_collision
  BEFORE INSERT ON workflow_automation_run_requests
  WHEN EXISTS (SELECT 1 FROM workflow_automation_run_requests WHERE idempotency_key = NEW.idempotency_key)
  BEGIN SELECT RAISE(ABORT, 'WORKFLOW_AUTOMATION_RUN_REQUEST_IMMUTABLE'); END;
  CREATE TRIGGER IF NOT EXISTS workflow_automation_run_requests_immutable_update
  BEFORE UPDATE ON workflow_automation_run_requests
  BEGIN SELECT RAISE(ABORT, 'WORKFLOW_AUTOMATION_RUN_REQUEST_IMMUTABLE'); END;
  CREATE TRIGGER IF NOT EXISTS workflow_automation_run_requests_immutable_delete
  BEFORE DELETE ON workflow_automation_run_requests
  WHEN EXISTS (SELECT 1 FROM workflow_automation_runs WHERE run_id = OLD.run_id)
  BEGIN SELECT RAISE(ABORT, 'WORKFLOW_AUTOMATION_RUN_REQUEST_IMMUTABLE'); END;

  CREATE TABLE IF NOT EXISTS workflow_automation_run_outbox (
    id INTEGER PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES workflow_automation_runs(run_id) ON DELETE CASCADE,
    attempt INTEGER NOT NULL CHECK (attempt > 0),
    topic TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE (run_id, attempt)
  );
  CREATE INDEX IF NOT EXISTS workflow_automation_run_outbox_pending
    ON workflow_automation_run_outbox(id);
  CREATE TRIGGER IF NOT EXISTS workflow_automation_run_outbox_prevent_replace_collision
  BEFORE INSERT ON workflow_automation_run_outbox
  WHEN EXISTS (
    SELECT 1 FROM workflow_automation_run_outbox
    WHERE id = NEW.id OR (run_id = NEW.run_id AND attempt = NEW.attempt)
  )
  BEGIN SELECT RAISE(ABORT, 'WORKFLOW_AUTOMATION_RUN_OUTBOX_IMMUTABLE'); END;
  CREATE TRIGGER IF NOT EXISTS workflow_automation_run_outbox_immutable_update
  BEFORE UPDATE ON workflow_automation_run_outbox
  BEGIN SELECT RAISE(ABORT, 'WORKFLOW_AUTOMATION_RUN_OUTBOX_IMMUTABLE'); END;
  CREATE TRIGGER IF NOT EXISTS workflow_automation_run_outbox_immutable_delete
  BEFORE DELETE ON workflow_automation_run_outbox
  WHEN EXISTS (SELECT 1 FROM workflow_automation_runs WHERE run_id = OLD.run_id)
  BEGIN SELECT RAISE(ABORT, 'WORKFLOW_AUTOMATION_RUN_OUTBOX_IMMUTABLE'); END;
`;

export function migrateLocalAutomationRuns(database) {
  database.exec("PRAGMA recursive_triggers = ON");
  database.exec("BEGIN IMMEDIATE");
  try {
    database.exec(WORKFLOW_AUTOMATION_RUN_SCHEMA_SQL);
    const requestColumns = new Set(database.prepare("PRAGMA table_info(workflow_automation_run_requests)").all().map((row) => row.name));
    // A short-lived pre-release 0016 schema did not retain the original
    // dispatch lease or actor for safe idempotent replay. Upgrade it in place
    // rather than assuming every local database was created by the final schema.
    if (!requestColumns.has("lease_token")) {
      database.exec("ALTER TABLE workflow_automation_run_requests ADD COLUMN lease_token TEXT");
    }
    if (!requestColumns.has("actor_type")) {
      database.exec("ALTER TABLE workflow_automation_run_requests ADD COLUMN actor_type TEXT");
    }
    if (!requestColumns.has("actor_id")) {
      database.exec("ALTER TABLE workflow_automation_run_requests ADD COLUMN actor_id TEXT");
    }
    const needsDispatchBackfill = database.prepare(`
      SELECT 1 FROM workflow_automation_run_requests
      WHERE operation = 'dispatch'
        AND (lease_token IS NULL OR actor_type IS NULL OR actor_id IS NULL)
      LIMIT 1
    `).get();
    if (needsDispatchBackfill) {
      database.exec("DROP TRIGGER IF EXISTS workflow_automation_run_requests_immutable_update");
      database.exec(`
        UPDATE workflow_automation_run_requests
        SET
          lease_token = COALESCE(lease_token, (
            SELECT lease_token FROM workflow_automation_runs
            WHERE workflow_automation_runs.run_id = workflow_automation_run_requests.run_id
          )),
          actor_type = COALESCE(actor_type, (
            SELECT dispatched_by_actor_type FROM workflow_automation_runs
            WHERE workflow_automation_runs.run_id = workflow_automation_run_requests.run_id
          )),
          actor_id = COALESCE(actor_id, (
            SELECT dispatched_by_actor_id FROM workflow_automation_runs
            WHERE workflow_automation_runs.run_id = workflow_automation_run_requests.run_id
          ))
        WHERE operation = 'dispatch'
          AND (lease_token IS NULL OR actor_type IS NULL OR actor_id IS NULL)
      `);
      database.exec(`
        CREATE TRIGGER workflow_automation_run_requests_immutable_update
        BEFORE UPDATE ON workflow_automation_run_requests
        BEGIN SELECT RAISE(ABORT, 'WORKFLOW_AUTOMATION_RUN_REQUEST_IMMUTABLE'); END
      `);
    }
    database.exec("COMMIT");
  } catch (error) {
    try {
      database.exec("ROLLBACK");
    } catch {
      // A failed SQLite statement may already have ended the transaction.
    }
    throw error;
  }
}
