import { describe, expect, it } from "vitest";
import type { Task } from "./types";
import { columnCardsToTasks, groupTasksByParent } from "./taskGrouping";

function task(id: string, title: string, parentId: string | null): Task {
  return {
    id,
    identifier: id.toUpperCase(),
    projectId: "alpha",
    title,
    description: "",
    status: "in_progress",
    stageId: null,
    priority: "none",
    labels: [],
    sortOrder: 0,
    threadId: null,
    threadBinding: null,
    legacyLocalThreadId: null,
    conversationRefs: [],
    participants: [],
    previewImage: null,
    activityKey: id,
    activityUpdatedAt: "2026-09-04T00:00:00.000Z",
    creatorType: "user",
    creatorId: "local-user",
    creatorName: "Local user",
    creatorAvatarUrl: null,
    assignee: { type: "user", id: "local-user", name: "Local user", avatarUrl: null },
    developmentContext: null,
    startDate: null,
    dueDate: null,
    recurrence: null,
    source: "local",
    externalUrl: null,
    archivedAt: null,
    relations: {
      parent: parentId ? {
        id: parentId,
        identifier: parentId.toUpperCase(),
        projectId: "alpha",
        title: parentId,
        status: "in_progress",
        priority: "none",
        assignee: { type: "user", id: "local-user", name: "Local user", avatarUrl: null },
        archivedAt: null,
      } : null,
      subIssues: [],
      blockedBy: [],
      blocks: [],
      related: [],
    },
    version: 1,
    createdAt: "2026-09-04T00:00:00.000Z",
    updatedAt: "2026-09-04T00:00:00.000Z",
  };
}

describe("groupTasksByParent", () => {
  it("never represents a theme card both as itself and as its own group stand-in", () => {
    // Reproduces the PIL-727 board bug: a parent card ("theme") and its only
    // child both land in the same status column while grouping is active.
    const theme = task("theme", "Calendário do contrato pago com Felipe", null);
    const child = task("child", "Sub-issue", "theme");
    const filler = [
      task("f1", "Filler 1", null),
      task("f2", "Filler 2", null),
      task("f3", "Filler 3", null),
      task("f4", "Filler 4", null),
    ];
    const visibleTasks = [theme, child, ...filler];
    const tasksById = new Map(visibleTasks.map((t) => [t.id, t]));

    const cards = groupTasksByParent(visibleTasks, tasksById, 5);
    const { tasks: renderedTasks } = columnCardsToTasks(cards);

    const themeOccurrences = renderedTasks.filter((t) => t.id === "theme");
    expect(themeOccurrences).toHaveLength(1);

    const renderedIds = renderedTasks.map((t) => t.id);
    expect(new Set(renderedIds).size).toBe(renderedIds.length);
  });

  it("still groups a parent's descendants under it when the parent itself is not directly visible", () => {
    const child1 = task("child1", "Child 1", "parent");
    const child2 = task("child2", "Child 2", "parent");
    const filler = [
      task("f1", "Filler 1", null),
      task("f2", "Filler 2", null),
      task("f3", "Filler 3", null),
      task("f4", "Filler 4", null),
    ];
    const visibleTasks = [child1, child2, ...filler];
    const parent = task("parent", "Parent", null);
    const tasksById = new Map([...visibleTasks, parent].map((t) => [t.id, t]));

    const cards = groupTasksByParent(visibleTasks, tasksById, 5);
    const { tasks: renderedTasks, groupBadges } = columnCardsToTasks(cards);

    expect(renderedTasks.some((t) => t.id === "parent")).toBe(true);
    expect(groupBadges.get("parent")?.count).toBe(2);
  });
});

describe("columnCardsToTasks", () => {
  it("dedupes cards that resolve to the same task id, as a defensive safety net", () => {
    const solo = task("solo", "Solo", null);
    const cards = [
      { kind: "single" as const, task: solo },
      { kind: "group" as const, parent: solo, count: 1, labels: [] },
    ];

    const { tasks: renderedTasks } = columnCardsToTasks(cards);

    expect(renderedTasks).toHaveLength(1);
  });
});
