import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";

import { createTaskboardServer } from "../server/index.mjs";

const running = [];
const actor = { type: "user", id: "source-record-tester", name: "Source Record Tester", avatarUrl: null };

afterEach(async () => {
  while (running.length > 0) {
    const { app, directory } = running.pop();
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});

async function start() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "taskboard-source-record-"));
  const app = createTaskboardServer({ dataDirectory: directory });
  app.database.createProject({ id: "source-records", name: "Source records", workspacePath: "/tmp/source-records" });
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

function sourcePayload(overrides = {}) {
  return {
    projectId: "source-records",
    title: "Paperclip candidate",
    description: "Imported projection",
    status: "todo",
    priority: "high",
    labels: ["paperclip"],
    sourceSystem: "paperclip",
    externalOrigin: "autoempresa",
    externalId: "pc-123",
    externalVersion: "7",
    sourceFingerprint: "sha256:fixture-7",
    externalKey: "AUT-123",
    externalUrl: "https://paperclip.example/issues/AUT-123",
    ...overrides,
  };
}

test("dedicated ingest persists source ownership while normal work cards stay editable", async () => {
  const { app, baseUrl } = await start();
  const created = await request(baseUrl, "/api/source-records", {
    method: "POST",
    body: sourcePayload(),
  });
  assert.equal(created.response.status, 201, JSON.stringify(created.body));
  assert.equal(created.body.created, true);
  assert.equal(created.body.idempotent, false);
  assert.equal(created.body.task.kind, "source_record");
  assert.equal(created.body.task.readOnly, true);
  assert.equal(created.body.task.sourceSystem, "paperclip");
  assert.equal(created.body.task.externalId, "pc-123");
  assert.equal(created.body.task.externalVersion, "7");
  assert.equal(created.body.task.sourceFingerprint, "sha256:fixture-7");
  assert.equal(created.body.task.candidateState, "available");
  assert.equal(created.body.task.fieldOwnership.title, "source");
  assert.equal(created.body.task.fieldOwnership.candidateState, "local");

  const repeated = await request(baseUrl, "/api/source-records", {
    method: "POST",
    body: sourcePayload(),
  });
  assert.equal(repeated.response.status, 200);
  assert.equal(repeated.body.idempotent, true);
  assert.equal(repeated.body.task.id, created.body.task.id);

  const updated = await request(baseUrl, "/api/source-records", {
    method: "POST",
    body: sourcePayload({ title: "Paperclip candidate updated", externalVersion: "8", sourceFingerprint: "sha256:fixture-8" }),
  });
  assert.equal(updated.response.status, 200, JSON.stringify(updated.body));
  assert.equal(updated.body.idempotent, false);
  assert.equal(updated.body.task.id, created.body.task.id);
  assert.equal(updated.body.task.title, "Paperclip candidate updated");
  assert.equal(updated.body.task.externalVersion, "8");

  const actions = await request(baseUrl, `/api/tasks/${created.body.task.id}/transitions`);
  assert.equal(actions.response.status, 200);
  assert.deepEqual(actions.body.actions, []);

  const pin = app.database.database.prepare(
    "SELECT revision_id FROM workflow_task_pins WHERE task_id = ?",
  ).get(created.body.task.id);
  const acceptanceAction = app.database.database.prepare(`
    SELECT action_key FROM workflow_transition_rules
    WHERE revision_id = ? AND from_task_stage_id = ? AND to_terminal_kind = 'completed'
  `).get(pin.revision_id, updated.body.task.stageId);
  assert.ok(acceptanceAction);
  const beforeEvidence = {
    activities: app.database.database.prepare("SELECT COUNT(*) AS count FROM task_activities WHERE task_id = ?").get(created.body.task.id).count,
    ledger: app.database.database.prepare("SELECT COUNT(*) AS count FROM workflow_ledger_events WHERE aggregate_id = ?").get(created.body.task.id).count,
    evidence: app.database.database.prepare("SELECT COUNT(*) AS count FROM workflow_human_evidence WHERE task_id = ?").get(created.body.task.id).count,
  };
  const forbiddenEvidence = await request(baseUrl, `/api/tasks/${created.body.task.id}/evidence`, {
    method: "POST",
    headers: { "idempotency-key": "source-record-evidence-1" },
    body: {
      expectedStateVersion: updated.body.task.version,
      actionKey: acceptanceAction.action_key,
    },
  });
  assert.equal(forbiddenEvidence.response.status, 409, JSON.stringify(forbiddenEvidence.body));
  assert.equal(forbiddenEvidence.body.error.code, "SOURCE_RECORD_READ_ONLY");
  assert.deepEqual({
    activities: app.database.database.prepare("SELECT COUNT(*) AS count FROM task_activities WHERE task_id = ?").get(created.body.task.id).count,
    ledger: app.database.database.prepare("SELECT COUNT(*) AS count FROM workflow_ledger_events WHERE aggregate_id = ?").get(created.body.task.id).count,
    evidence: app.database.database.prepare("SELECT COUNT(*) AS count FROM workflow_human_evidence WHERE task_id = ?").get(created.body.task.id).count,
  }, beforeEvidence);

  const forbiddenPatch = await request(baseUrl, `/api/tasks/${created.body.task.id}`, {
    method: "PATCH",
    body: { version: updated.body.task.version, title: "Local overwrite" },
  });
  assert.equal(forbiddenPatch.response.status, 409);
  assert.equal(forbiddenPatch.body.error.code, "SOURCE_RECORD_READ_ONLY");

  const forbiddenMove = await request(baseUrl, `/api/tasks/${created.body.task.id}/move`, {
    method: "POST",
    body: { version: updated.body.task.version, status: "in_progress" },
  });
  assert.equal(forbiddenMove.response.status, 409);
  assert.equal(forbiddenMove.body.error.code, "SOURCE_RECORD_READ_ONLY");

  const workCard = app.database.createTask({
    projectId: "source-records",
    title: "Editable work card",
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
  assert.equal(workCard.kind, "work_card");
  assert.equal(workCard.readOnly, false);
  assert.equal(workCard.fieldOwnership.title, "local");

  const editable = await request(baseUrl, `/api/tasks/${workCard.id}`, {
    method: "PATCH",
    body: { version: workCard.version, title: "Edited work card" },
  });
  assert.equal(editable.response.status, 200, JSON.stringify(editable.body));
  assert.equal(editable.body.task.title, "Edited work card");
});
