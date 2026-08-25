import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, test } from "node:test";

import { WORKFLOW_ERROR_CODES, WorkflowContractError } from "../shared/workflow-control.mjs";
import {
  WorkflowLedger,
  migrateLocalWorkflowLedger,
} from "../server/workflow-ledger.mjs";
import { ledgerEvent } from "./fixtures/workflow-control.mjs";
import { createCloudWorkerHarness } from "./helpers/cloud-worker-harness.mjs";

const fixtures = [];

afterEach(async () => {
  while (fixtures.length > 0) {
    const fixture = fixtures.pop();
    fixture.database?.close();
    if (fixture.directory) await rm(fixture.directory, { recursive: true, force: true });
    await fixture.cloud?.dispose();
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

test("a projection failure rolls back the event, projection, outbox, and ledger head together", () => {
  const { database, ledger } = createFixture();
  assert.throws(() => ledger.append(requestedEvent(), {
    project() { throw new Error("projection failure"); },
  }), /projection failure/);
  for (const table of ["workflow_ledger_events", "workflow_aggregate_projections", "workflow_outbox", "workflow_ledger_head"]) {
    assert.equal(database.prepare(`SELECT count(*) AS count FROM ${table}`).get().count, 0, table);
  }
});

test("local migration is idempotent and preserves legacy tasks as import-only projections", () => {
  const database = new DatabaseSync(":memory:");
  fixtures.push({ database });
  createTasksTable(database);
  database.prepare(`
    INSERT INTO tasks VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run("legacy-task", "legacy-project", "todo", null, 7, "2026-01-01T00:00:00.000Z", "2026-02-01T00:00:00.000Z");
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

test("the Cloud migration has the same append-only ledger and legacy projection boundary", async () => {
  const cloud = await createCloudWorkerHarness();
  fixtures.push({ cloud });
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
    SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'workflow_ledger_events_append_only_%'
    ORDER BY name
  `).all();
  assert.equal(triggers.results.length, 2);
});
