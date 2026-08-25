import { randomUUID } from "node:crypto";

import {
  AUTOMATION_RUN_ERROR_CODES,
  AutomationRunError,
  automationRequestFingerprint,
  automationRunIdForTransitionEvent,
  normalizeAutomationMode,
  normalizeDispatchCommand,
  normalizeResultCommand,
  redactAndLimit,
} from "../shared/automation-runs.mjs";
import { canonicalJson } from "../shared/workflow-control.mjs";
import { ApiError } from "./database.mjs";

function now() {
  return new Date().toISOString();
}

function apiError(error) {
  if (error instanceof ApiError) return error;
  if (error instanceof AutomationRunError) {
    const status = error.code === AUTOMATION_RUN_ERROR_CODES.RUN_NOT_FOUND ? 404
      : error.code === AUTOMATION_RUN_ERROR_CODES.INVALID_COMMAND || error.code === AUTOMATION_RUN_ERROR_CODES.PAYLOAD_TOO_LARGE ? 400
        : error.code === AUTOMATION_RUN_ERROR_CODES.DISPATCH_FORBIDDEN ? 403
        : 409;
    return new ApiError(status, error.code, error.message, error.details);
  }
  return error;
}

function requestActor(actor) {
  return {
    type: actor?.type ?? null,
    id: actor?.id ?? null,
  };
}

export function automationRunFromRow(row, { includeLease = false } = {}) {
  return {
    runId: row.run_id,
    taskId: row.task_id,
    transitionEventId: row.transition_event_id,
    transitionEventHash: row.transition_event_hash,
    workflowId: row.workflow_id,
    revisionId: row.revision_id,
    taskStageId: row.task_stage_id,
    contractStageId: row.contract_stage_id,
    agentProfileRevisionId: row.agent_profile_revision_id,
    mode: row.mode,
    status: row.status,
    payload: redactAndLimit(JSON.parse(row.payload_json), { limit: Number.POSITIVE_INFINITY }),
    result: row.result_json === null ? null : redactAndLimit(JSON.parse(row.result_json), { limit: Number.POSITIVE_INFINITY }),
    version: row.version,
    dispatchAttempt: row.dispatch_attempt,
    leaseExpiresAt: row.lease_expires_at,
    dispatchedBy: row.dispatched_by_actor_id === null ? null : {
      type: row.dispatched_by_actor_type,
      id: row.dispatched_by_actor_id,
    },
    dispatchedAt: row.dispatched_at,
    completedAt: row.completed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(includeLease ? { leaseToken: row.lease_token } : {}),
  };
}

function runEventFromRow(row) {
  return {
    eventId: row.event_id,
    runId: row.run_id,
    version: row.version,
    type: row.event_type,
    status: row.status,
    payload: redactAndLimit(JSON.parse(row.payload_json), { limit: Number.POSITIVE_INFINITY }),
    actor: row.actor_id === null ? null : { type: row.actor_type, id: row.actor_id },
    createdAt: row.created_at,
  };
}

function stagePolicy(definition, contractStageId) {
  const stage = definition.stages.find((candidate) => candidate.stageId === contractStageId);
  if (!stage) throw new ApiError(409, "AUTOMATION_RUN_STAGE_POLICY_MISSING", "Pinned transition stage has no immutable automation policy");
  const profile = definition.agentProfileRevisions.find((candidate) => (
    candidate.agentProfileRevisionId === stage.agentProfileRevisionId
  ));
  if (!profile) throw new ApiError(409, "AUTOMATION_RUN_POLICY_MISSING", "Pinned transition stage references an unavailable agent policy");
  return { stage, profile, mode: normalizeAutomationMode(profile.mode) };
}

function initialState(mode) {
  if (mode === "disabled") return {
    status: "cancelled",
    eventType: "run.cancelled",
    result: { reason: "policy_disabled", effect: "none" },
  };
  if (mode === "shadow") return {
    status: "succeeded",
    eventType: "run.succeeded",
    result: { reason: "shadow_recorded", effect: "none" },
  };
  return { status: "pending", eventType: "run.created", result: null };
}

/**
 * Called only by TransitionService while WorkflowLedger.append owns the
 * SQLite transaction. It records intent, but never starts an executor.
 */
