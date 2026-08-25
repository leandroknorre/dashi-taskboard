import assert from "node:assert/strict";
import test from "node:test";

import { createCloudWorkerHarness } from "./helpers/cloud-worker-harness.mjs";

async function setup() {
  const cloud = await createCloudWorkerHarness();
  const actorName = "transition-tester";
  const project = await cloud.request("/api/projects", {
    method: "POST", actorName, json: { id: "transitions", name: "Transitions" },
  });
  assert.equal(project.response.status, 201);
  const task = await cloud.request("/api/tasks", {
    method: "POST", actorName, json: { projectId: "transitions", title: "Transition target" },
  });
  assert.equal(task.response.status, 201);
  return { cloud, actorName, task: task.body.task };
}

test("cloud transition endpoint is authenticated and atomically idempotent", async () => {
  const { cloud, actorName, task } = await setup();
  try {
    const path = `/api/tasks/${task.id}/transitions`;
    const body = { expectedStateVersion: task.version, actionKey: "legacy_move_5_2", gateEvidence: [] };
    const anonymous = await cloud.request(path, { method: "POST", headers: { "idempotency-key": "transition_auth_1" }, json: body });
    assert.equal(anonymous.response.status, 401);
    const first = await cloud.request(path, { method: "POST", actorName, headers: { "idempotency-key": "transition_retry_1" }, json: body });
    assert.equal(first.response.status, 200, JSON.stringify(first.body));
    assert.equal(first.body.idempotent, false);
    assert.equal(first.body.task.status, "in_progress");
    const retry = await cloud.request(path, { method: "POST", actorName, headers: { "idempotency-key": "transition_retry_1" }, json: body });
    assert.equal(retry.response.status, 200, JSON.stringify(retry.body));
    assert.equal(retry.body.idempotent, true);
    assert.equal(retry.body.event.eventId, first.body.event.eventId);
    const collision = await cloud.request(path, { method: "POST", actorName, headers: { "idempotency-key": "transition_retry_1" }, json: { ...body, actionKey: "legacy_move_5_3" } });
    assert.equal(collision.response.status, 409);
    assert.equal(collision.body.error.code, "IDEMPOTENCY_CONFLICT");
    const stale = await cloud.request(path, { method: "POST", actorName, headers: { "idempotency-key": "transition_stale_1" }, json: body });
    assert.equal(stale.response.status, 409);
    assert.equal(stale.body.error.code, "EXPECTED_STATE_CONFLICT");
    const counts = await cloud.db.prepare("SELECT (SELECT count(*) FROM workflow_ledger_events) AS events, (SELECT count(*) FROM workflow_outbox) AS outbox, (SELECT count(*) FROM workflow_transition_requests) AS requests").first();
    assert.deepEqual(counts, { events: 1, outbox: 1, requests: 1 });
  } finally { await cloud.dispose(); }
});

test("completed transitions require structured human acceptance and leave no partial ledger", async () => {
  const { cloud, actorName, task } = await setup();
  try {
    const path = `/api/tasks/${task.id}/transitions`;
    const rejected = await cloud.request(path, { method: "POST", actorName, headers: { "idempotency-key": "transition_accept_1" }, json: { expectedStateVersion: task.version, actionKey: "legacy_move_5_6", gateEvidence: [] } });
    assert.equal(rejected.response.status, 409);
    assert.equal(rejected.body.error.code, "ACCEPTANCE_EVIDENCE_REQUIRED");
    const counts = await cloud.db.prepare("SELECT (SELECT count(*) FROM workflow_ledger_events) AS events, (SELECT count(*) FROM workflow_transition_requests) AS requests").first();
    assert.deepEqual(counts, { events: 0, requests: 0 });
  } finally { await cloud.dispose(); }
});
