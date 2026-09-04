import assert from "node:assert/strict";
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

function trustedBoundary(actorId = "api-transition-tester") {
  const authenticatedRequests = new WeakMap();
  return {
    preauthenticateHumanAcceptanceRequest: async (request) => {
      authenticatedRequests.set(request, { actorId, kind: "human" });
    },
    humanAcceptanceProvider: {
      attest: async ({ request }) => {
        const actor = authenticatedRequests.get(request);
        if (!actor) throw new Error("trusted request-bound actor is missing");
        return { actor };
      },
      authenticate: ({ request }) => {
        const actor = authenticatedRequests.get(request);
        if (!actor) throw new Error("trusted request-bound actor is missing");
        return { actor };
      },
    },
  };
}

async function start(options = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "taskboard-transition-api-"));
  const boundary = trustedBoundary();
  const {
    humanAcceptanceProvider = boundary.humanAcceptanceProvider,
    preauthenticateHumanAcceptanceRequest = boundary.preauthenticateHumanAcceptanceRequest,
    ...serverOptions
  } = options;
  const app = createTaskboardServer({
    dataDirectory: directory,
    ...serverOptions,
    humanAcceptanceProvider,
    preauthenticateHumanAcceptanceRequest,
  });
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

test("GET transition actions exposes destinations and POST preserves explicit sort order", async () => {
  const { app, baseUrl } = await start();
  const task = createTask(app, "Explicit transition metadata");
  const transitions = new TransitionService(app.database);
  const expectedAction = actionTo(transitions, task.id, "none");

  const listed = await request(baseUrl, `/api/tasks/${task.id}/transitions`);
  assert.equal(listed.response.status, 200);
  const action = listed.body.actions.find((candidate) => candidate.actionKey === expectedAction.actionKey);
  assert.deepEqual(Object.keys(action).sort(), [
    "actionKey", "requiresAcceptance", "toStageId", "toStatus", "toTerminalKind", "transitionId",
  ]);
  assert.equal(action.toStageId, expectedAction.toTaskStageId);
  assert.equal(action.toStatus, destinationStatus(app, transitions.getTaskWorkflow(task.id).revisionId, expectedAction));
  assert.equal(action.requiresAcceptance, false);

  const moved = await request(baseUrl, `/api/tasks/${task.id}/transitions`, {
    method: "POST",
    headers: { "idempotency-key": "api-transition-sort-order-1" },
    body: {
      expectedStateVersion: task.version,
      actionKey: action.actionKey,
      gateEvidence: [],
      sortOrder: 2500.5,
    },
  });
  assert.equal(moved.response.status, 200, JSON.stringify(moved.body));
  assert.equal(moved.body.task.sortOrder, 2500.5);
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
  const minted = await request(baseUrl, `/api/tasks/${parent.id}/evidence`, {
    method: "POST",
    headers: { "idempotency-key": "api-required-parent-evidence" },
    body: { expectedStateVersion: parent.version, actionKey: completion.actionKey },
  });
  assert.equal(minted.response.status, 201, JSON.stringify(minted.body));

  const blocked = await request(baseUrl, `/api/tasks/${parent.id}/transitions`, {
    method: "POST",
    headers: { "idempotency-key": "api-required-parent-completion" },
    body: {
      expectedStateVersion: parent.version,
      actionKey: completion.actionKey,
      gateEvidence: [minted.body.evidence],
    },
  });

  assert.equal(blocked.response.status, 409);
  assert.equal(blocked.body.error.code, "REQUIRED_DESCENDANT_INCOMPLETE");
  assert.equal(app.database.getTask(parent.id).status, parent.status);
  assert.equal(app.database.getTask(child.id).status, child.status);
  assert.equal(app.database.database.prepare("SELECT COUNT(*) AS count FROM workflow_transition_requests").get().count, 0);
});