export function createAutomationRunForTransition(database, {
  taskId,
  workflowId,
  revisionId,
  taskStageId,
  contractStageId,
  definition,
  transitionEvent,
  timestamp = now(),
}) {
  const existing = database.prepare(`
    SELECT * FROM workflow_automation_runs WHERE transition_event_id = ?
  `).get(transitionEvent.eventId);
  if (existing) return automationRunFromRow(existing);

  const { stage, profile, mode } = stagePolicy(definition, contractStageId);
  const runId = automationRunIdForTransitionEvent(transitionEvent.eventId);
  const state = initialState(mode);
  const payload = redactAndLimit({
    taskId,
    workflowId,
    revisionId,
    stageId: taskStageId,
    contractStageId,
    agentProfileRevisionId: stage.agentProfileRevisionId,
    transitionEventId: transitionEvent.eventId,
    transitionEventHash: transitionEvent.eventHash,
  });
  database.prepare(`
    INSERT INTO workflow_automation_runs (
      run_id, task_id, transition_event_id, transition_event_hash,
      workflow_id, revision_id, task_stage_id, contract_stage_id, agent_profile_revision_id,
      mode, status, payload_json, result_json, version, completed_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
  `).run(
    runId, taskId, transitionEvent.eventId, transitionEvent.eventHash,
    workflowId, revisionId, taskStageId, contractStageId, profile.agentProfileRevisionId,
    mode, state.status, canonicalJson(payload), state.result === null ? null : canonicalJson(state.result),
    state.status === "pending" ? null : timestamp, timestamp, timestamp,
  );
  database.prepare(`
    INSERT INTO workflow_automation_run_events (
      event_id, run_id, version, event_type, status, payload_json, actor_type, actor_id, created_at
    ) VALUES (?, ?, 1, ?, ?, ?, NULL, NULL, ?)
  `).run(
    randomUUID(), runId, state.eventType, state.status,
    canonicalJson({ mode, transitionEventId: transitionEvent.eventId, ...(state.result ?? {}) }), timestamp,
  );
  return automationRunFromRow(database.prepare("SELECT * FROM workflow_automation_runs WHERE run_id = ?").get(runId));
}

/** Local run registry. Dispatch creates an outbox record; it never executes it. */
export class AutomationRunService {
  constructor(taskboardDatabase, { clock = now, leaseToken = randomUUID } = {}) {
    this.taskboardDatabase = taskboardDatabase;
    this.database = taskboardDatabase.database;
    this.clock = clock;
    this.leaseToken = leaseToken;
  }

  listForTask(taskId) {
    this.#assertTask(taskId);
    return this.database.prepare(`
      SELECT * FROM workflow_automation_runs WHERE task_id = ? ORDER BY created_at DESC, run_id DESC
    `).all(taskId).map(automationRunFromRow);
  }

  get(runId) {
    const run = this.#run(runId);
    return {
      ...automationRunFromRow(run),
      events: this.database.prepare(`
        SELECT * FROM workflow_automation_run_events WHERE run_id = ? ORDER BY version
      `).all(runId).map(runEventFromRow),
    };
  }

