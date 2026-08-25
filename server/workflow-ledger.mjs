import { randomUUID } from "node:crypto";

import {
  WORKFLOW_ERROR_CODES,
  WorkflowContractError,
  canonicalJson,
  createLedgerEventEnvelope,
  normalizeLedgerEventEnvelope,
} from "../shared/workflow-control.mjs";

/**
 * This schema deliberately has no foreign key from ledger events to tasks.
 * A workflow aggregate can outlive, or be independent from, the taskboard.
 * The legacy task projection is the only compatibility bridge in this phase.
 */
export const WORKFLOW_LEDGER_SCHEMA_SQL = `
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
  CREATE INDEX IF NOT EXISTS workflow_ledger_events_aggregate_sequence
    ON workflow_ledger_events(aggregate_type, aggregate_id, sequence);

  CREATE TRIGGER IF NOT EXISTS workflow_ledger_events_append_only_update
  BEFORE UPDATE ON workflow_ledger_events
  BEGIN SELECT RAISE(ABORT, 'WORKFLOW_LEDGER_APPEND_ONLY'); END;
  CREATE TRIGGER IF NOT EXISTS workflow_ledger_events_append_only_delete
  BEFORE DELETE ON workflow_ledger_events
  BEGIN SELECT RAISE(ABORT, 'WORKFLOW_LEDGER_APPEND_ONLY'); END;

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
  CREATE INDEX IF NOT EXISTS workflow_outbox_pending
    ON workflow_outbox(dispatched_at, sequence);

  -- This is a projection baseline, not an event. Existing tasks must not gain
  -- fictional workflow history merely because the ledger is introduced.
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
  CREATE INDEX IF NOT EXISTS workflow_work_item_projections_project
    ON workflow_work_item_projections(project_id, work_item_id);
`;

export const WORKFLOW_LEDGER_BACKFILL_SQL = `
  INSERT INTO workflow_work_item_projections (
    work_item_id, project_id, status, stage_id, task_version, projection_kind,
    imported_at, source_updated_at, last_event_sequence, last_event_hash
  )
  SELECT
    id, project_id, status, stage_id, version, 'work_item.imported',
    created_at, updated_at, NULL, NULL
  FROM tasks
  WHERE 1
  ON CONFLICT(work_item_id) DO NOTHING;
`;

/**
 * Corrective migration 0015. SQLite's INSERT OR REPLACE deletes conflicting
 * rows instead of issuing UPDATE/DELETE triggers unless recursive triggers are
 * enabled. Checking the collision in BEFORE INSERT is the non-bypassable
 * guard: REPLACE cannot get as far as its implicit delete.
 */
export const WORKFLOW_LEDGER_HARDENING_0015_SQL = `
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
`;

