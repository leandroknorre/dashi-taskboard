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
  app.database.createProject({ id: "work", name: "Work", workspacePath: "/tmp/work" });
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

test("B4: concurrent adopt and retries create exactly one linked work_card", async () => {
  const { app, baseUrl } = await start();
  const ingested = await request(baseUrl, "/api/source-records", {
    method: "POST",
    body: sourcePayload({ externalId: "adopt-1", externalKey: "AUT-ADOPT-1" }),
  });
  const source = ingested.body.task;

  const [first, concurrent] = await Promise.all([
    request(baseUrl, `/api/source-records/${source.id}/adopt`, {
      method: "POST",
      headers: { "idempotency-key": "adopt_concurrent_one" },
      body: { version: source.version, targetProjectId: "work" },
    }),
    request(baseUrl, `/api/source-records/${source.id}/adopt`, {
      method: "POST",
      headers: { "idempotency-key": "adopt_concurrent_two" },
      body: { version: source.version, targetProjectId: "work" },
    }),
  ]);
  assert.equal(first.response.status, 200, JSON.stringify(first.body));
  assert.equal(concurrent.response.status, 200, JSON.stringify(concurrent.body));
  assert.equal(first.body.targetTaskId, concurrent.body.targetTaskId);
  assert.deepEqual(new Set([first.body.idempotent, concurrent.body.idempotent]), new Set([false, true]));
  assert.equal(first.body.disposition, "adopted");

  const count = app.database.database.prepare(`
    SELECT COUNT(*) AS count FROM tasks WHERE project_id = 'work' AND kind = 'work_card'
  `).get().count;
  assert.equal(count, 1);
  const linked = app.database.getTask(source.id);
  assert.equal(linked.candidateState, "adopted");
  assert.equal(linked.candidateTargetTaskId, first.body.targetTaskId);
  const workCard = app.database.getTask(first.body.targetTaskId);
  assert.equal(workCard.kind, "work_card");
  assert.equal(workCard.readOnly, false);
  assert.equal(workCard.projectId, "work");
  assert.equal(workCard.sourceSystem, null);

  const exactRetry = await request(baseUrl, `/api/source-records/${source.id}/adopt`, {
    method: "POST",
    headers: { "idempotency-key": "adopt_concurrent_one" },
    body: { version: source.version, targetProjectId: "work" },
  });
  assert.equal(exactRetry.response.status, 200);
  assert.equal(exactRetry.body.idempotent, true);
  assert.equal(exactRetry.body.targetTaskId, workCard.id);

  const functionalRetry = await request(baseUrl, `/api/source-records/${source.id}/adopt`, {
    method: "POST",
    headers: { "idempotency-key": "adopt_functional_repeat" },
    body: { version: source.version, targetProjectId: "work" },
  });
  assert.equal(functionalRetry.response.status, 200);
  assert.equal(functionalRetry.body.idempotent, true);
  assert.equal(functionalRetry.body.targetTaskId, workCard.id);
  assert.equal(app.database.database.prepare(`
    SELECT COUNT(*) AS count FROM tasks WHERE project_id = 'work' AND kind = 'work_card'
  `).get().count, 1);

  const reingested = await request(baseUrl, "/api/source-records", {
    method: "POST",
    body: sourcePayload({
      externalId: "adopt-1",
      externalKey: "AUT-ADOPT-1",
      title: "Source changed after adoption",
      externalVersion: "8",
      sourceFingerprint: "sha256:adopt-8",
    }),
  });
  assert.equal(reingested.response.status, 200);
  assert.equal(reingested.body.task.title, "Source changed after adoption");
  assert.equal(app.database.getTask(workCard.id).title, "Paperclip candidate");
});

test("B4: adopt rolls back its work_card and project counter when the source link cannot commit", async () => {
  const { app, baseUrl } = await start();
  const ingested = await request(baseUrl, "/api/source-records", {
    method: "POST",
    body: sourcePayload({ externalId: "adopt-rollback", externalKey: "AUT-ROLLBACK" }),
  });
  const source = ingested.body.task;
  const beforeCounter = app.database.database.prepare(`
    SELECT next_task_number FROM projects WHERE id = 'work'
  `).get().next_task_number;
  app.database.database.exec(`
    CREATE TRIGGER fail_candidate_link
    BEFORE UPDATE OF candidate_state ON tasks
    WHEN OLD.id = '${source.id}'
    BEGIN
      SELECT RAISE(ABORT, 'forced candidate link failure');
    END;
  `);
  const failed = await request(baseUrl, `/api/source-records/${source.id}/adopt`, {
    method: "POST",
    headers: { "idempotency-key": "adopt_forced_rollback" },
    body: { version: source.version, targetProjectId: "work" },
  });
  assert.equal(failed.response.status, 500);
  assert.equal(app.database.database.prepare(`
    SELECT COUNT(*) AS count FROM tasks WHERE project_id = 'work' AND kind = 'work_card'
  `).get().count, 0);
  assert.equal(app.database.database.prepare(`
    SELECT next_task_number FROM projects WHERE id = 'work'
  `).get().next_task_number, beforeCounter);
  assert.equal(app.database.getTask(source.id).candidateState, "available");
  assert.equal(app.database.database.prepare(`
    SELECT COUNT(*) AS count FROM source_candidate_requests WHERE idempotency_key = 'adopt_forced_rollback'
  `).get().count, 0);
});

