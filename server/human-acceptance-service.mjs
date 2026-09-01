import { createHash, randomUUID } from "node:crypto";

import { canonicalJson, normalizeWorkflowRevision } from "../shared/workflow-control.mjs";
import { ApiError } from "./database.mjs";
import { validHumanAcceptanceActor } from "./human-acceptance-provider.mjs";
import { WorkflowLedger } from "./workflow-ledger.mjs";

const now = () => new Date().toISOString();
const hash = (value) => createHash("sha256").update(value).digest("hex");
function evidenceFromRow(row) {
  return { evidenceId: row.evidence_id, gateId: row.gate_id, type: "human_acceptance", capturedAt: row.captured_at, actor: { actorId: row.actor_key, kind: "human" }, status: row.status, record: { evidenceEventId: row.evidence_event_id, eventHash: row.evidence_hash }, revocation: row.status === "revoked" ? { revokedAt: row.revoked_at } : null };
}

/** Public, provider-neutral boundary. The provider supplies only a human actor. */
export class HumanAcceptanceService {
  constructor(taskboardDatabase, { provider = null, clock = now } = {}) { this.taskboardDatabase = taskboardDatabase; this.database = taskboardDatabase.database; this.provider = provider; this.clock = clock; this.ledger = new WorkflowLedger(this.database, { now: clock }); }

