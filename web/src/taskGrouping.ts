import type { Task } from "./types";

export interface TaskGroupCard {
  kind: "group";
  /** The real ancestor task standing in for the group. */
  parent: Task;
  count: number;
  /** Union of labels present among the grouped (visible) descendants. */
  labels: string[];
}

export interface TaskSingleCard {
  kind: "single";
  task: Task;
}

export type TaskColumnCard = TaskSingleCard | TaskGroupCard;

/**
 * Once a column/section has more than `threshold` visible tasks, cards
 * with a parent are represented by their nearest ancestor that groups at
 * least two of the currently visible tasks (falling back to the direct
 * parent when no such ancestor exists in the chain). Tasks with no parent
 * at all (project roots) are never grouped.
 */
export function groupTasksByParent(
  visibleTasks: Task[],
  tasksById: Map<string, Task>,
  threshold: number,
): TaskColumnCard[] {
  if (visibleTasks.length <= threshold) {
    return visibleTasks.map((task) => ({ kind: "single", task }));
  }

  function ancestorChain(task: Task): string[] {
    const chain: string[] = [];
    const seen = new Set<string>();
    let current: Task | undefined = task;
    while (current?.relations.parent && !seen.has(current.relations.parent.id)) {
      const parentId = current.relations.parent.id;
      chain.push(parentId);
      seen.add(parentId);
      current = tasksById.get(parentId);
    }
    return chain;
  }

  const chainByTaskId = new Map<string, string[]>();
  for (const task of visibleTasks) {
    if (task.relations.parent) chainByTaskId.set(task.id, ancestorChain(task));
  }

  const visibleDescendantCount = new Map<string, number>();
  for (const chain of chainByTaskId.values()) {
    for (const ancestorId of chain) {
      visibleDescendantCount.set(ancestorId, (visibleDescendantCount.get(ancestorId) ?? 0) + 1);
    }
  }

  const groupKeyByTaskId = new Map<string, string>();
  for (const [taskId, chain] of chainByTaskId) {
    const nearestSharedAncestor = chain.find((ancestorId) => (visibleDescendantCount.get(ancestorId) ?? 0) >= 2);
    groupKeyByTaskId.set(taskId, nearestSharedAncestor ?? chain[0]);
  }

  const groups = new Map<string, { taskIds: string[]; labels: Set<string> }>();
  const cards: TaskColumnCard[] = [];

  for (const task of visibleTasks) {
    const groupKey = groupKeyByTaskId.get(task.id);
    if (!groupKey) {
      cards.push({ kind: "single", task });
      continue;
    }
    const group = groups.get(groupKey) ?? { taskIds: [], labels: new Set<string>() };
    group.taskIds.push(task.id);
    task.labels.forEach((label) => group.labels.add(label));
    groups.set(groupKey, group);
  }

  for (const [ancestorId, group] of groups) {
    const parent = tasksById.get(ancestorId);
    if (!parent) {
      // The ancestor task isn't loaded (shouldn't happen within one
      // project's task list) — fall back to showing the tasks ungrouped
      // rather than silently dropping them.
      for (const taskId of group.taskIds) {
        const task = visibleTasks.find((candidate) => candidate.id === taskId);
        if (task) cards.push({ kind: "single", task });
      }
      continue;
    }
    cards.push({ kind: "group", parent, count: group.taskIds.length, labels: [...group.labels] });
  }

  return cards;
}

export interface ColumnCardsAsTasks {
  tasks: Task[];
  groupBadges: Map<string, { count: number; labels: string[] }>;
}

/** Flattens grouped column cards back into a plain task list plus a lookup of which tasks stand in for a group. */
export function columnCardsToTasks(cards: TaskColumnCard[]): ColumnCardsAsTasks {
  const tasks: Task[] = [];
  const groupBadges = new Map<string, { count: number; labels: string[] }>();
  for (const card of cards) {
    if (card.kind === "single") {
      tasks.push(card.task);
    } else {
      tasks.push(card.parent);
      groupBadges.set(card.parent.id, { count: card.count, labels: card.labels });
    }
  }
  return { tasks, groupBadges };
}
