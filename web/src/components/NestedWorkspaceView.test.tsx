import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TaskboardLanguageProvider } from "../i18n";
import type { TaskRollup } from "../types";
import type { WorkspaceDescriptor } from "../workspaceDescriptor";
import { NestedWorkspaceView } from "./NestedWorkspaceView";

afterEach(cleanup);

const workspace: WorkspaceDescriptor = {
  kind: "task",
  root: {
    id: "root",
    identifier: "TASK-1",
    projectId: "project-1",
    title: "Release workspace",
    description: "Ship the public workspace.",
    status: "todo",
    macroBucket: "ready",
    target: { kind: "task", identifier: "TASK-1" },
  },
  breadcrumb: [
    { id: "program", title: "Program", target: { kind: "task", identifier: "TASK-0" } },
    { id: "root", title: "Release workspace", target: { kind: "task", identifier: "TASK-1" } },
  ],
  children: {
    items: [
      { id: "child", identifier: "TASK-2", projectId: "project-1", title: "Build board", status: "in_progress", macroBucket: "active", priority: "high", labels: [], archivedAt: null, parentId: "root", depth: 1, path: ["root", "child"], startDate: null, dueDate: null, createdAt: "2026-08-25T00:00:00.000Z", updatedAt: "2026-08-25T00:00:00.000Z" },
    ],
    nextCursor: "workspace:child",
  },
  descendants: {
    items: [
      { id: "child", identifier: "TASK-2", projectId: "project-1", title: "Build board", status: "in_progress", macroBucket: "active", priority: "high", labels: [], archivedAt: null, parentId: "root", depth: 1, path: ["root", "child"], startDate: null, dueDate: null, createdAt: "2026-08-25T00:00:00.000Z", updatedAt: "2026-08-25T00:00:00.000Z" },
      { id: "grandchild", identifier: "TASK-3", projectId: "project-1", title: "Verify list", status: "in_review", macroBucket: "review", priority: "none", labels: [], archivedAt: null, parentId: "child", depth: 2, path: ["root", "child", "grandchild"], startDate: null, dueDate: null, createdAt: "2026-08-25T00:00:00.000Z", updatedAt: "2026-08-25T00:00:00.000Z" },
    ],
    nextCursor: null,
  },
};

const rollup: TaskRollup = {
  version: 1,
  rootId: "root",
  stage: "todo",
  progress: { total: 2, completed: 0, terminal: 0 },
  visual: { state: "normal", sourceTaskIds: [] },
  freshness: { stale: false, sourceUpdatedAt: null, sourceRevision: "root:1" },
  provenance: { kind: "structural-parent", relationType: "parent", sourceTaskIds: ["child", "grandchild"] },
};

function renderWorkspace(view: "overview" | "board" | "list" | "tree" | "mindmap" | "timeline" = "overview", descendants = false) {
  const onViewChange = vi.fn();
  const onDescendantsChange = vi.fn();
  const onLoadMore = vi.fn();
  const onOpenTask = vi.fn();
  const onOpenTaskDetail = vi.fn();
  const onOpenWorkspace = vi.fn();
  render(
    <TaskboardLanguageProvider language="en">
      <NestedWorkspaceView
        workspace={workspace}
        rollup={rollup}
        view={view}
        descendants={descendants}
        loadingMore={false}
        onViewChange={onViewChange}
        onDescendantsChange={onDescendantsChange}
        onLoadMore={onLoadMore}
        onOpenTask={onOpenTask}
        onOpenTaskDetail={onOpenTaskDetail}
        onOpenWorkspace={onOpenWorkspace}
      />
    </TaskboardLanguageProvider>,
  );
  return { onViewChange, onDescendantsChange, onLoadMore, onOpenTask, onOpenTaskDetail, onOpenWorkspace };
}

