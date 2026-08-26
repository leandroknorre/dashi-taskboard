import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";

import { createTaskboardServer } from "../server/index.mjs";
import { TransitionService } from "../server/transition-service.mjs";

const running = [];
const actor = { type: "user", id: "api-transition-tester", name: "API Transition Tester", avatarUrl: null };

afterEach(async () => {
  while (running.length > 0) {
    const { app, directory } = running.pop();
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});

async function start() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "taskboard-transition-api-"));
  const app = createTaskboardServer({ dataDirectory: directory });
  app.database.createProject({ id: "transition-api", name: "Transition API", workspacePath: "/tmp/transition-api" });
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  running.push({ app, directory });
  return { app, baseUrl: `http://127.0.0.1:${address.port}` };
}

function createTask(app, title) {
  return app.database.createTask({
    projectId: "transition-api",
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

function actionTo(service, taskId, terminalKind) {
  const action = service.listActions(taskId).find((candidate) => candidate.toTerminalKind === terminalKind);
  assert.ok(action, `expected an action to ${terminalKind}`);
  return action;
}

function destinationStatus(app, revisionId, action) {
  return app.database.database.prepare(`
    SELECT canonical_status FROM workflow_revision_stage_bindings
    WHERE revision_id = ? AND task_stage_id = ?
  `).get(revisionId, action.toTaskStageId).canonical_status;
}

function validAcceptance() {
  return [{
    evidenceId: randomUUID(),
    gateId: "human-acceptance",
    type: "human_acceptance",
    capturedAt: "2026-08-25T00:00:00.000Z",
    actor: { actorId: "api-reviewer", kind: "human" },
    status: "valid",
    record: { evidenceEventId: randomUUID(), eventHash: "a".repeat(64) },
    revocation: null,
  }];
}

test("POST transition requires Idempotency-Key and a retry returns the original local transition", async () => {
  const { app, baseUrl } = await start();
  const task = createTask(app, "Explicit transition");
  const transitions = new TransitionService(app.database);
  const workflow = transitions.getTaskWorkflow(task.id);
  const action = actionTo(transitions, task.id, "none");
  const body = { expectedStateVersion: task.version, actionKey: action.actionKey, gateEvidence: [] };

  const missingKey = await request(baseUrl, `/api/tasks/${task.id}/transitions`, { method: "POST", body });
  assert.equal(missingKey.response.status, 400);
  assert.equal(missingKey.body.error.code, "IDEMPOTENCY_KEY_REQUIRED");

  const first = await request(baseUrl, `/api/tasks/${task.id}/transitions`, {
    method: "POST",
    headers: { "idempotency-key": "api-transition-retry-1" },
    body,
  });
  assert.equal(first.response.status, 200);
  assert.equal(first.body.idempotent, false);
  assert.equal(first.body.transition.revisionId, workflow.revisionId);

  const retry = await request(baseUrl, `/api/tasks/${task.id}/transitions`, {
    method: "POST",
    headers: { "idempotency-key": "api-transition-retry-1" },
    body,
  });
  assert.equal(retry.response.status, 200);
  assert.equal(retry.body.idempotent, true);
  assert.equal(retry.body.transition.eventId, first.body.transition.eventId);
  assert.equal(app.database.database.prepare("SELECT COUNT(*) AS count FROM workflow_outbox").get().count, 1);
});

test("legacy PATCH status and /move use controlled legacy actions; mixed and completion bypasses are rejected", async () => {
  const { app, baseUrl } = await start();
  const transitions = new TransitionService(app.database);

  const patchTask = createTask(app, "PATCH transition");
  const patchWorkflow = transitions.getTaskWorkflow(patchTask.id);
  const patchAction = actionTo(transitions, patchTask.id, "none");
  const patch = await request(baseUrl, `/api/tasks/${patchTask.id}`, {
    method: "PATCH",
    body: {
      version: patchTask.version,
      status: destinationStatus(app, patchWorkflow.revisionId, patchAction),
    },
  });
  assert.equal(patch.response.status, 200);
  assert.equal(patch.body.legacy, true);
  assert.equal(patch.body.task.version, patchTask.version + 1);

  const completionPatchTask = createTask(app, "PATCH completion gate");
  const completionPatchWorkflow = transitions.getTaskWorkflow(completionPatchTask.id);
  const completionPatch = actionTo(transitions, completionPatchTask.id, "completed");
  const completionBlocked = await request(baseUrl, `/api/tasks/${completionPatchTask.id}`, {
    method: "PATCH",
    body: {
      version: completionPatchTask.version,
      status: destinationStatus(app, completionPatchWorkflow.revisionId, completionPatch),
    },
  });
  assert.equal(completionBlocked.response.status, 409);
  assert.equal(completionBlocked.body.error.code, "ACCEPTANCE_EVIDENCE_REQUIRED");
  assert.equal(app.database.getTask(completionPatchTask.id).version, completionPatchTask.version);

  const mixedTask = createTask(app, "Mixed legacy PATCH");
  const mixedAction = actionTo(transitions, mixedTask.id, "none");
  const mixedWorkflow = transitions.getTaskWorkflow(mixedTask.id);
  const mixed = await request(baseUrl, `/api/tasks/${mixedTask.id}`, {
    method: "PATCH",
    body: {
      version: mixedTask.version,
      title: "Attempted mixed write",
      status: destinationStatus(app, mixedWorkflow.revisionId, mixedAction),
    },
  });
  assert.equal(mixed.response.status, 409);
  assert.equal(mixed.body.error.code, "TRANSITION_REQUIRED");
  assert.equal(app.database.getTask(mixedTask.id).version, mixedTask.version);

  const moveTask = createTask(app, "Move transition");
  const moveWorkflow = transitions.getTaskWorkflow(moveTask.id);
  const moveAction = actionTo(transitions, moveTask.id, "none");
  const moved = await request(baseUrl, `/api/tasks/${moveTask.id}/move`, {
    method: "POST",
    body: {
      version: moveTask.version,
      status: destinationStatus(app, moveWorkflow.revisionId, moveAction),
    },
  });
  assert.equal(moved.response.status, 200);
  assert.equal(moved.body.legacy, true);
  assert.equal(app.database.database.prepare(`
    SELECT COUNT(*) AS count FROM workflow_transition_requests WHERE task_id = ?
  `).get(moveTask.id).count, 1);

  const completionTask = createTask(app, "Completion bypass");
  const completionWorkflow = transitions.getTaskWorkflow(completionTask.id);
  const completion = actionTo(transitions, completionTask.id, "completed");
  const blocked = await request(baseUrl, `/api/tasks/${completionTask.id}/move`, {
    method: "POST",
    body: {
      version: completionTask.version,
      status: destinationStatus(app, completionWorkflow.revisionId, completion),
    },
  });
  assert.equal(blocked.response.status, 409);
  assert.equal(blocked.body.error.code, "ACCEPTANCE_EVIDENCE_REQUIRED");
  assert.equal(app.database.getTask(completionTask.id).status, completionTask.status);
  assert.equal(app.database.database.prepare(`
    SELECT COUNT(*) AS count FROM workflow_transition_requests WHERE task_id = ?
  `).get(completionTask.id).count, 0);
});

test("the legacy stage editor cannot remap a task after its workflow revision is pinned", async () => {
  const { app, baseUrl } = await start();
  const task = createTask(app, "Pinned stage workflow");
  const transitions = new TransitionService(app.database);
  transitions.getTaskWorkflow(task.id);
  const physicalWorkflow = app.database.getStageWorkflow("transition-api");

  const response = await request(baseUrl, "/api/projects/transition-api/stage-workflow", {
    method: "PUT",
    body: {
      version: physicalWorkflow.version,
      definition: physicalWorkflow.definition,
      removals: [],
    },
  });

  assert.equal(response.response.status, 409);
  assert.equal(response.body.error.code, "WORKFLOW_AUTHORING_UNAVAILABLE");
  assert.equal(app.database.getTask(task.id).version, task.version);
  assert.equal(app.database.database.prepare("SELECT COUNT(*) AS count FROM workflow_ledger_events").get().count, 0);
});

test("a real API parent completion stays blocked while a required descendant is open", async () => {
  const { app, baseUrl } = await start();
  const parent = createTask(app, "Required parent");
  const child = createTask(app, "Open required child");
  app.database.addTaskRelation(
    child.id,
    child.version,
    "parent",
    parent.id,
    undefined,
    undefined,
    actor,
    "manual",
    { required: true, rollup: true },
  );
  const transitions = new TransitionService(app.database);
  const completion = actionTo(transitions, parent.id, "completed");

  const blocked = await request(baseUrl, `/api/tasks/${parent.id}/transitions`, {
    method: "POST",
    headers: { "idempotency-key": "api-required-parent-completion" },
    body: {
      expectedStateVersion: parent.version,
      actionKey: completion.actionKey,
      gateEvidence: validAcceptance(),
    },
  });

  assert.equal(blocked.response.status, 409);
  assert.equal(blocked.body.error.code, "REQUIRED_DESCENDANT_INCOMPLETE");
  assert.equal(app.database.getTask(parent.id).status, parent.status);
  assert.equal(app.database.getTask(child.id).status, child.status);
  assert.equal(app.database.database.prepare("SELECT COUNT(*) AS count FROM workflow_ledger_events").get().count, 0);
});