test("a real API parent completion succeeds once its only required descendant is canceled", async () => {
  const { app, baseUrl } = await start();
  const parent = createTask(app, "Parent with a discarded child");
  const child = createTask(app, "Required child to be discarded");
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
  const refreshedChild = app.database.getTask(child.id);
  const cancellation = actionTo(transitions, refreshedChild.id, "canceled");
  const canceled = await request(baseUrl, `/api/tasks/${refreshedChild.id}/transitions`, {
    method: "POST",
    headers: { "idempotency-key": "api-required-child-cancel" },
    body: {
      expectedStateVersion: refreshedChild.version,
      actionKey: cancellation.actionKey,
      gateEvidence: [],
    },
  });
  assert.equal(canceled.response.status, 200, JSON.stringify(canceled.body));
  assert.equal(canceled.body.task.status, "canceled");

  const refreshedParent = app.database.getTask(parent.id);
  const completion = actionTo(transitions, refreshedParent.id, "completed");
  const minted = await request(baseUrl, `/api/tasks/${refreshedParent.id}/evidence`, {
    method: "POST",
    headers: { "idempotency-key": "api-required-parent-evidence-after-cancel" },
    body: { expectedStateVersion: refreshedParent.version, actionKey: completion.actionKey },
  });
  assert.equal(minted.response.status, 201, JSON.stringify(minted.body));

  const completed = await request(baseUrl, `/api/tasks/${refreshedParent.id}/transitions`, {
    method: "POST",
    headers: { "idempotency-key": "api-required-parent-completion-after-cancel" },
    body: {
      expectedStateVersion: refreshedParent.version,
      actionKey: completion.actionKey,
      gateEvidence: [minted.body.evidence],
    },
  });

  assert.equal(completed.response.status, 200, JSON.stringify(completed.body));
  assert.equal(completed.body.task.status, "done");
});

test("HTTP transition consumption binds provider-attested evidence to the same human actor", async () => {
  let authenticatedActor = "alpha";
  const authenticatedRequests = new WeakMap();
  const { app, baseUrl } = await start({
    humanAcceptanceProvider: {
      attest: async ({ request }) => {
        const actor = authenticatedRequests.get(request);
        if (!actor) throw new Error("trusted request-bound actor is missing");
        return { actor };
      },
      // Simulates an upstream-authenticated identity. It deliberately does
      // not trust Taskboard user headers supplied by the browser.
      authenticate: ({ request }) => {
        const actor = authenticatedRequests.get(request);
        if (!actor) throw new Error("trusted request-bound actor is missing");
        return { actor };
      },
    },
    preauthenticateHumanAcceptanceRequest: async (request) => {
      authenticatedRequests.set(request, { actorId: authenticatedActor, kind: "human" });
    },
  });
  const task = createTask(app, "HTTP actor binding");
  const transitions = new TransitionService(app.database);
  const completion = actionTo(transitions, task.id, "completed");

  const discovery = await request(baseUrl, `/api/tasks/${task.id}/transitions`);
  assert.equal(discovery.response.status, 200);
  assert.ok(discovery.body.actions.some((item) => item.actionKey === completion.actionKey));
  assert.equal(app.database.getTask(task.id).version, task.version);

  const minted = await request(baseUrl, `/api/tasks/${task.id}/evidence`, {
    method: "POST",
    headers: { "idempotency-key": "http-alpha-evidence", "x-taskboard-user-id": "alpha", "x-taskboard-user-name": "Alpha" },
    body: { expectedStateVersion: task.version, actionKey: completion.actionKey },
  });
  assert.equal(minted.response.status, 201, JSON.stringify(minted.body));

  // The current request is independently authenticated as beta. A forged
  // alpha header cannot select the identity used to consume evidence.
  authenticatedActor = "beta";
  const forgedHeader = await request(baseUrl, `/api/tasks/${task.id}/transitions`, {
    method: "POST",
    headers: { "idempotency-key": "http-forged-alpha-consume", "x-taskboard-user-id": "alpha", "x-taskboard-user-name": "Arbitrary%20Name" },
    body: { expectedStateVersion: task.version, actionKey: completion.actionKey, gateEvidence: [minted.body.evidence] },
  });
  assert.equal(forgedHeader.response.status, 409);
  assert.equal(forgedHeader.body.error.code, "ACCEPTANCE_EVIDENCE_REQUIRED");
  assert.equal(app.database.getTask(task.id).version, task.version);
  assert.equal(app.database.database.prepare("SELECT count(*) AS count FROM workflow_transition_requests WHERE task_id = ?").get(task.id).count, 0);
  assert.equal(app.database.database.prepare("SELECT count(*) AS count FROM workflow_transition_evidence_consumptions WHERE evidence_id = ?").get(minted.body.evidence.evidenceId).count, 0);

  // Once the provider independently authenticates alpha, a conflicting
  // browser header beta neither blocks nor becomes the recorded actor.
  authenticatedActor = "alpha";
  const trustedConsume = await request(baseUrl, `/api/tasks/${task.id}/transitions`, {
    method: "POST",
    headers: { "idempotency-key": "http-trusted-alpha-consume", "x-taskboard-user-id": "beta", "x-taskboard-user-name": "Another%20Arbitrary%20Name" },
    body: { expectedStateVersion: task.version, actionKey: completion.actionKey, gateEvidence: [minted.body.evidence] },
  });
  assert.equal(trustedConsume.response.status, 200, JSON.stringify(trustedConsume.body));
  assert.equal(trustedConsume.body.task.status, "done");
  assert.equal(app.database.database.prepare("SELECT actor_id FROM task_activities WHERE task_id = ? AND json_extract(changes, '$[0].field') = 'status' LIMIT 1").get(task.id).actor_id, "alpha");
});