/** Applies the local schema after the pre-existing task schema is available. */
export function migrateLocalWorkflowLedger(database) {
  // Defense in depth for old SQLite REPLACE semantics. The collision trigger
  // above is still the required guard because this pragma is connection-local.
  database.exec("PRAGMA recursive_triggers = ON");
  database.exec("BEGIN IMMEDIATE");
  try {
    database.exec(WORKFLOW_LEDGER_SCHEMA_SQL);
    database.exec(WORKFLOW_LEDGER_BACKFILL_SQL);
    database.exec(WORKFLOW_LEDGER_HARDENING_0015_SQL);
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function ledgerError(message, details) {
  return new WorkflowContractError(WORKFLOW_ERROR_CODES.LEDGER_HASH_INVALID, message, details);
}

function isoNow() {
  return new Date().toISOString();
}

export function ledgerEventIntent(event) {
  const {
    eventId: _eventId,
    prevHash: _prevHash,
    eventHash: _eventHash,
    ...intent
  } = event;
  return canonicalJson(intent);
}

function defaultProjection(previousState, event) {
  return {
    ...(previousState ?? {}),
    lastEventType: event.eventType,
    payload: event.payload,
    ...(event.runId === undefined ? {} : { runId: event.runId }),
  };
}

function projectionFromRow(row) {
  return {
    aggregateType: row.aggregate_type,
    aggregateId: row.aggregate_id,
    workflowId: row.workflow_id,
    revisionId: row.revision_id,
    lastSequence: row.last_sequence,
    lastEventId: row.last_event_id,
    lastEventType: row.last_event_type,
    lastEventHash: row.last_event_hash,
    state: JSON.parse(row.state_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function eventFromRow(row) {
  let event;
  try {
    event = normalizeLedgerEventEnvelope(JSON.parse(row.envelope_json));
  } catch {
    throw ledgerError("Ledger event envelope is malformed or its hash is invalid", {
      sequence: row.sequence,
      eventId: row.event_id,
    });
  }
  const expected = {
    event_id: event.eventId,
    event_type: event.eventType,
    workflow_id: event.workflowId,
    revision_id: event.revisionId,
    aggregate_type: event.aggregateType,
    aggregate_id: event.aggregateId,
    correlation_id: event.correlationId,
    causation_id: event.causationId,
    idempotency_key: event.idempotencyKey,
    idempotency_fingerprint: ledgerEventIntent(event),
    prev_hash: event.prevHash,
    event_hash: event.eventHash,
    occurred_at: event.occurredAt,
  };
  const mismatches = Object.entries(expected)
    .filter(([column, value]) => row[column] !== value)
    .map(([column]) => column);
  if (mismatches.length > 0 || !validStorageTimestamp(row.created_at)) {
    throw ledgerError("Ledger row columns do not match its immutable event envelope", {
      sequence: row.sequence,
      eventId: row.event_id,
      mismatches: mismatches.length > 0 ? mismatches : ["created_at"],
    });
  }
  return event;
}

function validStorageTimestamp(value) {
  return typeof value === "string"
    && !Number.isNaN(Date.parse(value))
    && new Date(value).toISOString() === value;
}

function auditOutbox(rows, events, outboxRows) {
  if (outboxRows.length !== rows.length) {
    throw ledgerError("Workflow outbox does not contain exactly one row per ledger event", {
      eventCount: rows.length,
      outboxCount: outboxRows.length,
    });
  }
  const bySequence = new Map(outboxRows.map((outbox) => [outbox.sequence, outbox]));
  const expected = [];
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    const event = events[index];
    const outbox = bySequence.get(row.sequence);
    const expectedPayload = canonicalJson(event);
    if (
      !outbox
      || outbox.event_id !== event.eventId
      || outbox.topic !== `workflow.${event.eventType}`
      || outbox.payload_json !== expectedPayload
      || outbox.created_at !== row.created_at
      || !validStorageTimestamp(outbox.created_at)
      || !Number.isSafeInteger(outbox.attempts)
      || outbox.attempts < 0
      || (outbox.dispatched_at !== null && !validStorageTimestamp(outbox.dispatched_at))
    ) {
      throw ledgerError("Workflow outbox row does not match its immutable ledger event", {
        sequence: row.sequence,
        eventId: event.eventId,
      });
    }
    expected.push({
      eventId: event.eventId,
      sequence: row.sequence,
      topic: `workflow.${event.eventType}`,
      payload: event,
      createdAt: outbox.created_at,
      dispatchedAt: outbox.dispatched_at,
      attempts: outbox.attempts,
    });
  }
  return expected;
}

export function auditWorkflowLedgerRows({
  eventRows,
  head,
  outboxRows,
  project = defaultProjection,
}) {
  const rows = [...eventRows].sort((left, right) => left.sequence - right.sequence);
  let expectedSequence = 1;
  let previousHash = null;
  const projections = new Map();
  const events = [];
  for (const row of rows) {
    if (row.sequence !== expectedSequence) {
      throw ledgerError("Ledger sequence is truncated or contains a gap", {
        expectedSequence,
        actualSequence: row.sequence,
      });
    }
    const event = eventFromRow(row);
    if (event.prevHash !== previousHash) {
      throw ledgerError("Ledger hash chain is broken", { sequence: row.sequence });
    }
    const key = `${event.aggregateType}\u0000${event.aggregateId}`;
    const previous = projections.get(key);
    const state = project(previous?.state ?? null, event);
    projections.set(key, {
      aggregateType: event.aggregateType,
      aggregateId: event.aggregateId,
      workflowId: event.workflowId,
      revisionId: event.revisionId,
      lastSequence: row.sequence,
      lastEventId: event.eventId,
      lastEventType: event.eventType,
      lastEventHash: event.eventHash,
      state,
    });
    events.push(event);
    previousHash = event.eventHash;
    expectedSequence += 1;
  }
  if (rows.length === 0) {
    if (head) throw ledgerError("Ledger head exists but no ledger events remain");
  } else if (
    !head
    || head.last_sequence !== rows.at(-1).sequence
    || head.last_event_hash !== previousHash
    || !validStorageTimestamp(head.updated_at)
  ) {
    throw ledgerError("Ledger head does not match the replayed immutable chain");
  }
  const outbox = auditOutbox(rows, events, outboxRows);
  return { projections: [...projections.values()], outbox };
}

function auditLedger(database, { project }) {
  return auditWorkflowLedgerRows({
    eventRows: database.prepare("SELECT * FROM workflow_ledger_events ORDER BY sequence").all(),
    head: database.prepare("SELECT * FROM workflow_ledger_head WHERE singleton = 1").get(),
    outboxRows: database.prepare("SELECT * FROM workflow_outbox ORDER BY sequence").all(),
    project,
  });
}

/**
 * Storage-only core. It intentionally has no route, transition policy, run
 * execution, or UI dependency. A future TransitionService owns event choice.
 */
export class WorkflowLedger {
  constructor(database, { now = isoNow } = {}) {
    this.database = database;
    this.now = now;
  }

  append(input, { project = defaultProjection } = {}) {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw new WorkflowContractError(WORKFLOW_ERROR_CODES.INVALID_CONTRACT, "Ledger append requires an event object");
    }
    if (typeof input.idempotencyKey !== "string" || input.idempotencyKey.length === 0) {
      throw new WorkflowContractError(WORKFLOW_ERROR_CODES.INVALID_CONTRACT, "Ledger append requires idempotencyKey");
    }

    this.database.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.database.prepare(`
        SELECT *
        FROM workflow_ledger_events WHERE idempotency_key = ?
      `).get(input.idempotencyKey);
      if (existing) {
        const storedEvent = eventFromRow(existing);
        const candidate = createLedgerEventEnvelope({
          ...input,
          eventId: input.eventId ?? storedEvent.eventId,
          prevHash: storedEvent.prevHash,
        });
        if (existing.idempotency_fingerprint !== ledgerEventIntent(candidate)) {
          throw new WorkflowContractError(
            WORKFLOW_ERROR_CODES.IDEMPOTENCY_CONFLICT,
            "idempotencyKey was already used for a different ledger event",
            { idempotencyKey: input.idempotencyKey, sequence: existing.sequence },
          );
        }
        const projection = this.database.prepare(`
          SELECT * FROM workflow_aggregate_projections
          WHERE aggregate_type = ? AND aggregate_id = ?
        `).get(storedEvent.aggregateType, storedEvent.aggregateId);
        this.database.exec("COMMIT");
        return {
          idempotent: true,
          sequence: existing.sequence,
          event: storedEvent,
          projection: projection ? projectionFromRow(projection) : null,
        };
      }

      const head = this.database.prepare("SELECT * FROM workflow_ledger_head WHERE singleton = 1").get();
      const sequence = (head?.last_sequence ?? 0) + 1;
      const prevHash = head?.last_event_hash ?? null;
      const event = createLedgerEventEnvelope({
        ...input,
        eventId: input.eventId ?? randomUUID(),
        prevHash,
      });
      if (input.eventHash !== undefined && input.eventHash !== event.eventHash) {
        throw ledgerError("Caller supplied an eventHash that does not match the canonical event");
      }
      const timestamp = this.now();
      const previous = this.database.prepare(`
        SELECT state_json FROM workflow_aggregate_projections
        WHERE aggregate_type = ? AND aggregate_id = ?
      `).get(event.aggregateType, event.aggregateId);
      const state = project(previous ? JSON.parse(previous.state_json) : null, event);
      const stateJson = canonicalJson(state);

      this.database.prepare(`
        INSERT INTO workflow_ledger_events (
          sequence, event_id, event_type, workflow_id, revision_id,
          aggregate_type, aggregate_id, correlation_id, causation_id,
          idempotency_key, idempotency_fingerprint, prev_hash, event_hash,
          envelope_json, occurred_at, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        sequence, event.eventId, event.eventType, event.workflowId, event.revisionId,
        event.aggregateType, event.aggregateId, event.correlationId, event.causationId,
        event.idempotencyKey, ledgerEventIntent(event), event.prevHash, event.eventHash,
        canonicalJson(event), event.occurredAt, timestamp,
      );
      this.database.prepare(`
        INSERT INTO workflow_aggregate_projections (
          aggregate_type, aggregate_id, workflow_id, revision_id, last_sequence,
          last_event_id, last_event_type, last_event_hash, state_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(aggregate_type, aggregate_id) DO UPDATE SET
          workflow_id = excluded.workflow_id,
          revision_id = excluded.revision_id,
          last_sequence = excluded.last_sequence,
          last_event_id = excluded.last_event_id,
          last_event_type = excluded.last_event_type,
          last_event_hash = excluded.last_event_hash,
          state_json = excluded.state_json,
          updated_at = excluded.updated_at
      `).run(
        event.aggregateType, event.aggregateId, event.workflowId, event.revisionId,
        sequence, event.eventId, event.eventType, event.eventHash, stateJson, timestamp, timestamp,
      );
      this.database.prepare(`
        INSERT INTO workflow_outbox (event_id, sequence, topic, payload_json, created_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(event.eventId, sequence, `workflow.${event.eventType}`, canonicalJson(event), timestamp);
      this.database.prepare(`
        INSERT INTO workflow_ledger_head (singleton, last_sequence, last_event_hash, updated_at)
        VALUES (1, ?, ?, ?)
        ON CONFLICT(singleton) DO UPDATE SET
          last_sequence = excluded.last_sequence,
          last_event_hash = excluded.last_event_hash,
          updated_at = excluded.updated_at
      `).run(sequence, event.eventHash, timestamp);
      const projection = this.database.prepare(`
        SELECT * FROM workflow_aggregate_projections
        WHERE aggregate_type = ? AND aggregate_id = ?
      `).get(event.aggregateType, event.aggregateId);
      this.database.exec("COMMIT");
      return { idempotent: false, sequence, event, projection: projectionFromRow(projection) };
    } catch (error) {
      try {
        this.database.exec("ROLLBACK");
      } catch {
        // The statement may have already ended the transaction after an abort.
      }
      throw error;
    }
  }

  replay({ project = defaultProjection } = {}) {
    return auditLedger(this.database, { project }).projections;
  }

  /** Returns the reconstructed event-to-outbox correspondence after auditing it. */
  audit({ project = defaultProjection } = {}) {
    return auditLedger(this.database, { project });
  }

  rebuildProjections({ project = defaultProjection } = {}) {
    const projections = this.replay({ project });
    const timestamp = this.now();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.exec("DELETE FROM workflow_aggregate_projections");
      const insert = this.database.prepare(`
        INSERT INTO workflow_aggregate_projections (
          aggregate_type, aggregate_id, workflow_id, revision_id, last_sequence,
          last_event_id, last_event_type, last_event_hash, state_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const projection of projections) {
        insert.run(
          projection.aggregateType, projection.aggregateId, projection.workflowId,
          projection.revisionId, projection.lastSequence, projection.lastEventId,
          projection.lastEventType, projection.lastEventHash, canonicalJson(projection.state),
          timestamp, timestamp,
        );
      }
      this.database.exec("COMMIT");
      return projections;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
}