  dispatch(runId, input, { actor } = {}) {
    let command;
    try {
      command = normalizeDispatchCommand(input);
    } catch (error) {
      throw apiError(error);
    }
    if (!actor || actor.type !== "user") {
      throw apiError(new AutomationRunError(
        AUTOMATION_RUN_ERROR_CODES.DISPATCH_FORBIDDEN,
        "Manual runs require an explicit human dispatch",
      ));
    }
    const fingerprint = automationRequestFingerprint("dispatch", runId, command);
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const replay = this.#idempotentRequest(runId, "dispatch", command.idempotencyKey, fingerprint, actor);
      if (replay) {
        this.database.exec("COMMIT");
        return { idempotent: true, ...this.#idempotentResponse(replay, "dispatch") };
      }
      const current = this.#run(runId);
      const timestamp = this.clock();
      const reclaiming = current.status === "dispatched"
        && current.lease_expires_at !== null
        && Date.parse(timestamp) > Date.parse(current.lease_expires_at);
      if (current.mode !== "manual" || (current.status !== "pending" && !reclaiming)) {
        throw new AutomationRunError(
          AUTOMATION_RUN_ERROR_CODES.NOT_DISPATCHABLE,
          "Only a pending manual run or an explicitly reclaimed expired lease can be dispatched",
        );
      }
      if (current.version !== command.expectedVersion) {
        throw new AutomationRunError(AUTOMATION_RUN_ERROR_CODES.VERSION_CONFLICT, "Run changed since it was last read", {
          expectedVersion: command.expectedVersion,
          actualVersion: current.version,
        });
      }
      const leaseToken = this.leaseToken();
      const leaseExpiresAt = new Date(Date.parse(timestamp) + command.leaseSeconds * 1_000).toISOString();
      const nextVersion = current.version + 1;
      const nextAttempt = current.dispatch_attempt + 1;
      const update = this.database.prepare(`
        UPDATE workflow_automation_runs
        SET status = 'dispatched', version = ?, dispatch_attempt = ?, lease_token = ?, lease_expires_at = ?,
            dispatched_by_actor_type = ?, dispatched_by_actor_id = ?, dispatched_at = ?, updated_at = ?
        WHERE run_id = ? AND version = ? AND (
          status = 'pending'
          OR (status = 'dispatched' AND lease_expires_at IS NOT NULL AND lease_expires_at < ?)
        )
      `).run(
        nextVersion, nextAttempt, leaseToken, leaseExpiresAt,
        actor?.type ?? "user", actor?.id ?? "local-user", timestamp, timestamp,
        runId, current.version, timestamp,
      );
      if (update.changes !== 1) {
        throw new AutomationRunError(AUTOMATION_RUN_ERROR_CODES.VERSION_CONFLICT, "Run changed during dispatch");
      }
      this.database.prepare(`
        INSERT INTO workflow_automation_run_events (
          event_id, run_id, version, event_type, status, payload_json, actor_type, actor_id, created_at
        ) VALUES (?, ?, ?, ?, 'dispatched', ?, ?, ?, ?)
      `).run(
        randomUUID(), runId, nextVersion, "run.dispatched",
        canonicalJson({
          attempt: nextAttempt,
          leaseExpiresAt,
          effect: "adapter_outbox_only",
          ...(reclaiming ? { reclaimedExpiredLease: true } : {}),
        }),
        actor?.type ?? "user", actor?.id ?? "local-user", timestamp,
      );
      this.database.prepare(`
        INSERT INTO workflow_automation_run_outbox (run_id, attempt, topic, payload_json, created_at)
        VALUES (?, ?, 'automation.run.dispatch', ?, ?)
      `).run(
        runId, nextAttempt,
        canonicalJson({ runId, taskId: current.task_id, workflowId: current.workflow_id, revisionId: current.revision_id, stageId: current.task_stage_id, attempt: nextAttempt, leaseExpiresAt }),
        timestamp,
      );
      const run = this.#run(runId);
      const response = { run: automationRunFromRow(run), leaseToken: run.lease_token };
      this.#insertRequest(command.idempotencyKey, runId, "dispatch", fingerprint, timestamp, leaseToken, actor, response);
      this.database.exec("COMMIT");
      return { idempotent: false, ...response };
    } catch (error) {
      this.#rollback();
      throw apiError(error);
    }
  }

