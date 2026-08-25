import { automationRequestFingerprint, normalizeResultCommand, redactAndLimit } from "../shared/automation-runs.mjs";
import { canonicalJson } from "../shared/workflow-control.mjs";

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
    response_json TEXT,
    replay_state TEXT NOT NULL DEFAULT 'unavailable' CHECK (replay_state IN ('available', 'unavailable')),
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

function redactedJson(value) {
  return canonicalJson(redactAndLimit(value, { limit: Number.POSITIVE_INFINITY }));
}

function redactedParsedJson(value) {
  return redactAndLimit(JSON.parse(value), { limit: Number.POSITIVE_INFINITY });
}

function completeActor(actorType, actorId) {
  return typeof actorType === "string" && actorType.length > 0
    && typeof actorId === "string" && actorId.length > 0;
}

function runResponseFromRow(row, overrides = {}) {
  return {
    runId: row.run_id,
    taskId: row.task_id,
    transitionEventId: row.transition_event_id,
    transitionEventHash: row.transition_event_hash,
    workflowId: row.workflow_id,
    revisionId: row.revision_id,
    taskStageId: row.task_stage_id,
    contractStageId: row.contract_stage_id,
    agentProfileRevisionId: row.agent_profile_revision_id,
    mode: row.mode,
    status: row.status,
    payload: redactedParsedJson(row.payload_json),
    result: row.result_json === null ? null : redactedParsedJson(row.result_json),
    version: row.version,
    dispatchAttempt: row.dispatch_attempt,
    leaseExpiresAt: row.lease_expires_at,
    dispatchedBy: row.dispatched_by_actor_id === null ? null : {
      type: row.dispatched_by_actor_type,
      id: row.dispatched_by_actor_id,
    },
    dispatchedAt: row.dispatched_at,
    completedAt: row.completed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...overrides,
  };
}

function unavailableReplay(reason) {
  return {
    leaseToken: null,
    actorType: null,
    actorId: null,
    responseJson: redactedJson({ unavailable: reason }),
    replayState: "unavailable",
  };
}

function normalizedStoredFingerprint(request) {
  if (/^sha256:[a-f0-9]{64}$/.test(request.request_fingerprint)) {
    return { fingerprint: request.request_fingerprint, valid: true, isHashed: true, legacyCommand: null };
  }
  try {
    const envelope = JSON.parse(request.request_fingerprint);
    if (
      envelope === null
      || typeof envelope !== "object"
      || Array.isArray(envelope)
      || typeof envelope.operation !== "string"
      || typeof envelope.runId !== "string"
      || envelope.operation !== request.operation
      || envelope.runId !== request.run_id
    ) {
      return {
        fingerprint: automationRequestFingerprint("legacy", "unavailable", {}),
        valid: false,
        isHashed: false,
        legacyCommand: null,
      };
    }
    const { operation, runId, ...command } = envelope;
    const { leaseToken, ...withoutLease } = command;
    const redactedCommand = redactAndLimit(withoutLease, { limit: Number.POSITIVE_INFINITY });
    const legacyCommand = {
      ...redactedCommand,
      ...(typeof leaseToken === "string" ? { leaseToken } : {}),
    };
    return {
      fingerprint: automationRequestFingerprint(operation, runId, legacyCommand),
      valid: true,
      isHashed: false,
      legacyCommand,
    };
  } catch {
    return {
      fingerprint: automationRequestFingerprint("legacy", "unavailable", {}),
      valid: false,
      isHashed: false,
      legacyCommand: null,
    };
  }
}

function legacyDispatchResponse(database, request) {
  const run = database.prepare("SELECT * FROM workflow_automation_runs WHERE run_id = ?").get(request.run_id);
  if (!run) return unavailableReplay("historical_dispatch_response_missing");
  const events = database.prepare(`
    SELECT * FROM workflow_automation_run_events
    WHERE run_id = ? AND event_type = 'run.dispatched' AND created_at = ?
    ORDER BY version
  `).all(request.run_id, request.created_at);
  if (events.length !== 1) return unavailableReplay("historical_dispatch_response_ambiguous");
  const event = events[0];
  let eventPayload;
  try {
    eventPayload = redactedParsedJson(event.payload_json);
  } catch {
    return unavailableReplay("historical_dispatch_response_invalid");
  }
  const attempt = eventPayload.attempt;
  const hasStableOriginalLease = Number.isSafeInteger(attempt)
    && attempt > 0
    && run.dispatch_attempt === attempt
    && run.lease_token !== null
    && run.dispatched_by_actor_type === event.actor_type
    && run.dispatched_by_actor_id === event.actor_id
    && typeof eventPayload.leaseExpiresAt === "string";
  const actor = { actorType: event.actor_type, actorId: event.actor_id };
  if (!hasStableOriginalLease || !completeActor(event.actor_type, event.actor_id)) {
    return { ...unavailableReplay("historical_dispatch_response_superseded"), ...actor };
  }
  try {
    return {
      leaseToken: run.lease_token,
      ...actor,
      responseJson: redactedJson({
        run: runResponseFromRow(run, {
          status: "dispatched",
          result: null,
          version: event.version,
          dispatchAttempt: attempt,
          leaseExpiresAt: eventPayload.leaseExpiresAt,
          dispatchedBy: { type: event.actor_type, id: event.actor_id },
          dispatchedAt: event.created_at,
          completedAt: null,
          updatedAt: event.created_at,
        }),
      }),
      replayState: "available",
    };
  } catch {
    return { ...unavailableReplay("historical_dispatch_response_invalid"), ...actor };
  }
}

