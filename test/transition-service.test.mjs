import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";

import { TaskboardDatabase } from "../server/database.mjs";
import { TransitionService } from "../server/transition-service.mjs";
import {
  acceptanceEvidence,
  humanAuthorization,
  revocation,
} from "./fixtures/workflow-control.mjs";

const fixtures = [];
const actor = { type: "user", id: "transition-tester", name: "Transition Tester", avatarUrl: null };

afterEach(async () => {
  while (fixtures.length > 0) {
    const fixture = fixtures.pop();
    for (const database of fixture.extraDatabases) database.close();
    fixture.database.close();
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

async function createFixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "taskboard-transition-service-"));
  const filename = path.join(directory, "taskboard.sqlite");
  const database = new TaskboardDatabase(filename);
  database.createProject({ id: "transition-project", name: "Transition project", workspacePath: "/tmp/transition" });
  const fixture = {
    directory,
    filename,
    database,
    service: new TransitionService(database),
    extraDatabases: [],
  };
  fixtures.push(fixture);
  return fixture;
}

function createTask(fixture, title, overrides = {}) {
  return fixture.database.createTask({
    projectId: "transition-project",
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
    ...overrides,
  });
}

function nonTerminalAction(service, taskId) {
  const action = service.listActions(taskId).find((item) => item.toTerminalKind === "none");
  assert.ok(action, "the legacy revision must expose a non-terminal action");
  return action;
}

function completionAction(service, taskId) {
  const action = service.listActions(taskId).find((item) => item.toTerminalKind === "completed");
  assert.ok(action, "the legacy revision must expose a completion action");
  return action;
}

function cancellationAction(service, taskId) {
  const action = service.listActions(taskId).find((item) => item.toTerminalKind === "canceled");
  assert.ok(action, "the legacy revision must expose a cancellation action");
  return action;
}

function validAcceptance() {
  return acceptanceEvidence({
    evidenceId: randomUUID(),
    record: { evidenceEventId: randomUUID(), eventHash: "a".repeat(64) },
  });
}

function command(task, action, idempotencyKey, overrides = {}) {
  return {
    expectedStateVersion: task.version,
    actionKey: action.actionKey,
    gateEvidence: [],
    authorizationId: null,
    idempotencyKey,
    ...overrides,
  };
}

function workflowCounts(database) {
  return {
    events: database.database.prepare("SELECT COUNT(*) AS count FROM workflow_ledger_events").get().count,
    outbox: database.database.prepare("SELECT COUNT(*) AS count FROM workflow_outbox").get().count,
    requests: database.database.prepare("SELECT COUNT(*) AS count FROM workflow_transition_requests").get().count,
  };
}

test("a transition appends ledger, projection, outbox, and returns the same effect after an uncertain retry", async () => {
  const fixture = await createFixture();
  const task = createTask(fixture, "Move safely");
  const action = nonTerminalAction(fixture.service, task.id);
  const input = command(task, action, "transition-retry-1");

  const original = fixture.service.transition(task.id, input, { actor });
  const retried = fixture.service.transition(task.id, input, { actor });

  assert.equal(original.idempotent, false);
  assert.equal(retried.idempotent, true);
  assert.equal(retried.task.id, original.task.id);
  assert.equal(retried.task.version, original.task.version);
  assert.equal(retried.request.eventId, original.request.eventId);
  assert.deepEqual(workflowCounts(fixture.database), { events: 1, outbox: 1, requests: 1 });
  assert.equal(
    fixture.database.database.prepare(`
      SELECT last_event_sequence, last_event_hash, task_version
      FROM workflow_work_item_projections WHERE work_item_id = ?
    `).get(task.id).last_event_sequence,
    1,
  );

  assert.throws(
    () => fixture.service.transition(task.id, {
      ...input,
      gateEvidence: [validAcceptance()],
    }, { actor }),
    (error) => error?.status === 409 && error?.code === "IDEMPOTENCY_CONFLICT",
  );
});