  recordResult(runId, input, { actor } = {}) {
    let command;
    try {
      command = normalizeResultCommand(input);
    } catch (error) {
      throw apiError(error);
    }
    const fingerprint = automationRequestFingerprint("result", runId, command);
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const priorRequest = this.database.prepare(`
        SELECT run_id, operation FROM workflow_automation_run_requests WHERE idempotency_key = ?
      `).get(command.idempotencyKey);
      if (priorRequest?.run_id === runId && priorRequest.operation === "result") {
        const priorRun = this.#run(runId);
        if (priorRun.lease_token !== command.leaseToken) {
          throw new AutomationRunError(AUTOMATION_RUN_ERROR_CODES.LEASE_INVALID, "Result does not hold the active dispatch lease");
        }
      }
      const replay = this.#idempotentRequest(runId, "result", command.idempotencyKey, fingerprint, actor);
      if (replay) {
        this.database.exec("COMMIT");
        return { idempotent: true, ...this.#idempotentResponse(replay, "result") };
      }
      const current = this.#run(runId);
      if (current.status !== "dispatched") {
        throw new AutomationRunError(AUTOMATION_RUN_ERROR_CODES.RESULT_NOT_ALLOWED, "Only a dispatched run can record a result");
      }
      if (current.version !== command.expectedVersion) {
        throw new AutomationRunError(AUTOMATION_RUN_ERROR_CODES.VERSION_CONFLICT, "Run changed since it was last read", {
          expectedVersion: command.expectedVersion,
          actualVersion: current.version,
        });
      }
      if (current.lease_token !== command.leaseToken) {
        throw new AutomationRunError(AUTOMATION_RUN_ERROR_CODES.LEASE_INVALID, "Result does not hold the active dispatch lease");
      }
      const timestamp = this.clock();
      if (current.lease_expires_at !== null && Date.parse(timestamp) > Date.parse(current.lease_expires_at)) {
        throw new AutomationRunError(AUTOMATION_RUN_ERROR_CODES.LEASE_EXPIRED, "Dispatch lease has expired");
      }
      const nextVersion = current.version + 1;
      const update = this.database.prepare(`
        UPDATE workflow_automation_runs
        SET status = ?, result_json = ?, version = ?, completed_at = ?, updated_at = ?
        WHERE run_id = ? AND version = ? AND status = 'dispatched' AND lease_token = ?
      `).run(
        command.status, canonicalJson(command.result), nextVersion, timestamp, timestamp,
        runId, current.version, command.leaseToken,
      );
      if (update.changes !== 1) {
        throw new AutomationRunError(AUTOMATION_RUN_ERROR_CODES.VERSION_CONFLICT, "Run changed during result recording");
      }
      this.database.prepare(`
        INSERT INTO workflow_automation_run_events (
          event_id, run_id, version, event_type, status, payload_json, actor_type, actor_id, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        randomUUID(), runId, nextVersion, `run.${command.status}`, command.status,
        canonicalJson(command.result), actor?.type ?? "user", actor?.id ?? "local-user", timestamp,
      );
      const run = this.#run(runId);
      const response = { run: automationRunFromRow(run) };
      this.#insertRequest(command.idempotencyKey, runId, "result", fingerprint, timestamp, null, actor, response);
      this.database.exec("COMMIT");
      return { idempotent: false, ...response };
    } catch (error) {
      this.#rollback();
      throw apiError(error);
    }
  }

  #assertTask(taskId) {
    if (!this.database.prepare("SELECT 1 FROM tasks WHERE id = ?").get(taskId)) {
      throw new ApiError(404, "TASK_NOT_FOUND", `Task '${taskId}' does not exist`);
    }
  }

  #run(runId) {
    const run = this.database.prepare("SELECT * FROM workflow_automation_runs WHERE run_id = ?").get(runId);
    if (!run) {
      throw new AutomationRunError(AUTOMATION_RUN_ERROR_CODES.RUN_NOT_FOUND, `Automation run '${runId}' does not exist`);
    }
    return run;
  }

  #idempotentRequest(runId, operation, idempotencyKey, fingerprint, actor) {
    const existing = this.database.prepare(`
      SELECT * FROM workflow_automation_run_requests WHERE idempotency_key = ?
    `).get(idempotencyKey);
    if (!existing) return null;
    if (existing.run_id !== runId || existing.operation !== operation || existing.request_fingerprint !== fingerprint) {
      throw new AutomationRunError(AUTOMATION_RUN_ERROR_CODES.IDEMPOTENCY_CONFLICT, "Idempotency-Key was already used for a different automation run request");
    }
    const requestedBy = requestActor(actor);
    if (existing.actor_type !== null || existing.actor_id !== null) {
      if (existing.actor_type !== requestedBy.type || existing.actor_id !== requestedBy.id) {
        throw new AutomationRunError(AUTOMATION_RUN_ERROR_CODES.IDEMPOTENCY_CONFLICT, "Idempotency-Key belongs to a different automation run actor");
      }
    }
    if (existing.replay_state !== "available") {
      throw new AutomationRunError(
        AUTOMATION_RUN_ERROR_CODES.REPLAY_UNAVAILABLE,
        "Historical automation run response is unavailable; use a new explicit dispatch when the run is eligible",
      );
    }
    return existing;
  }

  #idempotentResponse(request, operation) {
    let stored;
    try {
      stored = redactAndLimit(JSON.parse(request.response_json), { limit: Number.POSITIVE_INFINITY });
    } catch {
      throw new AutomationRunError(
        AUTOMATION_RUN_ERROR_CODES.REPLAY_UNAVAILABLE,
        "Historical automation run response is unavailable; use a new explicit dispatch when the run is eligible",
      );
    }
    if (stored === null || typeof stored !== "object" || Array.isArray(stored) || stored.run === undefined) {
      throw new AutomationRunError(
        AUTOMATION_RUN_ERROR_CODES.REPLAY_UNAVAILABLE,
        "Historical automation run response is unavailable; use a new explicit dispatch when the run is eligible",
      );
    }
    if (operation === "dispatch") {
      if (typeof request.lease_token !== "string") {
        throw new AutomationRunError(
          AUTOMATION_RUN_ERROR_CODES.REPLAY_UNAVAILABLE,
          "Historical automation run response is unavailable; use a new explicit dispatch when the run is eligible",
        );
      }
      return { run: stored.run, leaseToken: request.lease_token };
    }
    return { run: stored.run };
  }

  #insertRequest(idempotencyKey, runId, operation, fingerprint, timestamp, leaseToken = null, actor = undefined, response) {
    const requestedBy = requestActor(actor);
    const responseJson = canonicalJson(redactAndLimit({ run: response?.run }, { limit: Number.POSITIVE_INFINITY }));
    this.database.prepare(`
      INSERT INTO workflow_automation_run_requests (
        idempotency_key, run_id, operation, request_fingerprint, lease_token, actor_type, actor_id, response_json, replay_state, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'available', ?)
    `).run(idempotencyKey, runId, operation, fingerprint, leaseToken, requestedBy.type, requestedBy.id, responseJson, timestamp);
  }

  #rollback() {
    try {
      this.database.exec("ROLLBACK");
    } catch {
      // SQLite may have ended the transaction after an abort.
    }
  }
}