test("HTTP human acceptance preauthentication receives an immutable route scope", async () => {
  const calls = [];
  const boundary = trustedBoundary("scoped-human");
  const { app, baseUrl } = await start({
    ...boundary,
    preauthenticateHumanAcceptanceRequest: async (request, scope) => {
      calls.push(scope);
      assert.equal(Object.isFrozen(scope), true);
      await boundary.preauthenticateHumanAcceptanceRequest(request, scope);
    },
  });
  const task = createTask(app, "Scoped preauthentication");
  const transitions = new TransitionService(app.database);
  const completion = actionTo(transitions, task.id, "completed");

  const discovery = await request(baseUrl, `/api/tasks/${task.id}/transitions`);
  assert.equal(discovery.response.status, 200);
  assert.equal(calls.length, 0);
  assert.equal(app.database.getTask(task.id).version, task.version);

  const minted = await request(baseUrl, `/api/tasks/${task.id}/evidence`, {
    method: "POST",
    headers: { "idempotency-key": "scoped-human-evidence" },
    body: { expectedStateVersion: task.version, actionKey: completion.actionKey },
  });
  assert.equal(minted.response.status, 201, JSON.stringify(minted.body));
  assert.deepEqual(calls[0], {
    pathname: `/api/tasks/${task.id}/evidence`,
    operation: "evidence",
    taskId: task.id,
    expectedStateVersion: task.version,
    actionKey: completion.actionKey,
  });

  const consumed = await request(baseUrl, `/api/tasks/${task.id}/transitions`, {
    method: "POST",
    headers: { "idempotency-key": "scoped-human-transition" },
    body: {
      expectedStateVersion: task.version,
      actionKey: completion.actionKey,
      gateEvidence: [minted.body.evidence],
    },
  });
  assert.equal(consumed.response.status, 200, JSON.stringify(consumed.body));
  assert.deepEqual(calls[1], {
    pathname: `/api/tasks/${task.id}/transitions`,
    operation: "transition",
    taskId: task.id,
    expectedStateVersion: task.version,
    actionKey: completion.actionKey,
  });
});

