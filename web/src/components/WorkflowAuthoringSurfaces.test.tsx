import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TaskboardLanguageProvider } from "../i18n";
import type {
  Project,
  Task,
  WorkflowAuthoringDefinition,
  WorkflowAuthoringRecord,
} from "../types";
import { workflowDisplayStages } from "../workflowAuthoring";
import { BoardColumn } from "./BoardColumn";
import { BoardWorkflowDialog } from "./BoardWorkflowDialog";
import { IssueListView } from "./IssueListView";
import { ProjectRenameDialog } from "./ProjectRenameDialog";

type RecordedRequest = { input: RequestInfo | URL; init?: RequestInit };

const definition: WorkflowAuthoringDefinition = {
  schemaVersion: 2,
  stages: [
    {
      stageId: "todo",
      canonicalStatus: "todo",
      name: "To do",
      order: 0,
      boardVisible: true,
      active: true,
      isDefaultForStatus: true,
      terminalKind: "none",
    },
    {
      stageId: "custom-review",
      canonicalStatus: "in_review",
      name: "Custom review",
      order: 1,
      boardVisible: true,
      active: true,
      isDefaultForStatus: false,
      terminalKind: "none",
    },
  ],
};

function workflow(overrides: Partial<WorkflowAuthoringRecord> = {}): WorkflowAuthoringRecord {
  return {
    projectId: "project-1",
    workflowId: "project-1-workflow",
    revisionId: "11111111-1111-4111-8111-111111111111",
    revision: 1,
    definition,
    legacyOccupiedStages: [],
    projectUpdatedAt: "2026-09-01T22:00:00.000Z",
    ...overrides,
  };
}

const project: Project = {
  id: "project-1",
  name: "Old name",
  workspacePath: null,
  source: "local",
  labels: [],
  issueCount: 41,
  archivedAt: null,
  version: 1,
  createdAt: "2026-09-01T21:00:00.000Z",
  updatedAt: "2026-09-01T22:00:00.000Z",
};