describe("NestedWorkspaceView", () => {
  it.each(["board", "list", "tree", "mindmap", "timeline"] as const)(
    "marks source records as read-only in the %s projection",
    (view) => {
      const reference = {
        ...workspace.children.items[0],
        id: "source-record",
        identifier: "SRC-1",
        title: "Paperclip reference",
        kind: "source_record" as const,
        readOnly: true,
        sourceSystem: "paperclip",
        externalVersion: "17",
      };
      const sourceWorkspace: WorkspaceDescriptor = {
        ...workspace,
        children: { items: [reference], nextCursor: null },
        descendants: { items: [reference], nextCursor: null },
        hierarchy: { items: [reference], nextCursor: null },
      };
      render(
        <TaskboardLanguageProvider language="en">
          <NestedWorkspaceView
            workspace={sourceWorkspace}
            rollup={rollup}
            view={view}
            descendants={false}
            loadingMore={false}
            onViewChange={vi.fn()}
            onDescendantsChange={vi.fn()}
            onLoadMore={vi.fn()}
            onOpenTask={vi.fn()}
            onOpenTaskDetail={vi.fn()}
            onOpenWorkspace={vi.fn()}
          />
        </TaskboardLanguageProvider>,
      );

      expect(screen.getByText("Referência somente leitura")).toBeTruthy();
      expect(screen.getByText("paperclip · v17")).toBeTruthy();
    },
  );

  it("shows the manual purpose, rollup provenance and freshness in overview", () => {
    const { onOpenTask, onOpenWorkspace } = renderWorkspace();
    expect(screen.getByText("Ship the public workspace.")).toBeTruthy();
    expect(screen.getByText("0/2")).toBeTruthy();
    expect(screen.getByText(/Derived from/)).toBeTruthy();
    expect(screen.getByText(/Fresh at read time/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Open workspace Release workspace" }));
    expect(onOpenWorkspace).toHaveBeenCalledWith({ kind: "task", identifier: "TASK-1" });
    expect(onOpenTask).not.toHaveBeenCalled();
  });

  it("groups board cards by macro bucket while displaying the actual stage", () => {
    const { onOpenTask, onOpenTaskDetail, onLoadMore } = renderWorkspace("board");
    expect(screen.getByText("Active")).toBeTruthy();
    expect(screen.getByText("in progress")).toBeTruthy();
    fireEvent.click(screen.getByText("Build board"));
    expect(onOpenTask).toHaveBeenCalledWith(expect.objectContaining({ identifier: "TASK-2" }));
    fireEvent.click(screen.getByRole("button", { name: "Open details TASK-2" }));
    expect(onOpenTaskDetail).toHaveBeenCalledWith(expect.objectContaining({ identifier: "TASK-2" }));
    fireEvent.click(screen.getByText("Load more"));
    expect(onLoadMore).toHaveBeenCalledOnce();
  });

  it("uses route callbacks for workspace view and direct/all-descendant toggles", () => {
    const { onViewChange, onDescendantsChange, onOpenWorkspace } = renderWorkspace("list");
    fireEvent.click(screen.getByText("Tree"));
    expect(onViewChange).toHaveBeenCalledWith("tree");
    fireEvent.click(screen.getByLabelText("All descendants"));
    expect(onDescendantsChange).toHaveBeenCalledWith(true);
    fireEvent.click(screen.getByText("Program"));
    expect(onOpenWorkspace).toHaveBeenCalledWith({ kind: "task", identifier: "TASK-0" });
    expect(screen.getByRole("tablist", { name: "Workspace views" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "List" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("tabpanel").getAttribute("aria-labelledby")).toBe("nested-workspace-tab-list");
  });

  it("renders a keyboard-operable mind map from the workspace hierarchy", () => {
    const { onOpenTask, onOpenWorkspace } = renderWorkspace("mindmap", true);
    const map = screen.getByLabelText(/Mind map\. Use arrow keys/);
    expect(screen.getByRole("button", { name: /TASK-1.*Release workspace/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /TASK-3.*Verify list/i })).toBeTruthy();
    fireEvent.keyDown(map, { key: "+" });
    expect(screen.getByText("110%")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /TASK-3.*Verify list/i }));
    expect(onOpenTask).toHaveBeenCalledWith(expect.objectContaining({ identifier: "TASK-3" }));
    fireEvent.click(screen.getByRole("button", { name: /TASK-1.*Release workspace/i }));
    expect(onOpenWorkspace).toHaveBeenCalledWith({ kind: "task", identifier: "TASK-1" });
  });

  it("keeps the workspace root visible in a mind map with no loaded children", () => {
    const originalChildren = workspace.children.items;
    workspace.children.items = [];
    renderWorkspace("mindmap");
    expect(screen.getByRole("button", { name: /TASK-1.*Release workspace/i })).toBeTruthy();
    workspace.children.items = originalChildren;
  });

  it("keeps deliberate project extras after the six canonical workspace tabs", () => {
    const onProjectExtraChange = vi.fn();
    const rootWorkspace: WorkspaceDescriptor = {
      ...workspace,
      kind: "project",
      root: {
        id: "project:project-1",
        identifier: null,
        projectId: "project-1",
        title: "Alpha",
        description: "",
        status: null,
        macroBucket: null,
        target: null,
      },
      breadcrumb: [],
    };
    render(
      <TaskboardLanguageProvider language="en">
        <NestedWorkspaceView
          workspace={rootWorkspace}
          rollup={null}
          view="overview"
          descendants={false}
          loadingMore={false}
          onViewChange={vi.fn()}
          onDescendantsChange={vi.fn()}
          onLoadMore={vi.fn()}
          onOpenTask={vi.fn()}
          onOpenTaskDetail={vi.fn()}
          onOpenWorkspace={vi.fn()}
          projectExtras={[{ id: "gantt", label: "Gantt" }, { id: "docs", label: "Project Docs" }]}
          activeProjectExtra="gantt"
          onProjectExtraChange={onProjectExtraChange}
          projectExtraContent={<p>Legacy Gantt surface</p>}
        />
      </TaskboardLanguageProvider>,
    );

    for (const label of ["Overview", "Board", "List", "Tree", "Mind Map", "Timeline", "Gantt", "Project Docs"]) {
      expect(screen.getByRole("tab", { name: label })).toBeTruthy();
    }
    expect(screen.getByText("Legacy Gantt surface")).toBeTruthy();
    expect(screen.getByRole("tabpanel").getAttribute("aria-labelledby")).toBe("nested-workspace-extra-gantt");
    fireEvent.click(screen.getByRole("tab", { name: "Project Docs" }));
    expect(onProjectExtraChange).toHaveBeenCalledWith("docs");
  });

  it("orders the timeline deterministically and preserves real stage and macro bucket", () => {
    const originalItems = workspace.descendants!.items;
    workspace.descendants!.items = [
      { ...originalItems[0], createdAt: "2026-08-30T12:00:00.000Z" },
      { ...originalItems[1], startDate: "2026-08-25" },
    ];
    const { onOpenTask } = renderWorkspace("timeline", true);
    const timelineItems = screen.getAllByRole("listitem");
    expect(timelineItems[0].textContent).toContain("Verify list");
    expect(timelineItems[1].textContent).toContain("Build board");
    expect(screen.getByText("in review")).toBeTruthy();
    expect(screen.getByText("Review")).toBeTruthy();
    expect(screen.getByText(/No scheduled date/)).toBeTruthy();
    fireEvent.click(screen.getByText("Verify list"));
    expect(onOpenTask).toHaveBeenCalledWith(expect.objectContaining({ identifier: "TASK-3" }));
    workspace.descendants!.items = originalItems;
  });
});
