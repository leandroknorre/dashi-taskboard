import type { Task } from "./types";

/**
 * The Board's "Priorizar" toggle orders cards within a column by these
 * presence-only label flags, in this cascade — no numeric score, just
 * which tier a card's labels put it in first.
 */
export const PRIORITY_LABEL_TIERS = [
  "prioridade:impreterivel",
  "pareto:top20",
  "prioridade:rapido-facil",
] as const;

function priorityTier(task: Pick<Task, "labels">): number {
  const tier = PRIORITY_LABEL_TIERS.findIndex((label) => task.labels.includes(label));
  return tier === -1 ? PRIORITY_LABEL_TIERS.length : tier;
}

/** Stable sort by priority tier; ties keep their existing relative order. */
export function prioritizeTasks<T extends Pick<Task, "labels">>(tasks: T[]): T[] {
  return [...tasks].sort((left, right) => priorityTier(left) - priorityTier(right));
}
