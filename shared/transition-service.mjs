import {
  WORKFLOW_ERROR_CODES,
  WorkflowContractError,
  evaluateTransition,
} from "./workflow-control.mjs";

const ACTION_KEY = /^[a-z][a-z0-9_-]{0,63}$/;

export const TRANSITION_ERROR_CODES = Object.freeze({
  ACTION_NOT_FOUND: "ACTION_NOT_FOUND",
  EXPECTED_STATE_CONFLICT: "EXPECTED_STATE_CONFLICT",
  REQUIRED_DESCENDANT_INCOMPLETE: "REQUIRED_DESCENDANT_INCOMPLETE",
  TASK_ARCHIVED: "TASK_ARCHIVED",
  WORKFLOW_PIN_MISSING: "WORKFLOW_PIN_MISSING",
  IDEMPOTENCY_REQUEST_CONFLICT: "IDEMPOTENCY_REQUEST_CONFLICT",
});

export class TransitionServiceError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

export function normalizeTransitionCommand(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TransitionServiceError(TRANSITION_ERROR_CODES.ACTION_NOT_FOUND, "Transition command must be an object");
  }
  const unknown = Object.keys(value).filter((key) => ![
    "expectedStateVersion", "actionKey", "gateEvidence", "authorizationId", "idempotencyKey",
  ].includes(key));
  if (unknown.length > 0) {
    throw new TransitionServiceError(TRANSITION_ERROR_CODES.ACTION_NOT_FOUND, `Unknown transition field: ${unknown.join(", ")}`);
  }
  if (!Number.isSafeInteger(value.expectedStateVersion) || value.expectedStateVersion < 1) {
    throw new TransitionServiceError(TRANSITION_ERROR_CODES.EXPECTED_STATE_CONFLICT, "expectedStateVersion must be a positive integer");
  }
  if (typeof value.actionKey !== "string" || !ACTION_KEY.test(value.actionKey)) {
    throw new TransitionServiceError(TRANSITION_ERROR_CODES.ACTION_NOT_FOUND, "actionKey must be a stable identifier");
  }
  if (!Array.isArray(value.gateEvidence)) {
    throw new TransitionServiceError(TRANSITION_ERROR_CODES.ACTION_NOT_FOUND, "gateEvidence must be an array");
  }
  if (value.authorizationId !== null && value.authorizationId !== undefined && typeof value.authorizationId !== "string") {
    throw new TransitionServiceError(TRANSITION_ERROR_CODES.ACTION_NOT_FOUND, "authorizationId must be a string or null");
  }
  if (typeof value.idempotencyKey !== "string" || !ACTION_KEY.test(value.idempotencyKey)) {
    throw new TransitionServiceError(TRANSITION_ERROR_CODES.IDEMPOTENCY_REQUEST_CONFLICT, "idempotencyKey must be a stable identifier");
  }
  return {
    expectedStateVersion: value.expectedStateVersion,
    actionKey: value.actionKey,
    gateEvidence: structuredClone(value.gateEvidence),
    authorizationId: value.authorizationId ?? null,
    idempotencyKey: value.idempotencyKey,
  };
}

export function assertRequiredDescendantsCompleted(descendants) {
  const incomplete = descendants.filter((descendant) => (
    descendant.required === true && descendant.status !== "done"
  ));
  if (incomplete.length > 0) {
    throw new TransitionServiceError(
      TRANSITION_ERROR_CODES.REQUIRED_DESCENDANT_INCOMPLETE,
      "A completed task requires every required descendant to be done",
      { taskIds: incomplete.map((descendant) => descendant.taskId) },
    );
  }
}

/**
 * Pure policy evaluation. Storage resolves physical stage ids to contract stage
 * ids and supplies the pinned revision, rule, authorization, and descendants.
 */
export function evaluatePinnedTransition({
  revision,
  rule,
  task,
  command,
  authorization,
  descendants,
}) {
  if (task.version !== command.expectedStateVersion) {
    throw new TransitionServiceError(
      TRANSITION_ERROR_CODES.EXPECTED_STATE_CONFLICT,
      "Task changed since the requested transition state",
      { expectedStateVersion: command.expectedStateVersion, actualStateVersion: task.version },
    );
  }
  if (task.archivedAt !== null) {
    throw new TransitionServiceError(TRANSITION_ERROR_CODES.TASK_ARCHIVED, "Archived tasks cannot transition");
  }
  if (!rule || rule.actionKey !== command.actionKey || rule.fromTaskStageId !== task.stageId) {
    throw new TransitionServiceError(
      TRANSITION_ERROR_CODES.ACTION_NOT_FOUND,
      "actionKey is not available from the task's pinned workflow state",
      { actionKey: command.actionKey, stageId: task.stageId },
    );
  }
  const evaluated = evaluateTransition(revision, {
    transitionId: rule.transitionId,
    fromStageId: rule.fromContractStageId,
    toStageId: rule.toContractStageId,
    target: { type: "task", id: task.id },
    occurredAt: command.occurredAt,
    gateEvidence: command.gateEvidence,
    humanAuthorization: authorization,
  });
  if (!evaluated.ok) {
    throw new WorkflowContractError(
      evaluated.error.code,
      evaluated.error.message,
      evaluated.error.details,
    );
  }
  if (rule.toTerminalKind === "completed") {
    assertRequiredDescendantsCompleted(descendants);
  }
  return evaluated.data;
}

export function legacyActionKey(fromOrder, toOrder) {
  return `legacy_move_${fromOrder}_${toOrder}`;
}
