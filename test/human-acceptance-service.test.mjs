import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";

import { TaskboardDatabase } from "../server/database.mjs";
import { HumanAcceptanceService } from "../server/human-acceptance-service.mjs";
import { TransitionService } from "../server/transition-service.mjs";

const opened = [];
const actor = { type: "user", id: "tester", name: "Tester", avatarUrl: null };
afterEach(async () => { while (opened.length) { const item = opened.pop(); item.database.close(); await rm(item.directory, { recursive: true, force: true }); } });

async function fixture(provider = {
  attest: async () => ({ actor: { actorId: "tester", kind: "human" } }),
  authenticate: () => ({ actor: { actorId: "tester", kind: "human" } }),
}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "taskboard-human-acceptance-"));
  const database = new TaskboardDatabase(path.join(directory, "taskboard.sqlite"));
  opened.push({ database, directory });
  database.createProject({ id: "acceptance", name: "Acceptance", workspacePath: "/tmp/acceptance" });
  const task = database.createTask({ projectId: "acceptance", title: "Review", description: "", status: "todo", priority: "none", labels: [], threadId: null, actor, assignee: actor, developmentContext: null, startDate: null, dueDate: null, recurrence: null });
  const transitions = new TransitionService(database, { humanAcceptanceProvider: provider });
  const action = transitions.listActions(task.id).find((item) => item.toTerminalKind === "completed");
  assert.ok(action);
  return { database, task, action, transitions, acceptance: new HumanAcceptanceService(database, { provider }) };
}

test("human acceptance is provider-attested, task-version scoped, and consumed exactly once", async () => {
  const { database, task, action, transitions, acceptance } = await fixture();
  const command = { expectedStateVersion: task.version, actionKey: action.actionKey, gateId: null, idempotencyKey: "evidence-1" };
  const minted = await acceptance.register(task.id, command, { headers: {} });
  assert.equal(minted.idempotent, false);
  assert.equal(minted.evidence.actor.actorId, "tester");
  const retry = await acceptance.register(task.id, command, { headers: {} });
  assert.equal(retry.idempotent, true);
  assert.deepEqual(retry.evidence, minted.evidence);
  assert.equal(database.getTask(task.id).version, task.version);
  assert.throws(() => transitions.transition(task.id, { expectedStateVersion: task.version, actionKey: action.actionKey, gateEvidence: [{ ...minted.evidence, actor: { actorId: "other-human", kind: "human" } }], authorizationId: null, idempotencyKey: "wrong-actor" }, { actor }), (error) => error.code === "ACCEPTANCE_EVIDENCE_REQUIRED");
  const moved = transitions.transition(task.id, { expectedStateVersion: task.version, actionKey: action.actionKey, gateEvidence: [minted.evidence], authorizationId: null, idempotencyKey: "transition-1" }, { actor });
  assert.equal(moved.task.status, "done");
  assert.equal(database.database.prepare("SELECT actor_id FROM task_activities WHERE task_id = ? AND json_extract(changes, '$[0].field') = 'status' LIMIT 1").get(task.id).actor_id, "tester");
  assert.equal(database.database.prepare("SELECT count(*) AS count FROM workflow_transition_evidence_consumptions WHERE evidence_id = ?").get(minted.evidence.evidenceId).count, 1);
  const other = database.createTask({ projectId: "acceptance", title: "Other review", description: "", status: "todo", priority: "none", labels: [], threadId: null, actor, assignee: actor, developmentContext: null, startDate: null, dueDate: null, recurrence: null });
  const otherAction = transitions.listActions(other.id).find((item) => item.toTerminalKind === "completed");
  assert.throws(() => transitions.transition(other.id, { expectedStateVersion: other.version, actionKey: otherAction.actionKey, gateEvidence: [minted.evidence], authorizationId: null, idempotencyKey: "transition-replay" }, { actor }), (error) => error.code === "ACCEPTANCE_EVIDENCE_REQUIRED");
});

