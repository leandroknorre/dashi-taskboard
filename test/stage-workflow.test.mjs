import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { TaskboardDatabase } from "../server/database.mjs";

const actor = { type: "user", id: "test-user", name: "Test user", avatarUrl: null };

function createTask(database, stageId, title = "Uses a custom stage") {
  return database.createTask({
    projectId: "example",
    title,
    description: "",
    status: "todo",
    stageId,
    priority: "none",
    labels: [],
    actor,
    assignee: actor,
    developmentContext: null,
    startDate: null,
    dueDate: null,
    recurrence: null,
  });
}

test("empty projects remain editable until their first task pins the configured stage workflow", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "taskboard-stage-workflow-"));
  const database = new TaskboardDatabase(path.join(directory, "taskboard.sqlite"));
  try {
    database.createProject({ id: "example", name: "Example", workspacePath: null });
    const initial = database.getStageWorkflow("example");
    assert.equal(initial.definition.stages.length, 7);
    assert.equal(initial.definition.stages.filter((stage) => stage.isDefaultForStatus).length, 7);
    assert.equal(
      database.database.prepare("SELECT COUNT(*) AS count FROM workflow_definitions WHERE project_id = ?").get("example").count,
      0,
    );

    const extras = Array.from({ length: 7 }, (_, index) => ({
      stageId: randomUUID(),
      canonicalStatus: "todo",
      name: `Stage ${index + 8}`,
      order: initial.definition.stages.length + index,
      boardVisible: true,
      active: true,
      isDefaultForStatus: false,
      terminalKind: "none",
    }));
    const created = database.saveStageWorkflow("example", initial.version, {
      schemaVersion: 2,
      stages: [...initial.definition.stages, ...extras],
    });
    assert.equal(created.definition.stages.length, 14);
    const stageEight = extras[0];
    const stageFourteen = extras.at(-1);
    const task = createTask(database, stageEight.stageId);
    const finalStageTask = createTask(database, stageFourteen.stageId, "Uses the final custom stage");
    assert.equal(task.status, "todo");
    assert.equal(task.stageId, stageEight.stageId);
    assert.equal(finalStageTask.stageId, stageFourteen.stageId);
    const definition = database.database.prepare(
      "SELECT current_revision_id FROM workflow_definitions WHERE project_id = ?",
    ).get("example");
    assert.ok(definition.current_revision_id);
    assert.equal(
      database.database.prepare("SELECT COUNT(*) AS count FROM workflow_task_pins WHERE task_id = ?").get(task.id).count,
      1,
    );
    assert.throws(
      () => database.saveStageWorkflow("example", created.version, {
        schemaVersion: 2,
        stages: created.definition.stages.filter((stage) => stage.stageId !== stageEight.stageId),
      }),
      (error) => error?.code === "WORKFLOW_AUTHORING_UNAVAILABLE",
    );
    assert.equal(database.getTask(task.id).stageId, stageEight.stageId);
    assert.equal(database.getTask(finalStageTask.id).stageId, stageFourteen.stageId);
  } finally {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("startup migration leaves an empty project's configured stages editable", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "taskboard-stage-workflow-restart-"));
  const filename = path.join(directory, "taskboard.sqlite");
  let database = new TaskboardDatabase(filename);
  try {
    database.createProject({ id: "empty", name: "Empty", workspacePath: null });
    database.getStageWorkflow("empty");
    database.close();
    database = new TaskboardDatabase(filename);

    const initial = database.getStageWorkflow("empty");
    assert.equal(
      database.database.prepare("SELECT COUNT(*) AS count FROM workflow_definitions WHERE project_id = ?").get("empty").count,
      0,
    );
    const renamed = initial.definition.stages.map((stage, index) => (
      index === 0 ? { ...stage, name: "Inbox" } : stage
    ));
    assert.equal(
      database.saveStageWorkflow("empty", initial.version, { schemaVersion: 2, stages: renamed })
        .definition.stages[0].name,
      "Inbox",
    );
  } finally {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Jira imports pin a workflow at the first inserted task", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "taskboard-stage-workflow-jira-"));
  const database = new TaskboardDatabase(path.join(directory, "taskboard.sqlite"));
  try {
    database.syncJiraTasks([{
      id: "JIRA:EXAMPLE:1",
      identifier: "JIRA:EXAMPLE:1",
      title: "Imported task",
      description: "",
      status: "todo",
      priority: "none",
      labels: [],
      sortOrder: 1024,
      creator: actor,
      assignee: actor,
      dueDate: null,
      externalOrigin: "example",
      externalId: "1",
      externalKey: "EXAMPLE-1",
      externalUrl: "https://jira.example.test/browse/EXAMPLE-1",
      createdAt: "2026-08-26T00:00:00.000Z",
      updatedAt: "2026-08-26T00:00:00.000Z",
    }], { archiveMissing: false, projectName: "Jira test" });
    const task = database.getTask("JIRA:EXAMPLE:1");
    assert.ok(task);
    assert.equal(
      database.database.prepare("SELECT COUNT(*) AS count FROM workflow_definitions WHERE project_id = 'jira-my-tasks'").get().count,
      1,
    );
    assert.equal(
      database.database.prepare("SELECT COUNT(*) AS count FROM workflow_task_pins WHERE task_id = ?").get(task.id).count,
      1,
    );
  } finally {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
