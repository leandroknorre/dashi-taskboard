import { TASK_STATUSES } from "./domain.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const BOARD_WORKFLOW_SCHEMA_VERSION = 1;
export const STAGE_WORKFLOW_SCHEMA_VERSION = 2;

const DEFAULT_STAGE_DETAILS = [
  ["todo", "To do", true],
  ["in_progress", "In progress", true],
  ["blocked", "Blocked", true],
  ["in_review", "In review", true],
  ["backlog", "Backlog", false],
  ["done", "Done", false],
  ["canceled", "Canceled", false],
];

export function defaultBoardWorkflowDefinition() {
  return { schemaVersion: BOARD_WORKFLOW_SCHEMA_VERSION, stages: DEFAULT_STAGE_DETAILS.map(([status, label, boardVisible], order) => ({ status, label, boardVisible, order })) };
}

export function defaultStageWorkflowDefinition() {
  return {
    schemaVersion: STAGE_WORKFLOW_SCHEMA_VERSION,
    stages: DEFAULT_STAGE_DETAILS.map(([status, label, boardVisible], order) => ({
      stageId: null,
      canonicalStatus: status,
      name: label,
      boardVisible,
      order,
      active: true,
      isDefaultForStatus: true,
      terminalKind: status === "done" ? "done" : status === "canceled" ? "canceled" : "none",
    })),
  };
}

/**
 * Validates the persisted, project-scoped board presentation. The supplied
 * error factory keeps transport-specific errors out of this shared contract.
 */
export function normalizeBoardWorkflowDefinition(value, invalid) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw invalid("'definition' must be a JSON object");
  if (value.schemaVersion !== BOARD_WORKFLOW_SCHEMA_VERSION || !Array.isArray(value.stages) || value.stages.length !== TASK_STATUSES.length) throw invalid("'definition' must be schema version 1 with seven stages");
  const stages = value.stages.map((stage, index) => {
    if (!stage || typeof stage !== "object" || Array.isArray(stage)) throw invalid(`'definition.stages[${index}]' must be an object`);
    if (Object.keys(stage).some((key) => !["status", "label", "boardVisible", "order"].includes(key))) throw invalid(`Unknown definition.stages[${index}] field`);
    if (!TASK_STATUSES.includes(stage.status) || typeof stage.label !== "string" || !stage.label.trim() || typeof stage.boardVisible !== "boolean" || !Number.isSafeInteger(stage.order) || stage.order < 0 || stage.order >= TASK_STATUSES.length) throw invalid(`Invalid definition.stages[${index}]`);
    return { status: stage.status, label: stage.label.trim(), boardVisible: stage.boardVisible, order: stage.order };
  });
  if (new Set(stages.map((stage) => stage.status)).size !== TASK_STATUSES.length || new Set(stages.map((stage) => stage.order)).size !== TASK_STATUSES.length) throw invalid("'definition.stages' must contain each canonical status once with unique orders");
  return { schemaVersion: BOARD_WORKFLOW_SCHEMA_VERSION, stages };
}

export function normalizeStageWorkflowDefinition(value, invalid) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw invalid("'definition' must be a JSON object");
  }
  const unknown = Object.keys(value).filter((key) => !["schemaVersion", "stages"].includes(key));
  if (unknown.length > 0) throw invalid(`Unknown definition field${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}`);
  if (value.schemaVersion !== STAGE_WORKFLOW_SCHEMA_VERSION) {
    throw invalid("'definition.schemaVersion' must be 2");
  }
  if (!Array.isArray(value.stages) || value.stages.length === 0) {
    throw invalid("'definition.stages' must contain at least one stage");
  }

  const stages = value.stages.map((stage, index) => {
    if (stage === null || typeof stage !== "object" || Array.isArray(stage)) {
      throw invalid(`'definition.stages[${index}]' must be an object`);
    }
    const unknownStage = Object.keys(stage).filter((key) => !["stageId", "canonicalStatus", "name", "boardVisible", "order", "active", "isDefaultForStatus", "terminalKind"].includes(key));
    if (unknownStage.length > 0) {
      throw invalid(`Unknown definition.stages[${index}] field${unknownStage.length === 1 ? "" : "s"}: ${unknownStage.join(", ")}`);
    }
    if (stage.stageId !== null && (typeof stage.stageId !== "string" || !UUID.test(stage.stageId))) {
      throw invalid(`'definition.stages[${index}].stageId' must be a UUID`);
    }
    if (!TASK_STATUSES.includes(stage.canonicalStatus)) {
      throw invalid(`'definition.stages[${index}].canonicalStatus' must be a canonical task status`);
    }
    if (typeof stage.name !== "string" || !stage.name.trim() || stage.name.trim().length > 120) {
      throw invalid(`'definition.stages[${index}].name' must be a non-empty string up to 120 characters`);
    }
    if (typeof stage.boardVisible !== "boolean") {
      throw invalid(`'definition.stages[${index}].boardVisible' must be boolean`);
    }
    if (!Number.isSafeInteger(stage.order) || stage.order < 0) {
      throw invalid(`'definition.stages[${index}].order' must be a non-negative integer`);
    }
    for (const field of ["boardVisible", "active", "isDefaultForStatus"]) if (typeof stage[field] !== "boolean") throw invalid(`'definition.stages[${index}].${field}' must be boolean`);
    const expectedTerminalKind = stage.canonicalStatus === "done"
      ? "done"
      : stage.canonicalStatus === "canceled"
        ? "canceled"
        : "none";
    if (stage.terminalKind !== expectedTerminalKind) throw invalid(`'definition.stages[${index}].terminalKind' must be ${expectedTerminalKind} for ${stage.canonicalStatus}`);
    return {
      stageId: stage.stageId?.trim() ?? null,
      canonicalStatus: stage.canonicalStatus,
      name: stage.name.trim(),
      boardVisible: stage.boardVisible,
      order: stage.order,
      active: stage.active,
      isDefaultForStatus: stage.isDefaultForStatus,
      terminalKind: stage.terminalKind,
    };
  });
  if (new Set(stages.map((stage) => stage.order)).size !== stages.length) {
    throw invalid("'definition.stages' orders must be unique");
  }
  if (new Set(stages.filter((stage) => stage.stageId).map((stage) => stage.stageId)).size !== stages.filter((stage) => stage.stageId).length) throw invalid("'definition.stages' stageIds must be unique");
  for (const status of TASK_STATUSES) {
    const defaults = stages.filter((stage) => stage.canonicalStatus === status && stage.active && stage.isDefaultForStatus);
    if (defaults.length !== 1) throw invalid(`Each canonical status needs exactly one active default stage (${status})`);
  }
  return { schemaVersion: STAGE_WORKFLOW_SCHEMA_VERSION, stages: stages.sort((left, right) => left.order - right.order) };
}