test("forged evidence and an unavailable provider fail closed without task mutation", async () => {
  const missing = await fixture(null);
  await assert.rejects(() => missing.acceptance.register(missing.task.id, { expectedStateVersion: missing.task.version, actionKey: missing.action.actionKey, gateId: null, idempotencyKey: "missing-provider" }, {}), (error) => error.code === "HUMAN_ACCEPTANCE_UNAVAILABLE" && error.status === 503);
  const forged = await fixture();
  const fake = { evidenceId: "11111111-1111-4111-8111-111111111111", gateId: "human-acceptance", type: "human_acceptance", capturedAt: "2026-08-25T00:00:00.000Z", actor: { actorId: "forged", kind: "human" }, status: "valid", record: { evidenceEventId: "22222222-2222-4222-8222-222222222222", eventHash: "a".repeat(64) }, revocation: null };
  assert.throws(() => forged.transitions.transition(forged.task.id, { expectedStateVersion: forged.task.version, actionKey: forged.action.actionKey, gateEvidence: [fake], authorizationId: null, idempotencyKey: "forged-transition" }, { actor }), (error) => error.code === "ACCEPTANCE_EVIDENCE_REQUIRED");
  assert.equal(forged.database.getTask(forged.task.id).version, forged.task.version);
  assert.equal(forged.database.database.prepare("SELECT count(*) AS count FROM workflow_transition_requests WHERE task_id = ?").get(forged.task.id).count, 0);
  await assert.rejects(() => forged.acceptance.register(forged.task.id, { expectedStateVersion: forged.task.version + 1, actionKey: forged.action.actionKey, gateId: null, idempotencyKey: "wrong-version" }, {}), (error) => error.code === "EXPECTED_STATE_CONFLICT");
  forged.database.database.prepare("UPDATE workflow_human_evidence SET status = 'revoked', revoked_at = ? WHERE evidence_id = ?").run("2026-08-25T00:01:00.000Z", (await forged.acceptance.register(forged.task.id, { expectedStateVersion: forged.task.version, actionKey: forged.action.actionKey, gateId: null, idempotencyKey: "will-revoke" }, {})).evidence.evidenceId);
  const revoked = forged.database.database.prepare("SELECT * FROM workflow_human_evidence WHERE task_id = ?").get(forged.task.id);
  assert.throws(() => forged.transitions.transition(forged.task.id, { expectedStateVersion: forged.task.version, actionKey: forged.action.actionKey, gateEvidence: [{ evidenceId: revoked.evidence_id, gateId: revoked.gate_id, type: "human_acceptance", capturedAt: revoked.captured_at, actor: { actorId: revoked.actor_key, kind: "human" }, status: "revoked", record: { evidenceEventId: revoked.evidence_event_id, eventHash: revoked.evidence_hash }, revocation: { revokedAt: revoked.revoked_at } }], authorizationId: null, idempotencyKey: "revoked-transition" }, { actor }), (error) => error.code === "ACCEPTANCE_EVIDENCE_REQUIRED");
  const terminalWithoutProvider = await fixture({ attest: async () => ({ actor: { actorId: "tester", kind: "human" } }) });
  assert.throws(() => terminalWithoutProvider.transitions.transition(terminalWithoutProvider.task.id, { expectedStateVersion: terminalWithoutProvider.task.version, actionKey: terminalWithoutProvider.action.actionKey, gateEvidence: [], authorizationId: null, idempotencyKey: "no-auth-provider-terminal" }, { actor, request: {} }), (error) => error.code === "HUMAN_ACCEPTANCE_UNAVAILABLE" && error.status === 503);
});

