CREATE TABLE IF NOT EXISTS workflow_human_evidence (
  evidence_id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  request_fingerprint TEXT NOT NULL,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  task_version INTEGER NOT NULL,
  workflow_id TEXT NOT NULL,
  revision_id TEXT NOT NULL,
  transition_id TEXT NOT NULL,
  action_key TEXT NOT NULL,
  gate_id TEXT NOT NULL,
  evidence_type TEXT NOT NULL CHECK (evidence_type = 'human_acceptance'),
  actor_key TEXT NOT NULL,
  captured_at TEXT NOT NULL,
  evidence_event_id TEXT NOT NULL UNIQUE,
  evidence_hash TEXT NOT NULL UNIQUE,
  ledger_event_id TEXT NOT NULL UNIQUE REFERENCES workflow_ledger_events(event_id),
  status TEXT NOT NULL CHECK (status IN ('valid', 'revoked')),
  revoked_at TEXT,
  revoked_event_id TEXT UNIQUE,
  revocation_hash TEXT UNIQUE,
  revocation_reason TEXT,
  revocation_idempotency_key TEXT UNIQUE,
  revocation_request_fingerprint TEXT,
  revocation_ledger_event_id TEXT UNIQUE REFERENCES workflow_ledger_events(event_id),
  created_at TEXT NOT NULL,
  CHECK (
    (status = 'valid'
      AND revoked_at IS NULL
      AND revoked_event_id IS NULL
      AND revocation_hash IS NULL
      AND revocation_reason IS NULL
      AND revocation_idempotency_key IS NULL
      AND revocation_request_fingerprint IS NULL
      AND revocation_ledger_event_id IS NULL)
    OR
    (status = 'revoked'
      AND revoked_at IS NOT NULL
      AND revoked_event_id IS NOT NULL
      AND revocation_hash IS NOT NULL
      AND revocation_reason IS NOT NULL
      AND revocation_idempotency_key IS NOT NULL
      AND revocation_request_fingerprint IS NOT NULL
      AND revocation_ledger_event_id IS NOT NULL)
  )
);
CREATE INDEX IF NOT EXISTS workflow_human_evidence_scope
  ON workflow_human_evidence(task_id, workflow_id, revision_id, transition_id, task_version, status);
CREATE TRIGGER IF NOT EXISTS workflow_transition_requests_current_task_version
BEFORE INSERT ON workflow_transition_requests
WHEN NOT EXISTS (
  SELECT 1 FROM tasks
  WHERE id = NEW.task_id
    AND version = NEW.expected_state_version
    AND archived_at IS NULL
)
BEGIN SELECT RAISE(ABORT, 'STALE_WORKFLOW_TRANSITION_REQUEST'); END;
CREATE TRIGGER IF NOT EXISTS workflow_human_evidence_current_task_version
BEFORE INSERT ON workflow_human_evidence
WHEN NOT EXISTS (
  SELECT 1 FROM tasks WHERE id = NEW.task_id AND version = NEW.task_version AND archived_at IS NULL
)
BEGIN SELECT RAISE(ABORT, 'STALE_HUMAN_ACCEPTANCE_EVIDENCE'); END;
CREATE TRIGGER IF NOT EXISTS workflow_human_evidence_revoke_once
BEFORE UPDATE OF status ON workflow_human_evidence
WHEN OLD.status <> 'valid' OR NEW.status <> 'revoked'
BEGIN SELECT RAISE(ABORT, 'HUMAN_ACCEPTANCE_EVIDENCE_ALREADY_REVOKED'); END;

CREATE TABLE IF NOT EXISTS workflow_transition_evidence_consumptions (
  request_id TEXT NOT NULL REFERENCES workflow_transition_requests(request_id) ON DELETE CASCADE,
  evidence_id TEXT NOT NULL UNIQUE REFERENCES workflow_human_evidence(evidence_id),
  consumed_at TEXT NOT NULL,
  PRIMARY KEY (request_id, evidence_id)
);

CREATE TRIGGER IF NOT EXISTS workflow_transition_evidence_consumption_valid
BEFORE INSERT ON workflow_transition_evidence_consumptions
WHEN NOT EXISTS (
  SELECT 1
  FROM workflow_transition_requests AS requests
  JOIN workflow_human_evidence AS evidence ON evidence.evidence_id = NEW.evidence_id
  WHERE requests.request_id = NEW.request_id
    AND evidence.status = 'valid'
    AND evidence.task_id = requests.task_id
    AND evidence.task_version = requests.expected_state_version
    AND evidence.workflow_id = requests.workflow_id
    AND evidence.revision_id = requests.revision_id
    AND evidence.transition_id = requests.transition_id
)
BEGIN SELECT RAISE(ABORT, 'INVALID_HUMAN_ACCEPTANCE_EVIDENCE'); END;
