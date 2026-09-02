import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";

import { createTaskboardServer } from "../server/index.mjs";
import { TransitionService } from "../server/transition-service.mjs";
import { WorkflowAuthoringService } from "../server/workflow-authoring-service.mjs";

const running = [];
const actor = {
  type: "user",
  id: "workflow-author",
  name: "Workflow Author",
  avatarUrl: null,
};

afterEach(async () => {
  while (running.length > 0) {
    const { app, directory } = running.pop();
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});

function trustedBoundary() {
  const authenticated = new WeakMap();
  return {
    preauthenticateHumanAcceptanceRequest: async (request) => {
      authenticated.set(request, { actorId: "workflow-author", kind: "human" });
    },
    humanAcceptanceProvider: {
      attest: async ({ request }) => ({ actor: authenticated.get(request) }),
      authenticate: ({ request }) => ({ actor: authenticated.get(request) }),
    },
  };
}

async function start() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "taskboard-workflow-authoring-"));
  const boundary = trustedBoundary();
  const app = createTaskboardServer({
    dataDirectory: directory,
    humanAcceptanceProvider: boundary.humanAcceptanceProvider,
    preauthenticateHumanAcceptanceRequest: boundary.preauthenticateHumanAcceptanceRequest,
  });
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  running.push({ app, directory });
  return { app, baseUrl: `http://127.0.0.1:${address.port}` };
}

