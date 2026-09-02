import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";

import { createTaskboardServer } from "../server/index.mjs";

const running = [];
const actor = { type: "user", id: "archive-tester", name: "Archive Tester", avatarUrl: null };

afterEach(async () => {
  while (running.length > 0) {
    const { app, directory } = running.pop();
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});

async function start() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "taskboard-project-archive-"));
  const app = createTaskboardServer({ dataDirectory: directory });
  app.database.createProject({ id: "legacy", name: "Legacy mirror", workspacePath: "/tmp/legacy" });
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  running.push({ app, directory });
  return { app, baseUrl: `http://127.0.0.1:${address.port}` };
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

function createTask(app, title) {
  return app.database.createTask({
    projectId: "legacy",
    title,
    description: `${title} body`,
    status: "backlog",
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

function preservedSnapshot(app) {
  const database = app.database.database;
  return {
    tasks: database.prepare("SELECT COUNT(*) AS count FROM tasks WHERE project_id = 'legacy'").get().count,
    taskRows: database.prepare(`
      SELECT id, identifier, title, description, status, stage_id, priority, labels, version, archived_at
      FROM tasks WHERE project_id = 'legacy' ORDER BY id
    `).all(),
    relations: database.prepare(`
      SELECT relation_type, source_task_id, target_task_id, origin, metadata, created_at
      FROM task_relations ORDER BY relation_type, source_task_id, target_task_id
    `).all(),
    comments: database.prepare(`
      SELECT id, task_id, body, version, created_at, updated_at FROM comments ORDER BY id
    `).all(),
    attachments: database.prepare(`
      SELECT id, task_id, comment_id, kind, filename, content_type, size, created_at
      FROM attachments ORDER BY id
    `).all(),
  };
}

test("B7: project archive is metadata-only, hidden by default, read-only, and reversible", async () => {
  const { app, baseUrl } = await start();
  const parent = createTask(app, "Legacy parent");
  const child = createTask(app, "Legacy child");
  const linked = app.database.addTaskRelation(
    parent.id,
    parent.version,
    "parent",
    child.id,
    null,
    undefined,
    actor,
  );
  const comment = app.database.createComment(parent.id, {
    body: "Preserved note",
    threadId: null,
    actor,
  });
  app.database.createAttachment(parent.id, {
    id: "preserved-attachment",
    kind: "attachment",
    filename: "evidence.txt",
    contentType: "text/plain",
    size: 8,
  });
  const before = preservedSnapshot(app);
  const initialProject = app.database.getProject("legacy");

  const archived = await request(baseUrl, "/api/projects/legacy/archive", {
    method: "POST",
    headers: { "idempotency-key": "archive_legacy_one" },
    body: { version: initialProject.version },
  });
  assert.equal(archived.response.status, 200, JSON.stringify(archived.body));
  assert.equal(archived.body.disposition, "archived");
  assert.equal(archived.body.version, initialProject.version + 1);
  assert.ok(archived.body.project.archivedAt);

  const retry = await request(baseUrl, "/api/projects/legacy/archive", {
    method: "POST",
    headers: { "idempotency-key": "archive_legacy_one" },
    body: { version: initialProject.version },
  });
  assert.equal(retry.response.status, 200);
  assert.equal(retry.body.idempotent, true);
  assert.deepEqual(retry.body.project, archived.body.project);

  const listedDefault = await request(baseUrl, "/api/projects");
  assert.equal(listedDefault.body.projects.some((project) => project.id === "legacy"), false);
  const listedArchived = await request(baseUrl, "/api/projects?archived=true");
  assert.equal(listedArchived.body.projects.some((project) => project.id === "legacy"), true);
  const listedAll = await request(baseUrl, "/api/projects?archived=all");
  assert.equal(listedAll.body.projects.some((project) => project.id === "legacy"), true);

  const explicitProject = await request(baseUrl, "/api/projects/legacy");
  assert.equal(explicitProject.response.status, 200);
  assert.equal(explicitProject.body.project.archivedAt, archived.body.project.archivedAt);
  const explicitTask = await request(baseUrl, `/api/tasks/${linked.task.id}`);
  assert.equal(explicitTask.response.status, 200);
  assert.equal(explicitTask.body.task.title, "Legacy parent");
  const comments = await request(baseUrl, `/api/tasks/${linked.task.id}/comments`);
  assert.equal(comments.response.status, 200);
  assert.equal(comments.body.comments.some((entry) => entry.id === comment.id), true);

  const createBlocked = await request(baseUrl, "/api/tasks", {
    method: "POST",
    body: {
      projectId: "legacy",
      title: "Must not exist",
      description: "",
      status: "backlog",
      priority: "none",
      labels: [],
    },
  });
  assert.equal(createBlocked.response.status, 409);
  assert.equal(createBlocked.body.error.code, "PROJECT_ARCHIVED");

  const updateBlocked = await request(baseUrl, `/api/tasks/${linked.task.id}`, {
    method: "PATCH",
    body: { version: linked.task.version, title: "Must not change" },
  });
  assert.equal(updateBlocked.response.status, 409);
  assert.equal(updateBlocked.body.error.code, "PROJECT_ARCHIVED");
  const transitionBlocked = await request(baseUrl, `/api/tasks/${linked.task.id}/transitions`, {
    method: "POST",
    headers: { "idempotency-key": "archived_transition" },
    body: { expectedStateVersion: linked.task.version, actionKey: "ignored", gateEvidence: [] },
  });
  assert.equal(transitionBlocked.response.status, 409);
  assert.equal(transitionBlocked.body.error.code, "PROJECT_ARCHIVED");
  const commentBlocked = await request(baseUrl, `/api/tasks/${linked.task.id}/comments`, {
    method: "POST",
    body: { body: "Must not append" },
  });
  assert.equal(commentBlocked.response.status, 409);
  assert.equal(commentBlocked.body.error.code, "PROJECT_ARCHIVED");
  assert.deepEqual(preservedSnapshot(app), before);

  const restored = await request(baseUrl, "/api/projects/legacy/restore", {
    method: "POST",
    headers: { "idempotency-key": "restore_legacy_one" },
    body: { version: archived.body.version },
  });
  assert.equal(restored.response.status, 200, JSON.stringify(restored.body));
  assert.equal(restored.body.disposition, "active");
  assert.equal(restored.body.project.archivedAt, null);
  assert.equal(restored.body.version, archived.body.version + 1);
  assert.deepEqual(preservedSnapshot(app), before);

  const listedAgain = await request(baseUrl, "/api/projects");
  assert.equal(listedAgain.body.projects.some((project) => project.id === "legacy"), true);
  const createAfterRestore = await request(baseUrl, "/api/tasks", {
    method: "POST",
    body: {
      projectId: "legacy",
      title: "Allowed after restore",
      description: "",
      status: "backlog",
      priority: "none",
      labels: [],
    },
  });
  assert.equal(createAfterRestore.response.status, 201, JSON.stringify(createAfterRestore.body));
});
