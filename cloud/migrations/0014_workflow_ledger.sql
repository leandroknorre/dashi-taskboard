CREATE TABLE IF NOT EXISTS workflow_ledger_events (
  sequence INTEGER PRIMARY KEY,
  event_id TEXT NOT NULL UNIQUE,
  event_type TEXT NOT NULL,
  workflow_id TEXT NOT NULL,
  revision_id TEXT NOT NULL,
  aggregate_type TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  correlation_id TEXT NOT NULL,
  causation_id TEXT,
  idempotency_key TEXT NOT NULL UNIQUE,
  idempotency_fingerprint TEXT NOT NULL,
  prev_hash TEXT,
  event_hash TEXT NOT NULL UNIQUE,
  envelope_json TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS workflow_ledger_events_aggregate_sequence ON workflow_ledger_events(aggregate_type, aggregate_id, sequence);
CREATE TRIGGER IF NOT EXISTS workflow_ledger_events_append_only_update BEFORE UPDATE ON workflow_ledger_events BEGIN SELECT RAISE(ABORT, 'WORKFLOW_LEDGER_APPEND_ONLY'); END;
CREATE TRIGGER IF NOT EXISTS workflow_ledger_events_append_only_delete BEFORE DELETE ON workflow_ledger_events BEGIN SELECT RAISE(ABORT, 'WORKFLOW_LEDGER_APPEND_ONLY'); END;
CREATE TABLE IF NOT EXISTS workflow_ledger_head (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  last_sequence INTEGER NOT NULL CHECK (last_sequence > 0),
  last_event_hash TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS workflow_aggregate_projections (
  aggregate_type TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  workflow_id TEXT NOT NULL,
  revision_id TEXT NOT NULL,
  last_sequence INTEGER NOT NULL UNIQUE,
  last_event_id TEXT NOT NULL UNIQUE,
  last_event_type TEXT NOT NULL,
  last_event_hash TEXT NOT NULL,
  state_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (aggregate_type, aggregate_id)
);
CREATE TABLE IF NOT EXISTS workflow_outbox (
  id INTEGER PRIMARY KEY,
  event_id TEXT NOT NULL UNIQUE REFERENCES workflow_ledger_events(event_id),
  sequence INTEGER NOT NULL UNIQUE REFERENCES workflow_ledger_events(sequence),
  topic TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  dispatched_at TEXT,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0)
);
CREATE INDEX IF NOT EXISTS workflow_outbox_pending ON workflow_outbox(dispatched_at, sequence);
CREATE TABLE IF NOT EXISTS workflow_work_item_projections (
  work_item_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL,
  status TEXT NOT NULL,
  stage_id TEXT,
  task_version INTEGER NOT NULL,
  projection_kind TEXT NOT NULL CHECK (projection_kind = 'work_item.imported'),
  imported_at TEXT NOT NULL,
  source_updated_at TEXT NOT NULL,
  last_event_sequence INTEGER,
  last_event_hash TEXT
);
CREATE INDEX IF NOT EXISTS workflow_work_item_projections_project ON workflow_work_item_projections(project_id, work_item_id);
INSERT INTO workflow_work_item_projections (work_item_id, project_id, status, stage_id, task_version, projection_kind, imported_at, source_updated_at, last_event_sequence, last_event_hash)
SELECT id, project_id, status, stage_id, version, 'work_item.imported', created_at, updated_at, NULL, NULL FROM tasks
WHERE 1
ON CONFLICT(work_item_id) DO NOTHING;