test("HTTP human acceptance preauthentication rejection leaves all workflow state untouched", async () => {
  const calls = [];
  const rejection = Object.assign(
    new Error("Independent human authentication was rejected"),
    { status: 403, code: "HUMAN_AUTH_REJECTED" },
  );
  const { app, baseUrl } = await start({
    preauthenticateHumanAcceptanceRequest: async (_request, scope) => {
      calls.push(scope);
      throw rejection;
    },
  });
  const task = createTask(app, "Rejected preauthentication");
  const transitions = new TransitionService(app.database);
  const completion = actionTo(transitions, task.id, "completed");
  const before = {
    task: app.database.getTask(task.id),
    evidence: app.database.database.prepare("SELECT count(*) AS count FROM workflow_human_evidence").get().count,
    consumptions: app.database.database.prepare("SELECT count(*) AS count FROM workflow_transition_evidence_consumptions").get().count,
    requests: app.database.database.prepare("SELECT count(*) AS count FROM workflow_transition_requests").get().count,
    ledger: app.database.database.prepare("SELECT count(*) AS count FROM workflow_ledger_events").get().count,
  };

  const evidence = await request(baseUrl, `/api/tasks/${task.id}/evidence`, {
    method: "POST",
    headers: { "idempotency-key": "rejected-preauthentication-evidence" },
    body: { expectedStateVersion: task.version, actionKey: completion.actionKey },
  });
  assert.equal(evidence.response.status, 403, JSON.stringify(evidence.body));
  assert.equal(evidence.body.error.code, "HUMAN_AUTH_REJECTED");

  const transition = await request(baseUrl, `/api/tasks/${task.id}/transitions`, {
    method: "POST",
    headers: { "idempotency-key": "rejected-preauthentication-transition" },
    body: {
      expectedStateVersion: task.version,
      actionKey: completion.actionKey,
      gateEvidence: [],
    },
  });
  assert.equal(transition.response.status, 403, JSON.stringify(transition.body));
  assert.equal(transition.body.error.code, "HUMAN_AUTH_REJECTED");
  assert.deepEqual(calls.map((scope) => scope.operation), ["evidence", "transition"]);
  assert.deepEqual(app.database.getTask(task.id), before.task);
  assert.equal(app.database.database.prepare("SELECT count(*) AS count FROM workflow_human_evidence").get().count, before.evidence);
  assert.equal(app.database.database.prepare("SELECT count(*) AS count FROM workflow_transition_evidence_consumptions").get().count, before.consumptions);
  assert.equal(app.database.database.prepare("SELECT count(*) AS count FROM workflow_transition_requests").get().count, before.requests);
  assert.equal(app.database.database.prepare("SELECT count(*) AS count FROM workflow_ledger_events").get().count, before.ledger);
});

test("HTTP human acceptance fails closed when its provider or preauthentication hook is absent", async () => {
  const { app, baseUrl } = await start({
    humanAcceptanceProvider: null,
    preauthenticateHumanAcceptanceRequest: null,
  });
  const task = createTask(app, "Missing human acceptance boundary");
  const transitions = new TransitionService(app.database);
  const completion = actionTo(transitions, task.id, "completed");

  const evidence = await request(baseUrl, `/api/tasks/${task.id}/evidence`, {
    method: "POST",
    headers: { "idempotency-key": "missing-boundary-evidence" },
    body: { expectedStateVersion: task.version, actionKey: completion.actionKey },
  });
  assert.equal(evidence.response.status, 503, JSON.stringify(evidence.body));
  assert.equal(evidence.body.error.code, "HUMAN_ACCEPTANCE_UNAVAILABLE");

  const transition = await request(baseUrl, `/api/tasks/${task.id}/transitions`, {
    method: "POST",
    headers: { "idempotency-key": "missing-boundary-transition" },
    body: {
      expectedStateVersion: task.version,
      actionKey: completion.actionKey,
      gateEvidence: [],
    },
  });
  assert.equal(transition.response.status, 503, JSON.stringify(transition.body));
  assert.equal(transition.body.error.code, "HUMAN_ACCEPTANCE_UNAVAILABLE");
  assert.equal(app.database.getTask(task.id).version, task.version);
  assert.equal(app.database.database.prepare("SELECT count(*) AS count FROM workflow_ledger_events").get().count, 0);
  assert.equal(app.database.database.prepare("SELECT count(*) AS count FROM workflow_transition_requests").get().count, 0);
});
