import { describe, expect, it } from "vitest";
import type { Project, Task } from "./types";
import { descriptorFromProjectTasks } from "./workspaceDescriptor";

const project: Project = {
  id: "alpha",
  name: "Alpha",
  workspacePath: null,
  source: "local",
  labels: [],
  issueCount: 4,
  createdAt: "2026-08-25T00:00:00.000Z",
  updatedAt: "2026-08-25T00:00:00.000Z",
};

function task(id: string, title: string, sortOrder: number, parentId: string | null): Task {
  return {
    id,
    identifier: `ALPHA-${sortOrder + 1}`,
    projectId: project.id,
    title,
    description: "",
    status: "todo",
    stageId: null,
    priority: "none",
    labels: [],
    sortOrder,
    threadId: null,
    threadBinding: null,
    legacyLocalThreadId: null,
    conversationRefs: [],
    participants: [],
    previewImage: null,
    activityKey: id,
    activityUpdatedAt: "2026-08-25T00:00:00.000Z",
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
        projectId: project.id,
        title: parentId,
        status: "todo",
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
    createdAt: `2026-08-2${sortOrder + 1}T00:00:00.000Z`,
    updatedAt: `2026-08-2${sortOrder + 1}T00:00:00.000Z`,
  };
}

describe("descriptorFromProjectTasks", () => {
  it("keeps root Board/List children at one level while hierarchy views retain descendants", () => {
    const descriptor = descriptorFromProjectTasks(project, [
      task("vision", "Vision", 0, null),
      task("program", "Program", 1, "vision"),
      task("area", "Area", 2, "program"),
      task("standalone", "Standalone", 3, null),
    ]);

    expect(descriptor.children.items.map((item) => item.title)).toEqual(["Vision", "Standalone"]);
    expect(descriptor.children.items.every((item) => item.parentId === "project:alpha")).toBe(true);
    expect(descriptor.hierarchy?.items.map((item) => item.title)).toEqual([
      "Vision", "Program", "Area", "Standalone",
    ]);
    expect(descriptor.hierarchy?.items.find((item) => item.id === "program")).toMatchObject({
      parentId: "vision",
      depth: 2,
      path: ["project:alpha", "vision", "program"],
    });
  });
});