test("two service connections serialize the CAS: one state write wins and the stale command cannot append", async () => {
  const fixture = await createFixture();
  const task = createTask(fixture, "Contended task");
  const firstAction = nonTerminalAction(fixture.service, task.id);
  const secondDatabase = new TaskboardDatabase(fixture.filename);
  fixture.extraDatabases.push(secondDatabase);
  const secondService = new TransitionService(secondDatabase);
  const secondAction = nonTerminalAction(secondService, task.id);

  const results = await Promise.allSettled([
    Promise.resolve().then(() => fixture.service.transition(
      task.id,
      command(task, firstAction, "concurrent-transition-a"),
      { actor },
    )),
    Promise.resolve().then(() => secondService.transition(
      task.id,
      command(task, secondAction, "concurrent-transition-b"),
      { actor },
    )),
  ]);

  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  const rejected = results.find((result) => result.status === "rejected");
  assert.equal(rejected.reason.code, "EXPECTED_STATE_CONFLICT");
  assert.deepEqual(workflowCounts(fixture.database), { events: 1, outbox: 1, requests: 1 });
  assert.equal(fixture.database.getTask(task.id).version, task.version + 1);
});

test("completion needs valid human acceptance and every required descendant, but never waits for optional descendants", async () => {
  const fixture = await createFixture();
  let parent = createTask(fixture, "Parent");
  const requiredChild = createTask(fixture, "Required child");
  const optionalChild = createTask(fixture, "Optional child");
  fixture.database.addTaskRelation(
    requiredChild.id, requiredChild.version, "parent", parent.id,
    undefined, undefined, actor, "manual", { required: true, rollup: true },
  );
  fixture.database.addTaskRelation(
    optionalChild.id, optionalChild.version, "parent", parent.id,
    undefined, undefined, actor, "manual", { required: false, rollup: true },
  );
  const parentCompletion = completionAction(fixture.service, parent.id);

  assert.throws(
    () => fixture.service.transition(parent.id, command(
      parent,
      parentCompletion,
      "parent-before-required",
      { gateEvidence: [validAcceptance()] },
    ), { actor }),
    (error) => error?.status === 409 && error?.code === "REQUIRED_DESCENDANT_INCOMPLETE",
  );
  assert.deepEqual(workflowCounts(fixture.database), { events: 0, outbox: 0, requests: 0 });

  const refreshedRequiredChild = fixture.database.getTask(requiredChild.id);
  const childCompletion = completionAction(fixture.service, refreshedRequiredChild.id);
  fixture.service.transition(refreshedRequiredChild.id, command(
    refreshedRequiredChild,
    childCompletion,
    "required-child-complete",
    { gateEvidence: [validAcceptance()] },
  ), { actor });

  const completedParent = fixture.service.transition(parent.id, command(
    fixture.database.getTask(parent.id),
    parentCompletion,
    "parent-after-required",
    { gateEvidence: [validAcceptance()] },
  ), { actor });
  assert.equal(completedParent.task.status, "done");
  assert.equal(fixture.database.getTask(optionalChild.id).status, "todo");
  assert.equal(workflowCounts(fixture.database).events, 2);
});

