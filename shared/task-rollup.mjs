const TERMINAL_STATUSES = new Set(["done", "canceled"]);

function stableTaskOrder(left, right) {
  return String(left.id).localeCompare(String(right.id));
}

function stableRelationOrder(left, right) {
  return String(left.childId).localeCompare(String(right.childId));
}

function rollupEnabled(relation) {
  return relation.type === "parent" && relation.metadata?.rollup !== false;
}

function sourceRevision(tasks) {
  return tasks
    .map((task) => `${task.id}:${task.version ?? 0}:${task.updatedAt ?? ""}`)
    .join("|");
}

/**
 * Returns the structural ancestors whose rollup changes when a task changes.
 * Only parent edges with rollup enabled participate; lateral relationships are
 * deliberately ignored.
 */
export function rollupAffectedAncestorIds(taskId, relations) {
  const parentsByChild = new Map();
  for (const relation of relations) {
    if (!rollupEnabled(relation)) continue;
    const parents = parentsByChild.get(relation.childId) ?? [];
    parents.push(relation.parentId);
    parentsByChild.set(relation.childId, parents);
  }

  const ancestors = [];
  const seen = new Set([taskId]);
  let frontier = [taskId];
  while (frontier.length > 0) {
    const next = [];
    for (const childId of frontier) {
      for (const parentId of (parentsByChild.get(childId) ?? []).sort()) {
        if (seen.has(parentId)) continue;
        seen.add(parentId);
        ancestors.push(parentId);
        next.push(parentId);
      }
    }
    frontier = next;
  }
  return ancestors;
}

/**
 * Deterministically derives a read model for a composite work item. The
 * result never mutates or proposes changes to the root's manually controlled
 * stage, title, or description.
 */
export function calculateTaskRollup({ root, tasks, relations, maxNodes = 1_000 }) {
  if (!root?.id) throw new TypeError("'root.id' is required");
  if (!Array.isArray(tasks)) throw new TypeError("'tasks' must be an array");
  if (!Array.isArray(relations)) throw new TypeError("'relations' must be an array");
  if (!Number.isSafeInteger(maxNodes) || maxNodes < 1) {
    throw new TypeError("'maxNodes' must be a positive safe integer");
  }

  const tasksById = new Map(tasks.map((task) => [task.id, task]));
  tasksById.set(root.id, root);
  const childrenByParent = new Map();
  for (const relation of relations) {
    if (!rollupEnabled(relation)) continue;
    if (!tasksById.has(relation.parentId) || !tasksById.has(relation.childId)) continue;
    const children = childrenByParent.get(relation.parentId) ?? [];
    children.push(relation);
    childrenByParent.set(relation.parentId, children);
  }
  for (const children of childrenByParent.values()) children.sort(stableRelationOrder);

  const descendants = [];
  const seen = new Set([root.id]);
  let frontier = [root.id];
  while (frontier.length > 0) {
    const next = [];
    for (const parentId of frontier) {
      for (const relation of (childrenByParent.get(parentId) ?? [])) {
        if (seen.has(relation.childId)) continue;
        const child = tasksById.get(relation.childId);
        if (!child) continue;
        if (descendants.length + 1 >= maxNodes) {
          throw new RangeError(`Task tree cannot exceed ${maxNodes} nodes`);
        }
        seen.add(child.id);
        descendants.push(child);
        next.push(child.id);
      }
    }
    frontier = next;
  }

  const activeDescendants = descendants.filter((task) => task.archivedAt == null);
  const completed = activeDescendants.filter((task) => task.status === "done").length;
  const terminal = activeDescendants.filter((task) => TERMINAL_STATUSES.has(task.status)).length;
  const blockedTaskIds = activeDescendants
    .filter((task) => task.status === "blocked")
    .sort(stableTaskOrder)
    .map((task) => task.id);
  const criticalTaskIds = activeDescendants
    .filter((task) => !TERMINAL_STATUSES.has(task.status) && task.priority === "urgent")
    .sort(stableTaskOrder)
    .map((task) => task.id);
  const sources = [root, ...descendants].sort(stableTaskOrder);
  const sourceUpdatedAt = sources.reduce((latest, task) => (
    task.updatedAt && (!latest || task.updatedAt > latest) ? task.updatedAt : latest
  ), null);
  const visualState = blockedTaskIds.length > 0
    ? "blocked"
    : criticalTaskIds.length > 0
      ? "critical"
      : "normal";

  return {
    version: 1,
    rootId: root.id,
    // The manually chosen stage remains separate from derived visual state.
    stage: root.status,
    progress: {
      total: activeDescendants.length,
      completed,
      terminal,
    },
    visual: {
      state: visualState,
      sourceTaskIds: visualState === "blocked" ? blockedTaskIds : (
        visualState === "critical" ? criticalTaskIds : []
      ),
    },
    freshness: {
      stale: false,
      sourceUpdatedAt,
      sourceRevision: sourceRevision(sources),
    },
    provenance: {
      kind: "structural-parent",
      relationType: "parent",
      sourceTaskIds: descendants.map((task) => task.id),
    },
  };
}
