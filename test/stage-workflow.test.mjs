import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { TaskboardDatabase } from "../server/database.mjs";

const actor = { type: "user", id: "test-user", name: "Test user", avatarUrl: null };

test("project stages persist, map to canonical statuses, and remap issues on removal", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "taskboard-stage-workflow-"));
  const database = new TaskboardDatabase(path.join(directory, "taskboard.sqlite"));
  try {
    database.createProject({ id: "example", name: "Example", workspacePath: null });
    const initial = database.getStageWorkflow("example");
    assert.equal(initial.definition.stages.length, 7);
    assert.equal(initial.definition.stages.filter((stage) => stage.isDefaultForStatus).length, 7);

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
    const task = database.createTask({
      projectId: "example",
      title: "Uses a custom stage",
      description: "",
      status: "todo",
      stageId: stageEight.stageId,
      priority: "none",
      labels: [],
      actor,
      assignee: actor,
      developmentContext: null,
      startDate: null,
      dueDate: null,
      recurrence: null,
    });
    const finalStageTask = database.createTask({
      projectId: "example",
      title: "Uses the final custom stage",
      description: "",
      status: "todo",
      stageId: stageFourteen.stageId,
      priority: "none",
      labels: [],
      actor,
      assignee: actor,
      developmentContext: null,
      startDate: null,
      dueDate: null,
      recurrence: null,
    });
    assert.equal(task.status, "todo");
    assert.equal(task.stageId, stageEight.stageId);
    assert.equal(finalStageTask.stageId, stageFourteen.stageId);

    const todoDefault = created.definition.stages.find((stage) => (
      stage.canonicalStatus === "todo" && stage.isDefaultForStatus
    ));
    const updated = database.saveStageWorkflow("example", created.version, {
      schemaVersion: 2,
      stages: created.definition.stages.filter((stage) => stage.stageId !== stageEight.stageId),
    }, [{ stageId: stageEight.stageId, destinationStageId: todoDefault.stageId }]);
    assert.equal(updated.definition.stages.some((stage) => stage.stageId === stageEight.stageId), false);
    assert.equal(database.getTask(task.id).stageId, todoDefault.stageId);
    assert.equal(database.getTask(finalStageTask.id).stageId, stageFourteen.stageId);
  } finally {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
