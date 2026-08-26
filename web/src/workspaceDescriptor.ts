import type {
  NestedWorkspace,
  NestedWorkspaceItem,
  NestedWorkspacePage,
  Project,
  Task,
  TaskStatus,
} from "./types";

type WorkspaceMacroBucket = NestedWorkspaceItem["macroBucket"];

export type WorkspaceNavigationTarget =
  | { kind: "project"; projectId: string }
  | { kind: "task"; identifier: string };

export interface WorkspaceRoot {
  id: string;
  identifier: string | null;
  projectId: string;
  title: string;
  description: string;
  /** A project root has no persisted task stage. */
  status: TaskStatus | null;
  macroBucket: WorkspaceMacroBucket | null;
  target: WorkspaceNavigationTarget | null;
}

export interface WorkspaceBreadcrumb {
  id: string;
  title: string;
  target: WorkspaceNavigationTarget;
}

/**
 * The UI's common read model for a project root and a task-owned workspace.
 * It intentionally only contains display facts; task workspaces remain backed
 * by the existing read-only API and project roots are adapted from the loaded
 * project task collection.
 */
export interface WorkspaceDescriptor {
  kind: "project" | "task";
  root: WorkspaceRoot;
  breadcrumb: WorkspaceBreadcrumb[];
  children: NestedWorkspacePage;
  descendants?: NestedWorkspacePage;
  /** Full hierarchy for a project root's Tree and Mind Map projections. */
  hierarchy?: NestedWorkspacePage;
}

function macroBucketForStatus(status: TaskStatus): WorkspaceMacroBucket {
  if (status === "done" || status === "canceled") return "closed";
  if (status === "blocked") return "blocked";
  if (status === "in_review") return "review";
  if (status === "in_progress") return "active";
  if (status === "todo") return "ready";
  return "planned";
}

function workspaceItemFromTask(
  task: Task,
  parentId: string | null,
  depth: number,
  path: string[],
): NestedWorkspaceItem {
  return {
    id: task.id,
    identifier: task.identifier,
    projectId: task.projectId,
    title: task.title,
    status: task.status,
    macroBucket: macroBucketForStatus(task.status),
    priority: task.priority,
    archivedAt: task.archivedAt,
    parentId,
    depth,
    path,
    startDate: task.startDate,
    dueDate: task.dueDate,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  };
}

function orderedTasks(tasks: Task[]) {
  return [...tasks].sort((left, right) => (
    left.sortOrder - right.sortOrder
    || left.createdAt.localeCompare(right.createdAt)
    || left.identifier.localeCompare(right.identifier)
  ));
}

export function descriptorFromNestedWorkspace(
  workspace: NestedWorkspace,
  project: Project | null,
): WorkspaceDescriptor {
  const root = workspace.overview;
  return {
    kind: "task",
    root: {
      id: root.id,
      identifier: root.identifier,
      projectId: root.projectId,
      title: root.title,
      description: root.description,
      status: root.status,
      macroBucket: root.macroBucket,
      target: { kind: "task", identifier: root.identifier },
    },
    breadcrumb: [
      ...(project ? [{
        id: `project:${project.id}`,
        title: project.name,
        target: { kind: "project" as const, projectId: project.id },
      }] : []),
      ...workspace.breadcrumb.map((item) => ({
        id: item.id,
        title: item.title,
        target: { kind: "task" as const, identifier: item.identifier },
      })),
    ],
    children: workspace.children,
    descendants: workspace.descendants,
  };
}

/**
 * Builds a root read model from the already loaded project collection. Board,
 * List and Timeline use `children` (only parent-less tasks); hierarchy views
 * use the complete, relation-preserving `hierarchy` page.
 */
export function descriptorFromProjectTasks(project: Project, allTasks: Task[]): WorkspaceDescriptor {
  const tasks = orderedTasks(allTasks.filter((task) => (
    task.projectId === project.id && task.archivedAt === null
  )));
  const taskById = new Map(tasks.map((task) => [task.id, task]));
  const childTasks = new Map<string, Task[]>();
  const parentIdForTask = new Map<string, string | null>();
  const rootId = `project:${project.id}`;

  for (const task of tasks) {
    const relationParentId = task.relations.parent?.id ?? null;
    const parentId = relationParentId && taskById.has(relationParentId)
      ? relationParentId
      : null;
    parentIdForTask.set(task.id, parentId);
    if (parentId) {
      const children = childTasks.get(parentId) ?? [];
      children.push(task);
      childTasks.set(parentId, children);
    }
  }
  for (const [parentId, children] of childTasks) childTasks.set(parentId, orderedTasks(children));

  const directRoots = tasks.filter((task) => parentIdForTask.get(task.id) === null);
  const descendants: NestedWorkspaceItem[] = [];
  const visited = new Set<string>();
  const append = (task: Task, parentId: string, depth: number, path: string[]) => {
    if (visited.has(task.id)) return;
    visited.add(task.id);
    const nextPath = [...path, task.id];
    descendants.push(workspaceItemFromTask(task, parentId, depth, nextPath));
    for (const child of childTasks.get(task.id) ?? []) append(child, task.id, depth + 1, nextPath);
  };
  for (const root of directRoots) append(root, rootId, 1, [rootId]);
  // Corrupt/cyclic parent links must remain visible instead of silently
  // disappearing from a root workspace.
  for (const task of tasks) {
    if (!visited.has(task.id)) append(task, rootId, 1, [rootId]);
  }

  const immediateChildren = descendants.filter((item) => item.parentId === rootId);
  return {
    kind: "project",
    root: {
      id: rootId,
      identifier: null,
      projectId: project.id,
      title: project.name,
      description: "",
      status: null,
      macroBucket: null,
      target: null,
    },
    breadcrumb: [],
    children: { items: immediateChildren, nextCursor: null },
    descendants: { items: descendants, nextCursor: null },
    hierarchy: { items: descendants, nextCursor: null },
  };
}
