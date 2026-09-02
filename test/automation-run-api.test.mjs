import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";

import { createTaskboardServer } from "../server/index.mjs";
import { TransitionService } from "../server/transition-service.mjs";

const running = [];
const actor = { type: "user", id: "automation-api-tester", name: "Automation API Tester", avatarUrl: null };
const humanHeaders = {
  "x-taskboard-user-id": actor.id,
  "x-taskboard-user-name": "Automation%20API%20Tester",
};

afterEach(async () => {
  while (running.length > 0) {
    const { app, directory } = running.pop();
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});

async function start() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "taskboard-automation-api-"));
  const app = createTaskboardServer({ dataDirectory: directory });
  app.database.createProject({ id: "automation-api", name: "Automation API", workspacePath: "/tmp/automation-api" });
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  running.push({ app, directory });
  return { app, baseUrl: `http://127.0.0.1:${address.port}` };
}

function createTask(app, title) {
  return app.database.createTask({
    projectId: "automation-api",
    title,
    description: "",
    status: "todo",
    priority: "none",
    labels: [],
    threadId: null,
    actor,
    assignee: actor,
    developmentContext: null,
    startDate: null,
    dueDate: null,
    recurrence: null,
  });
}

async function request(baseUrl, pathname, options = {}) {
  const headers = new Headers(options.headers);
  if (options.body !== undefined && !headers.has("content-type")) headers.set("content-type", "application/json");
  const response = await fetch(`${baseUrl}${pathname}`, {
    ...options,
    headers,
    body: options.body === undefined || typeof options.body === "string"
      ? options.body
      : JSON.stringify(options.body),
  });
  const text = await response.text();
  return { response, body: text ? JSON.parse(text) : undefined };
}

test("local transition creates a listed run and explicit APIs dispatch and record a redacted result", async () => {
  const { app, baseUrl } = await start();
  const task = createTask(app, "Automation route task");
  const transitions = new TransitionService(app.database);
  const action = transitions.listActions(task.id).find((candidate) => candidate.toTerminalKind === "none");
  assert.ok(action, "fixture must expose a non-terminal action");

  const created = await request(baseUrl, `/api/tasks/${task.id}/transitions`, {
    method: "POST",
    headers: { "idempotency-key": "automation-api-transition" },
    body: { expectedStateVersion: task.version, actionKey: action.actionKey, gateEvidence: [] },
  });
  assert.equal(created.response.status, 200, JSON.stringify(created.body));
  assert.equal(created.body.automationRun.mode, "manual");
  assert.equal(created.body.automationRun.status, "pending");
  const runId = created.body.automationRun.runId;

  const listed = await request(baseUrl, `/api/tasks/${task.id}/automation-runs`);
  assert.equal(listed.response.status, 200);
  assert.equal(listed.body.runs.length, 1);
  assert.equal(listed.body.runs[0].runId, runId);
  assert.equal(Object.hasOwn(listed.body.runs[0], "leaseToken"), false);

  const detail = await request(baseUrl, `/api/automation-runs/${runId}`);
  assert.equal(detail.response.status, 200);
  assert.equal(detail.body.run.events.length, 1);

  const missingKey = await request(baseUrl, `/api/automation-runs/${runId}/dispatch`, {
    method: "POST",
    body: { expectedVersion: 1 },
  });
  assert.equal(missingKey.response.status, 400);
  assert.equal(missingKey.body.error.code, "IDEMPOTENCY_KEY_REQUIRED");
  const agentDispatch = await request(baseUrl, `/api/automation-runs/${runId}/dispatch`, {
    method: "POST",
    headers: { "idempotency-key": "automation-api-agent", "x-taskboard-client": "taskctl" },
    body: { expectedVersion: 1 },
  });
  assert.equal(agentDispatch.response.status, 403);
  assert.equal(agentDispatch.body.error.code, "AUTOMATION_RUN_DISPATCH_FORBIDDEN");

  const anonymousDispatch = await request(baseUrl, `/api/automation-runs/${runId}/dispatch`, {
    method: "POST",
    headers: { "idempotency-key": "automation-api-anonymous" },
    body: { expectedVersion: 1 },
  });
  assert.equal(anonymousDispatch.response.status, 401);
  assert.equal(anonymousDispatch.body.error.code, "EXPLICIT_HUMAN_ACTOR_REQUIRED");

  const dispatched = await request(baseUrl, `/api/automation-runs/${runId}/dispatch`, {
    method: "POST",
    headers: { ...humanHeaders, "idempotency-key": "automation-api-dispatch" },
    body: { expectedVersion: 1, leaseSeconds: 60 },
  });
  assert.equal(dispatched.response.status, 200, JSON.stringify(dispatched.body));
  assert.equal(dispatched.body.run.status, "dispatched");
  assert.match(dispatched.body.leaseToken, /^[0-9a-f-]{36}$/i);
  const dispatchRetry = await request(baseUrl, `/api/automation-runs/${runId}/dispatch`, {
    method: "POST",
    headers: { ...humanHeaders, "idempotency-key": "automation-api-dispatch" },
    body: { expectedVersion: 1, leaseSeconds: 60 },
  });
  assert.equal(dispatchRetry.response.status, 200);
  assert.equal(dispatchRetry.body.idempotent, true);
  assert.equal(dispatchRetry.body.leaseToken, dispatched.body.leaseToken);

  const result = await request(baseUrl, `/api/automation-runs/${runId}/result`, {
    method: "POST",
    headers: { "idempotency-key": "automation-api-result" },
    body: {
      expectedVersion: 2,
      leaseToken: dispatched.body.leaseToken,
      status: "succeeded",
      result: { summary: "adapter acknowledged", apiKey: "must-not-persist" },
    },
  });
  assert.equal(result.response.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.run.status, "succeeded");
  assert.equal(result.body.run.result.apiKey, "[redacted]");
  const after = await request(baseUrl, `/api/automation-runs/${runId}`);
  assert.equal(after.body.run.events.length, 3);
  assert.equal(Object.hasOwn(after.body.run, "leaseToken"), false);
});

