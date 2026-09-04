import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActorIdentity, Comment, DevelopmentScan, Task } from "../types";
import { TaskDetail } from "./TaskDetail";

const api = vi.hoisted(() => {
  class MockApiError extends Error {
    code?: string;
    constructor(status: number, body: { message?: string; code?: string } = {}) {
      super(body.message ?? `HTTP ${status}`);
      this.code = body.code;
    }
  }
  return {
    ApiError: MockApiError,
    getTask: vi.fn(),
    listComments: vi.fn(),
    listAttachments: vi.fn(),
    listTaskActivities: vi.fn(),
    createComment: vi.fn(),
    updateComment: vi.fn(),
    deleteComment: vi.fn(),
    uploadAttachment: vi.fn(),
    uploadCommentAttachment: vi.fn(),
    deleteAttachment: vi.fn(),
    createTask: vi.fn(),
    getAiChatComposerCandidates: vi.fn(),
  };
});

vi.mock("../api", () => ({
  ApiError: api.ApiError,
  resolveTaskboardUrl: (path: string) => path,
  attachmentDownloadUrl: () => "",
  attachmentContentUrl: () => "",
  resolvePersistedAttachmentUrl: (url: string) => url,
  getTask: api.getTask,
  listComments: api.listComments,
  listAttachments: api.listAttachments,
  listTaskActivities: api.listTaskActivities,
  createComment: api.createComment,
  updateComment: api.updateComment,
  deleteComment: api.deleteComment,
  uploadAttachment: api.uploadAttachment,
  uploadCommentAttachment: api.uploadCommentAttachment,
  deleteAttachment: api.deleteAttachment,
  createTask: api.createTask,
  getAiChatComposerCandidates: api.getAiChatComposerCandidates,
}));

const storageStore = vi.hoisted(() => new Map<string, string>());

vi.mock("../storage", () => ({
  taskboardStorage: {
    getItem: (key: string) => storageStore.get(key) ?? null,
    setItem: (key: string, value: string) => { storageStore.set(key, value); },
    removeItem: (key: string) => { storageStore.delete(key); },
  },
}));

const CURRENT_USER: ActorIdentity = { type: "user", id: "leandro", name: "Leandro", avatarUrl: null };
const COMMENT_AUTHOR: ActorIdentity = { type: "user", id: "felipe", name: "Felipe", avatarUrl: null };

const DEVELOPMENT_SCAN: DevelopmentScan = { workspacePath: null, contexts: [] };

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "task-1",
    identifier: "TASK-1",
    projectId: "project-1",
    title: "Sample task",
    description: "The description holds a detail worth quoting in a comment.",
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
    activityKey: "activity-1",
    activityUpdatedAt: "2026-01-01T00:00:00.000Z",
    creatorType: "user",
    creatorId: CURRENT_USER.id,
    creatorName: CURRENT_USER.name,
    creatorAvatarUrl: null,
    assignee: CURRENT_USER,
    developmentContext: null,
    startDate: null,
    dueDate: null,
    recurrence: null,
    source: "local",
    externalUrl: null,
    archivedAt: null,
    relations: { parent: null, subIssues: [], blockedBy: [], blocks: [], related: [] },
    version: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeComment(overrides: Partial<Comment> = {}): Comment {
  return {
    id: "comment-1",
    taskId: "task-1",
    body: "Here is an important detail worth quoting later.",
    authorType: COMMENT_AUTHOR.type,
    authorId: COMMENT_AUTHOR.id,
    authorName: COMMENT_AUTHOR.name,
    authorAvatarUrl: null,
    threadId: null,
    threadBinding: null,
    legacyLocalThreadId: null,
    attachments: [],
    version: 1,
    createdAt: "2026-01-01T14:32:00.000Z",
    updatedAt: "2026-01-01T14:32:00.000Z",
    ...overrides,
  };
}

function selectTextWithin(element: Element, matchText: string) {
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode();
  while (node) {
    const index = node.textContent?.indexOf(matchText) ?? -1;
    if (index >= 0) {
      const range = document.createRange();
      range.setStart(node, index);
      range.setEnd(node, index + matchText.length);
      const selection = window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
      document.dispatchEvent(new Event("selectionchange"));
      return;
    }
    node = walker.nextNode();
  }
  throw new Error(`Text "${matchText}" not found inside element`);
}