test("revoked and narrowly mismatched authorization records cannot cancel a pinned task", async () => {
  const fixture = await createFixture();
  const originalTask = createTask(fixture, "Original revision task");
  const original = fixture.service.getTaskWorkflow(originalTask.id);
  const bindings = fixture.database.database.prepare(`
    SELECT contract_stage_id, task_stage_id, canonical_status, terminal_kind, stage_order
    FROM workflow_revision_stage_bindings WHERE revision_id = ? ORDER BY stage_order
  `).all(original.revisionId).map((row) => ({
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
  `).all(original.revisionId).map((row) => ({
    actionKey: row.action_key,
    transitionId: row.transition_id,
    fromTaskStageId: row.from_task_stage_id,
    toTaskStageId: row.to_task_stage_id,
    fromContractStageId: row.from_contract_stage_id,
    toContractStageId: row.to_contract_stage_id,
    toTerminalKind: row.to_terminal_kind,
    legacy: row.legacy === 1,
  }));
  const originalCancellation = cancellationAction(fixture.service, originalTask.id);
  const protectedDefinition = structuredClone(original.definition);
  protectedDefinition.revisionId = randomUUID();
  protectedDefinition.revision = original.revision + 1;
  protectedDefinition.createdAt = "2026-08-25T00:00:00.000Z";
  protectedDefinition.transitions = protectedDefinition.transitions.map((transition) => (
    transition.transitionId === originalCancellation.transitionId
      ? {
        ...transition,
        irreversible: true,
        authorization: { required: true, action: "cancel_task" },
      }
      : transition
  ));
  fixture.service.publishRevision({
    projectId: "transition-project",
    definition: protectedDefinition,
    bindings,
    rules,
  });

  const task = createTask(fixture, "Authorized task");
  const action = cancellationAction(fixture.service, task.id);
  const workflow = fixture.service.getTaskWorkflow(task.id);
  assert.equal(workflow.revisionId, protectedDefinition.revisionId);
  const scope = {
    workflowId: workflow.workflowId,
    revisionId: workflow.revisionId,
    transitionId: action.transitionId,
    target: { type: "task", id: task.id },
  };
  const revokedId = randomUUID();
  fixture.service.storeAuthorization(humanAuthorization({
    authorizationId: revokedId,
    action: "cancel_task",
    scope,
    expiresAt: null,
    status: "revoked",
    revocation: revocation({ revokedAt: "2026-08-25T00:00:00.000Z" }),
  }));
  assert.throws(
    () => fixture.service.transition(task.id, command(task, action, "cancel-revoked", { authorizationId: revokedId }), { actor }),
    (error) => error?.status === 409 && error?.code === "AUTHORIZATION_REVOKED",
  );

  const mismatchedId = randomUUID();
  fixture.service.storeAuthorization(humanAuthorization({
    authorizationId: mismatchedId,
    action: "cancel_task",
    scope: { ...scope, target: { type: "task", id: randomUUID() } },
    expiresAt: null,
  }));
  assert.throws(
    () => fixture.service.transition(task.id, command(task, action, "cancel-wrong-scope", { authorizationId: mismatchedId }), { actor }),
    (error) => error?.status === 409 && error?.code === "HUMAN_AUTH_SCOPE_MISMATCH",
  );
  assert.deepEqual(workflowCounts(fixture.database), { events: 0, outbox: 0, requests: 0 });
});

test("a failed task-side projection write rolls back the request, task, event, and outbox together", async () => {
  const fixture = await createFixture();
  const task = createTask(fixture, "Atomic rollback");
  const action = nonTerminalAction(fixture.service, task.id);
  const before = fixture.database.getTask(task.id);
  fixture.database.database.exec(`
    CREATE TRIGGER fail_transition_activity
    BEFORE INSERT ON task_activities
    BEGIN SELECT RAISE(ABORT, 'TRANSITION_ACTIVITY_FAILURE'); END;
  `);
  try {
    assert.throws(
      () => fixture.service.transition(task.id, command(task, action, "rollback-transition-1"), { actor }),
      /TRANSITION_ACTIVITY_FAILURE/,
    );
  } finally {
    fixture.database.database.exec("DROP TRIGGER fail_transition_activity");
  }

  const after = fixture.database.getTask(task.id);
  assert.equal(after.status, before.status);
  assert.equal(after.stageId, before.stageId);
  assert.equal(after.version, before.version);
  assert.deepEqual(workflowCounts(fixture.database), { events: 0, outbox: 0, requests: 0 });
  const projection = fixture.database.database.prepare(`
    SELECT task_version, last_event_sequence, last_event_hash
    FROM workflow_work_item_projections WHERE work_item_id = ?
  `).get(task.id);
  assert.equal(projection.task_version, before.version);
  assert.equal(projection.last_event_sequence, null);
  assert.equal(projection.last_event_hash, null);
});

test("publication creates the next immutable revision while existing tasks stay pinned to revision one", async () => {
  const fixture = await createFixture();
  const existingTask = createTask(fixture, "Already pinned");
  const current = fixture.service.getTaskWorkflow(existingTask.id);
  const bindings = fixture.database.database.prepare(`
    SELECT contract_stage_id, task_stage_id, canonical_status, terminal_kind, stage_order
    FROM workflow_revision_stage_bindings WHERE revision_id = ? ORDER BY stage_order
  `).all(current.revisionId).map((row) => ({
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
  `).all(current.revisionId).map((row) => ({
    actionKey: row.action_key,
    transitionId: row.transition_id,
    fromTaskStageId: row.from_task_stage_id,
    toTaskStageId: row.to_task_stage_id,
    fromContractStageId: row.from_contract_stage_id,
    toContractStageId: row.to_contract_stage_id,
    toTerminalKind: row.to_terminal_kind,
    legacy: row.legacy === 1,
  }));
  const nextDefinition = structuredClone(current.definition);
  nextDefinition.revisionId = randomUUID();
  nextDefinition.revision = current.revision + 1;
  nextDefinition.createdAt = "2026-08-25T00:00:00.000Z";
  const published = fixture.service.publishRevision({
    projectId: "transition-project",
    definition: nextDefinition,
    bindings,
    rules,
  });

  assert.equal(published.revision, 2);
  assert.equal(fixture.service.getTaskWorkflow(existingTask.id).revisionId, current.revisionId);
  const freshTask = createTask(fixture, "Pinned after publication");
  assert.equal(fixture.service.getTaskWorkflow(freshTask.id).revisionId, published.revisionId);
  const physicalWorkflow = fixture.database.getStageWorkflow("transition-project");
  assert.throws(
    () => fixture.database.saveStageWorkflow(
      "transition-project",
      physicalWorkflow.version,
      physicalWorkflow.definition,
    ),
    (error) => error?.status === 409 && error?.code === "WORKFLOW_AUTHORING_UNAVAILABLE",
  );
  assert.throws(
    () => fixture.database.database.prepare(`
      UPDATE workflow_revisions SET definition_json = '{}' WHERE revision_id = ?
    `).run(current.revisionId),
    /WORKFLOW_REVISION_IMMUTABLE/,
  );
  assert.throws(
    () => fixture.database.database.prepare(`
      INSERT OR REPLACE INTO workflow_revisions
      SELECT * FROM workflow_revisions WHERE revision_id = ?
    `).run(current.revisionId),
    /WORKFLOW_REVISION_IMMUTABLE/,
  );
});

test("opening a legacy task database twice creates one revision-one snapshot and pins tasks without fictional events", async () => {
  const fixture = await createFixture();
  const legacyTask = createTask(fixture, "Legacy task");
  const before = fixture.database.getTask(legacyTask.id);
  fixture.database.close();
  const reopened = new TaskboardDatabase(fixture.filename);
  fixture.database = reopened;
  fixture.service = new TransitionService(reopened);

  const first = reopened.database.prepare(`
    SELECT definitions.workflow_id, definitions.current_revision_id, revisions.revision
    FROM workflow_definitions AS definitions
    JOIN workflow_revisions AS revisions ON revisions.revision_id = definitions.current_revision_id
    WHERE definitions.project_id = 'transition-project'
  `).get();
  const pin = reopened.database.prepare("SELECT * FROM workflow_task_pins WHERE task_id = ?").get(legacyTask.id);
  const projection = reopened.database.prepare(`
    SELECT projection_kind, last_event_sequence, last_event_hash
    FROM workflow_work_item_projections WHERE work_item_id = ?
  `).get(legacyTask.id);
  assert.equal(first.revision, 1);
  assert.equal(pin.revision_id, first.current_revision_id);
  assert.equal(reopened.database.prepare("SELECT COUNT(*) AS count FROM workflow_ledger_events").get().count, 0);
  assert.equal(projection.projection_kind, "work_item.imported");
  assert.equal(projection.last_event_sequence, null);
  assert.equal(projection.last_event_hash, null);
  const after = reopened.getTask(legacyTask.id);
  assert.equal(after.status, before.status);
  assert.equal(after.stageId, before.stageId);
  assert.equal(after.version, before.version);

  reopened.close();
  const second = new TaskboardDatabase(fixture.filename);
  fixture.database = second;
  fixture.service = new TransitionService(second);
  assert.equal(second.database.prepare(`
    SELECT COUNT(*) AS count FROM workflow_definitions WHERE project_id = 'transition-project'
  `).get().count, 1);
  assert.equal(second.database.prepare("SELECT COUNT(*) AS count FROM workflow_task_pins WHERE task_id = ?").get(legacyTask.id).count, 1);
});