test("archived projects reject automation dispatch and result mutations", async () => {
  const { app, baseUrl } = await start();
  const task = createTask(app, "Archive automation guard");
  const transitions = new TransitionService(app.database);
  const action = transitions.listActions(task.id).find((candidate) => candidate.toTerminalKind === "none");
  const created = await request(baseUrl, `/api/tasks/${task.id}/transitions`, {
    method: "POST",
    headers: { "idempotency-key": "archive-automation-transition" },
    body: { expectedStateVersion: task.version, actionKey: action.actionKey, gateEvidence: [] },
  });
  const runId = created.body.automationRun.runId;
  const dispatched = await request(baseUrl, `/api/automation-runs/${runId}/dispatch`, {
    method: "POST",
    headers: { ...humanHeaders, "idempotency-key": "archive-automation-dispatch" },
    body: { expectedVersion: 1, leaseSeconds: 60 },
  });
  assert.equal(dispatched.response.status, 200, JSON.stringify(dispatched.body));
  const before = {
    run: app.database.database.prepare("SELECT status, version, result_json FROM workflow_automation_runs WHERE run_id = ?").get(runId),
    events: app.database.database.prepare("SELECT COUNT(*) AS count FROM workflow_automation_run_events WHERE run_id = ?").get(runId).count,
    outbox: app.database.database.prepare("SELECT COUNT(*) AS count FROM workflow_automation_run_outbox WHERE run_id = ?").get(runId).count,
  };
  app.database.database.prepare(`
    UPDATE projects SET archived_at = ?, version = version + 1 WHERE id = 'automation-api'
  `).run("2026-09-01T12:00:00.000Z");

  const replayBlocked = await request(baseUrl, `/api/automation-runs/${runId}/dispatch`, {
    method: "POST",
    headers: { ...humanHeaders, "idempotency-key": "archive-automation-dispatch" },
    body: { expectedVersion: 1, leaseSeconds: 60 },
  });
  assert.equal(replayBlocked.response.status, 409);
  assert.equal(replayBlocked.body.error.code, "PROJECT_ARCHIVED");

  const resultBlocked = await request(baseUrl, `/api/automation-runs/${runId}/result`, {
    method: "POST",
    headers: { "idempotency-key": "archive-automation-result" },
    body: {
      expectedVersion: 2,
      leaseToken: dispatched.body.leaseToken,
      status: "succeeded",
      result: { summary: "must not persist" },
    },
  });
  assert.equal(resultBlocked.response.status, 409);
  assert.equal(resultBlocked.body.error.code, "PROJECT_ARCHIVED");
  assert.deepEqual({
    run: app.database.database.prepare("SELECT status, version, result_json FROM workflow_automation_runs WHERE run_id = ?").get(runId),
    events: app.database.database.prepare("SELECT COUNT(*) AS count FROM workflow_automation_run_events WHERE run_id = ?").get(runId).count,
    outbox: app.database.database.prepare("SELECT COUNT(*) AS count FROM workflow_automation_run_outbox WHERE run_id = ?").get(runId).count,
  }, before);
});