function legacyResultResponse(database, request, legacyCommand) {
  if (legacyCommand === null) return unavailableReplay("historical_result_actor_unproven");
  let command;
  try {
    command = normalizeResultCommand(legacyCommand);
  } catch {
    return unavailableReplay("historical_result_command_invalid");
  }
  if (command.idempotencyKey !== request.idempotency_key) {
    return unavailableReplay("historical_result_request_mismatch");
  }
  const run = database.prepare("SELECT * FROM workflow_automation_runs WHERE run_id = ?").get(request.run_id);
  if (!run) return unavailableReplay("historical_result_response_missing");
  try {
    const isTerminalResult = ["succeeded", "failed", "cancelled"].includes(run.status);
    const commandMatchesRun = isTerminalResult
      && run.status === command.status
      && run.version === command.expectedVersion + 1
      && run.lease_token === command.leaseToken
      && run.completed_at === request.created_at
      && run.updated_at === request.created_at
      && canonicalJson(redactedParsedJson(run.result_json)) === canonicalJson(command.result);
    if (!commandMatchesRun) return unavailableReplay("historical_result_response_unlinked");

    const events = database.prepare(`
      SELECT * FROM workflow_automation_run_events
      WHERE run_id = ?
        AND version = ?
        AND event_type = ?
        AND status = ?
        AND created_at = ?
      ORDER BY event_id
    `).all(request.run_id, run.version, `run.${run.status}`, run.status, request.created_at);
    if (events.length !== 1) return unavailableReplay("historical_result_actor_ambiguous");
    const event = events[0];
    const previous = database.prepare(`
      SELECT 1 FROM workflow_automation_run_events
      WHERE run_id = ? AND version = ? AND event_type = 'run.dispatched' AND status = 'dispatched'
    `).get(request.run_id, run.version - 1);
    const requestActorIsConsistent = (request.actor_type === null && request.actor_id === null)
      || (completeActor(request.actor_type, request.actor_id)
        && request.actor_type === event.actor_type
        && request.actor_id === event.actor_id);
    if (
      !previous
      || event.payload_json !== run.result_json
      || !["user", "agent"].includes(event.actor_type)
      || !completeActor(event.actor_type, event.actor_id)
      || !requestActorIsConsistent
    ) {
      return unavailableReplay("historical_result_actor_unproven");
    }
    return {
      leaseToken: null,
      actorType: event.actor_type,
      actorId: event.actor_id,
      responseJson: redactedJson({ run: runResponseFromRow(run) }),
      replayState: "available",
    };
  } catch {
    return unavailableReplay("historical_result_response_invalid");
  }
}

function immutableRequestUpdateTrigger(database) {
  database.exec(`
    CREATE TRIGGER workflow_automation_run_requests_immutable_update
    BEFORE UPDATE ON workflow_automation_run_requests
    BEGIN SELECT RAISE(ABORT, 'WORKFLOW_AUTOMATION_RUN_REQUEST_IMMUTABLE'); END
  `);
}

function immutableEventUpdateTrigger(database) {
  database.exec(`
    CREATE TRIGGER workflow_automation_run_events_immutable_update
    BEFORE UPDATE ON workflow_automation_run_events
    BEGIN SELECT RAISE(ABORT, 'WORKFLOW_AUTOMATION_RUN_EVENT_IMMUTABLE'); END
  `);
}

function immutableOutboxUpdateTrigger(database) {
  database.exec(`
    CREATE TRIGGER workflow_automation_run_outbox_immutable_update
    BEFORE UPDATE ON workflow_automation_run_outbox
    BEGIN SELECT RAISE(ABORT, 'WORKFLOW_AUTOMATION_RUN_OUTBOX_IMMUTABLE'); END
  `);
}

function sanitizedStoredJson(value) {
  try {
    const sanitized = redactedJson(JSON.parse(value));
    return sanitized === value ? null : sanitized;
  } catch {
    return null;
  }
}

