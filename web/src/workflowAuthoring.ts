import type {
  LegacyOccupiedStage,
  WorkflowAuthoringRecord,
  WorkflowStage,
} from "./types";

export type WorkflowDisplayStage = WorkflowStage & {
  legacy: boolean;
  issueCount?: number;
};

export function workflowDisplayStages(
  workflow: WorkflowAuthoringRecord | null,
): WorkflowDisplayStage[] {
  if (!workflow) return [];
  const current = workflow.definition.stages.flatMap((stage) => (
    stage.stageId === null ? [] : [{ ...stage, stageId: stage.stageId, legacy: false }]
  ));
  const currentIds = new Set(current.map((stage) => stage.stageId));
  const legacy = workflow.legacyOccupiedStages
    .filter((stage) => !currentIds.has(stage.stageId))
    .map((stage: LegacyOccupiedStage, index) => ({
      ...stage,
      order: current.length + index,
      boardVisible: true,
      active: false,
      isDefaultForStatus: false,
      issueCount: stage.taskCount,
      legacy: true,
    }));
  return [...current, ...legacy].sort((left, right) => (
    left.order - right.order
    || Number(left.legacy) - Number(right.legacy)
    || left.stageId.localeCompare(right.stageId)
  ));
}