test("B5: merge links an existing work_card without changing any target field", async () => {
  const { app, baseUrl } = await start();
  const sourceResponse = await request(baseUrl, "/api/source-records", {
    method: "POST",
    body: sourcePayload({ externalId: "merge-1", externalKey: "AUT-MERGE-1" }),
  });
  const source = sourceResponse.body.task;
  const target = app.database.createTask({
    projectId: "work",
    title: "Existing operational card",
    description: "Local truth",
    status: "in_progress",
    priority: "urgent",
    labels: ["local"],
    threadId: null,
    actor,
    assignee: actor,
    developmentContext: null,
    startDate: null,
    dueDate: null,
    recurrence: null,
  });
  const before = app.database.database.prepare("SELECT * FROM tasks WHERE id = ?").get(target.id);

  const merged = await request(baseUrl, `/api/source-records/${source.id}/merge`, {
    method: "POST",
    headers: { "idempotency-key": "merge_existing_one" },
    body: { version: source.version, targetTaskId: target.id },
  });
  assert.equal(merged.response.status, 200, JSON.stringify(merged.body));
  assert.equal(merged.body.disposition, "merged");
  assert.equal(merged.body.targetTaskId, target.id);
  assert.equal(merged.body.sourceRecord.candidateTargetTaskId, target.id);
  assert.deepEqual(app.database.database.prepare("SELECT * FROM tasks WHERE id = ?").get(target.id), before);

  const repeated = await request(baseUrl, `/api/source-records/${source.id}/merge`, {
    method: "POST",
    headers: { "idempotency-key": "merge_existing_repeat" },
    body: { version: source.version, targetTaskId: target.id },
  });
  assert.equal(repeated.response.status, 200);
  assert.equal(repeated.body.idempotent, true);
  assert.equal(repeated.body.targetTaskId, target.id);
  assert.deepEqual(app.database.database.prepare("SELECT * FROM tasks WHERE id = ?").get(target.id), before);
});

test("B6: discard leaves a recoverable audit record and restore returns it to pending", async () => {
  const { app, baseUrl } = await start();
  const sourceResponse = await request(baseUrl, "/api/source-records", {
    method: "POST",
    body: sourcePayload({ externalId: "discard-1", externalKey: "AUT-DISCARD-1" }),
  });
  const source = sourceResponse.body.task;
  const discarded = await request(baseUrl, `/api/source-records/${source.id}/discard`, {
    method: "POST",
    headers: { "idempotency-key": "discard_one" },
    body: { version: source.version },
  });
  assert.equal(discarded.response.status, 200, JSON.stringify(discarded.body));
  assert.equal(discarded.body.disposition, "discarded");
  assert.equal(discarded.body.targetTaskId, null);
  assert.equal(discarded.body.sourceRecord.candidateState, "discarded");
  assert.ok(discarded.body.sourceRecord.candidateDispositionAt);

  const defaultQueue = await request(baseUrl, "/api/tasks?projectId=source-records");
  assert.equal(defaultQueue.response.status, 200);
  assert.equal(defaultQueue.body.tasks.some((task) => task.id === source.id), false);
  const recoveryQueue = await request(baseUrl, "/api/tasks?projectId=source-records&archived=all");
  assert.equal(recoveryQueue.body.tasks.some((task) => task.id === source.id), true);
  const explicit = await request(baseUrl, `/api/tasks/${source.id}`);
  assert.equal(explicit.body.task.candidateState, "discarded");
  assert.equal(app.database.database.prepare(`
    SELECT COUNT(*) AS count FROM source_candidate_requests WHERE source_task_id = ?
  `).get(source.id).count, 1);

  const restored = await request(baseUrl, `/api/source-records/${source.id}/restore`, {
    method: "POST",
    headers: { "idempotency-key": "restore_one" },
    body: { version: discarded.body.version },
  });
  assert.equal(restored.response.status, 200, JSON.stringify(restored.body));
  assert.equal(restored.body.disposition, "pending");
  assert.equal(restored.body.sourceRecord.candidateState, "available");
  assert.equal(restored.body.sourceRecord.candidateDispositionAt, null);
  const pendingQueue = await request(baseUrl, "/api/tasks?projectId=source-records");
  assert.equal(pendingQueue.body.tasks.some((task) => task.id === source.id), true);

  const stale = await request(baseUrl, `/api/source-records/${source.id}/discard`, {
    method: "POST",
    headers: { "idempotency-key": "discard_stale" },
    body: { version: source.version },
  });
  assert.equal(stale.response.status, 409);
  assert.equal(stale.body.error.code, "VERSION_CONFLICT");

  const conflictingKey = await request(baseUrl, `/api/source-records/${source.id}/discard`, {
    method: "POST",
    headers: { "idempotency-key": "restore_one" },
    body: { version: restored.body.version },
  });
  assert.equal(conflictingKey.response.status, 409);
  assert.equal(conflictingKey.body.error.code, "IDEMPOTENCY_CONFLICT");
});