function taskInStage(stageId: string): Task {
  return {
    id: "legacy-task",
    identifier: "LEG-1",
    projectId: "project-1",
    title: "Card kept in legacy stage",
    description: "",
    status: "in_review",
    stageId,
    priority: "none",
    labels: [],
    sortOrder: 0,
    threadId: null,
    threadBinding: null,
    legacyLocalThreadId: null,
    conversationRefs: [],
    participants: [],
    previewImage: null,
    activityKey: "legacy-task:1",
    activityUpdatedAt: "2026-09-01T22:00:00.000Z",
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
    relations: { parent: null, subIssues: [], blockedBy: [], blocks: [], related: [] },
    version: 1,
    createdAt: "2026-09-01T22:00:00.000Z",
    updatedAt: "2026-09-01T22:00:00.000Z",
  };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function english(children: ReactNode) {
  return <TaskboardLanguageProvider language="en">{children}</TaskboardLanguageProvider>;
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function pathOf(request: RecordedRequest) {
  return new URL(String(request.input), document.baseURI).pathname;
}

function bodyOf(request: RecordedRequest) {
  return JSON.parse(String(request.init?.body));
}

describe("workflow authoring dialog", () => {
  it("validates then publishes N+1 and retires a removed custom stage without a remap", async () => {
    const requests: RecordedRequest[] = [];
    const published = workflow({
      revisionId: "22222222-2222-4222-8222-222222222222",
      revision: 2,
      definition: { schemaVersion: 2, stages: [definition.stages[0]!] },
      legacyOccupiedStages: [{
        stageId: "custom-review",
        canonicalStatus: "in_review",
        name: "Custom review",
        terminalKind: "none",
        taskCount: 2,
      }],
    });
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = { input, init };
      requests.push(request);
      const path = pathOf(request);
      if (path.endsWith("/validate")) return json({ validation: { valid: true } });
      if (path.endsWith("/publish")) return json({ workflow: published }, 201);
      return json({ workflow: workflow() });
    }));
    const onSaved = vi.fn();
    render(english(
      <BoardWorkflowDialog projectId="project-1" onClose={vi.fn()} onSaved={onSaved} />,
    ));

    expect(await screen.findByText("Current revision 1")).toBeTruthy();
    const removeButtons = screen.getAllByRole("button", { name: "Remove" });
    expect(removeButtons[0]!.hasAttribute("disabled")).toBe(true);
    fireEvent.click(removeButtons[1]!);
    fireEvent.click(screen.getByRole("button", { name: "Publish new revision" }));

    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(published));
    expect(requests.map(pathOf)).toEqual([
      "/api/projects/project-1/workflow-authoring",
      "/api/projects/project-1/workflow-authoring/validate",
      "/api/projects/project-1/workflow-authoring/publish",
    ]);
    expect(bodyOf(requests[1]!)).toEqual(bodyOf(requests[2]!));
    expect(bodyOf(requests[1]!).expectedRevisionId).toBe(workflow().revisionId);
    expect(bodyOf(requests[1]!).definition.stages).toHaveLength(1);
    expect(bodyOf(requests[1]!)).not.toHaveProperty("removals");
    expect(screen.getByText("Custom review · 2")).toBeTruthy();
    expect(screen.getByText("Legacy")).toBeTruthy();
  });

  it("can publish revision 1 before an empty project has any cards", async () => {
    const requests: RecordedRequest[] = [];
    const empty = workflow({ revisionId: null, revision: 0 });
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = { input, init };
      requests.push(request);
      if (pathOf(request).endsWith("/validate")) return json({ validation: { valid: true } });
      if (pathOf(request).endsWith("/publish")) return json({ workflow: workflow() }, 201);
      return json({ workflow: empty });
    }));
    render(english(
      <BoardWorkflowDialog projectId="project-1" onClose={vi.fn()} onSaved={vi.fn()} />,
    ));

    expect(await screen.findByText("No workflow revision published yet")).toBeTruthy();
    const publish = screen.getByRole("button", { name: "Publish new revision" });
    expect(publish.hasAttribute("disabled")).toBe(false);
    fireEvent.click(publish);
    await waitFor(() => expect(requests.some((request) => pathOf(request).endsWith("/publish"))).toBe(true));
    const validate = requests.find((request) => pathOf(request).endsWith("/validate"))!;
    expect(bodyOf(validate).expectedRevisionId).toBeNull();
  });

  it("shows validation failure and never attempts publication", async () => {
    const requests: RecordedRequest[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = { input, init };
      requests.push(request);
      if (pathOf(request).endsWith("/validate")) {
        return json({ error: { code: "INVALID_FIELD", message: "A completed stage needs human acceptance" } }, 400);
      }
      return json({ workflow: workflow({ revisionId: null, revision: 0 }) });
    }));
    render(english(
      <BoardWorkflowDialog projectId="project-1" onClose={vi.fn()} onSaved={vi.fn()} />,
    ));

    await screen.findByText("No workflow revision published yet");
    fireEvent.click(screen.getByRole("button", { name: "Publish new revision" }));
    expect((await screen.findByRole("alert")).textContent).toContain("A completed stage needs human acceptance");
    expect(requests.some((request) => pathOf(request).endsWith("/publish"))).toBe(false);
  });
});