  async register(taskId, command, request) {
    this.taskboardDatabase.assertTaskWritable(taskId);
    if (!this.provider || typeof this.provider.attest !== "function") throw new ApiError(503, "HUMAN_ACCEPTANCE_UNAVAILABLE", "Human acceptance is not configured for this server");
    const context = this.#context(taskId);
    if (context.task.version !== command.expectedStateVersion) throw new ApiError(409, "EXPECTED_STATE_CONFLICT", "Task changed since the requested acceptance state");
    if (context.task.archived_at !== null) throw new ApiError(409, "TASK_ARCHIVED", "Archived tasks cannot record acceptance evidence");
    const rule = this.database.prepare("SELECT * FROM workflow_transition_rules WHERE revision_id = ? AND action_key = ?").get(context.pin.revision_id, command.actionKey);
    if (!rule || rule.from_task_stage_id !== context.task.stage_id) throw new ApiError(400, "ACTION_NOT_FOUND", "actionKey is not available from the task's pinned workflow state");
    const transition = context.definition.transitions.find((item) => item.transitionId === rule.transition_id);
    const gates = (transition?.gateIds ?? []).map((id) => context.definition.gates.find((gate) => gate.gateId === id)).filter((gate) => gate?.kind === "acceptance");
    if (gates.length === 0) throw new ApiError(400, "ACTION_NOT_FOUND", "This transition does not accept human acceptance evidence");
    if (gates.length > 1 && command.gateId === null) throw new ApiError(400, "GATE_ID_REQUIRED", "gateId is required when a transition has multiple human acceptance gates");
    const gate = gates.find((item) => item.gateId === (command.gateId ?? gates[0].gateId));
    if (!gate) throw new ApiError(400, "ACTION_NOT_FOUND", "gateId is not an acceptance gate for this transition");
    const attested = await this.provider.attest({ request, taskId, expectedStateVersion: context.task.version, actionKey: rule.action_key, gateId: gate.gateId, workflowId: context.pin.workflow_id, revisionId: context.pin.revision_id, transitionId: rule.transition_id, idempotencyKey: command.idempotencyKey });
    const actor = attested?.actor ?? attested;
    if (!validHumanAcceptanceActor(actor)) throw new ApiError(403, "HUMAN_ACTOR_REQUIRED", "Acceptance provider did not attest a valid human actor");
    const fingerprint = canonicalJson({ taskId, expectedStateVersion: context.task.version, actionKey: rule.action_key, gateId: gate.gateId, actorKey: actor.actorId, type: "human_acceptance" });
    const existing = this.database.prepare("SELECT * FROM workflow_human_evidence WHERE idempotency_key = ?").get(command.idempotencyKey);
    if (existing) {
      if (existing.request_fingerprint !== fingerprint) throw new ApiError(409, "IDEMPOTENCY_CONFLICT", "Idempotency-Key was already used for a different acceptance evidence request");
      const event = this.database.prepare("SELECT envelope_json FROM workflow_ledger_events WHERE event_id = ?").get(existing.ledger_event_id);
      if (!event) throw new ApiError(409, "LEDGER_HASH_INVALID", "Acceptance evidence points to a missing ledger event");
      return { evidence: evidenceFromRow(existing), event: JSON.parse(event.envelope_json), idempotent: true };
    }
    if (this.database.prepare("SELECT event_id FROM workflow_ledger_events WHERE idempotency_key = ?").get(command.idempotencyKey)) throw new ApiError(409, "IDEMPOTENCY_CONFLICT", "Idempotency-Key was already used for a different workflow request");
    const timestamp = this.clock(); const evidenceId = randomUUID(); const evidenceEventId = randomUUID();
    const evidenceHash = hash(canonicalJson({ schemaVersion: 1, evidenceId, evidenceEventId, taskId, taskVersion: context.task.version, workflowId: context.pin.workflow_id, revisionId: context.pin.revision_id, transitionId: rule.transition_id, actionKey: rule.action_key, gateId: gate.gateId, type: "human_acceptance", actorKey: actor.actorId, capturedAt: timestamp }));
    const eventInput = { schemaVersion: 1, eventType: "gate.satisfied", occurredAt: timestamp, workflowId: context.pin.workflow_id, revisionId: context.pin.revision_id, aggregateType: "task", aggregateId: taskId, correlationId: randomUUID(), causationId: null, idempotencyKey: command.idempotencyKey, payload: { gateId: gate.gateId, evidence: { evidenceId, evidenceEventId, eventHash: evidenceHash } } };
    let inserted = null;
    try {
      const result = this.ledger.append(eventInput, {
        project: (previous, event) => ({ ...(previous ?? {}), lastEventType: event.eventType, payload: event.payload, task: previous?.task ?? { id: taskId, stageId: context.task.stage_id, status: context.task.status, version: context.task.version } }),
        afterAppend: (event) => {
          this.database.prepare("INSERT INTO workflow_human_evidence (evidence_id,idempotency_key,request_fingerprint,task_id,task_version,workflow_id,revision_id,transition_id,action_key,gate_id,evidence_type,actor_key,captured_at,evidence_event_id,evidence_hash,ledger_event_id,status,revoked_at,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(evidenceId, command.idempotencyKey, fingerprint, taskId, context.task.version, context.pin.workflow_id, context.pin.revision_id, rule.transition_id, rule.action_key, gate.gateId, "human_acceptance", actor.actorId, timestamp, evidenceEventId, evidenceHash, event.eventId, "valid", null, timestamp);
          this.database.prepare("INSERT INTO task_activities (id,task_id,actor_type,actor_id,actor_name,actor_avatar_url,changes,created_at) VALUES (?,?,?,?,?,?,?,?)").run(randomUUID(), taskId, "user", actor.actorId, "Trusted human acceptance operator", null, JSON.stringify([{ field: "acceptanceEvidence", before: null, after: evidenceId }]), timestamp);
          inserted = this.database.prepare("SELECT * FROM workflow_human_evidence WHERE evidence_id = ?").get(evidenceId);
        },
      });
      if (result.idempotent) { const row = this.database.prepare("SELECT * FROM workflow_human_evidence WHERE idempotency_key = ?").get(command.idempotencyKey); if (!row || row.request_fingerprint !== fingerprint) throw new ApiError(409, "IDEMPOTENCY_CONFLICT", "Idempotency-Key was already used for a different workflow request"); return { evidence: evidenceFromRow(row), event: result.event, idempotent: true }; }
      return { evidence: evidenceFromRow(inserted), event: result.event, idempotent: false };
    } catch (error) { if (String(error).includes("STALE_HUMAN_ACCEPTANCE_EVIDENCE")) throw new ApiError(409, "EXPECTED_STATE_CONFLICT", "Task changed while acceptance evidence was being recorded"); throw error; }
  }

  #context(taskId) {
    const task = this.database.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId); if (!task) throw new ApiError(404, "TASK_NOT_FOUND", `Task '${taskId}' does not exist`);
    const pin = this.database.prepare("SELECT * FROM workflow_task_pins WHERE task_id = ?").get(taskId); const revision = pin && this.database.prepare("SELECT * FROM workflow_revisions WHERE revision_id = ?").get(pin.revision_id);
    if (!pin || !revision) throw new ApiError(409, "WORKFLOW_PIN_MISSING", "Task has no pinned workflow revision");
    return { task, pin, definition: normalizeWorkflowRevision(JSON.parse(revision.definition_json)) };
  }
}
