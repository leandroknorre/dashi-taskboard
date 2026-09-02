import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TaskboardLanguageProvider } from "../i18n";
import type { ActorIdentity, Task } from "../types";
import type { TaskCardPresentation } from "../taskConversations";
import { IssueListView } from "./IssueListView";
import { TaskCard } from "./TaskCard";
import { TaskDetail } from "./TaskDetail";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const currentUser: ActorIdentity = {
  type: "user",
  id: "local-user",
  name: "Local user",
  avatarUrl: null,
};

function workCard(overrides: Partial<Task> = {}): Task {
  return {
    id: "work-1",
    identifier: "WORK-1",
    projectId: "project-1",
    title: "Editable work card",
    description: "Operational copy",
    status: "todo",
    stageId: "todo",
    priority: "medium",
    labels: [],
    sortOrder: 1,
    threadId: null,
    threadBinding: null,
    legacyLocalThreadId: null,
    conversationRefs: [],
    participants: [],
    previewImage: null,
    activityKey: "work-1:1",
    activityUpdatedAt: "2026-09-01T20:00:00.000Z",
    creatorType: "user",
    creatorId: "local-user",
    creatorName: "Local user",
    creatorAvatarUrl: null,
    assignee: currentUser,
    developmentContext: null,
    startDate: null,
    dueDate: null,
    recurrence: null,
    kind: "work_card",
    readOnly: false,
    source: "local",
    externalUrl: null,
    archivedAt: null,
    relations: { parent: null, subIssues: [], blockedBy: [], blocks: [], related: [] },
    version: 1,
    createdAt: "2026-09-01T20:00:00.000Z",
    updatedAt: "2026-09-01T20:00:00.000Z",
    ...overrides,
  };
}

function sourceRecord(candidateState: Task["candidateState"] = "available"): Task {
  return workCard({
    id: "source-1",
    identifier: "SRC-1",
    title: "Paperclip reference",
    description: "Source-owned summary",
    kind: "source_record",
    readOnly: true,
    sourceSystem: "paperclip",
    externalId: "AUT-434",
    externalVersion: "17",
    candidateState,
    candidateTargetTaskId: candidateState === "adopted" ? "work-1" : null,
    source: "local",
    version: 4,
  });
}

const presentation: TaskCardPresentation = {
  conversations: [],
  processing: { running: false, completed: null, total: null, startedAt: null },
  unread: false,
};

function language(children: ReactNode) {
  return <TaskboardLanguageProvider language="en">{children}</TaskboardLanguageProvider>;
}

describe("source_record board and list surfaces", () => {
  it("marks a board reference as read-only and removes drag, completion and property writes", () => {
    const task = sourceRecord();
    const onEdit = vi.fn();
    const onContextMenu = vi.fn();
    const onComplete = vi.fn();
    const { container } = render(language(
      <TaskCard
        task={task}
        presentation={presentation}
        now={Date.now()}
        isDragging={false}
        dragShift={0}
        isMoving={false}
        isSettling={false}
        isContextMenuOpen={false}
        availableLabels={[]}
        currentUser={currentUser}
        showCover={false}
        showBody
        onCreateLabel={async () => {}}
        onEdit={onEdit}
        onUpdate={async (current) => current}
        onComplete={onComplete}
        onContextMenu={onContextMenu}
        onDragStart={vi.fn()}
        onDragEnd={vi.fn()}
        onOpenConversation={vi.fn()}
      />,
    ));

    const article = container.querySelector("article")!;
    expect(article.getAttribute("draggable")).toBe("false");
    expect(screen.getByText("Referência somente leitura")).toBeTruthy();
    expect(screen.getByText("paperclip · v17")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Complete SRC-1/ })).toBeNull();
    expect(screen.queryByLabelText("SRC-1 priority")).toBeNull();
    fireEvent.contextMenu(article);
    expect(onContextMenu).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /Open SRC-1/ }));
    expect(onEdit).toHaveBeenCalledWith(task);
  });

  it("keeps a list reference navigable while exposing no inline editor", () => {
    const task = sourceRecord();
    const onOpenTask = vi.fn();
    render(language(
      <IssueListView
        scrollRef={{ current: null }}
        tasks={[task]}
        presentations={{ [task.id]: presentation }}
        currentUser={currentUser}
        hasActiveFilters={false}
        onOpenTask={onOpenTask}
        onOpenTaskDetail={vi.fn()}
        onOpenConversation={vi.fn()}
        onUpdate={async (current) => current}
      />,
    ));

    expect(screen.getByText("Referência somente leitura")).toBeTruthy();
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(screen.queryByLabelText("SRC-1 due date")).toBeNull();
    fireEvent.click(screen.getByText("Paperclip reference"));
    expect(onOpenTask).toHaveBeenCalledWith(task);
  });
});