test("an attested actor cannot be consumed by another HTTP actor", async () => {
  const provider = {
    attest: async () => ({ actor: { actorId: "alpha", kind: "human" } }),
    authenticate: () => ({ actor: { actorId: "beta", kind: "human" } }),
  };
  const { task, action, transitions, acceptance, database } = await fixture(provider);
  const evidence = (await acceptance.register(task.id, { expectedStateVersion: task.version, actionKey: action.actionKey, gateId: null, idempotencyKey: "alpha-evidence" }, {})).evidence;
  // The ordinary actor value lies about alpha; only the provider's beta is
  // authoritative and therefore consumption fails.
  assert.throws(() => transitions.transition(task.id, { expectedStateVersion: task.version, actionKey: action.actionKey, gateEvidence: [evidence], authorizationId: null, idempotencyKey: "beta-consume" }, { actor: { ...actor, id: "alpha" }, request: {} }), (error) => error.code === "ACCEPTANCE_EVIDENCE_REQUIRED");
  assert.equal(database.getTask(task.id).version, task.version);
  assert.equal(database.database.prepare("SELECT count(*) AS count FROM workflow_ledger_events WHERE aggregate_id = ? AND event_type = 'transition.requested'").get(task.id).count, 0);
  assert.equal(database.database.prepare("SELECT count(*) AS count FROM workflow_transition_evidence_consumptions WHERE evidence_id = ?").get(evidence.evidenceId).count, 0);
});

test("SQLite refuses action or gate tampering even if service checks regress", async () => {
  const { task, action, acceptance, database } = await fixture();
  const evidence = (await acceptance.register(task.id, { expectedStateVersion: task.version, actionKey: action.actionKey, gateId: null, idempotencyKey: "trigger-evidence" }, {})).evidence;
  const pin = database.database.prepare("SELECT * FROM workflow_task_pins WHERE task_id = ?").get(task.id);
  const rule = database.database.prepare("SELECT * FROM workflow_transition_rules WHERE revision_id = ? AND action_key = ?").get(pin.revision_id, action.actionKey);
  const insertRequest = database.database.prepare("INSERT INTO workflow_transition_requests (request_id,task_id,idempotency_key,request_fingerprint,expected_state_version,action_key,workflow_id,revision_id,transition_id,from_stage_id,to_stage_id,event_id,event_hash,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)");
  const assertRejected = (field, value) => {
    database.database.exec("BEGIN IMMEDIATE");
    try {
      database.database.prepare(`UPDATE workflow_human_evidence SET ${field} = ? WHERE evidence_id = ?`).run(value, evidence.evidenceId);
      insertRequest.run(`request-${field}`, task.id, `request-${field}`, "test", task.version, action.actionKey, pin.workflow_id, pin.revision_id, rule.transition_id, rule.from_task_stage_id, rule.to_task_stage_id, `event-${field}`, "hash", "2026-08-25T00:00:00.000Z");
      assert.throws(() => database.database.prepare("INSERT INTO workflow_transition_evidence_consumptions (request_id,evidence_id,consumed_at) VALUES (?,?,?)").run(`request-${field}`, evidence.evidenceId, "2026-08-25T00:00:00.000Z"), /INVALID_HUMAN_ACCEPTANCE_EVIDENCE/);
    } finally {
      database.database.exec("ROLLBACK");
    }
  };
  assertRejected("action_key", "tampered-action");
  assertRejected("gate_id", "tampered-gate");
  assert.equal(database.getTask(task.id).version, task.version);
  assert.equal(database.database.prepare("SELECT count(*) AS count FROM workflow_transition_evidence_consumptions WHERE evidence_id = ?").get(evidence.evidenceId).count, 0);
});

test("action discovery is observational and does not create a missing pin", async () => {
  const { database, task, transitions } = await fixture();
  database.database.prepare("DROP TRIGGER workflow_task_pins_on_task_insert").run();
  const orphan = database.createTask({ projectId: "acceptance", title: "Unpinned", description: "", status: "todo", priority: "none", labels: [], threadId: null, actor, assignee: actor, developmentContext: null, startDate: null, dueDate: null, recurrence: null });
  assert.equal(database.database.prepare("SELECT count(*) AS count FROM workflow_task_pins WHERE task_id = ?").get(orphan.id).count, 0);
  assert.throws(() => transitions.listActions(orphan.id), /pinned workflow revision/);
  assert.equal(database.database.prepare("SELECT count(*) AS count FROM workflow_task_pins WHERE task_id = ?").get(orphan.id).count, 0);
  assert.ok(task.id);
});
