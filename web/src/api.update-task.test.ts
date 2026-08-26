import { afterEach, describe, expect, it, vi } from "vitest";
import { moveTask, restoreTaskDraftChanges, updateTask } from "./api";
import type { Task, TaskDraft } from "./types";

const task: Task = {
  id: "task-1",
  identifier: "TASK-1",
  projectId: "project-1",
  title: "Original title",
  description: "Original description",
  status: "in_review",
  stageId: "review",
  priority: "high",
  labels: ["regression"],
  sortOrder: 10,
  threadId: null,
  threadBinding: null,
  legacyLocalThreadId: null,
  conversationRefs: [],
  participants: [],
  previewImage: null,
  activityKey: "task-1",
  activityUpdatedAt: "2026-08-25T00:00:00.000Z",
  creatorType: "user",
  creatorId: "local-user",
  creatorName: "Local User",
  creatorAvatarUrl: null,
  assignee: { type: "user", id: "local-user", name: "Local User", avatarUrl: null },
  developmentContext: null,
  startDate: "2026-08-20",
  dueDate: "2026-08-31",
  recurrence: null,
  source: "local",
  externalUrl: null,
  archivedAt: null,
  relations: { parent: null, subIssues: [], blockedBy: [], blocks: [], related: [] },
  version: 12,
  createdAt: "2026-08-20T00:00:00.000Z",
  updatedAt: "2026-08-25T00:00:00.000Z",
};

type RecordedRequest = { input: RequestInfo | URL; init?: RequestInit };

const normalUpdates: Array<[string, Partial<TaskDraft>]> = [
  ["title", { title: "Renamed title" }],
  ["priority", { priority: "low" }],
  ["labels", { labels: ["regression", "verified"] }],
  ["start date", { startDate: "2026-08-21" }],
  ["due date", { dueDate: "2026-09-01" }],
];

afterEach(() => vi.unstubAllGlobals());

function mockFetch() {
  const requests: RecordedRequest[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push({ input, init });
    return new Response(JSON.stringify({ task }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }));
  return requests;
}

function requestBody(request: RecordedRequest) {
  return JSON.parse(String(request.init?.body));
}

describe("task mutation payloads", () => {
  it("sends the detail review-to-done transition as one atomic PATCH", async () => {
    const requests = mockFetch();

    await updateTask(task, { status: "done", stageId: "done" });

    expect(requests).toHaveLength(1);
    expect(new URL(String(requests[0]?.input), document.baseURI).pathname).toBe("/api/tasks/task-1");
    expect(requests[0]?.init?.method).toBe("PATCH");
    expect(requestBody(requests[0]!)).toEqual({ version: 12, status: "done", stageId: "done" });
  });

  it.each(normalUpdates)("sends only the changed %s field", async (_name, changes) => {
    const requests = mockFetch();

    await updateTask(task, changes);

    expect(requests).toHaveLength(1);
    expect(requestBody(requests[0]!)).toEqual({ version: 12, ...changes });
  });

  it("restores a priority-only undo without resending workflow state", async () => {
    const changedTask: Task = { ...task, priority: "low", version: 13 };
    const restoreChanges = restoreTaskDraftChanges(task, changedTask);
    const requests = mockFetch();

    expect(restoreChanges).toEqual({ priority: "high" });
    expect(restoreChanges).not.toHaveProperty("status");
    expect(restoreChanges).not.toHaveProperty("stageId");
    await updateTask(changedTask, restoreChanges);
    expect(requests).toHaveLength(1);
    expect(requestBody(requests[0]!)).toEqual({ version: 13, priority: "high" });
  });

  it("restores a status change as an atomic workflow-only patch", () => {
    const restoreChanges = restoreTaskDraftChanges(task, {
      ...task,
      status: "done",
      stageId: "done",
    });

    expect(restoreChanges).toEqual({ status: "in_review", stageId: "review" });
  });

  it("keeps board moves on POST /move", async () => {
    const requests = mockFetch();

    await moveTask(task, "done", undefined, undefined, undefined, "done");

    expect(requests).toHaveLength(1);
    expect(new URL(String(requests[0]?.input), document.baseURI).pathname).toBe("/api/tasks/task-1/move");
    expect(requests[0]?.init?.method).toBe("POST");
    expect(requestBody(requests[0]!)).toEqual({ version: 12, status: "done", stageId: "done" });
  });
});