function noop() {}
async function asyncNoop() {}

describe("TaskDetail quote-in-comment selection", () => {
  beforeEach(() => {
    Object.defineProperty(Range.prototype, "getBoundingClientRect", {
      configurable: true,
      value: () => new DOMRect(20, 20, 40, 18),
    });
    api.listComments.mockResolvedValue([makeComment()]);
    api.listTaskActivities.mockResolvedValue([]);
    api.listAttachments.mockResolvedValue([]);
  });

  afterEach(() => {
    document.body.replaceChildren();
    vi.clearAllMocks();
    storageStore.clear();
    window.getSelection()?.removeAllRanges();
  });

  function renderTaskDetail() {
    const task = makeTask();
    render(
      <TaskDetail
        task={task}
        tasks={[task]}
        referenceTasks={[task]}
        currentUser={CURRENT_USER}
        availableLabels={[]}
        developmentScan={DEVELOPMENT_SCAN}
        developmentScanLoading={false}
        commentsRevision={0}
        attachmentsRevision={0}
        onCreateLabel={asyncNoop}
        onDeleteLabel={asyncNoop}
        onUpdate={async (current) => current}
        onStatusChange={async () => null}
        onSourceRecordAction={async () => { throw new Error("not used"); }}
        onOpenTask={noop}
        onOpenWorkspace={noop}
        onAddRelation={async () => { throw new Error("not used"); }}
        onRemoveRelation={async () => { throw new Error("not used"); }}
        onOpenThread={noop}
        onOpenLegacyLocalThread={noop}
        onOpenInThread={noop}
        onCopy={noop}
        openingThread={false}
        onError={noop}
      />,
    );
    return task;
  }

  it("quotes a comment excerpt into the new-comment field with an author/time prefix", async () => {
    renderTaskDetail();
    const commentBody = await waitFor(() => {
      const node = document.querySelector('[data-quote-source="comment"]');
      if (!node) throw new Error("comment body not rendered yet");
      return node;
    });

    selectTextWithin(commentBody, "important detail worth quoting");

    const quoteButton = await screen.findByRole("button", { name: /quote in comment/i });
    // The button is portaled straight to document.body so its `position: fixed`
    // coordinates resolve against the real viewport, not against `.workspace`
    // (which establishes CSS layout containment via `container-type`, making
    // it the containing block for any fixed-position descendant left inline).
    expect(quoteButton.parentElement).toBe(document.body);
    fireEvent.mouseDown(quoteButton);
    fireEvent.click(quoteButton);

    const composer = screen.getByLabelText("Leave a comment") as HTMLElement;
    const expectedTime = (() => {
      const date = new Date("2026-01-01T14:32:00.000Z");
      const hours = String(date.getHours()).padStart(2, "0");
      const minutes = String(date.getMinutes()).padStart(2, "0");
      return `${hours}h${minutes}`;
    })();

    await waitFor(() => {
      expect(composer.textContent).toContain(`@felipe, ${expectedTime}:`);
      expect(composer.textContent).toContain("important detail worth quoting");
    });

    // The floating button disappears again once the quote has been inserted.
    expect(screen.queryByRole("button", { name: /quote in comment/i })).toBeNull();
  });

  it("quotes a description excerpt without an author prefix", async () => {
    renderTaskDetail();
    const descriptionNode = await waitFor(() => {
      const node = document.querySelector('[data-quote-source="description"]');
      if (!node) throw new Error("description not rendered yet");
      return node;
    });

    selectTextWithin(descriptionNode, "detail worth quoting");

    const quoteButton = await screen.findByRole("button", { name: /quote in comment/i });
    fireEvent.mouseDown(quoteButton);
    fireEvent.click(quoteButton);

    const composer = screen.getByLabelText("Leave a comment") as HTMLElement;
    await waitFor(() => {
      expect(composer.textContent).toContain("detail worth quoting");
    });
    expect(composer.textContent).not.toContain("@");
  });
});
