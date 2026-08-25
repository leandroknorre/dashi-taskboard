import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";

import { AutomationRunService } from "../server/automation-run-service.mjs";
import { TaskboardDatabase } from "../server/database.mjs";
import { migrateLocalAutomationRuns } from "../server/workflow-automation-run-schema.mjs";
import { TransitionService } from "../server/transition-service.mjs";
import { canonicalJson } from "../shared/workflow-control.mjs";

const fixtures = [];
const human = { type: "user", id: "automation-human", name: "Automation Human", avatarUrl: null };

afterEach(async () => {
  while (fixtures.length > 0) {
    const fixture = fixtures.pop();
    fixture.database.close();
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

async function createFixture({ clock, leaseToken } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "taskboard-automation-run-"));
  const filename = path.join(directory, "taskboard.sqlite");
  const database = new TaskboardDatabase(filename);
  database.createProject({ id: "automation-project", name: "Automation project", workspacePath: "/tmp/automation" });
  const fixture = {
    directory,
    filename,
    database,
    transitions: new TransitionService(database),
    runs: new AutomationRunService(database, { clock, leaseToken }),
  };
  fixtures.push(fixture);
  return fixture;
}

function createTask(fixture, title) {
  return fixture.database.createTask({
    projectId: "automation-project",
    title,
    description: "",
    status: "todo",
    priority: "none",
    labels: [],
    threadId: null,
    actor: human,
    assignee: human,
    developmentContext: null,
    startDate: null,
    dueDate: null,
    recurrence: null,
  });
}

function nonTerminalAction(service, taskId) {
  const action = service.listActions(taskId).find((candidate) => candidate.toTerminalKind === "none");
  assert.ok(action, "fixture must have a non-terminal transition");
  return action;
}

function transition(fixture, task, key) {
  const action = nonTerminalAction(fixture.transitions, task.id);
  return fixture.transitions.transition(task.id, {
    expectedStateVersion: task.version,
    actionKey: action.actionKey,
    gateEvidence: [],
    authorizationId: null,
    idempotencyKey: key,
  }, { actor: human });
}

function revisionStorage(fixture, revisionId) {
  const bindings = fixture.database.database.prepare(`
    SELECT contract_stage_id, task_stage_id, canonical_status, terminal_kind, stage_order
    FROM workflow_revision_stage_bindings WHERE revision_id = ? ORDER BY stage_order
  `).all(revisionId).map((row) => ({
    contractStageId: row.contract_stage_id,
    taskStageId: row.task_stage_id,
    canonicalStatus: row.canonical_status,
    terminalKind: row.terminal_kind,
    order: row.stage_order,
  }));
  const rules = fixture.database.database.prepare(`
    SELECT action_key, transition_id, from_task_stage_id, to_task_stage_id,
      from_contract_stage_id, to_contract_stage_id, to_terminal_kind, legacy
    FROM workflow_transition_rules WHERE revision_id = ? ORDER BY action_key
  `).all(revisionId).map((row) => ({
    actionKey: row.action_key,
    transitionId: row.transition_id,
    fromTaskStageId: row.from_task_stage_id,
    toTaskStageId: row.to_task_stage_id,
    fromContractStageId: row.from_contract_stage_id,
    toContractStageId: row.to_contract_stage_id,
    toTerminalKind: row.to_terminal_kind,
    legacy: row.legacy === 1,
  }));
  return { bindings, rules };
}

function publishMode(fixture, mode) {
  const seed = createTask(fixture, `Seed ${mode}`);
  const current = fixture.transitions.getTaskWorkflow(seed.id);
  const definition = structuredClone(current.definition);
  const profileRevisionId = randomUUID();
  definition.revisionId = randomUUID();
  definition.revision += 1;
  definition.createdAt = "2026-08-25T00:00:00.000Z";
  definition.agentProfileRevisions = definition.agentProfileRevisions.map((profile) => ({
    ...profile,
    agentProfileId: `automation-${mode}`,
    agentProfileRevisionId: profileRevisionId,
    revision: profile.revision + 1,
    mode,
  }));
  definition.stages = definition.stages.map((stage) => ({ ...stage, agentProfileRevisionId: profileRevisionId }));
  const { bindings, rules } = revisionStorage(fixture, current.revisionId);
  return fixture.transitions.publishRevision({
    projectId: "automation-project",
    definition,
    bindings,
    rules,
  });
}

function replaceRequestTableWithLegacyRow(fixture, { runId, command, createdAt, operation = "dispatch" }) {
  fixture.database.database.exec("DROP TABLE workflow_automation_run_requests");
  fixture.database.database.exec(`
    CREATE TABLE workflow_automation_run_requests (
      idempotency_key TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES workflow_automation_runs(run_id) ON DELETE CASCADE,
      operation TEXT NOT NULL CHECK (operation IN ('dispatch', 'result')),
      request_fingerprint TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `);
  fixture.database.database.prepare(`
    INSERT INTO workflow_automation_run_requests (
      idempotency_key, run_id, operation, request_fingerprint, created_at
    ) VALUES (?, ?, ?, ?, ?)
  `).run(
    command.idempotencyKey,
    runId,
    operation,
    canonicalJson({ operation, runId, ...command }),
    createdAt,
  );
}

test("manual stage entry creates one deterministic pending run and explicit dispatch writes one adapter outbox row", async () => {
  const fixture = await createFixture();
  const task = createTask(fixture, "Manual stage entry");
  const action = nonTerminalAction(fixture.transitions, task.id);
  const input = {
    expectedStateVersion: task.version,
    actionKey: action.actionKey,
    gateEvidence: [],
    authorizationId: null,
    idempotencyKey: "automation-transition-one",
  };
  const first = fixture.transitions.transition(task.id, input, { actor: human });
  const retried = fixture.transitions.transition(task.id, input, { actor: human });

  assert.equal(first.automationRun.mode, "manual");
  assert.equal(first.automationRun.status, "pending");
  assert.equal(first.automationRun.taskId, task.id);
  assert.equal(first.automationRun.transitionEventId, first.event.eventId);
  assert.equal(first.automationRun.revisionId, first.request.revisionId);
  assert.equal(retried.idempotent, true);
  assert.equal(retried.automationRun.runId, first.automationRun.runId);
  assert.equal(fixture.runs.listForTask(task.id).length, 1);
  assert.equal(fixture.database.database.prepare("SELECT COUNT(*) AS count FROM workflow_automation_run_outbox").get().count, 0);

  assert.throws(
    () => fixture.runs.dispatch(first.automationRun.runId, {
      expectedVersion: 99,
      idempotencyKey: "automation-stale-dispatch",
    }, { actor: human }),
    (error) => error?.status === 409 && error?.code === "AUTOMATION_RUN_VERSION_CONFLICT",
  );
  assert.throws(
    () => fixture.runs.dispatch(first.automationRun.runId, {
      expectedVersion: 1,
      idempotencyKey: "automation-agent-dispatch",
    }, { actor: { type: "agent", id: "adapter", name: "Adapter", avatarUrl: null } }),
    (error) => error?.status === 403 && error?.code === "AUTOMATION_RUN_DISPATCH_FORBIDDEN",
  );

  const dispatched = fixture.runs.dispatch(first.automationRun.runId, {
    expectedVersion: 1,
    leaseSeconds: 60,
    idempotencyKey: "automation-manual-dispatch",
  }, { actor: human });
  const dispatchRetry = fixture.runs.dispatch(first.automationRun.runId, {
    expectedVersion: 1,
    leaseSeconds: 60,
    idempotencyKey: "automation-manual-dispatch",
  }, { actor: human });

  assert.equal(dispatched.run.status, "dispatched");
  assert.equal(dispatched.run.version, 2);
  assert.match(dispatched.leaseToken, /^[0-9a-f-]{36}$/i);
  assert.equal(dispatchRetry.idempotent, true);
  assert.equal(dispatchRetry.leaseToken, dispatched.leaseToken);
  assert.equal(fixture.database.database.prepare("SELECT COUNT(*) AS count FROM workflow_automation_run_outbox").get().count, 1);
  const outbox = JSON.parse(fixture.database.database.prepare("SELECT payload_json FROM workflow_automation_run_outbox").get().payload_json);
  assert.equal(outbox.runId, first.automationRun.runId);
  assert.equal(Object.hasOwn(outbox, "leaseToken"), false);
  assert.throws(
    () => fixture.database.database.prepare(`
      INSERT OR REPLACE INTO workflow_automation_runs
      SELECT * FROM workflow_automation_runs WHERE run_id = ?
    `).run(first.automationRun.runId),
    /WORKFLOW_AUTOMATION_RUN_IMMUTABLE/,
  );
});

test("result requires the dispatch lease, redacts payloads, and is idempotent", async () => {
  const fixture = await createFixture();
  const task = createTask(fixture, "Result lifecycle");
  const created = transition(fixture, task, "automation-transition-result");
  const dispatched = fixture.runs.dispatch(created.automationRun.runId, {
    expectedVersion: 1,
    idempotencyKey: "automation-result-dispatch",
  }, { actor: human });

  assert.throws(
    () => fixture.runs.recordResult(created.automationRun.runId, {
      expectedVersion: 2,
      leaseToken: randomUUID(),
      status: "succeeded",
      result: { summary: "wrong lease" },
      idempotencyKey: "automation-wrong-lease",
    }),
    (error) => error?.status === 409 && error?.code === "AUTOMATION_RUN_LEASE_INVALID",
  );
  assert.throws(
    () => fixture.runs.recordResult(created.automationRun.runId, {
      expectedVersion: 2,
      leaseToken: dispatched.leaseToken,
      status: "succeeded",
      result: { detail: "x".repeat(16 * 1024) },
      idempotencyKey: "automation-too-large-result",
    }),
    (error) => error?.status === 400 && error?.code === "AUTOMATION_RUN_PAYLOAD_TOO_LARGE",
  );

  const completed = fixture.runs.recordResult(created.automationRun.runId, {
    expectedVersion: 2,
    leaseToken: dispatched.leaseToken,
    status: "succeeded",
    result: { summary: "recorded", nested: { accessToken: "never-store-this" } },
    idempotencyKey: "automation-result-one",
  }, { actor: { type: "agent", id: "external-adapter", name: "External adapter", avatarUrl: null } });
  const replay = fixture.runs.recordResult(created.automationRun.runId, {
    expectedVersion: 2,
    leaseToken: dispatched.leaseToken,
    status: "succeeded",
    result: { summary: "recorded", nested: { accessToken: "another-secret" } },
    idempotencyKey: "automation-result-one",
  }, { actor: { type: "agent", id: "external-adapter", name: "External adapter", avatarUrl: null } });

  assert.equal(completed.run.status, "succeeded");
  assert.equal(completed.run.version, 3);
  assert.equal(completed.run.result.nested.accessToken, "[redacted]");
  assert.equal(replay.idempotent, true);
  assert.throws(
    () => fixture.runs.recordResult(created.automationRun.runId, {
      expectedVersion: 2,
      leaseToken: randomUUID(),
      status: "succeeded",
      result: { summary: "recorded", nested: { accessToken: "never-store-this" } },
      idempotencyKey: "automation-result-one",
    }, { actor: { type: "agent", id: "external-adapter", name: "External adapter", avatarUrl: null } }),
    (error) => error?.status === 409 && error?.code === "AUTOMATION_RUN_LEASE_INVALID",
  );
  assert.equal(fixture.runs.get(created.automationRun.runId).events.length, 3);
});

test("secret key variants are redacted before persistence and every local read path", async () => {
  const fixture = await createFixture();
  const task = createTask(fixture, "Redaction variants");
  const created = transition(fixture, task, "automation-redaction-transition");
  const dispatched = fixture.runs.dispatch(created.automationRun.runId, {
    expectedVersion: 1,
    idempotencyKey: "automation-redaction-dispatch",
  }, { actor: human });
  const secrets = {
    privateKey: "private-camel-secret",
    private_key: "private-underscore-secret",
    "private-key": "private-hyphen-secret",
    accessKey: "access-camel-secret",
    access_key: "access-underscore-secret",
    "access-key": "access-hyphen-secret",
    apiKey: "api-secret",
    secret: "secret-value",
    token: "token-value",
    password: "password-value",
    authorization: "authorization-value",
    cookie: "cookie-value",
    nested: { signingKey: "signing-secret", sessionId: "session-secret" },
  };
  const completed = fixture.runs.recordResult(created.automationRun.runId, {
    expectedVersion: 2,
    leaseToken: dispatched.leaseToken,
    status: "succeeded",
    result: secrets,
    idempotencyKey: "automation-redaction-result",
  }, { actor: { type: "agent", id: "redaction-adapter", name: "Redaction Adapter", avatarUrl: null } });

  for (const key of ["privateKey", "private_key", "private-key", "accessKey", "access_key", "access-key", "apiKey", "secret", "token", "password", "authorization", "cookie"]) {
    assert.equal(completed.run.result[key], "[redacted]");
  }
  assert.equal(completed.run.result.nested.signingKey, "[redacted]");
  assert.equal(completed.run.result.nested.sessionId, "[redacted]");

  const values = Object.values(secrets).filter((value) => typeof value === "string");
  values.push("signing-secret", "session-secret", dispatched.leaseToken);
  const stored = [
    ...fixture.database.database.prepare("SELECT payload_json FROM workflow_automation_runs WHERE run_id = ?").all(created.automationRun.runId).map((row) => row.payload_json),
    ...fixture.database.database.prepare("SELECT result_json FROM workflow_automation_runs WHERE run_id = ?").all(created.automationRun.runId).map((row) => row.result_json),
    ...fixture.database.database.prepare("SELECT payload_json FROM workflow_automation_run_events WHERE run_id = ?").all(created.automationRun.runId).map((row) => row.payload_json),
    ...fixture.database.database.prepare("SELECT payload_json FROM workflow_automation_run_outbox WHERE run_id = ?").all(created.automationRun.runId).map((row) => row.payload_json),
    ...fixture.database.database.prepare("SELECT request_fingerprint, response_json FROM workflow_automation_run_requests WHERE run_id = ?").all(created.automationRun.runId).flatMap((row) => [row.request_fingerprint, row.response_json]),
  ].filter((value) => value !== null);
  for (const serialized of stored) {
    for (const value of values) assert.equal(serialized.includes(value), false, `stored JSON leaked ${value}`);
  }

  const listed = fixture.runs.listForTask(task.id)[0];
  const detail = fixture.runs.get(created.automationRun.runId);
  assert.equal(listed.result.privateKey, "[redacted]");
  assert.equal(detail.result.accessKey, "[redacted]");
  assert.equal(detail.events.at(-1).payload.privateKey, "[redacted]");
  assert.equal(Object.hasOwn(detail, "leaseToken"), false);
});

test("a result inside the 16 KiB limit still records its historical response snapshot", async () => {
  const fixture = await createFixture();
  const task = createTask(fixture, "Large result snapshot");
  const created = transition(fixture, task, "automation-large-result-transition");
  const dispatched = fixture.runs.dispatch(created.automationRun.runId, {
    expectedVersion: 1,
    idempotencyKey: "automation-large-result-dispatch",
  }, { actor: human });
  const command = {
    expectedVersion: 2,
    leaseToken: dispatched.leaseToken,
    status: "succeeded",
    result: { detail: "x".repeat(15_800) },
    idempotencyKey: "automation-large-result-record",
  };
  const completed = fixture.runs.recordResult(created.automationRun.runId, command, { actor: human });
  const replay = fixture.runs.recordResult(created.automationRun.runId, command, { actor: human });
  assert.equal(completed.run.status, "succeeded");
  assert.equal(replay.idempotent, true);
});

test("0016 reentry scrubs pre-fix sensitive JSON from payload, result, events, outbox, and request responses", async () => {
  const fixture = await createFixture();
  const task = createTask(fixture, "Legacy redaction migration");
  const created = transition(fixture, task, "automation-legacy-redaction-transition");
  const dispatched = fixture.runs.dispatch(created.automationRun.runId, {
    expectedVersion: 1,
    idempotencyKey: "automation-legacy-redaction-dispatch",
  }, { actor: human });
  const raw = { privateKey: "legacy-private-value", access_key: "legacy-access-value" };
  const database = fixture.database.database;
  database.prepare("UPDATE workflow_automation_runs SET payload_json = ?, result_json = ? WHERE run_id = ?").run(
    canonicalJson(raw), canonicalJson(raw), created.automationRun.runId,
  );
  database.exec("DROP TRIGGER workflow_automation_run_events_immutable_update");
  database.prepare("UPDATE workflow_automation_run_events SET payload_json = ? WHERE run_id = ? AND event_type = 'run.dispatched'").run(
    canonicalJson(raw), created.automationRun.runId,
  );
  database.exec("DROP TRIGGER workflow_automation_run_outbox_immutable_update");
  database.prepare("UPDATE workflow_automation_run_outbox SET payload_json = ? WHERE run_id = ?").run(
    canonicalJson(raw), created.automationRun.runId,
  );
  database.exec("DROP TRIGGER workflow_automation_run_requests_immutable_update");
  database.prepare(`
    UPDATE workflow_automation_run_requests
    SET request_fingerprint = ?, response_json = ?
    WHERE idempotency_key = ?
  `).run(
    canonicalJson({ operation: "dispatch", runId: created.automationRun.runId, expectedVersion: 1, idempotencyKey: "automation-legacy-redaction-dispatch", privateKey: raw.privateKey }),
    canonicalJson({ run: { result: raw } }),
    "automation-legacy-redaction-dispatch",
  );

  migrateLocalAutomationRuns(database);
  const serialized = [
    ...database.prepare("SELECT payload_json, result_json FROM workflow_automation_runs WHERE run_id = ?").all(created.automationRun.runId).flatMap((row) => [row.payload_json, row.result_json]),
    ...database.prepare("SELECT payload_json FROM workflow_automation_run_events WHERE run_id = ?").all(created.automationRun.runId).map((row) => row.payload_json),
    ...database.prepare("SELECT payload_json FROM workflow_automation_run_outbox WHERE run_id = ?").all(created.automationRun.runId).map((row) => row.payload_json),
    ...database.prepare("SELECT request_fingerprint, response_json FROM workflow_automation_run_requests WHERE run_id = ?").all(created.automationRun.runId).flatMap((row) => [row.request_fingerprint, row.response_json]),
  ];
  for (const text of serialized) {
    assert.equal(text.includes(raw.privateKey), false);
    assert.equal(text.includes(raw.access_key), false);
  }
  assert.equal(fixture.runs.listForTask(task.id)[0].payload.privateKey, "[redacted]");
  assert.equal(fixture.runs.get(created.automationRun.runId).events.find((event) => event.type === "run.dispatched").payload.access_key, "[redacted]");
  assert.equal(dispatched.leaseToken.length > 0, true);
});

test("an explicitly reclaimed expired lease creates one new attempt without exposing it to an old idempotency retry", async () => {
  let instant = "2026-08-25T12:00:00.000Z";
  const fixture = await createFixture({ clock: () => instant });
  const task = createTask(fixture, "Expired manual lease");
  const created = transition(fixture, task, "automation-expired-transition");
  const first = fixture.runs.dispatch(created.automationRun.runId, {
    expectedVersion: 1,
    leaseSeconds: 30,
    idempotencyKey: "automation-expired-first-dispatch",
  }, { actor: human });

  instant = "2026-08-25T12:00:31.000Z";
  assert.throws(
    () => fixture.runs.recordResult(created.automationRun.runId, {
      expectedVersion: 2,
      leaseToken: first.leaseToken,
      status: "succeeded",
      result: { summary: "too late" },
      idempotencyKey: "automation-expired-result",
    }),
    (error) => error?.status === 409 && error?.code === "AUTOMATION_RUN_LEASE_EXPIRED",
  );

  const reclaimed = fixture.runs.dispatch(created.automationRun.runId, {
    expectedVersion: 2,
    leaseSeconds: 30,
    idempotencyKey: "automation-expired-reclaim",
  }, { actor: human });
  assert.equal(reclaimed.run.status, "dispatched");
  assert.equal(reclaimed.run.version, 3);
  assert.equal(reclaimed.run.dispatchAttempt, 2);
  assert.notEqual(reclaimed.leaseToken, first.leaseToken);
  assert.equal(fixture.database.database.prepare("SELECT COUNT(*) AS count FROM workflow_automation_run_outbox").get().count, 2);

  const oldReplay = fixture.runs.dispatch(created.automationRun.runId, {
    expectedVersion: 1,
    leaseSeconds: 30,
    idempotencyKey: "automation-expired-first-dispatch",
  }, { actor: human });
  assert.equal(oldReplay.idempotent, true);
  assert.equal(oldReplay.leaseToken, first.leaseToken);
  assert.throws(
    () => fixture.runs.dispatch(created.automationRun.runId, {
      expectedVersion: 1,
      leaseSeconds: 30,
      idempotencyKey: "automation-expired-first-dispatch",
    }, { actor: { type: "user", id: "different-human", name: "Different Human", avatarUrl: null } }),
    (error) => error?.status === 409 && error?.code === "AUTOMATION_RUN_IDEMPOTENCY_CONFLICT",
  );

  const completed = fixture.runs.recordResult(created.automationRun.runId, {
    expectedVersion: 3,
    leaseToken: reclaimed.leaseToken,
    status: "succeeded",
    result: { summary: "reclaimed and completed" },
    idempotencyKey: "automation-expired-reclaimed-result",
  }, { actor: human });
  assert.equal(completed.run.status, "succeeded");
  assert.deepEqual(
    fixture.runs.get(created.automationRun.runId).events.map((event) => event.type),
    ["run.created", "run.dispatched", "run.dispatched", "run.succeeded"],
  );
  assert.equal(fixture.runs.get(created.automationRun.runId).events[2].payload.reclaimedExpiredLease, true);
});

test("0016 reentry upgrades provisional request rows and preserves their dispatch replay", async () => {
  const fixture = await createFixture();
  const task = createTask(fixture, "Provisional migration row");
  const created = transition(fixture, task, "automation-provisional-transition");
  const command = {
    expectedVersion: 1,
    leaseSeconds: 60,
    idempotencyKey: "automation-provisional-dispatch",
  };
  const dispatched = fixture.runs.dispatch(created.automationRun.runId, command, { actor: human });
  const previous = fixture.database.database.prepare(`
    SELECT idempotency_key, run_id, operation, request_fingerprint, created_at
    FROM workflow_automation_run_requests WHERE idempotency_key = ?
  `).get(command.idempotencyKey);
  fixture.database.database.exec("DROP TABLE workflow_automation_run_requests");
  fixture.database.database.exec(`
    CREATE TABLE workflow_automation_run_requests (
      idempotency_key TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES workflow_automation_runs(run_id) ON DELETE CASCADE,
      operation TEXT NOT NULL CHECK (operation IN ('dispatch', 'result')),
      request_fingerprint TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `);
  fixture.database.database.prepare(`
    INSERT INTO workflow_automation_run_requests (
      idempotency_key, run_id, operation, request_fingerprint, created_at
    ) VALUES (?, ?, ?, ?, ?)
  `).run(
    previous.idempotency_key,
    previous.run_id,
    previous.operation,
    previous.request_fingerprint,
    previous.created_at,
  );
  migrateLocalAutomationRuns(fixture.database.database);
  migrateLocalAutomationRuns(fixture.database.database);
  const columns = fixture.database.database.prepare("PRAGMA table_info(workflow_automation_run_requests)").all();
  assert.ok(columns.some((column) => column.name === "lease_token"));
  assert.ok(columns.some((column) => column.name === "actor_id"));
  const replay = fixture.runs.dispatch(created.automationRun.runId, command, { actor: human });
  assert.equal(replay.idempotent, true);
  assert.equal(replay.leaseToken, dispatched.leaseToken);
});

test("legacy dispatch migrated before reclaim preserves its historical response and never upgrades its lease", async () => {
  let instant = "2026-08-26T12:00:00.000Z";
  const originalActor = { type: "user", id: "legacy-original", name: "Legacy Original", avatarUrl: null };
  const reclaimingActor = { type: "user", id: "legacy-reclaimer", name: "Legacy Reclaimer", avatarUrl: null };
  const fixture = await createFixture({ clock: () => instant });
  const task = createTask(fixture, "Legacy migration before reclaim");
  const created = transition(fixture, task, "legacy-before-transition");
  const command = { expectedVersion: 1, leaseSeconds: 30, idempotencyKey: "legacy-before-dispatch" };
  const original = fixture.runs.dispatch(created.automationRun.runId, command, { actor: originalActor });
  const request = fixture.database.database.prepare(`
    SELECT created_at FROM workflow_automation_run_requests WHERE idempotency_key = ?
  `).get(command.idempotencyKey);
  replaceRequestTableWithLegacyRow(fixture, { runId: created.automationRun.runId, command, createdAt: request.created_at });

  migrateLocalAutomationRuns(fixture.database.database);
  const recovered = fixture.database.database.prepare(`
    SELECT lease_token, actor_id, response_json, replay_state
    FROM workflow_automation_run_requests WHERE idempotency_key = ?
  `).get(command.idempotencyKey);
  assert.equal(recovered.lease_token, original.leaseToken);
  assert.equal(recovered.actor_id, originalActor.id);
  assert.equal(recovered.replay_state, "available");
  assert.doesNotMatch(recovered.response_json, new RegExp(original.leaseToken, "i"));

  instant = "2026-08-26T12:00:31.000Z";
  const reclaimed = fixture.runs.dispatch(created.automationRun.runId, {
    expectedVersion: 2,
    leaseSeconds: 30,
    idempotencyKey: "legacy-before-reclaim",
  }, { actor: reclaimingActor });
  assert.notEqual(reclaimed.leaseToken, original.leaseToken);

  const oldReplay = fixture.runs.dispatch(created.automationRun.runId, command, { actor: originalActor });
  assert.equal(oldReplay.idempotent, true);
  assert.equal(oldReplay.leaseToken, original.leaseToken);
  assert.equal(oldReplay.run.version, 2);
  assert.equal(oldReplay.run.dispatchAttempt, 1);
  assert.throws(
    () => fixture.runs.dispatch(created.automationRun.runId, command, { actor: reclaimingActor }),
    (error) => error?.status === 409 && error?.code === "AUTOMATION_RUN_IDEMPOTENCY_CONFLICT",
  );
});

test("legacy dispatch reclaimed before migration fails closed instead of receiving the active replacement lease", async () => {
  let instant = "2026-08-27T12:00:00.000Z";
  const originalActor = { type: "user", id: "legacy-old", name: "Legacy Old", avatarUrl: null };
  const reclaimingActor = { type: "user", id: "legacy-new", name: "Legacy New", avatarUrl: null };
  const fixture = await createFixture({ clock: () => instant });
  const task = createTask(fixture, "Legacy migration after reclaim");
  const created = transition(fixture, task, "legacy-after-transition");
  const command = { expectedVersion: 1, leaseSeconds: 30, idempotencyKey: "legacy-after-dispatch" };
  const original = fixture.runs.dispatch(created.automationRun.runId, command, { actor: originalActor });
  const request = fixture.database.database.prepare(`
    SELECT created_at FROM workflow_automation_run_requests WHERE idempotency_key = ?
  `).get(command.idempotencyKey);

  instant = "2026-08-27T12:00:31.000Z";
  const reclaimed = fixture.runs.dispatch(created.automationRun.runId, {
    expectedVersion: 2,
    leaseSeconds: 30,
    idempotencyKey: "legacy-after-reclaim",
  }, { actor: reclaimingActor });
  replaceRequestTableWithLegacyRow(fixture, { runId: created.automationRun.runId, command, createdAt: request.created_at });
  migrateLocalAutomationRuns(fixture.database.database);

  const unavailable = fixture.database.database.prepare(`
    SELECT lease_token, actor_id, response_json, replay_state, request_fingerprint
    FROM workflow_automation_run_requests WHERE idempotency_key = ?
  `).get(command.idempotencyKey);
  assert.equal(unavailable.lease_token, null);
  assert.equal(unavailable.actor_id, originalActor.id);
  assert.equal(unavailable.replay_state, "unavailable");
  assert.doesNotMatch(unavailable.response_json, new RegExp(reclaimed.leaseToken, "i"));
  assert.doesNotMatch(unavailable.request_fingerprint, new RegExp(original.leaseToken, "i"));
  assert.doesNotMatch(unavailable.request_fingerprint, new RegExp(reclaimed.leaseToken, "i"));

  assert.throws(
    () => fixture.runs.dispatch(created.automationRun.runId, command, { actor: originalActor }),
    (error) => error?.status === 409 && error?.code === "AUTOMATION_RUN_REPLAY_UNAVAILABLE",
  );
  assert.throws(
    () => fixture.runs.dispatch(created.automationRun.runId, command, { actor: reclaimingActor }),
    (error) => error?.status === 409 && error?.code === "AUTOMATION_RUN_IDEMPOTENCY_CONFLICT",
  );
  assert.notEqual(reclaimed.leaseToken, original.leaseToken);
});

test("legacy result migration recovers its actor only from the linked terminal event", async () => {
  const instant = "2026-08-28T12:00:00.000Z";
  const resultActor = { type: "agent", id: "legacy-result-agent", name: "Legacy Result Agent", avatarUrl: null };
  const differentActor = { type: "agent", id: "legacy-result-other", name: "Legacy Result Other", avatarUrl: null };
  const fixture = await createFixture({ clock: () => instant });
  const task = createTask(fixture, "Legacy result actor recovery");
  const created = transition(fixture, task, "legacy-result-recovery-transition");
  const dispatched = fixture.runs.dispatch(created.automationRun.runId, {
    expectedVersion: 1,
    idempotencyKey: "legacy-result-recovery-dispatch",
  }, { actor: human });
  const command = {
    expectedVersion: 2,
    leaseToken: dispatched.leaseToken,
    status: "succeeded",
    result: { summary: "legacy terminal result" },
    idempotencyKey: "legacy-result-recovery-result",
  };
  fixture.runs.recordResult(created.automationRun.runId, command, { actor: resultActor });
  const request = fixture.database.database.prepare(`
    SELECT created_at FROM workflow_automation_run_requests WHERE idempotency_key = ?
  `).get(command.idempotencyKey);
  replaceRequestTableWithLegacyRow(fixture, {
    runId: created.automationRun.runId,
    command,
    createdAt: request.created_at,
    operation: "result",
  });

  migrateLocalAutomationRuns(fixture.database.database);
  const recovered = fixture.database.database.prepare(`
    SELECT actor_type, actor_id, response_json, replay_state
    FROM workflow_automation_run_requests WHERE idempotency_key = ?
  `).get(command.idempotencyKey);
  assert.equal(recovered.actor_type, resultActor.type);
  assert.equal(recovered.actor_id, resultActor.id);
  assert.equal(recovered.replay_state, "available");
  assert.doesNotMatch(recovered.response_json, new RegExp(dispatched.leaseToken, "i"));

  const replay = fixture.runs.recordResult(created.automationRun.runId, command, { actor: resultActor });
  assert.equal(replay.idempotent, true);
  assert.throws(
    () => fixture.runs.recordResult(created.automationRun.runId, command, { actor: differentActor }),
    (error) => error?.status === 409 && error?.code === "AUTOMATION_RUN_IDEMPOTENCY_CONFLICT",
  );
});

test("legacy result without actor proof is unavailable to both the original and a different actor", async () => {
  const instant = "2026-08-29T12:00:00.000Z";
  const resultActor = { type: "agent", id: "legacy-result-unproven", name: "Legacy Result Unproven", avatarUrl: null };
  const differentActor = { type: "agent", id: "legacy-result-intruder", name: "Legacy Result Intruder", avatarUrl: null };
  const fixture = await createFixture({ clock: () => instant });
  const task = createTask(fixture, "Legacy result actor unavailable");
  const created = transition(fixture, task, "legacy-result-unavailable-transition");
  const dispatched = fixture.runs.dispatch(created.automationRun.runId, {
    expectedVersion: 1,
    idempotencyKey: "legacy-result-unavailable-dispatch",
  }, { actor: human });
  const command = {
    expectedVersion: 2,
    leaseToken: dispatched.leaseToken,
    status: "succeeded",
    result: { summary: "do not replay this historical result" },
    idempotencyKey: "legacy-result-unavailable-result",
  };
  fixture.runs.recordResult(created.automationRun.runId, command, { actor: resultActor });
  const request = fixture.database.database.prepare(`
    SELECT created_at FROM workflow_automation_run_requests WHERE idempotency_key = ?
  `).get(command.idempotencyKey);
  const unlinkedCreatedAt = new Date(Date.parse(request.created_at) + 1).toISOString();
  replaceRequestTableWithLegacyRow(fixture, {
    runId: created.automationRun.runId,
    command,
    createdAt: unlinkedCreatedAt,
    operation: "result",
  });

  migrateLocalAutomationRuns(fixture.database.database);
  migrateLocalAutomationRuns(fixture.database.database);
  const unavailable = fixture.database.database.prepare(`
    SELECT actor_type, actor_id, response_json, replay_state
    FROM workflow_automation_run_requests WHERE idempotency_key = ?
  `).get(command.idempotencyKey);
  assert.equal(unavailable.actor_type, null);
  assert.equal(unavailable.actor_id, null);
  assert.equal(unavailable.replay_state, "unavailable");
  assert.doesNotMatch(unavailable.response_json, /do not replay this historical result/);

  for (const actor of [resultActor, differentActor]) {
    assert.throws(
      () => fixture.runs.recordResult(created.automationRun.runId, command, { actor }),
      (error) => error?.status === 409 && error?.code === "AUTOMATION_RUN_REPLAY_UNAVAILABLE",
    );
  }
});

test("reentry downgrades a previously available result replay when its actor proof is missing", async () => {
  const resultActor = { type: "agent", id: "previous-result-actor", name: "Previous Result Actor", avatarUrl: null };
  const differentActor = { type: "agent", id: "previous-result-intruder", name: "Previous Result Intruder", avatarUrl: null };
  const fixture = await createFixture();
  const task = createTask(fixture, "Previously migrated result actor");
  const created = transition(fixture, task, "previous-result-actor-transition");
  const dispatched = fixture.runs.dispatch(created.automationRun.runId, {
    expectedVersion: 1,
    idempotencyKey: "previous-result-actor-dispatch",
  }, { actor: human });
  const command = {
    expectedVersion: 2,
    leaseToken: dispatched.leaseToken,
    status: "succeeded",
    result: { summary: "previously available response" },
    idempotencyKey: "previous-result-actor-result",
  };
  fixture.runs.recordResult(created.automationRun.runId, command, { actor: resultActor });
  fixture.database.database.exec("DROP TRIGGER workflow_automation_run_requests_immutable_update");
  fixture.database.database.prepare(`
    UPDATE workflow_automation_run_requests
    SET actor_type = NULL, actor_id = NULL
    WHERE idempotency_key = ?
  `).run(command.idempotencyKey);

  migrateLocalAutomationRuns(fixture.database.database);
  const unavailable = fixture.database.database.prepare(`
    SELECT actor_type, actor_id, response_json, replay_state
    FROM workflow_automation_run_requests WHERE idempotency_key = ?
  `).get(command.idempotencyKey);
  assert.equal(unavailable.actor_type, null);
  assert.equal(unavailable.actor_id, null);
  assert.equal(unavailable.replay_state, "unavailable");
  assert.doesNotMatch(unavailable.response_json, /previously available response/);

  for (const actor of [resultActor, differentActor]) {
    assert.throws(
      () => fixture.runs.recordResult(created.automationRun.runId, command, { actor }),
      (error) => error?.status === 409 && error?.code === "AUTOMATION_RUN_REPLAY_UNAVAILABLE",
    );
  }
});

test("a raw legacy result fingerprint with a mismatched actor is rehashed and fails closed", async () => {
  const instant = "2026-08-30T12:00:00.000Z";
  const resultActor = { type: "agent", id: "raw-result-actor", name: "Raw Result Actor", avatarUrl: null };
  const mismatchedActor = { type: "agent", id: "raw-result-mismatch", name: "Raw Result Mismatch", avatarUrl: null };
  const fixture = await createFixture({ clock: () => instant });
  const task = createTask(fixture, "Raw legacy result mismatch");
  const created = transition(fixture, task, "raw-result-mismatch-transition");
  const dispatched = fixture.runs.dispatch(created.automationRun.runId, {
    expectedVersion: 1,
    idempotencyKey: "raw-result-mismatch-dispatch",
  }, { actor: human });
  const secret = "raw-result-private-value";
  const command = {
    expectedVersion: 2,
    leaseToken: dispatched.leaseToken,
    status: "succeeded",
    result: { summary: "raw result must not replay", privateKey: secret },
    idempotencyKey: "raw-result-mismatch-result",
  };
  const completed = fixture.runs.recordResult(created.automationRun.runId, command, { actor: resultActor });
  const database = fixture.database.database;
  database.exec("DROP TRIGGER workflow_automation_run_requests_immutable_update");
  database.prepare(`
    UPDATE workflow_automation_run_requests
    SET request_fingerprint = ?, actor_type = ?, actor_id = ?, response_json = ?, replay_state = 'available'
    WHERE idempotency_key = ?
  `).run(
    canonicalJson({ operation: "result", runId: created.automationRun.runId, ...command }),
    mismatchedActor.type,
    mismatchedActor.id,
    canonicalJson({ run: completed.run }),
    command.idempotencyKey,
  );

  migrateLocalAutomationRuns(database);
  const unavailable = database.prepare(`
    SELECT request_fingerprint, actor_type, actor_id, response_json, replay_state
    FROM workflow_automation_run_requests WHERE idempotency_key = ?
  `).get(command.idempotencyKey);
  assert.match(unavailable.request_fingerprint, /^sha256:[a-f0-9]{64}$/);
  assert.equal(unavailable.request_fingerprint.includes(secret), false);
  assert.equal(unavailable.request_fingerprint.includes(dispatched.leaseToken), false);
  assert.equal(unavailable.actor_type, null);
  assert.equal(unavailable.actor_id, null);
  assert.equal(unavailable.replay_state, "unavailable");
  assert.doesNotMatch(unavailable.response_json, /raw result must not replay/);

  for (const actor of [resultActor, mismatchedActor]) {
    assert.throws(
      () => fixture.runs.recordResult(created.automationRun.runId, command, { actor }),
      (error) => error?.status === 409 && error?.code === "AUTOMATION_RUN_REPLAY_UNAVAILABLE",
    );
  }
});

test("a raw legacy result fingerprint with its event actor is rehashed and replays only to that actor", async () => {
  const instant = "2026-08-31T12:00:00.000Z";
  const resultActor = { type: "agent", id: "raw-result-match", name: "Raw Result Match", avatarUrl: null };
  const differentActor = { type: "agent", id: "raw-result-other", name: "Raw Result Other", avatarUrl: null };
  const fixture = await createFixture({ clock: () => instant });
  const task = createTask(fixture, "Raw legacy result recovery");
  const created = transition(fixture, task, "raw-result-recovery-transition");
  const dispatched = fixture.runs.dispatch(created.automationRun.runId, {
    expectedVersion: 1,
    idempotencyKey: "raw-result-recovery-dispatch",
  }, { actor: human });
  const secret = "raw-result-recovery-private";
  const command = {
    expectedVersion: 2,
    leaseToken: dispatched.leaseToken,
    status: "succeeded",
    result: { summary: "raw result can recover", privateKey: secret },
    idempotencyKey: "raw-result-recovery-result",
  };
  const completed = fixture.runs.recordResult(created.automationRun.runId, command, { actor: resultActor });
  const database = fixture.database.database;
  database.exec("DROP TRIGGER workflow_automation_run_requests_immutable_update");
  database.prepare(`
    UPDATE workflow_automation_run_requests
    SET request_fingerprint = ?, actor_type = ?, actor_id = ?, response_json = ?, replay_state = 'available'
    WHERE idempotency_key = ?
  `).run(
    canonicalJson({ operation: "result", runId: created.automationRun.runId, ...command }),
    resultActor.type,
    resultActor.id,
    canonicalJson({ run: completed.run }),
    command.idempotencyKey,
  );

  migrateLocalAutomationRuns(database);
  const recovered = database.prepare(`
    SELECT request_fingerprint, actor_type, actor_id, response_json, replay_state
    FROM workflow_automation_run_requests WHERE idempotency_key = ?
  `).get(command.idempotencyKey);
  assert.match(recovered.request_fingerprint, /^sha256:[a-f0-9]{64}$/);
  assert.equal(recovered.request_fingerprint.includes(secret), false);
  assert.equal(recovered.request_fingerprint.includes(dispatched.leaseToken), false);
  assert.equal(recovered.actor_type, resultActor.type);
  assert.equal(recovered.actor_id, resultActor.id);
  assert.equal(recovered.replay_state, "available");
  assert.doesNotMatch(recovered.response_json, new RegExp(dispatched.leaseToken, "i"));

  assert.equal(fixture.runs.recordResult(created.automationRun.runId, command, { actor: resultActor }).idempotent, true);
  assert.throws(
    () => fixture.runs.recordResult(created.automationRun.runId, command, { actor: differentActor }),
    (error) => error?.status === 409 && error?.code === "AUTOMATION_RUN_IDEMPOTENCY_CONFLICT",
  );
});

test("a result recorded without an explicit actor uses the local actor instead of a replay wildcard", async () => {
  const fixture = await createFixture();
  const task = createTask(fixture, "Result local actor default");
  const created = transition(fixture, task, "result-local-actor-transition");
  const dispatched = fixture.runs.dispatch(created.automationRun.runId, {
    expectedVersion: 1,
    idempotencyKey: "result-local-actor-dispatch",
  }, { actor: human });
  const command = {
    expectedVersion: 2,
    leaseToken: dispatched.leaseToken,
    status: "succeeded",
    result: { summary: "local actor result" },
    idempotencyKey: "result-local-actor-result",
  };
  fixture.runs.recordResult(created.automationRun.runId, command);
  const stored = fixture.database.database.prepare(`
    SELECT actor_type, actor_id FROM workflow_automation_run_requests WHERE idempotency_key = ?
  `).get(command.idempotencyKey);
  assert.equal(stored.actor_type, "user");
  assert.equal(stored.actor_id, "local-user");
  assert.equal(fixture.runs.recordResult(created.automationRun.runId, command).idempotent, true);
  assert.throws(
    () => fixture.runs.recordResult(created.automationRun.runId, command, {
      actor: { type: "agent", id: "foreign-result-actor", name: "Foreign Result Actor", avatarUrl: null },
    }),
    (error) => error?.status === 409 && error?.code === "AUTOMATION_RUN_IDEMPOTENCY_CONFLICT",
  );
});

test("shadow and disabled policies record stage entry without a dispatchable effect", async () => {
  const fixture = await createFixture();
  publishMode(fixture, "shadow");
  const shadowTask = createTask(fixture, "Shadow stage entry");
  const shadow = transition(fixture, shadowTask, "automation-shadow-transition").automationRun;
  assert.equal(shadow.mode, "shadow");
  assert.equal(shadow.status, "succeeded");
  assert.deepEqual(shadow.result, { reason: "shadow_recorded", effect: "none" });
  assert.throws(
    () => fixture.runs.dispatch(shadow.runId, { expectedVersion: 1, idempotencyKey: "automation-shadow-dispatch" }, { actor: human }),
    (error) => error?.status === 409 && error?.code === "AUTOMATION_RUN_NOT_DISPATCHABLE",
  );

  const disabledFixture = await createFixture();
  publishMode(disabledFixture, "disabled");
  const disabledTask = createTask(disabledFixture, "Disabled stage entry");
  const disabled = transition(disabledFixture, disabledTask, "automation-disabled-transition").automationRun;
  assert.equal(disabled.mode, "disabled");
  assert.equal(disabled.status, "cancelled");
  assert.deepEqual(disabled.result, { reason: "policy_disabled", effect: "none" });
  assert.equal(disabledFixture.database.database.prepare("SELECT COUNT(*) AS count FROM workflow_automation_run_outbox").get().count, 0);
});

test("automation run insertion rolls back with its transition and survives database reentry without duplication", async () => {
  const fixture = await createFixture();
  const task = createTask(fixture, "Atomic run insertion");
  fixture.database.database.exec(`
    CREATE TRIGGER fail_automation_run
    BEFORE INSERT ON workflow_automation_runs
    BEGIN SELECT RAISE(ABORT, 'AUTOMATION_RUN_INSERT_FAILURE'); END;
  `);
  try {
    assert.throws(
      () => transition(fixture, task, "automation-rollback-transition"),
      /AUTOMATION_RUN_INSERT_FAILURE/,
    );
  } finally {
    fixture.database.database.exec("DROP TRIGGER fail_automation_run");
  }
  assert.equal(fixture.database.getTask(task.id).version, task.version);
  assert.equal(fixture.database.database.prepare("SELECT COUNT(*) AS count FROM workflow_ledger_events").get().count, 0);
  assert.equal(fixture.database.database.prepare("SELECT COUNT(*) AS count FROM workflow_automation_runs").get().count, 0);

  const committed = transition(fixture, task, "automation-reentry-transition");
  fixture.database.close();
  fixture.database = new TaskboardDatabase(fixture.filename);
  fixture.transitions = new TransitionService(fixture.database);
  fixture.runs = new AutomationRunService(fixture.database);
  const replay = fixture.transitions.transition(task.id, {
    expectedStateVersion: task.version,
    actionKey: committed.request.actionKey,
    gateEvidence: [],
    authorizationId: null,
    idempotencyKey: "automation-reentry-transition",
  }, { actor: human });
  assert.equal(replay.idempotent, true);
  assert.equal(replay.automationRun.runId, committed.automationRun.runId);
  assert.equal(fixture.database.database.prepare("SELECT COUNT(*) AS count FROM workflow_automation_runs").get().count, 1);
});