describe("source_record detail", () => {
  function detailProps(task: Task, onAction = vi.fn()) {
    const work = workCard();
    return {
      task,
      tasks: [task, work],
      referenceTasks: [task, work],
      currentUser,
      availableLabels: [],
      developmentScan: { workspacePath: null, contexts: [] },
      developmentScanLoading: false,
      commentsRevision: 0,
      attachmentsRevision: 0,
      onCreateLabel: async () => {},
      onDeleteLabel: async () => {},
      onUpdate: async (current: Task) => current,
      onStatusChange: async (current: Task) => current,
      onSourceRecordAction: onAction,
      onOpenTask: vi.fn(),
      onOpenWorkspace: vi.fn(),
      onAddRelation: async (current: Task) => ({ task: current, relatedTask: work }),
      onRemoveRelation: async (current: Task) => ({ task: current, relatedTask: work }),
      onOpenThread: vi.fn(),
      onOpenLegacyLocalThread: vi.fn(),
      onOpenInThread: vi.fn(),
      onCopy: vi.fn(),
      openingThread: false,
      onError: vi.fn(),
    };
  }

  it("routes an available reference to candidate actions instead of the editable issue detail", async () => {
    const task = sourceRecord();
    const adopted = { ...task, candidateState: "adopted" as const, candidateTargetTaskId: "work-1", version: 5 };
    const work = workCard();
    const onAction = vi.fn(async () => ({
      sourceRecord: adopted,
      workCard: work,
      targetTaskId: work.id,
      disposition: "adopted" as const,
      version: 5,
      idempotent: false,
    }));
    render(language(<TaskDetail {...detailProps(task, onAction)} />));

    expect(screen.getByRole("heading", { name: "Paperclip reference" })).toBeTruthy();
    expect(screen.queryByLabelText("Issue title")).toBeNull();
    expect(screen.queryByText("Add attachment")).toBeNull();
    expect(screen.queryByText("Add sub-issue")).toBeNull();
    expect(screen.getByRole("button", { name: "Adotar" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Mesclar" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Descartar" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Adotar" }));
    await waitFor(() => expect(onAction).toHaveBeenCalledWith(task, "adopt", undefined));
    expect(await screen.findByText("Referência adotada")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Abrir card operacional/ })).toBeTruthy();
  });

  it("offers restore only for a discarded reference", () => {
    render(language(<TaskDetail {...detailProps(sourceRecord("discarded"))} />));
    expect(screen.getByRole("button", { name: "Restaurar" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Adotar" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Mesclar" })).toBeNull();
  });

  it("keeps an adopted work card editable and links back to its source record", async () => {
    const source = sourceRecord("adopted");
    const work = workCard();
    const onOpenTask = vi.fn();
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const payload = url.endsWith("/comments")
        ? { comments: [] }
        : url.endsWith("/activities")
          ? { activities: [] }
          : { attachments: [] };
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }));

    render(language(
      <TaskDetail
        {...detailProps(work)}
        tasks={[work, source]}
        referenceTasks={[work, source]}
        onOpenTask={onOpenTask}
      />,
    ));

    expect(screen.getByLabelText("Issue title")).toBeTruthy();
    expect(screen.getByText("This work card was adopted from")).toBeTruthy();
    expect(screen.getByText("paperclip · v17")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /SRC-1.*Paperclip reference/ }));
    expect(onOpenTask).toHaveBeenCalledWith(source);
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(3));
  });
});