describe("legacy board columns", () => {
  function renderBoardColumn(dropEnabled: boolean, legacy = false) {
    const onDragEnter = vi.fn();
    const onDrop = vi.fn();
    const view = render(english(
      <BoardColumn
        scrollRef={() => {}}
        status="in_review"
        stageId={legacy ? "old-review" : "new-review"}
        label={legacy ? "Old review" : "New review"}
        tasks={[]}
        presentations={{}}
        now={Date.now()}
        emptyMessage="No issues"
        isDropTarget
        draggedTaskId="task-1"
        draggedTaskHeight={80}
        movingTaskId={null}
        settlingTaskId={null}
        contextMenuTaskId={null}
        availableLabels={[]}
        currentUser={{ type: "user", id: "local-user", name: "Local user", avatarUrl: null }}
        showCover={false}
        showBody={false}
        createEnabled
        dropEnabled={dropEnabled}
        legacy={legacy}
        onCreateLabel={async () => {}}
        onCreate={vi.fn()}
        onEdit={vi.fn()}
        onUpdate={async (task) => task}
        onComplete={vi.fn()}
        onContextMenu={vi.fn()}
        onDragStart={vi.fn()}
        onDragEnd={vi.fn()}
        onDragEnter={onDragEnter}
        onDrop={onDrop}
        onOpenConversation={vi.fn()}
      />
    ));
    return { ...view, onDragEnter, onDrop };
  }

  it("marks an occupied old stage as legacy and rejects create/drop interaction", () => {
    const { container, onDragEnter, onDrop } = renderBoardColumn(false, true);
    const column = container.querySelector("section")!;
    expect(screen.getByText("Legacy")).toBeTruthy();
    expect(column.getAttribute("aria-disabled")).toBe("true");
    expect(column.classList.contains("is-drop-target")).toBe(false);
    expect(screen.queryByRole("button", { name: /Create issue/ })).toBeNull();
    fireEvent.dragEnter(column);
    fireEvent.drop(column);
    expect(onDragEnter).not.toHaveBeenCalled();
    expect(onDrop).not.toHaveBeenCalled();
  });

  it("keeps a newly published stage available for create and drop", () => {
    const { container, onDragEnter, onDrop } = renderBoardColumn(true);
    const column = container.querySelector("section")!;
    expect(screen.getByRole("button", { name: "Create issue in New review" })).toBeTruthy();
    expect(screen.queryByText("Legacy")).toBeNull();
    fireEvent.dragEnter(column);
    fireEvent.drop(column, {
      dataTransfer: {
        getData: (type: string) => type === "application/x-taskboard-task" ? "task-1" : "",
      },
    });
    expect(onDragEnter).toHaveBeenCalledWith("in_review", "new-review");
    expect(onDrop).toHaveBeenCalledWith("in_review", "task-1", null, "new-review");
  });
});

describe("legacy read projections", () => {
  it("keeps a legacy-stage card visible in List with a read-only stage badge", () => {
    const retired = workflow({
      definition: { schemaVersion: 2, stages: [definition.stages[0]!] },
      legacyOccupiedStages: [{
        stageId: "custom-review",
        canonicalStatus: "in_review",
        name: "Custom review",
        terminalKind: "none",
        taskCount: 1,
      }],
    });
    render(english(
      <IssueListView
        scrollRef={{ current: null }}
        tasks={[taskInStage("custom-review")]}
        presentations={{}}
        currentUser={{ type: "user", id: "local-user", name: "Local user", avatarUrl: null }}
        workflowStages={workflowDisplayStages(retired)}
        hasActiveFilters={false}
        onOpenTask={vi.fn()}
        onOpenTaskDetail={vi.fn()}
        onOpenConversation={vi.fn()}
        onUpdate={async (task) => task}
      />,
    ));

    expect(screen.getByText("Custom review")).toBeTruthy();
    expect(screen.getByText("Legacy")).toBeTruthy();
    expect(screen.getByText("Card kept in legacy stage")).toBeTruthy();
  });
});

describe("project rename dialog", () => {
  it("renames with expectedUpdatedAt and returns the same project id", async () => {
    const requests: RecordedRequest[] = [];
    const renamed = { ...project, name: "Construction engine", version: 2 };
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ input, init });
      return json({ project: renamed });
    }));
    const onSaved = vi.fn();
    render(english(
      <ProjectRenameDialog project={project} onClose={vi.fn()} onSaved={onSaved} />,
    ));

    fireEvent.change(screen.getByLabelText("Project name"), { target: { value: "Construction engine" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(renamed));
    expect(pathOf(requests[0]!)).toBe("/api/projects/project-1");
    expect(bodyOf(requests[0]!)).toEqual({
      name: "Construction engine",
      expectedUpdatedAt: project.updatedAt,
    });
    expect(onSaved.mock.calls[0]![0].id).toBe(project.id);
  });

  it.each([
    ["PROJECT_UPDATED_AT_CONFLICT", "This project changed elsewhere"],
    ["PROJECT_ARCHIVED", "This project cannot be renamed"],
  ])("keeps the dialog open for %s", async (code, message) => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ error: { code, message: "Rejected" } }, 409)));
    const onSaved = vi.fn();
    render(english(
      <ProjectRenameDialog project={project} onClose={vi.fn()} onSaved={onSaved} />,
    ));
    fireEvent.change(screen.getByLabelText("Project name"), { target: { value: "New name" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect((await screen.findByRole("alert")).textContent).toContain(message);
    expect(onSaved).not.toHaveBeenCalled();
  });
});
