import assert from "node:assert/strict";
import test from "node:test";

import { createCloudWorkerHarness } from "./helpers/cloud-worker-harness.mjs";

async function setup(options = {}) {
  const cloud = await createCloudWorkerHarness(options);
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

function humanEvidenceHeaders(cloud, taskId, command, idempotencyKey, {
  subject = "trusted_human_test",
  assertion = {},
  ...headers
} = {}) {
  return {
    "idempotency-key": idempotencyKey,
    "x-taskboard-human-acceptance": cloud.createHumanAcceptanceAssertion({
      taskId,
      expectedStateVersion: command.expectedStateVersion,
      actionKey: command.actionKey,
      gateId: command.gateId ?? "human-acceptance",
      idempotencyKey,
      subject,
      ...assertion,
    }),
    ...headers,
  };
}

function humanEvidenceRevocationHeaders(cloud, taskId, evidence, command, idempotencyKey, {
  subject = "trusted_human_test",
  assertion = {},
  ...headers
} = {}) {
  return {
    "idempotency-key": idempotencyKey,
    "x-taskboard-human-acceptance": cloud.createHumanAcceptanceAssertion({
      purpose: "human_acceptance_revocation",
      taskId,
      evidenceId: evidence.evidenceId,
      taskVersion: evidence.scope.taskVersion,
      workflowId: evidence.scope.workflowId,
      revisionId: evidence.scope.revisionId,
      transitionId: evidence.scope.transitionId,
      actionKey: evidence.scope.actionKey,
      gateId: evidence.scope.gateId,
      reason: command.reason,
      idempotencyKey,
      subject,
      ...assertion,
    }),
    ...headers,
  };
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

test("a CAS race rolls back every transition artifact before reporting the stale version", async () => {
  const { cloud, actorName, task } = await setup();
  try {
    const command = { expectedStateVersion: task.version, actionKey: "legacy_move_5_2", gateEvidence: [] };
    const before = await cloud.db.prepare(`
      SELECT
        (SELECT count(*) FROM workflow_ledger_events WHERE aggregate_id = ?) AS events,
        (SELECT count(*) FROM workflow_transition_requests WHERE task_id = ?) AS requests,
        (SELECT count(*) FROM workflow_outbox AS outbox
         JOIN workflow_ledger_events AS events ON events.event_id = outbox.event_id
         WHERE events.aggregate_id = ?) AS outbox,
        (SELECT count(*) FROM workflow_aggregate_projections
         WHERE aggregate_type = 'task' AND aggregate_id = ?) AS aggregate_projections,
        (SELECT last_event_sequence FROM workflow_work_item_projections
         WHERE work_item_id = ?) AS work_item_sequence
    `).bind(task.id, task.id, task.id, task.id, task.id).first();
    await cloud.db.prepare(`
      CREATE TRIGGER force_transition_cas_race
      BEFORE INSERT ON workflow_ledger_events
      WHEN NEW.event_type = 'transition.requested'
      BEGIN UPDATE tasks SET version = version + 1 WHERE id = NEW.aggregate_id; END;
    `).run();
    const stale = await cloud.request(`/api/tasks/${task.id}/transitions`, {
      method: "POST", actorName, headers: { "idempotency-key": "transition_cas_race_1" }, json: command,
    });
    assert.equal(stale.response.status, 409, JSON.stringify(stale.body));
    assert.equal(stale.body.error.code, "EXPECTED_STATE_CONFLICT");
    const after = await cloud.db.prepare(`
      SELECT
        (SELECT count(*) FROM workflow_ledger_events WHERE aggregate_id = ?) AS events,
        (SELECT count(*) FROM workflow_transition_requests WHERE task_id = ?) AS requests,
        (SELECT count(*) FROM workflow_outbox AS outbox
         JOIN workflow_ledger_events AS events ON events.event_id = outbox.event_id
         WHERE events.aggregate_id = ?) AS outbox,
        (SELECT count(*) FROM workflow_aggregate_projections
         WHERE aggregate_type = 'task' AND aggregate_id = ?) AS aggregate_projections,
        (SELECT last_event_sequence FROM workflow_work_item_projections
         WHERE work_item_id = ?) AS work_item_sequence
    `).bind(task.id, task.id, task.id, task.id, task.id).first();
    assert.deepEqual(after, before);
    const unchanged = await cloud.request(`/api/tasks/${task.id}`, { actorName });
    assert.equal(unchanged.body.task.version, task.version);
    await cloud.db.exec("DROP TRIGGER force_transition_cas_race");
    const retried = await cloud.request(`/api/tasks/${task.id}/transitions`, {
      method: "POST", actorName, headers: { "idempotency-key": "transition_cas_race_1" }, json: command,
    });
    assert.equal(retried.response.status, 200, JSON.stringify(retried.body));
  } finally { await cloud.dispose(); }
});

test("completed transitions require structured human acceptance and leave no partial ledger", async () => {
  const { cloud, actorName, task } = await setup();
  try {
    const path = `/api/tasks/${task.id}/transitions`;
    const forgedEvidence = {
      evidenceId: "11111111-1111-4111-8111-111111111111",
      gateId: "human-acceptance",
      type: "human_acceptance",
      capturedAt: "2026-08-24T12:00:00.000Z",
      actor: { actorId: "human_forged", kind: "human" },
      status: "valid",
      record: { evidenceEventId: "22222222-2222-4222-8222-222222222222", eventHash: "a".repeat(64) },
      revocation: null,
    };
    const rejected = await cloud.request(path, { method: "POST", actorName, headers: { "idempotency-key": "transition_accept_1" }, json: { expectedStateVersion: task.version, actionKey: "legacy_move_5_6", gateEvidence: [forgedEvidence] } });
    assert.equal(rejected.response.status, 409);
    assert.equal(rejected.body.error.code, "ACCEPTANCE_EVIDENCE_REQUIRED");
    const counts = await cloud.db.prepare("SELECT (SELECT count(*) FROM workflow_ledger_events) AS events, (SELECT count(*) FROM workflow_transition_requests) AS requests").first();
    assert.deepEqual(counts, { events: 0, requests: 0 });
  } finally { await cloud.dispose(); }
});

test("human evidence minting fails closed when the separate signer is not configured", async () => {
  const { cloud, actorName, task } = await setup({ humanAcceptanceSecret: "" });
  try {
    const result = await cloud.request(`/api/tasks/${task.id}/evidence`, {
      method: "POST", actorName, headers: {
        "idempotency-key": "acceptance_missing_signer_config_1",
        "x-taskboard-human-acceptance": "untrusted-value",
      }, json: { expectedStateVersion: task.version, actionKey: "legacy_move_5_6" },
    });
    assert.equal(result.response.status, 500);
    assert.equal(result.body.error.code, "SERVER_MISCONFIGURED");
  } finally { await cloud.dispose(); }
});

test("human signer assertions bind the operator subject and every evidence-create scope", async () => {
  const { cloud, actorName, task } = await setup();
  try {
    const evidencePath = `/api/tasks/${task.id}/evidence`;
    const registration = { expectedStateVersion: task.version, actionKey: "legacy_move_5_6" };
    const other = await cloud.request("/api/tasks", {
      method: "POST", actorName, json: { projectId: "transitions", title: "Assertion scope target" },
    });
    assert.equal(other.response.status, 201, JSON.stringify(other.body));
    const signed = cloud.createHumanAcceptanceAssertion({
      taskId: task.id,
      ...registration,
      idempotencyKey: "assertion_signature_source_1",
    });
    const [version, encodedPayload, signature] = signed.split(".");
    const alteredPayload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8"));
    alteredPayload.subject = "forged_human_subject";
    const forgedSubject = `${version}.${Buffer.from(JSON.stringify(alteredPayload), "utf8").toString("base64url")}.${signature}`;
    const rawSharedSecret = await cloud.request(evidencePath, {
      method: "POST", actorName, headers: {
        "idempotency-key": "assertion_raw_shared_secret_1",
        "x-taskboard-human-acceptance": cloud.sharedSecret,
      }, json: registration,
    });
    assert.equal(rawSharedSecret.response.status, 403);
    assert.equal(rawSharedSecret.body.error.code, "HUMAN_ACCEPTANCE_SIGNER_REQUIRED");
    const invalidHeaders = [
      {
        label: "signature",
        headers: {
          "idempotency-key": "assertion_invalid_signature_1",
          "x-taskboard-human-acceptance": `${signed.slice(0, -1)}${signed.endsWith("a") ? "b" : "a"}`,
        },
      },
      {
        label: "subject",
        headers: { "idempotency-key": "assertion_forged_subject_1", "x-taskboard-human-acceptance": forgedSubject },
      },
      {
        label: "task",
        headers: humanEvidenceHeaders(cloud, task.id, registration, "assertion_task_scope_1", {
          assertion: { taskId: other.body.task.id },
        }),
      },
      {
        label: "version",
        headers: humanEvidenceHeaders(cloud, task.id, registration, "assertion_version_scope_1", {
          assertion: { expectedStateVersion: task.version + 1 },
        }),
      },
      {
        label: "action",
        headers: humanEvidenceHeaders(cloud, task.id, registration, "assertion_action_scope_1", {
          assertion: { actionKey: "legacy_move_5_7" },
        }),
      },
      {
        label: "gate",
        headers: humanEvidenceHeaders(cloud, task.id, registration, "assertion_gate_scope_1", {
          assertion: { gateId: "other_acceptance_gate" },
        }),
      },
      {
        label: "idempotency",
        headers: humanEvidenceHeaders(cloud, task.id, registration, "assertion_idempotency_scope_1", {
          assertion: { idempotencyKey: "different_idempotency_key" },
        }),
      },
      {
        label: "route",
        headers: humanEvidenceHeaders(cloud, task.id, registration, "assertion_route_scope_1", {
          assertion: { route: "/api/tasks/:id/evidence/:evidenceId/revoke" },
        }),
      },
      {
        label: "method",
        headers: humanEvidenceHeaders(cloud, task.id, registration, "assertion_method_scope_1", {
          assertion: { method: "PUT" },
        }),
      },
      {
        label: "ttl",
        headers: humanEvidenceHeaders(cloud, task.id, registration, "assertion_ttl_scope_1", {
          assertion: { issuedAt: Date.now() - 60_000, expiresAt: Date.now() - 1 },
        }),
      },
      {
        label: "nonce",
        headers: humanEvidenceHeaders(cloud, task.id, registration, "assertion_nonce_scope_1", {
          assertion: { nonce: "short" },
        }),
      },
      {
        label: "version-marker",
        headers: humanEvidenceHeaders(cloud, task.id, registration, "assertion_version_marker_scope_1", {
          assertion: { version: 2 },
        }),
      },
    ];
    for (const invalid of invalidHeaders) {
      const result = await cloud.request(evidencePath, {
        method: "POST", actorName, headers: invalid.headers, json: registration,
      });
      assert.equal(result.response.status, 403, `${invalid.label}: ${JSON.stringify(result.body)}`);
      assert.equal(result.body.error.code, "HUMAN_ACCEPTANCE_SIGNER_REQUIRED", invalid.label);
    }
    const nonePersisted = await cloud.db.prepare("SELECT count(*) AS count FROM workflow_human_evidence WHERE task_id = ?").bind(task.id).first();
    assert.equal(nonePersisted.count, 0);

    const accepted = await cloud.request(evidencePath, {
      method: "POST", actorName: "untrusted-basic-display-name",
      headers: humanEvidenceHeaders(cloud, task.id, registration, "assertion_valid_1"), json: registration,
    });
    assert.equal(accepted.response.status, 201, JSON.stringify(accepted.body));
    const audit = await cloud.db.prepare(`
      SELECT evidence.actor_key, ledger.envelope_json, activity.actor_id, activity.actor_name
      FROM workflow_human_evidence AS evidence
      JOIN workflow_ledger_events AS ledger ON ledger.event_id = evidence.ledger_event_id
      JOIN task_activities AS activity ON activity.task_id = evidence.task_id AND activity.actor_id = evidence.actor_key
      WHERE evidence.evidence_id = ?
    `).bind(accepted.body.evidence.evidenceId).first();
    assert.equal(audit.actor_key, accepted.body.evidence.actor.actorId);
    assert.equal(audit.actor_id, accepted.body.evidence.actor.actorId);
    assert.equal(audit.actor_name, "Trusted human acceptance operator");
    assert.equal(audit.envelope_json.includes("trusted_human_test"), false);
    assert.equal(audit.envelope_json.includes("untrusted-basic-display-name"), false);
  } finally { await cloud.dispose(); }
});

test("human evidence is server-attested, replayable only by its request, and consumed once", async () => {
  const { cloud, actorName, task } = await setup();
  try {
    const evidencePath = `/api/tasks/${task.id}/evidence`;
    const registration = { expectedStateVersion: task.version, actionKey: "legacy_move_5_6" };
    const agentAttempt = await cloud.request(evidencePath, {
      method: "POST", actorName,
      headers: humanEvidenceHeaders(cloud, task.id, registration, "acceptance_agent_1", { "x-taskboard-client": "taskctl" }),
      json: registration,
    });
    assert.equal(agentAttempt.response.status, 403);
    assert.equal(agentAttempt.body.error.code, "HUMAN_ACTOR_REQUIRED");
    const sharedSecretOnly = await cloud.request(evidencePath, {
      method: "POST", actorName: "agent-omits-client-header", headers: { "idempotency-key": "acceptance_shared_secret_only_1" }, json: registration,
    });
    assert.equal(sharedSecretOnly.response.status, 403);
    assert.equal(sharedSecretOnly.body.error.code, "HUMAN_ACCEPTANCE_SIGNER_REQUIRED");
    const wrongSigner = await cloud.request(evidencePath, {
      method: "POST", actorName, headers: {
        "idempotency-key": "acceptance_wrong_signer_1",
        "x-taskboard-human-acceptance": "not-the-trusted-signer",
      }, json: registration,
    });
    assert.equal(wrongSigner.response.status, 403);
    assert.equal(wrongSigner.body.error.code, "HUMAN_ACCEPTANCE_SIGNER_REQUIRED");
    const first = await cloud.request(evidencePath, {
      method: "POST", actorName,
      headers: humanEvidenceHeaders(cloud, task.id, registration, "acceptance_register_1"), json: registration,
    });
    assert.equal(first.response.status, 201, JSON.stringify(first.body));
    assert.equal(first.body.idempotent, false);
    assert.match(first.body.evidence.evidenceId, /^[0-9a-f-]{36}$/i);
    assert.notEqual(first.body.evidence.actor.actorId, "human_forged");
    const replay = await cloud.request(evidencePath, {
      method: "POST", actorName: "basic-name-does-not-control-human-identity",
      headers: humanEvidenceHeaders(cloud, task.id, registration, "acceptance_register_1"), json: registration,
    });
    assert.equal(replay.response.status, 201, JSON.stringify(replay.body));
    assert.equal(replay.body.idempotent, true);
    assert.deepEqual(replay.body.evidence, first.body.evidence);
    const crossEndpointCollision = await cloud.request(`/api/tasks/${task.id}/transitions`, {
      method: "POST", actorName, headers: { "idempotency-key": "acceptance_register_1" },
      json: { ...registration, gateEvidence: [] },
    });
    assert.equal(crossEndpointCollision.response.status, 409);
    assert.equal(crossEndpointCollision.body.error.code, "IDEMPOTENCY_CONFLICT");
    const conflictingRegistration = { ...registration, actionKey: "legacy_move_5_7" };
    const collision = await cloud.request(evidencePath, {
      method: "POST", actorName,
      headers: humanEvidenceHeaders(cloud, task.id, conflictingRegistration, "acceptance_register_1"), json: conflictingRegistration,
    });
    assert.equal(collision.response.status, 409);
    assert.equal(collision.body.error.code, "IDEMPOTENCY_CONFLICT");

    const wrongActor = await cloud.request(`/api/tasks/${task.id}/transitions`, {
      method: "POST", actorName, headers: { "idempotency-key": "acceptance_wrong_actor_1" },
      json: {
        ...registration,
        gateEvidence: [{ ...first.body.evidence, actor: { actorId: "human_someone_else", kind: "human" } }],
      },
    });
    assert.equal(wrongActor.response.status, 409);
    assert.equal(wrongActor.body.error.code, "ACCEPTANCE_EVIDENCE_REQUIRED");
    const wrongHash = await cloud.request(`/api/tasks/${task.id}/transitions`, {
      method: "POST", actorName, headers: { "idempotency-key": "acceptance_wrong_hash_1" },
      json: {
        ...registration,
        gateEvidence: [{
          ...first.body.evidence,
          record: { ...first.body.evidence.record, eventHash: "b".repeat(64) },
        }],
      },
    });
    assert.equal(wrongHash.response.status, 409);
    assert.equal(wrongHash.body.error.code, "ACCEPTANCE_EVIDENCE_REQUIRED");

    const transition = await cloud.request(`/api/tasks/${task.id}/transitions`, {
      method: "POST", actorName, headers: { "idempotency-key": "acceptance_consume_1" },
      json: { ...registration, gateEvidence: [first.body.evidence] },
    });
    assert.equal(transition.response.status, 200, JSON.stringify(transition.body));
    const consumed = await cloud.db.prepare("SELECT count(*) AS count FROM workflow_transition_evidence_consumptions WHERE evidence_id = ?").bind(first.body.evidence.evidenceId).first();
    assert.equal(consumed.count, 1);

    const other = await cloud.request("/api/tasks", {
      method: "POST", actorName, json: { projectId: "transitions", title: "Other target" },
    });
    const replayElsewhere = await cloud.request(`/api/tasks/${other.body.task.id}/transitions`, {
      method: "POST", actorName, headers: { "idempotency-key": "acceptance_reuse_1" },
      json: { expectedStateVersion: other.body.task.version, actionKey: "legacy_move_5_6", gateEvidence: [first.body.evidence] },
    });
    assert.equal(replayElsewhere.response.status, 409);
    assert.equal(replayElsewhere.body.error.code, "ACCEPTANCE_EVIDENCE_REQUIRED");
  } finally { await cloud.dispose(); }
});

test("concurrent evidence writes serialize the ledger and resolve idempotency collisions deterministically", async () => {
  const { cloud, actorName, task } = await setup();
  try {
    const other = await cloud.request("/api/tasks", {
      method: "POST", actorName, json: { projectId: "transitions", title: "Concurrent evidence target" },
    });
    assert.equal(other.response.status, 201, JSON.stringify(other.body));
    const [first, second] = await Promise.all([
      cloud.request(`/api/tasks/${task.id}/evidence`, {
        method: "POST", actorName,
        headers: humanEvidenceHeaders(cloud, task.id, { expectedStateVersion: task.version, actionKey: "legacy_move_5_6" }, "acceptance_concurrent_1"),
        json: { expectedStateVersion: task.version, actionKey: "legacy_move_5_6" },
      }),
      cloud.request(`/api/tasks/${other.body.task.id}/evidence`, {
        method: "POST", actorName,
        headers: humanEvidenceHeaders(cloud, other.body.task.id, { expectedStateVersion: other.body.task.version, actionKey: "legacy_move_5_6" }, "acceptance_concurrent_2"),
        json: { expectedStateVersion: other.body.task.version, actionKey: "legacy_move_5_6" },
      }),
    ]);
    assert.equal(first.response.status, 201, JSON.stringify(first.body));
    assert.equal(second.response.status, 201, JSON.stringify(second.body));
    const sequences = await cloud.db.prepare("SELECT sequence FROM workflow_ledger_events ORDER BY sequence").all();
    assert.deepEqual(sequences.results, [{ sequence: 1 }, { sequence: 2 }]);
    const [collisionA, collisionB] = await Promise.all([
      cloud.request(`/api/tasks/${task.id}/evidence`, {
        method: "POST", actorName,
        headers: humanEvidenceHeaders(cloud, task.id, { expectedStateVersion: task.version, actionKey: "legacy_move_5_6" }, "acceptance_global_collision_1"),
        json: { expectedStateVersion: task.version, actionKey: "legacy_move_5_6" },
      }),
      cloud.request(`/api/tasks/${other.body.task.id}/evidence`, {
        method: "POST", actorName,
        headers: humanEvidenceHeaders(cloud, other.body.task.id, { expectedStateVersion: other.body.task.version, actionKey: "legacy_move_5_6" }, "acceptance_global_collision_1"),
        json: { expectedStateVersion: other.body.task.version, actionKey: "legacy_move_5_6" },
      }),
    ]);
    const collisions = [collisionA, collisionB];
    assert.equal(collisions.filter((result) => result.response.status === 201).length, 1, JSON.stringify(collisions.map((result) => result.body)));
    assert.equal(collisions.filter((result) => result.response.status === 409 && result.body.error.code === "IDEMPOTENCY_CONFLICT").length, 1, JSON.stringify(collisions.map((result) => result.body)));
    assert.equal(collisions.some((result) => result.response.status >= 500), false);
  } finally { await cloud.dispose(); }
});

test("stale or server-revoked evidence cannot create a transition request or outbox entry", async () => {
  const { cloud, actorName, task } = await setup();
  try {
    const registration = { expectedStateVersion: task.version, actionKey: "legacy_move_5_6" };
    const registered = await cloud.request(`/api/tasks/${task.id}/evidence`, {
      method: "POST", actorName,
      headers: humanEvidenceHeaders(cloud, task.id, registration, "acceptance_revoke_1"), json: registration,
    });
    assert.equal(registered.response.status, 201, JSON.stringify(registered.body));
    const versionBump = await cloud.request(`/api/tasks/${task.id}`, {
      method: "PATCH", actorName, json: { version: task.version, title: "Changed after acceptance" },
    });
    assert.equal(versionBump.response.status, 200, JSON.stringify(versionBump.body));
    const stale = await cloud.request(`/api/tasks/${task.id}/transitions`, {
      method: "POST", actorName, headers: { "idempotency-key": "acceptance_stale_1" },
      json: { expectedStateVersion: versionBump.body.task.version, actionKey: "legacy_move_5_6", gateEvidence: [registered.body.evidence] },
    });
    assert.equal(stale.response.status, 409);
    assert.equal(stale.body.error.code, "ACCEPTANCE_EVIDENCE_REQUIRED");

    const freshCommand = { expectedStateVersion: versionBump.body.task.version, actionKey: "legacy_move_5_6" };
    const fresh = await cloud.request(`/api/tasks/${task.id}/evidence`, {
      method: "POST", actorName,
      headers: humanEvidenceHeaders(cloud, task.id, freshCommand, "acceptance_revoke_2"), json: freshCommand,
    });
    assert.equal(fresh.response.status, 201, JSON.stringify(fresh.body));
    const revokeCommand = { reason: "withdrawn" };
    const creationAssertionReusedForRevoke = await cloud.request(`/api/tasks/${task.id}/evidence/${fresh.body.evidence.evidenceId}/revoke`, {
      method: "POST", actorName,
      headers: humanEvidenceHeaders(cloud, task.id, freshCommand, "acceptance_revoke_cross_purpose_1"), json: revokeCommand,
    });
    assert.equal(creationAssertionReusedForRevoke.response.status, 403);
    assert.equal(creationAssertionReusedForRevoke.body.error.code, "HUMAN_ACCEPTANCE_SIGNER_REQUIRED");
    const wrongReasonAssertion = await cloud.request(`/api/tasks/${task.id}/evidence/${fresh.body.evidence.evidenceId}/revoke`, {
      method: "POST", actorName,
      headers: humanEvidenceRevocationHeaders(cloud, task.id, fresh.body.evidence, revokeCommand, "acceptance_revoke_reason_scope_1", { assertion: { reason: "other_reason" } }),
      json: revokeCommand,
    });
    assert.equal(wrongReasonAssertion.response.status, 403);
    assert.equal(wrongReasonAssertion.body.error.code, "HUMAN_ACCEPTANCE_SIGNER_REQUIRED");
    const wrongEvidenceAssertion = await cloud.request(`/api/tasks/${task.id}/evidence/${fresh.body.evidence.evidenceId}/revoke`, {
      method: "POST", actorName,
      headers: humanEvidenceRevocationHeaders(cloud, task.id, fresh.body.evidence, revokeCommand, "acceptance_revoke_evidence_scope_1", { assertion: { evidenceId: "11111111-1111-4111-8111-111111111111" } }),
      json: revokeCommand,
    });
    assert.equal(wrongEvidenceAssertion.response.status, 403);
    assert.equal(wrongEvidenceAssertion.body.error.code, "HUMAN_ACCEPTANCE_SIGNER_REQUIRED");
    const otherActor = await cloud.request(`/api/tasks/${task.id}/evidence/${fresh.body.evidence.evidenceId}/revoke`, {
      method: "POST", actorName: "different-basic-name",
      headers: humanEvidenceRevocationHeaders(cloud, task.id, fresh.body.evidence, revokeCommand, "acceptance_revoke_other_actor_1", { subject: "different_trusted_human" }),
      json: revokeCommand,
    });
    assert.equal(otherActor.response.status, 403);
    assert.equal(otherActor.body.error.code, "HUMAN_EVIDENCE_ACTOR_REQUIRED");
    const revoked = await cloud.request(`/api/tasks/${task.id}/evidence/${fresh.body.evidence.evidenceId}/revoke`, {
      method: "POST", actorName: "basic-name-does-not-control-human-identity",
      headers: humanEvidenceRevocationHeaders(cloud, task.id, fresh.body.evidence, revokeCommand, "acceptance_revoke_record_1"),
      json: revokeCommand,
    });
    assert.equal(revoked.response.status, 200, JSON.stringify(revoked.body));
    assert.equal(revoked.body.idempotent, false);
    assert.equal(revoked.body.event.eventType, "gate.revoked");
    assert.equal(revoked.body.evidence.status, "revoked");
    assert.deepEqual(revoked.body.evidence.revocation.reason, "withdrawn");
    assert.match(revoked.body.evidence.revocation.revokedEventId, /^[0-9a-f-]{36}$/i);
    assert.match(revoked.body.evidence.revocation.eventHash, /^[0-9a-f]{64}$/i);
    const revocationAudit = await cloud.db.prepare(`
      SELECT evidence.status, evidence.revocation_ledger_event_id, outbox.topic
      FROM workflow_human_evidence AS evidence
      JOIN workflow_outbox AS outbox ON outbox.event_id = evidence.revocation_ledger_event_id
      WHERE evidence.evidence_id = ?
    `).bind(fresh.body.evidence.evidenceId).first();
    assert.deepEqual(revocationAudit, {
      status: "revoked",
      revocation_ledger_event_id: revoked.body.event.eventId,
      topic: "workflow.gate.revoked",
    });
    const revokedReplay = await cloud.request(`/api/tasks/${task.id}/evidence/${fresh.body.evidence.evidenceId}/revoke`, {
      method: "POST", actorName,
      headers: humanEvidenceRevocationHeaders(cloud, task.id, fresh.body.evidence, revokeCommand, "acceptance_revoke_record_1"),
      json: revokeCommand,
    });
    assert.equal(revokedReplay.response.status, 200, JSON.stringify(revokedReplay.body));
    assert.equal(revokedReplay.body.idempotent, true);
    assert.deepEqual(revokedReplay.body.evidence, revoked.body.evidence);
    const rejected = await cloud.request(`/api/tasks/${task.id}/transitions`, {
      method: "POST", actorName, headers: { "idempotency-key": "acceptance_revoked_1" },
      json: { expectedStateVersion: versionBump.body.task.version, actionKey: "legacy_move_5_6", gateEvidence: [revoked.body.evidence] },
    });
    assert.equal(rejected.response.status, 409);
    assert.equal(rejected.body.error.code, "ACCEPTANCE_EVIDENCE_REQUIRED");
    const records = await cloud.db.prepare(`
      SELECT
        (SELECT count(*) FROM workflow_transition_requests WHERE task_id = ?) AS requests,
        (SELECT count(*) FROM workflow_outbox WHERE topic = 'workflow.transition.requested') AS outbox
    `).bind(task.id).first();
    assert.deepEqual(records, { requests: 0, outbox: 0 });
  } finally { await cloud.dispose(); }
});

test("evidence consumption failure rolls back the task, request, ledger, outbox, and projection", async () => {
  const { cloud, actorName, task } = await setup();
  try {
    const registration = { expectedStateVersion: task.version, actionKey: "legacy_move_5_6" };
    const evidence = await cloud.request(`/api/tasks/${task.id}/evidence`, {
      method: "POST", actorName,
      headers: humanEvidenceHeaders(cloud, task.id, registration, "acceptance_atomic_evidence_1"), json: registration,
    });
    assert.equal(evidence.response.status, 201, JSON.stringify(evidence.body));
    const before = await cloud.db.prepare(`
      SELECT
        (SELECT count(*) FROM workflow_ledger_events WHERE aggregate_id = ?) AS events,
        (SELECT count(*) FROM workflow_transition_requests WHERE task_id = ?) AS requests,
        (SELECT count(*) FROM workflow_outbox AS outbox
         JOIN workflow_ledger_events AS events ON events.event_id = outbox.event_id
         WHERE events.aggregate_id = ?) AS outbox,
        (SELECT last_sequence FROM workflow_aggregate_projections
         WHERE aggregate_type = 'task' AND aggregate_id = ?) AS aggregate_sequence,
        (SELECT count(*) FROM workflow_transition_evidence_consumptions
         WHERE evidence_id = ?) AS consumptions
    `).bind(task.id, task.id, task.id, task.id, evidence.body.evidence.evidenceId).first();
    await cloud.db.prepare(`
      CREATE TRIGGER reject_test_evidence_consumption
      BEFORE INSERT ON workflow_transition_evidence_consumptions
      BEGIN SELECT RAISE(ABORT, 'TEST_EVIDENCE_CONSUMPTION_ROLLBACK'); END;
    `).run();
    const rejected = await cloud.request(`/api/tasks/${task.id}/transitions`, {
      method: "POST", actorName, headers: { "idempotency-key": "acceptance_atomic_transition_1" },
      json: { ...registration, gateEvidence: [evidence.body.evidence] },
    });
    assert.equal(rejected.response.status, 500, JSON.stringify(rejected.body));
    const after = await cloud.db.prepare(`
      SELECT
        (SELECT count(*) FROM workflow_ledger_events WHERE aggregate_id = ?) AS events,
        (SELECT count(*) FROM workflow_transition_requests WHERE task_id = ?) AS requests,
        (SELECT count(*) FROM workflow_outbox AS outbox
         JOIN workflow_ledger_events AS events ON events.event_id = outbox.event_id
         WHERE events.aggregate_id = ?) AS outbox,
        (SELECT last_sequence FROM workflow_aggregate_projections
         WHERE aggregate_type = 'task' AND aggregate_id = ?) AS aggregate_sequence,
        (SELECT count(*) FROM workflow_transition_evidence_consumptions
         WHERE evidence_id = ?) AS consumptions
    `).bind(task.id, task.id, task.id, task.id, evidence.body.evidence.evidenceId).first();
    assert.deepEqual(after, before);
    const unchanged = await cloud.request(`/api/tasks/${task.id}`, { actorName });
    assert.equal(unchanged.body.task.status, task.status);
    assert.equal(unchanged.body.task.version, task.version);
    await cloud.db.exec("DROP TRIGGER reject_test_evidence_consumption");
    const retried = await cloud.request(`/api/tasks/${task.id}/transitions`, {
      method: "POST", actorName, headers: { "idempotency-key": "acceptance_atomic_transition_1" },
      json: { ...registration, gateEvidence: [evidence.body.evidence] },
    });
    assert.equal(retried.response.status, 200, JSON.stringify(retried.body));
  } finally { await cloud.dispose(); }
});
