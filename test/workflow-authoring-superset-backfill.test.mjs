import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";

import { createTaskboardServer } from "../server/index.mjs";

// A task's workflow pin (workflow_task_pins) is immutable by design: it is
// set once at task creation and never UPDATEd/DELETEd while the task lives.
// So publishing a workflow revision that only ADDS a stage (a superset of
// the previous one) cannot re-pin an older card onto the new revision. This
// suite proves the additive alternative instead: the previous, still-pinned
// revision(s) get backfilled with a binding + legacy transition rules for
// the new stage, so an old card becomes movable into it without touching a
// single immutable row.

const running = [];
const actor = { type: "user", id: "workflow-author", name: "Workflow Author", avatarUrl: null };

afterEach(async () => {
  while (running.length > 0) {
    const { app, directory } = running.pop();
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});

async function start() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "taskboard-superset-backfill-"));
  const app = createTaskboardServer({ dataDirectory: directory });
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

function createProject(app, id = "backfill") {
  return app.database.createProject({ id, name: "Backfill", workspacePath: null });
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

/** Appends a brand-new, non-terminal stage (no stageId => always "new"). */
function withExtraStage(workflow, name, { isDefaultForStatus = false } = {}) {
  const maxOrder = Math.max(...workflow.definition.stages.map((stage) => stage.order));
  return {
    ...workflow.definition,
    stages: [
      ...workflow.definition.stages,
      {
        stageId: null,
        canonicalStatus: "todo",
        name,
        boardVisible: true,
        order: maxOrder + 1,
        active: true,
        isDefaultForStatus,
        terminalKind: "none",
      },
    ],
  };
}

test("a card pinned to an old revision can move into a stage added by a later, superset publish", async () => {
  const { app, baseUrl } = await start();
  createProject(app);
  const oldTask = createTask(app, "backfill", "Pinned before Clarificar existed");

  const before = await request(baseUrl, "/api/projects/backfill/workflow-authoring");
  assert.equal(before.response.status, 200);
  const oldRevisionId = before.body.workflow.revisionId;
  const oldStageCount = before.body.workflow.definition.stages.length;

  const definition = withExtraStage(before.body.workflow, "Clarificar");
  const published = await request(baseUrl, "/api/projects/backfill/workflow-authoring/publish", {
    method: "POST",
    body: { expectedRevisionId: oldRevisionId, definition },
  });
  assert.equal(published.response.status, 201, JSON.stringify(published.body));
  const clarificar = published.body.workflow.definition.stages.find((stage) => stage.name === "Clarificar");
  assert.ok(clarificar, "the published definition includes the new stage");

  // The old task's pin never moved — that row is genuinely immutable.
  const pin = app.database.database.prepare(
    "SELECT revision_id FROM workflow_task_pins WHERE task_id = ?",
  ).get(oldTask.id);
  assert.equal(pin.revision_id, oldRevisionId);

  // But its pinned (old) revision was additively backfilled: a binding for
  // Clarificar, without ever UPDATEing/DELETEing an existing row.
  const allBindings = app.database.database.prepare(`
    SELECT * FROM workflow_revision_stage_bindings WHERE revision_id = ?
  `).all(oldRevisionId);
  assert.equal(allBindings.length, oldStageCount + 1, "old revision gained exactly one new binding");
  assert.ok(
    allBindings.some((binding) => binding.task_stage_id === clarificar.stageId),
    "the new binding is for Clarificar",
  );

  // GET /api/tasks/:id/transitions must now list an action from the old
  // pinned revision straight into Clarificar.
  const actions = await request(baseUrl, `/api/tasks/${oldTask.id}/transitions`);
  assert.equal(actions.response.status, 200);
  const toClarificar = actions.body.actions.find((action) => action.toStageId === clarificar.stageId);
  assert.ok(toClarificar, `expected an action into Clarificar, got ${JSON.stringify(actions.body.actions)}`);
  assert.equal(toClarificar.toStatus, "todo");

  // POST the move: this is the actual proof — the old card really moves.
  const moved = await request(baseUrl, `/api/tasks/${oldTask.id}/transitions`, {
    method: "POST",
    headers: { "idempotency-key": "move-old-card-into-clarificar" },
    body: {
      expectedStateVersion: oldTask.version,
      actionKey: toClarificar.actionKey,
      gateEvidence: [],
      authorizationId: null,
    },
  });
  assert.equal(moved.response.status, 200, JSON.stringify(moved.body));
  assert.equal(moved.body.task.stageId, clarificar.stageId);

  // The task's pin itself never moves (only its stage does) — oldTask is
  // still pinned to oldRevisionId, so a THIRD, further-superset publish
  // must backfill it again, composing on top of the first backfill.
  assert.equal(
    app.database.database.prepare("SELECT revision_id FROM workflow_task_pins WHERE task_id = ?").get(oldTask.id).revision_id,
    oldRevisionId,
  );
  const thirdDefinition = withExtraStage(published.body.workflow, "Later Stage");
  const thirdPublish = await request(baseUrl, "/api/projects/backfill/workflow-authoring/publish", {
    method: "POST",
    body: { expectedRevisionId: published.body.workflow.revisionId, definition: thirdDefinition },
  });
  assert.equal(thirdPublish.response.status, 201, JSON.stringify(thirdPublish.body));
  const laterStage = thirdPublish.body.workflow.definition.stages.find((stage) => stage.name === "Later Stage");
  const bindingsAfterThirdPublish = app.database.database.prepare(
    "SELECT COUNT(*) AS count FROM workflow_revision_stage_bindings WHERE revision_id = ?",
  ).get(oldRevisionId).count;
  assert.equal(bindingsAfterThirdPublish, oldStageCount + 2, "still-pinned old revision is backfilled again");
  const actionsAfterThird = await request(baseUrl, `/api/tasks/${oldTask.id}/transitions`);
  assert.ok(
    actionsAfterThird.body.actions.some((action) => action.toStageId === laterStage.stageId),
    "the old-revision card can now also reach the third revision's new stage",
  );
});

test("a revision whose stage set was narrowed by a later publish is not backfilled", async () => {
  const { app, baseUrl } = await start();
  createProject(app);

  // revision 2 = default stages + "Temporary" (a superset of revision 1,
  // which has no task pinned to it and is otherwise irrelevant here).
  const revision1 = await request(baseUrl, "/api/projects/backfill/workflow-authoring");
  const withTemporary = withExtraStage(revision1.body.workflow, "Temporary");
  const revision2 = await request(baseUrl, "/api/projects/backfill/workflow-authoring/publish", {
    method: "POST",
    body: { expectedRevisionId: revision1.body.workflow.revisionId, definition: withTemporary },
  });
  assert.equal(revision2.response.status, 201, JSON.stringify(revision2.body));
  const revision2Id = revision2.body.workflow.revisionId;

  // The task is created now, while "Temporary" is part of the live
  // workflow — it pins to revision 2.
  const task = createTask(app, "backfill", "Pinned while Temporary still existed");
  assert.equal(
    app.database.database.prepare("SELECT revision_id FROM workflow_task_pins WHERE task_id = ?").get(task.id).revision_id,
    revision2Id,
  );

  // revision 3 drops "Temporary" and adds "Clarificar" — relative to
  // revision 2 (the task's pin) this is NOT a superset, so revision 2 must
  // not be backfilled with Clarificar.
  const withoutTemporary = revision2.body.workflow.definition.stages.filter((stage) => stage.name !== "Temporary");
  const maxOrder = Math.max(...withoutTemporary.map((stage) => stage.order));
  const revision3Definition = {
    ...revision2.body.workflow.definition,
    stages: [
      ...withoutTemporary,
      { stageId: null, canonicalStatus: "todo", name: "Clarificar", boardVisible: true, order: maxOrder + 1, active: true, isDefaultForStatus: false, terminalKind: "none" },
    ],
  };
  const revision3 = await request(baseUrl, "/api/projects/backfill/workflow-authoring/publish", {
    method: "POST",
    body: { expectedRevisionId: revision2Id, definition: revision3Definition },
  });
  assert.equal(revision3.response.status, 201, JSON.stringify(revision3.body));
  const clarificar = revision3.body.workflow.definition.stages.find((stage) => stage.name === "Clarificar");

  const bindingCountBefore = withTemporary.stages.length;
  const bindingCountAfter = app.database.database.prepare(
    "SELECT COUNT(*) AS count FROM workflow_revision_stage_bindings WHERE revision_id = ?",
  ).get(revision2Id).count;
  assert.equal(bindingCountAfter, bindingCountBefore, "narrowed-away revision 2 gains no Clarificar binding");

  const actions = await request(baseUrl, `/api/tasks/${task.id}/transitions`);
  assert.equal(actions.response.status, 200);
  assert.ok(
    actions.body.actions.every((action) => action.toStageId !== clarificar.stageId),
    "the task's pinned revision has no path into Clarificar",
  );
});