async function request(baseUrl, pathname, options = {}) {
  const headers = new Headers(options.headers);
  if (options.body !== undefined && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  const response = await fetch(`${baseUrl}${pathname}`, {
    ...options,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  return { response, body: text ? JSON.parse(text) : undefined };
}

function createProject(app, id = "authoring") {
  return app.database.createProject({ id, name: "Authoring", workspacePath: null });
}

function createTask(app, projectId, title = "Task") {
  return app.database.createTask({
    projectId,
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

function workflowState(database) {
  const tables = [
    "projects",
    "project_stage_workflows",
    "workflow_stages",
    "workflow_definitions",
    "workflow_revisions",
    "workflow_revision_stage_bindings",
    "workflow_transition_rules",
    "workflow_task_pins",
    "workflow_ledger_events",
    "tasks",
  ];
  return Object.fromEntries(tables.map((table) => [
    table,
    database.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
  ]));
}

function renamedDefinition(workflow, name = "Inbox") {
  return {
    ...workflow.definition,
    stages: workflow.definition.stages.map((stage, index) => (
      index === 0 ? { ...stage, name } : stage
    )),
  };
}

test("validation is pure and publication appends N+1 while old and new tasks keep their pins", async () => {
  const { app, baseUrl } = await start();
  createProject(app);
  const oldTask = createTask(app, "authoring", "Pinned before publication");
  const before = await request(baseUrl, "/api/projects/authoring/workflow-authoring");
  assert.equal(before.response.status, 200);
  assert.equal(before.body.workflow.revision, 1);
  const revisionOneJson = app.database.database.prepare(
    "SELECT definition_json FROM workflow_revisions WHERE revision_id = ?",
  ).get(before.body.workflow.revisionId).definition_json;
  const stateBeforeValidation = workflowState(app.database.database);
  const definition = renamedDefinition(before.body.workflow);

  const validated = await request(baseUrl, "/api/projects/authoring/workflow-authoring/validate", {
    method: "POST",
    body: { expectedRevisionId: before.body.workflow.revisionId, definition },
  });
  assert.equal(validated.response.status, 200, JSON.stringify(validated.body));
  assert.equal(validated.body.validation.valid, true);
  assert.equal(validated.body.validation.nextRevision, 2);
  assert.deepEqual(workflowState(app.database.database), stateBeforeValidation);

  const published = await request(baseUrl, "/api/projects/authoring/workflow-authoring/publish", {
    method: "POST",
    body: { expectedRevisionId: before.body.workflow.revisionId, definition },
  });
  assert.equal(published.response.status, 201, JSON.stringify(published.body));
  assert.equal(published.body.workflow.revision, 2);
  assert.equal(published.body.workflow.definition.stages[0].name, "Inbox");
  assert.equal(
    app.database.database.prepare(
      "SELECT definition_json FROM workflow_revisions WHERE revision_id = ?",
    ).get(before.body.workflow.revisionId).definition_json,
    revisionOneJson,
  );
  assert.equal(
    app.database.database.prepare("SELECT revision_id FROM workflow_task_pins WHERE task_id = ?").get(oldTask.id).revision_id,
    before.body.workflow.revisionId,
  );
  const newTask = createTask(app, "authoring", "Pinned after publication");
  assert.equal(
    app.database.database.prepare("SELECT revision_id FROM workflow_task_pins WHERE task_id = ?").get(newTask.id).revision_id,
    published.body.workflow.revisionId,
  );

  const legacy = await request(baseUrl, "/api/projects/authoring/stage-workflow", {
    method: "PUT",
    body: {
      version: app.database.getStageWorkflow("authoring").version,
      definition: published.body.workflow.definition,
      removals: [],
    },
  });
  assert.equal(legacy.response.status, 409);
  assert.equal(legacy.body.error.code, "WORKFLOW_AUTHORING_UNAVAILABLE");
});

test("same-base concurrent publication has one winner and no partial third revision", async () => {
  const { app, baseUrl } = await start();
  createProject(app, "concurrent");
  createTask(app, "concurrent");
  const loaded = (await request(baseUrl, "/api/projects/concurrent/workflow-authoring")).body.workflow;
  const body = {
    expectedRevisionId: loaded.revisionId,
    definition: renamedDefinition(loaded, "Concurrent inbox"),
  };
  const results = await Promise.all([
    request(baseUrl, "/api/projects/concurrent/workflow-authoring/publish", { method: "POST", body }),
    request(baseUrl, "/api/projects/concurrent/workflow-authoring/publish", { method: "POST", body }),
  ]);
  assert.deepEqual(results.map((result) => result.response.status).sort(), [201, 409]);
  assert.equal(results.find((result) => result.response.status === 409).body.error.code, "WORKFLOW_REVISION_CONFLICT");
  assert.equal(app.database.database.prepare(`
    SELECT COUNT(*) AS count FROM workflow_revisions AS revisions
    JOIN workflow_definitions AS workflows ON workflows.workflow_id = revisions.workflow_id
    WHERE workflows.project_id = 'concurrent'
  `).get().count, 2);
  assert.equal((await request(baseUrl, "/api/projects/concurrent/workflow-authoring")).body.workflow.revision, 2);
});

test("a failure after physical stage edits rolls the whole publication back", async () => {
  const { app } = await start();
  createProject(app, "rollback");
  createTask(app, "rollback");
  const transitions = new TransitionService(app.database);
  const authoring = new WorkflowAuthoringService(app.database, {
    publishRevision() {
      throw new Error("injected publication failure");
    },
  });
  const loaded = authoring.get("rollback");
  const before = workflowState(app.database.database);
  assert.throws(
    () => authoring.publish("rollback", {
      expectedRevisionId: loaded.revisionId,
      definition: renamedDefinition(loaded, "Must roll back"),
    }),
    /injected publication failure/,
  );
  assert.deepEqual(workflowState(app.database.database), before);
  assert.equal(transitions.getTaskWorkflow(app.database.listTasks({ projectId: "rollback" })[0].id).revision, 1);
});

test("removing an occupied stage keeps it inactive for pinned legacy cards", async () => {
  const { app, baseUrl } = await start();
  createProject(app, "legacy-stage");
  const oldTask = createTask(app, "legacy-stage");
  const loaded = (await request(baseUrl, "/api/projects/legacy-stage/workflow-authoring")).body.workflow;
  const oldTodo = loaded.definition.stages.find((stage) => stage.canonicalStatus === "todo");
  const replacement = { ...oldTodo, stageId: null, name: "Fresh inbox", order: 100 };
  const definition = {
    ...loaded.definition,
    stages: [
      ...loaded.definition.stages.filter((stage) => stage.stageId !== oldTodo.stageId),
      replacement,
    ],
  };
  const published = await request(baseUrl, "/api/projects/legacy-stage/workflow-authoring/publish", {
    method: "POST",
    body: { expectedRevisionId: loaded.revisionId, definition },
  });
  assert.equal(published.response.status, 201, JSON.stringify(published.body));
  assert.deepEqual(published.body.workflow.legacyOccupiedStages, [{
    stageId: oldTodo.stageId,
    name: oldTodo.name,
    canonicalStatus: "todo",
    terminalKind: "none",
    taskCount: 1,
  }]);
  assert.deepEqual(
    { ...app.database.database.prepare("SELECT active, is_default_for_status, board_visible FROM workflow_stages WHERE id = ?").get(oldTodo.stageId) },
    { active: 0, is_default_for_status: 0, board_visible: 0 },
  );
  assert.equal(app.database.getTask(oldTask.id).stageId, oldTodo.stageId);
  const freshTask = createTask(app, "legacy-stage", "Fresh task");
  assert.notEqual(freshTask.stageId, oldTodo.stageId);
  assert.equal(
    app.database.database.prepare("SELECT revision_id FROM workflow_task_pins WHERE task_id = ?").get(freshTask.id).revision_id,
    published.body.workflow.revisionId,
  );
});

test("physical stage ids are reused only while canonical status and terminal kind stay unchanged", async () => {
  const { app, baseUrl } = await start();
  createProject(app, "stage-identity");
  createTask(app, "stage-identity");
  const loaded = (await request(baseUrl, "/api/projects/stage-identity/workflow-authoring")).body.workflow;
  const todo = loaded.definition.stages.find((stage) => stage.canonicalStatus === "todo");
  const progress = loaded.definition.stages.find((stage) => stage.canonicalStatus === "in_progress");
  const definition = {
    ...loaded.definition,
    stages: loaded.definition.stages.map((stage) => {
      if (stage.stageId === todo.stageId) return { ...stage, canonicalStatus: "in_progress" };
      if (stage.stageId === progress.stageId) return { ...stage, canonicalStatus: "todo" };
      return stage;
    }),
  };
  const published = await request(baseUrl, "/api/projects/stage-identity/workflow-authoring/publish", {
    method: "POST",
    body: { expectedRevisionId: loaded.revisionId, definition },
  });
  assert.equal(published.response.status, 201, JSON.stringify(published.body));
  const publishedIds = new Set(published.body.workflow.definition.stages.map((stage) => stage.stageId));
  assert.equal(publishedIds.has(todo.stageId), false);
  assert.equal(publishedIds.has(progress.stageId), false);
  const unchanged = loaded.definition.stages.find((stage) => stage.canonicalStatus === "blocked");
  assert.equal(publishedIds.has(unchanged.stageId), true);
});

test("published completion still needs human acceptance and reopening records a new event", async () => {
  const { app, baseUrl } = await start();
  createProject(app, "acceptance");
  createTask(app, "acceptance", "Revision one seed");
  const loaded = (await request(baseUrl, "/api/projects/acceptance/workflow-authoring")).body.workflow;
  const published = await request(baseUrl, "/api/projects/acceptance/workflow-authoring/publish", {
    method: "POST",
    body: {
      expectedRevisionId: loaded.revisionId,
      definition: renamedDefinition(loaded, "Accepted inbox"),
    },
  });
  assert.equal(published.response.status, 201, JSON.stringify(published.body));
  let task = createTask(app, "acceptance", "Complete and reopen");
  let actions = (await request(baseUrl, `/api/tasks/${task.id}/transitions`)).body.actions;
  const complete = actions.find((action) => action.toTerminalKind === "completed");
  assert.ok(complete);

  const blocked = await request(baseUrl, `/api/tasks/${task.id}/transitions`, {
    method: "POST",
    headers: { "idempotency-key": "authoring_complete_without_evidence" },
    body: {
      expectedStateVersion: task.version,
      actionKey: complete.actionKey,
      gateEvidence: [],
    },
  });
  assert.equal(blocked.response.status, 409);
  assert.equal(blocked.body.error.code, "ACCEPTANCE_EVIDENCE_REQUIRED");
  assert.equal(app.database.database.prepare("SELECT COUNT(*) AS count FROM workflow_ledger_events WHERE aggregate_id = ?").get(task.id).count, 0);

  const evidence = await request(baseUrl, `/api/tasks/${task.id}/evidence`, {
    method: "POST",
    headers: { "idempotency-key": "authoring_acceptance_evidence" },
    body: { expectedStateVersion: task.version, actionKey: complete.actionKey },
  });
  assert.equal(evidence.response.status, 201, JSON.stringify(evidence.body));
  const completed = await request(baseUrl, `/api/tasks/${task.id}/transitions`, {
    method: "POST",
    headers: { "idempotency-key": "authoring_complete_with_evidence" },
    body: {
      expectedStateVersion: task.version,
      actionKey: complete.actionKey,
      gateEvidence: [evidence.body.evidence],
    },
  });
  assert.equal(completed.response.status, 200, JSON.stringify(completed.body));
  assert.equal(completed.body.task.status, "done");
  task = completed.body.task;

  actions = (await request(baseUrl, `/api/tasks/${task.id}/transitions`)).body.actions;
  const reopen = actions.find((action) => action.toStatus === "in_review")
    ?? actions.find((action) => action.toTerminalKind === "none");
  assert.ok(reopen);
  const reopened = await request(baseUrl, `/api/tasks/${task.id}/transitions`, {
    method: "POST",
    headers: { "idempotency-key": "authoring_reopen_after_completion" },
    body: {
      expectedStateVersion: task.version,
      actionKey: reopen.actionKey,
      gateEvidence: [],
    },
  });
  assert.equal(reopened.response.status, 200, JSON.stringify(reopened.body));
  assert.notEqual(reopened.body.task.status, "done");
  const events = app.database.database.prepare(`
    SELECT revision_id, event_id FROM workflow_ledger_events
    WHERE aggregate_id = ? AND event_type = 'transition.requested' ORDER BY sequence
  `).all(task.id);
  assert.equal(events.length, 2);
  assert.equal(events[0].revision_id, published.body.workflow.revisionId);
  assert.equal(events[1].revision_id, published.body.workflow.revisionId);
  assert.notEqual(events[0].event_id, events[1].event_id);
});

test("an empty project publishes revision one before any card exists", async () => {
  const { app, baseUrl } = await start();
  createProject(app, "empty-pilot");
  const loaded = (await request(baseUrl, "/api/projects/empty-pilot/workflow-authoring")).body.workflow;
  assert.equal(loaded.revisionId, null);
  assert.equal(loaded.revision, 0);
  assert.equal(loaded.definition.stages.every((stage) => stage.stageId === null), true);
  const validated = await request(baseUrl, "/api/projects/empty-pilot/workflow-authoring/validate", {
    method: "POST",
    body: { expectedRevisionId: null, definition: loaded.definition },
  });
  assert.equal(validated.response.status, 200, JSON.stringify(validated.body));
  assert.equal(validated.body.validation.definition.stages.every((stage) => stage.stageId === null), true);
  assert.equal(app.database.database.prepare("SELECT COUNT(*) AS count FROM workflow_definitions WHERE project_id = 'empty-pilot'").get().count, 0);
  const published = await request(baseUrl, "/api/projects/empty-pilot/workflow-authoring/publish", {
    method: "POST",
    body: { expectedRevisionId: null, definition: loaded.definition },
  });
  assert.equal(published.response.status, 201, JSON.stringify(published.body));
  assert.equal(published.body.workflow.revision, 1);
  assert.ok(published.body.workflow.revisionId);
  assert.equal(published.body.workflow.definition.stages.every((stage) => stage.stageId !== null), true);
  assert.equal(app.database.database.prepare("SELECT COUNT(*) AS count FROM tasks WHERE project_id = 'empty-pilot'").get().count, 0);
  const reloaded = (await request(baseUrl, "/api/projects/empty-pilot/workflow-authoring")).body.workflow;
  assert.equal(reloaded.revisionId, published.body.workflow.revisionId);
  assert.equal(reloaded.definition.stages.length, 7);
});

test("project rename is a CAS-only metadata edit and rejects global, Jira, archived, and stale targets", async () => {
  const { app, baseUrl } = await start();
  createProject(app, "construction");
  const parent = createTask(app, "construction", "Parent");
  const child = createTask(app, "construction", "Child");
  app.database.addTaskRelation(
    child.id,
    child.version,
    "parent",
    parent.id,
    null,
    undefined,
    actor,
    "manual",
    { required: true, rollup: true },
  );
  app.database.createComment(parent.id, { body: "Preserved conversation", threadId: null, actor });
  const preservedTables = [
    "tasks",
    "task_relations",
    "comments",
    "workflow_task_pins",
    "workflow_revisions",
    "workflow_revision_stage_bindings",
    "workflow_transition_rules",
    "workflow_ledger_events",
  ];
  const before = Object.fromEntries(preservedTables.map((table) => [
    table,
    app.database.database.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
  ]));
  const currentProject = app.database.getProject("construction");
  const renamed = await request(baseUrl, "/api/projects/construction", {
    method: "PATCH",
    body: { name: "Construction engine", expectedUpdatedAt: currentProject.updatedAt },
  });
  assert.equal(renamed.response.status, 200, JSON.stringify(renamed.body));
  assert.equal(renamed.body.project.id, "construction");
  assert.equal(renamed.body.project.name, "Construction engine");
  assert.equal(renamed.body.project.version, currentProject.version + 1);
  for (const [table, rows] of Object.entries(before)) {
    assert.deepEqual(app.database.database.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(), rows, table);
  }

  const stale = await request(baseUrl, "/api/projects/construction", {
    method: "PATCH",
    body: { name: "Stale rename", expectedUpdatedAt: currentProject.updatedAt },
  });
  assert.equal(stale.response.status, 409);
  assert.equal(stale.body.error.code, "PROJECT_UPDATED_AT_CONFLICT");

  const global = await request(baseUrl, "/api/projects/local", {
    method: "PATCH",
    body: {
      name: "Global renamed",
      expectedUpdatedAt: app.database.getProject("local").updatedAt,
    },
  });
  assert.equal(global.response.status, 409);
  assert.equal(global.body.error.code, "PROJECT_RENAME_UNAVAILABLE");

  app.database.ensureJiraProject("Jira");
  const jira = await request(baseUrl, "/api/projects/jira-my-tasks", {
    method: "PATCH",
    body: {
      name: "Jira renamed",
      expectedUpdatedAt: app.database.getProject("jira-my-tasks").updatedAt,
    },
  });
  assert.equal(jira.response.status, 409);
  assert.equal(jira.body.error.code, "PROJECT_RENAME_UNAVAILABLE");

  const archivedProject = createProject(app, "archived-project");
  app.database.mutateProjectDisposition(
    "archived-project",
    "archive",
    archivedProject.version,
    "archive_before_rename",
    actor,
  );
  const archived = await request(baseUrl, "/api/projects/archived-project", {
    method: "PATCH",
    body: {
      name: "Archived renamed",
      expectedUpdatedAt: app.database.getProject("archived-project").updatedAt,
    },
  });
  assert.equal(archived.response.status, 409);
  assert.equal(archived.body.error.code, "PROJECT_ARCHIVED");
});