export function migrateLocalAutomationRuns(database) {
  database.exec("PRAGMA recursive_triggers = ON");
  database.exec("BEGIN IMMEDIATE");
  try {
    database.exec(WORKFLOW_AUTOMATION_RUN_SCHEMA_SQL);
    const requestColumns = new Set(database.prepare("PRAGMA table_info(workflow_automation_run_requests)").all().map((row) => row.name));
    if (!requestColumns.has("lease_token")) database.exec("ALTER TABLE workflow_automation_run_requests ADD COLUMN lease_token TEXT");
    if (!requestColumns.has("actor_type")) database.exec("ALTER TABLE workflow_automation_run_requests ADD COLUMN actor_type TEXT");
    if (!requestColumns.has("actor_id")) database.exec("ALTER TABLE workflow_automation_run_requests ADD COLUMN actor_id TEXT");
    if (!requestColumns.has("response_json")) database.exec("ALTER TABLE workflow_automation_run_requests ADD COLUMN response_json TEXT");
    if (!requestColumns.has("replay_state")) {
      database.exec("ALTER TABLE workflow_automation_run_requests ADD COLUMN replay_state TEXT NOT NULL DEFAULT 'unavailable'");
    }

    const requests = database.prepare("SELECT * FROM workflow_automation_run_requests").all();
    const updates = [];
    for (const request of requests) {
      const fingerprint = normalizedStoredFingerprint(request);
      const sanitizedResponse = request.response_json === null ? null : sanitizedStoredJson(request.response_json);
      const hasRecordedActor = completeActor(request.actor_type, request.actor_id);
      const alreadySafe = fingerprint.valid
        && fingerprint.isHashed
        && request.replay_state === "available"
        && request.response_json !== null
        && sanitizedResponse === null
        && hasRecordedActor;
      if (alreadySafe) continue;
      if (fingerprint.valid && fingerprint.isHashed && request.replay_state === "available" && request.response_json !== null && hasRecordedActor) {
        updates.push({
          request,
          fingerprint: fingerprint.fingerprint,
          historical: {
            leaseToken: request.lease_token,
            actorType: request.actor_type,
            actorId: request.actor_id,
            responseJson: sanitizedResponse ?? request.response_json,
            replayState: "available",
          },
        });
        continue;
      }
      const historical = !fingerprint.valid
        ? unavailableReplay("historical_request_fingerprint_invalid")
        : request.operation === "dispatch"
          ? legacyDispatchResponse(database, request)
          : legacyResultResponse(database, request, fingerprint.legacyCommand);
      updates.push({ request, fingerprint: fingerprint.fingerprint, historical });
    }
    if (updates.length > 0) {
      database.exec("DROP TRIGGER IF EXISTS workflow_automation_run_requests_immutable_update");
      const update = database.prepare(`
        UPDATE workflow_automation_run_requests
        SET request_fingerprint = ?, lease_token = ?, actor_type = ?, actor_id = ?, response_json = ?, replay_state = ?
        WHERE idempotency_key = ?
      `);
      for (const { request, fingerprint, historical } of updates) {
        update.run(
          fingerprint,
          historical.leaseToken,
          historical.actorType,
          historical.actorId,
          historical.responseJson,
          historical.replayState,
          request.idempotency_key,
        );
      }
      immutableRequestUpdateTrigger(database);
    }

    // Pre-fix 0016 could have persisted key variants that were later
    // recognized as sensitive. The migration is the narrowly scoped exception
    // to append-only JSON records: it removes only redacted values, inside the
    // same transaction that immediately restores their immutability triggers.
    const runJsonUpdates = database.prepare(`
      SELECT run_id, payload_json, result_json FROM workflow_automation_runs
    `).all().flatMap((row) => {
      const payload = sanitizedStoredJson(row.payload_json);
      const result = row.result_json === null ? null : sanitizedStoredJson(row.result_json);
      return payload === null && result === null ? [] : [{ row, payload, result }];
    });
    if (runJsonUpdates.length > 0) {
      const update = database.prepare(`
        UPDATE workflow_automation_runs
        SET payload_json = COALESCE(?, payload_json), result_json = COALESCE(?, result_json)
        WHERE run_id = ?
      `);
      for (const { row, payload, result } of runJsonUpdates) update.run(payload, result, row.run_id);
    }

    const eventJsonUpdates = database.prepare(`
      SELECT event_id, payload_json FROM workflow_automation_run_events
    `).all().flatMap((row) => {
      const payload = sanitizedStoredJson(row.payload_json);
      return payload === null ? [] : [{ eventId: row.event_id, payload }];
    });
    if (eventJsonUpdates.length > 0) {
      database.exec("DROP TRIGGER IF EXISTS workflow_automation_run_events_immutable_update");
      const update = database.prepare("UPDATE workflow_automation_run_events SET payload_json = ? WHERE event_id = ?");
      for (const { eventId, payload } of eventJsonUpdates) update.run(payload, eventId);
      immutableEventUpdateTrigger(database);
    }

    const outboxJsonUpdates = database.prepare(`
      SELECT id, payload_json FROM workflow_automation_run_outbox
    `).all().flatMap((row) => {
      const payload = sanitizedStoredJson(row.payload_json);
      return payload === null ? [] : [{ id: row.id, payload }];
    });
    if (outboxJsonUpdates.length > 0) {
      database.exec("DROP TRIGGER IF EXISTS workflow_automation_run_outbox_immutable_update");
      const update = database.prepare("UPDATE workflow_automation_run_outbox SET payload_json = ? WHERE id = ?");
      for (const { id, payload } of outboxJsonUpdates) update.run(payload, id);
      immutableOutboxUpdateTrigger(database);
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
