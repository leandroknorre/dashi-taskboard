import { render, screen } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { ActorIdentity, DevelopmentScan, Task } from "../types";
import { TaskEditor } from "./TaskEditor";

// jsdom does not implement <dialog> modal behavior or ResizeObserver.
beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
    this.removeAttribute("open");
  };
  class StubResizeObserver {
    observe() {}
    disconnect() {}
  }
  vi.stubGlobal("ResizeObserver", StubResizeObserver);
});

const currentUser: ActorIdentity = { type: "user", id: "local-user", name: "Local user", avatarUrl: null };

const developmentScan: DevelopmentScan = { workspacePath: null, contexts: [] };

function task(id: string, title: string, parentId: string | null): Task {
  return {
    id,
    identifier: id.toUpperCase(),
    projectId: "alpha",
    title,
    description: "",
    status: "todo",
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
    assignee: currentUser,
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
        status: "todo",
        priority: "none",
        assignee: currentUser,
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

describe("TaskEditor new-task default parent", () => {
  it("pre-selects the workspace root as parent when creating from inside a task workspace", () => {
    const workspaceRoot = task("theme", "Trabalho", null);
    render(
      <TaskEditor
        projectId="alpha"
        task={null}
        tasks={[workspaceRoot]}
        referenceTasks={[]}
        initialStatus="todo"
        initialParentId="theme"
        initialDraft={null}
        labels={[]}
        currentUser={currentUser}
        developmentScan={developmentScan}
        developmentScanLoading={false}
        onCreateLabel={async () => {}}
        onCancel={() => {}}
        onSave={async () => {}}
      />,
    );

    expect(screen.getByText("Trabalho")).toBeTruthy();
  });

  it("creates a root-level task with no parent chip when there is no default parent", () => {
    const other = task("other", "Some other card", null);
    render(
      <TaskEditor
        projectId="alpha"
        task={null}
        tasks={[other]}
        referenceTasks={[]}
        initialStatus="todo"
        initialParentId={null}
        initialDraft={null}
        labels={[]}
        currentUser={currentUser}
        developmentScan={developmentScan}
        developmentScanLoading={false}
        onCreateLabel={async () => {}}
        onCancel={() => {}}
        onSave={async () => {}}
      />,
    );

    expect(screen.queryByText("Some other card")).toBeNull();
  });
});
