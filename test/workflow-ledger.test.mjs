import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, test } from "node:test";

import {
  WORKFLOW_ERROR_CODES,
  WorkflowContractError,
  canonicalJson,
  createLedgerEventEnvelope,
} from "../shared/workflow-control.mjs";
import {
  WORKFLOW_LEDGER_SCHEMA_SQL,
  WorkflowLedger,
  auditWorkflowLedgerRows,
  ledgerEventIntent,
  migrateLocalWorkflowLedger,
} from "../server/workflow-ledger.mjs";
import { ledgerEvent } from "./fixtures/workflow-control.mjs";
import { createCloudWorkerHarness } from "./helpers/cloud-worker-harness.mjs";

const fixtures = [];
const projectRoot = path.resolve(import.meta.dirname, "..");
const ledgerColumns = [
  "sequence", "event_id", "event_type", "workflow_id", "revision_id",
  "aggregate_type", "aggregate_id", "correlation_id", "causation_id",
  "idempotency_key", "idempotency_fingerprint", "prev_hash", "event_hash",
  "envelope_json", "occurred_at", "created_at",
];

afterEach(async () => {
  // Close every connection FIRST, then remove directories in a second pass.
  // The competing-connections test opens two separate DatabaseSync handles
  // onto the same on-disk ledger.sqlite; if a directory is rm()'d while the
  // *other* fixture's connection to that same file is still open, Windows
  // refuses the unlink (EBUSY: resource busy or locked) because it doesn't
  // allow deleting a file that still has an open handle — Linux/macOS allow
  // it (the inode is unlinked but stays alive until the last fd closes), so
  // this only surfaced on the Windows runner. Closing all connections before
  // any rm() removes the open-handle race on every OS.
  const popped = [];
  while (fixtures.length > 0) {
    const fixture = fixtures.pop();
    popped.push(fixture);
    fixture.database?.close();
    await fixture.cloud?.dispose();
  }
  for (const fixture of popped) {
    if (fixture.directory) {
      await rm(fixture.directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
  }
});

function createTasksTable(database) {
  database.exec(`
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      status TEXT NOT NULL,
      stage_id TEXT,
      version INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
}

function createFixture({ filename = ":memory:" } = {}) {
  const database = new DatabaseSync(filename);
  database.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  createTasksTable(database);
  migrateLocalWorkflowLedger(database);
  const fixture = { database, ledger: new WorkflowLedger(database, { now: () => "2026-08-24T12:07:00.000Z" }) };
  fixtures.push(fixture);
  return fixture;
}

function requestedEvent(overrides = {}) {
  return ledgerEvent({
    eventId: "99999999-9999-4999-8999-999999999991",
    eventType: "transition.requested",
    idempotencyKey: "request-review-1",
    payload: {
      transitionId: "submit-review",
      fromStageId: "draft",
      toStageId: "reviewed",
      target: { type: "review", id: "review-1" },
    },
    ...overrides,
  });
}

function executedEvent(overrides = {}) {
  return ledgerEvent({
    eventId: "99999999-9999-4999-8999-999999999992",
    eventType: "transition.executed",
    idempotencyKey: "execute-review-1",
    payload: {
      transitionId: "submit-review",
      execution: { status: "succeeded", result: { output: "reviewed" } },
    },
    ...overrides,
  });
}

function insertOrReplaceLedgerRow(database, row) {
  return database.prepare(`
    INSERT OR REPLACE INTO workflow_ledger_events (${ledgerColumns.join(", ")})
    VALUES (${ledgerColumns.map(() => "?").join(", ")})
  `).run(...ledgerColumns.map((column) => row[column]));
}

function replacementCandidate(row, collisionColumn) {
  const candidate = {
    ...row,
    sequence: 100,
    event_id: "replacement-event",
    idempotency_key: "replacement-idempotency",
    event_hash: "d".repeat(64),
    idempotency_fingerprint: "replacement-intent",
    envelope_json: "{}",
  };
  candidate[collisionColumn] = row[collisionColumn];
  return candidate;
}

function cloudLedgerRow(event, sequence, createdAt = "2026-08-24T12:07:00.000Z") {
  return {
    sequence,
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
    envelope_json: canonicalJson(event),
    occurred_at: event.occurredAt,
    created_at: createdAt,
  };
}

function cloudLedgerInsertStatement(cloud, row, { replace = false } = {}) {
  return cloud.db.prepare(`
    INSERT ${replace ? "OR REPLACE " : ""}INTO workflow_ledger_events (${ledgerColumns.join(", ")})
    VALUES (${ledgerColumns.map(() => "?").join(", ")})
  `).bind(...ledgerColumns.map((column) => row[column]));
}

async function insertCloudLedgerRow(cloud, row, options = {}) {
  return cloudLedgerInsertStatement(cloud, row, options).run();
}

async function cloudAuditInput(cloud) {
  return {
    eventRows: (await cloud.db.prepare("SELECT * FROM workflow_ledger_events ORDER BY sequence").all()).results,
    head: await cloud.db.prepare("SELECT * FROM workflow_ledger_head WHERE singleton = 1").first(),
    outboxRows: (await cloud.db.prepare("SELECT * FROM workflow_outbox ORDER BY sequence").all()).results,
  };
}

function cloudMigrationStatements(source) {
  const statements = [];
  let current = [];
  let trigger = false;
  for (const sourceLine of source.split(/\r?\n/)) {
    const line = sourceLine.trim();
    if (line === "") continue;
    if (current.length === 0) trigger = /^CREATE\s+TRIGGER\b/i.test(line);
    current.push(line);
    if ((trigger ? /\bEND;$/i : /;$/).test(line)) {
      statements.push(current.join(" "));
      current = [];
      trigger = false;
    }
  }
  return statements.join("\n");
}

test("append atomically writes an immutable event, projection, outbox, and replayable hash chain", () => {
  const { database, ledger } = createFixture();
  const first = ledger.append(requestedEvent());
  const second = ledger.append(executedEvent());

  assert.equal(first.sequence, 1);
  assert.equal(second.sequence, 2);
  assert.equal(second.event.prevHash, first.event.eventHash);
  assert.equal(database.prepare("SELECT count(*) AS count FROM workflow_outbox").get().count, 2);
  assert.equal(database.prepare("SELECT count(*) AS count FROM workflow_aggregate_projections").get().count, 1);
  assert.deepEqual(ledger.replay(), [{
    aggregateType: "review",
    aggregateId: "review-1",
    workflowId: "contract-review",
    revisionId: "11111111-1111-4111-8111-111111111111",
    lastSequence: 2,
    lastEventId: second.event.eventId,
    lastEventType: "transition.executed",
    lastEventHash: second.event.eventHash,
    state: {
      lastEventType: "transition.executed",
      payload: { transitionId: "submit-review", execution: { status: "succeeded", result: { output: "reviewed" } } },
    },
  }]);
});

test("competing connections serialize writes and retain a contiguous sequence", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "taskboard-workflow-ledger-"));
  const filename = path.join(directory, "ledger.sqlite");
  const primary = createFixture({ filename });
  const secondDatabase = new DatabaseSync(filename);
  secondDatabase.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  fixtures.push({ database: secondDatabase, directory });
  const secondary = new WorkflowLedger(secondDatabase, { now: () => "2026-08-24T12:07:00.000Z" });

  const results = await Promise.all([
    Promise.resolve().then(() => primary.ledger.append(requestedEvent())),
    Promise.resolve().then(() => secondary.append(executedEvent())),
  ]);
  assert.deepEqual(results.map((result) => result.sequence).sort(), [1, 2]);
  assert.equal(primary.ledger.replay().at(0).lastSequence, 2);
});

test("a retry after an uncertain timeout returns the original effect, while a reused key with new intent conflicts", () => {
  const { ledger } = createFixture();
  const original = ledger.append(requestedEvent());
  const retried = ledger.append(requestedEvent({
    eventId: "99999999-9999-4999-8999-999999999993",
  }));
  assert.equal(retried.idempotent, true);
  assert.equal(retried.sequence, original.sequence);

  assert.throws(
    () => ledger.append(requestedEvent({ payload: {
      transitionId: "submit-review", fromStageId: "draft", toStageId: "accepted",
      target: { type: "review", id: "review-1" },
    } })),
    (error) => error instanceof WorkflowContractError && error.code === WORKFLOW_ERROR_CODES.IDEMPOTENCY_CONFLICT,
  );
});

test("replay detects an altered envelope and physical truncation", () => {
  const { database, ledger } = createFixture();
  ledger.append(requestedEvent());
  ledger.append(executedEvent());
  database.exec("DROP TRIGGER workflow_ledger_events_append_only_update");
  database.prepare("UPDATE workflow_ledger_events SET envelope_json = ? WHERE sequence = 1").run("{}");
  assert.throws(
    () => ledger.replay(),
    (error) => error instanceof WorkflowContractError && error.code === WORKFLOW_ERROR_CODES.LEDGER_HASH_INVALID,
  );

  const truncated = createFixture();
  truncated.ledger.append(requestedEvent());
  truncated.ledger.append(executedEvent());
  truncated.database.exec("DROP TRIGGER workflow_ledger_events_append_only_delete");
  truncated.database.exec("PRAGMA foreign_keys = OFF");
  truncated.database.exec("DELETE FROM workflow_ledger_events WHERE sequence = 2");
  truncated.database.exec("PRAGMA foreign_keys = ON");
  assert.throws(
    () => truncated.ledger.replay(),
    (error) => error instanceof WorkflowContractError && error.code === WORKFLOW_ERROR_CODES.LEDGER_HASH_INVALID,
  );
});

test("0015 blocks INSERT OR REPLACE on every immutable ledger identity, including a staged head rewrite", () => {
  const { database, ledger } = createFixture();
  ledger.append(requestedEvent());
  ledger.append(executedEvent());
  const row = database.prepare("SELECT * FROM workflow_ledger_events WHERE sequence = 1").get();
  const originalHead = { ...database.prepare("SELECT * FROM workflow_ledger_head WHERE singleton = 1").get() };
  assert.equal(database.prepare("PRAGMA recursive_triggers").get().recursive_triggers, 1);

  for (const column of ["sequence", "event_id", "idempotency_key", "event_hash"]) {
    assert.throws(
      () => insertOrReplaceLedgerRow(database, replacementCandidate(row, column)),
      /WORKFLOW_LEDGER_APPEND_ONLY/,
      column,
    );
  }

  database.exec("BEGIN IMMEDIATE");
  try {
    database.prepare(`
      UPDATE workflow_ledger_head
      SET last_sequence = ?, last_event_hash = ?, updated_at = ?
      WHERE singleton = 1
    `).run(1, "e".repeat(64), "2026-08-24T12:08:00.000Z");
    assert.throws(
      () => insertOrReplaceLedgerRow(database, replacementCandidate(row, "sequence")),
      /WORKFLOW_LEDGER_APPEND_ONLY/,
    );
  } finally {
    database.exec("ROLLBACK");
  }
  assert.deepEqual({ ...database.prepare("SELECT * FROM workflow_ledger_head WHERE singleton = 1").get() }, originalHead);
  assert.equal(ledger.replay().at(0).lastSequence, 2);
});

test("replay validates all denormalized event fields and the event-to-outbox correspondence", () => {
  const eventTypeChanged = createFixture();
  eventTypeChanged.ledger.append(requestedEvent());
  eventTypeChanged.database.exec("DROP TRIGGER workflow_ledger_events_append_only_update");
  eventTypeChanged.database.prepare(`
    UPDATE workflow_ledger_events SET event_type = 'transition.executed' WHERE sequence = 1
  `).run();
  assert.throws(
    () => eventTypeChanged.ledger.replay(),
    (error) => error instanceof WorkflowContractError && error.code === WORKFLOW_ERROR_CODES.LEDGER_HASH_INVALID,
  );

  const outboxDiverged = createFixture();
  outboxDiverged.ledger.append(requestedEvent());
  outboxDiverged.database.prepare(`
    UPDATE workflow_outbox SET topic = 'workflow.diverged' WHERE sequence = 1
  `).run();
  assert.throws(
    () => outboxDiverged.ledger.audit(),
    (error) => error instanceof WorkflowContractError && error.code === WORKFLOW_ERROR_CODES.LEDGER_HASH_INVALID,
  );
  assert.throws(
    () => outboxDiverged.ledger.replay(),
    (error) => error instanceof WorkflowContractError && error.code === WORKFLOW_ERROR_CODES.LEDGER_HASH_INVALID,
  );
});

test("a projection failure rolls back the event, projection, outbox, and ledger head together", () => {
  const { database, ledger } = createFixture();
  assert.throws(() => ledger.append(requestedEvent(), {
    project() { throw new Error("projection failure"); },
  }), /projection failure/);
  for (const table of ["workflow_ledger_events", "workflow_aggregate_projections", "workflow_outbox", "workflow_ledger_head"]) {
    assert.equal(database.prepare(`SELECT count(*) AS count FROM ${table}`).get().count, 0, table);
  }
});

test("local migration upgrades 0014 to idempotent 0015 hardening and preserves legacy import projections", () => {
  const database = new DatabaseSync(":memory:");
  fixtures.push({ database });
  createTasksTable(database);
  database.prepare(`
    INSERT INTO tasks VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run("legacy-task", "legacy-project", "todo", null, 7, "2026-01-01T00:00:00.000Z", "2026-02-01T00:00:00.000Z");
  database.exec(WORKFLOW_LEDGER_SCHEMA_SQL);
  assert.equal(database.prepare(`
    SELECT count(*) AS count FROM sqlite_schema
    WHERE type = 'trigger' AND name = 'workflow_ledger_events_prevent_replace_collision'
  `).get().count, 0);
  migrateLocalWorkflowLedger(database);
  migrateLocalWorkflowLedger(database);
  assert.deepEqual({ ...database.prepare("SELECT * FROM tasks WHERE id = 'legacy-task'").get() }, {
    id: "legacy-task", project_id: "legacy-project", status: "todo", stage_id: null,
    version: 7, created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-02-01T00:00:00.000Z",
  });
  assert.deepEqual({ ...database.prepare("SELECT projection_kind, last_event_sequence, last_event_hash FROM workflow_work_item_projections").get() }, {
    projection_kind: "work_item.imported", last_event_sequence: null, last_event_hash: null,
  });
  assert.equal(database.prepare("SELECT count(*) AS count FROM workflow_ledger_events").get().count, 0);
});

test("Cloud 0014→0015 is idempotent, blocks REPLACE plus head rewrites, and audits event/outbox tampering", async () => {
  const cloud = await createCloudWorkerHarness();
  fixtures.push({ cloud });
  const hardeningSql = await readFile(
    path.join(projectRoot, "cloud", "migrations", "0015_workflow_ledger_hardening.sql"),
    "utf8",
  );
  const hardeningStatements = cloudMigrationStatements(hardeningSql);
  await cloud.db.exec(hardeningStatements);
  await cloud.db.exec(hardeningStatements);
  const tables = await cloud.db.prepare(`
    SELECT name FROM sqlite_master
    WHERE type = 'table' AND name IN (
      'workflow_ledger_events', 'workflow_ledger_head', 'workflow_aggregate_projections',
      'workflow_outbox', 'workflow_work_item_projections'
    ) ORDER BY name
  `).all();
  assert.deepEqual(tables.results.map((row) => row.name), [
    "workflow_aggregate_projections", "workflow_ledger_events", "workflow_ledger_head",
    "workflow_outbox", "workflow_work_item_projections",
  ]);
  const triggers = await cloud.db.prepare(`
    SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'workflow_ledger_events_%'
    ORDER BY name
  `).all();
  assert.deepEqual(triggers.results.map((row) => row.name), [
    "workflow_ledger_events_append_only_delete",
    "workflow_ledger_events_append_only_update",
    "workflow_ledger_events_prevent_replace_collision",
  ]);

  const first = createLedgerEventEnvelope(requestedEvent());
  const second = createLedgerEventEnvelope(executedEvent({ prevHash: first.eventHash }));
  const firstRow = cloudLedgerRow(first, 1);
  const secondRow = cloudLedgerRow(second, 2);
  await insertCloudLedgerRow(cloud, firstRow);
  await insertCloudLedgerRow(cloud, secondRow);
  await cloud.db.prepare(`
    INSERT INTO workflow_ledger_head (singleton, last_sequence, last_event_hash, updated_at)
    VALUES (?, ?, ?, ?)
  `).bind(1, 2, second.eventHash, firstRow.created_at).run();
  for (const event of [first, second]) {
    const sequence = event === first ? 1 : 2;
    await cloud.db.prepare(`
      INSERT INTO workflow_outbox (event_id, sequence, topic, payload_json, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).bind(
      event.eventId, sequence, `workflow.${event.eventType}`, canonicalJson(event), firstRow.created_at,
    ).run();
  }

  for (const column of ["sequence", "event_id", "idempotency_key", "event_hash"]) {
    await assert.rejects(
      () => insertCloudLedgerRow(cloud, replacementCandidate(firstRow, column), { replace: true }),
      /WORKFLOW_LEDGER_APPEND_ONLY/,
      column,
    );
  }
  const originalHead = {
    ...await cloud.db.prepare("SELECT * FROM workflow_ledger_head WHERE singleton = 1").first(),
  };
  await assert.rejects(
    () => cloud.db.batch([
      cloud.db.prepare(`
        UPDATE workflow_ledger_head
        SET last_sequence = ?, last_event_hash = ?, updated_at = ?
        WHERE singleton = 1
      `).bind(1, "e".repeat(64), "2026-08-24T12:08:00.000Z"),
      cloudLedgerInsertStatement(cloud, replacementCandidate(firstRow, "sequence"), { replace: true }),
    ]),
    /WORKFLOW_LEDGER_APPEND_ONLY/,
  );
  assert.deepEqual(
    { ...await cloud.db.prepare("SELECT * FROM workflow_ledger_head WHERE singleton = 1").first() },
    originalHead,
  );
  assert.equal(auditWorkflowLedgerRows(await cloudAuditInput(cloud)).projections.at(0).lastSequence, 2);

  await cloud.db.exec("DROP TRIGGER workflow_ledger_events_append_only_update");
  await cloud.db.prepare(`
    UPDATE workflow_ledger_events SET event_type = 'transition.executed' WHERE sequence = 1
  `).run();
  const eventTypeTampered = await cloudAuditInput(cloud);
  assert.throws(
    () => auditWorkflowLedgerRows(eventTypeTampered),
    (error) => error instanceof WorkflowContractError && error.code === WORKFLOW_ERROR_CODES.LEDGER_HASH_INVALID,
  );
  await cloud.db.prepare(`
    UPDATE workflow_ledger_events SET event_type = 'transition.requested' WHERE sequence = 1
  `).run();
  await cloud.db.prepare(`
    UPDATE workflow_outbox SET payload_json = '{}' WHERE sequence = 2
  `).run();
  const outboxTampered = await cloudAuditInput(cloud);
  assert.throws(
    () => auditWorkflowLedgerRows(outboxTampered),
    (error) => error instanceof WorkflowContractError && error.code === WORKFLOW_ERROR_CODES.LEDGER_HASH_INVALID,
  );
});
