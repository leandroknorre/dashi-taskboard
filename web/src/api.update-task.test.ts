import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ApiError,
  classifyTaskMutationFailure,
  moveTask,
  mutateSourceRecord,
  restoreTaskDraftChanges,
  updateTask,
} from "./api";
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

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function requestPath(request: RecordedRequest) {
  return new URL(String(request.input), document.baseURI).pathname;
}

function idempotencyKey(request: RecordedRequest) {
  return new Headers(request.init?.headers).get("Idempotency-Key");
}

const completionAction = {
  actionKey: "complete-review",
  transitionId: "complete-review",
  toStageId: "done",
  toStatus: "done" as const,
  toTerminalKind: "completed" as const,
  requiresAcceptance: true,
};

const acceptanceEvidence = {
  evidenceId: "11111111-1111-4111-8111-111111111111",
  gateId: "human-acceptance",
  type: "human_acceptance",
};

describe("task mutation payloads", () => {
  it("sends source-record candidate actions with version and a stable idempotency key", async () => {
    const sourceRecord: Task = {
      ...task,
      id: "source-1",
      identifier: "SRC-1",
      kind: "source_record",
      readOnly: true,
      candidateState: "available",
      sourceSystem: "paperclip",
      externalId: "AUT-1",
      externalVersion: "7",
      version: 4,
    };
    const requests: RecordedRequest[] = [];
    let attempts = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ input, init });
      attempts += 1;
      if (attempts === 1) throw new TypeError("connection reset after write");
      return jsonResponse({
        sourceRecord: { ...sourceRecord, candidateState: "adopted", version: 5 },
        workCard: { ...task, id: "work-2", identifier: "TASK-2" },
        targetTaskId: "work-2",
        disposition: "adopted",
        version: 5,
        idempotent: false,
      });
    }));

    await expect(mutateSourceRecord(sourceRecord, "adopt", { targetProjectId: "project-1" }))
      .resolves.toMatchObject({ disposition: "adopted", targetTaskId: "work-2" });

    expect(requests).toHaveLength(2);
    expect(requests.map(requestPath)).toEqual([
      "/api/source-records/source-1/adopt",
      "/api/source-records/source-1/adopt",
    ]);
    expect(requests.map(requestBody)).toEqual([
      { version: 4, targetProjectId: "project-1" },
      { version: 4, targetProjectId: "project-1" },
    ]);
    expect(idempotencyKey(requests[0]!)).toMatch(/^source-record-adopt-/);
    expect(idempotencyKey(requests[1]!)).toBe(idempotencyKey(requests[0]!));
  });

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

  it("uses actions, human evidence, and a transition to complete an issue", async () => {
    const requests: RecordedRequest[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = { input, init };
      requests.push(request);
      if (requestPath(request).endsWith("/transitions") && (init?.method ?? "GET") === "GET") {
        return jsonResponse({ actions: [completionAction] });
      }
      if (requestPath(request).endsWith("/evidence")) {
        return jsonResponse({ evidence: acceptanceEvidence }, 201);
      }
      return jsonResponse({ task: { ...task, status: "done", stageId: "done", version: 13 } });
    }));

    const moved = await moveTask(task, "done", 40, "done");

    expect(moved.status).toBe("done");
    expect(requests.map(requestPath)).toEqual([
      "/api/tasks/task-1/transitions",
      "/api/tasks/task-1/evidence",
      "/api/tasks/task-1/transitions",
    ]);
    expect(requestBody(requests[1]!)).toEqual({
      expectedStateVersion: 12,
      actionKey: "complete-review",
    });
    expect(requestBody(requests[2]!)).toEqual({
      expectedStateVersion: 12,
      actionKey: "complete-review",
      gateEvidence: [acceptanceEvidence],
      sortOrder: 40,
    });
    expect(idempotencyKey(requests[1]!)).toMatch(/^task-evidence-/);
    expect(idempotencyKey(requests[2]!)).toMatch(/^task-transition-/);
    expect(idempotencyKey(requests[1]!)).not.toBe(idempotencyKey(requests[2]!));
  });

  it("retries uncertain idempotent writes with the same keys", async () => {
    const requests: RecordedRequest[] = [];
    let evidenceAttempts = 0;
    let transitionAttempts = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = { input, init };
      requests.push(request);
      const pathname = requestPath(request);
      if (pathname.endsWith("/transitions") && (init?.method ?? "GET") === "GET") {
        return jsonResponse({ actions: [completionAction] });
      }
      if (pathname.endsWith("/evidence")) {
        evidenceAttempts += 1;
        if (evidenceAttempts === 1) throw new TypeError("connection reset after write");
        return jsonResponse({ evidence: acceptanceEvidence }, 201);
      }
      transitionAttempts += 1;
      if (transitionAttempts === 1) throw new TypeError("connection reset after transition");
      return jsonResponse({ task: { ...task, status: "done", stageId: "done", version: 13 } });
    }));

    await expect(moveTask(task, "done", 40, "done")).resolves.toMatchObject({ status: "done" });

    const evidenceRequests = requests.filter((request) => requestPath(request).endsWith("/evidence"));
    const transitionRequests = requests.filter((request) => (
      requestPath(request).endsWith("/transitions") && request.init?.method === "POST"
    ));
    expect(evidenceRequests).toHaveLength(2);
    expect(transitionRequests).toHaveLength(2);
    expect(idempotencyKey(evidenceRequests[0]!)).toBe(idempotencyKey(evidenceRequests[1]!));
    expect(idempotencyKey(transitionRequests[0]!)).toBe(idempotencyKey(transitionRequests[1]!));
  });

  it("preserves the reorder-only /move path without bypassing a stage transition", async () => {
    const requests = mockFetch();

    await moveTask(task, "in_review", 22, "review");

    expect(requests).toHaveLength(1);
    expect(requestPath(requests[0]!)).toBe("/api/tasks/task-1/move");
    expect(requestBody(requests[0]!)).toEqual({
      version: 12,
      status: "in_review",
      stageId: "review",
      sortOrder: 22,
    });
  });

  it("surfaces a transition version conflict without retrying the write", async () => {
    const requests: RecordedRequest[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = { input, init };
      requests.push(request);
      if (requestPath(request).endsWith("/transitions") && (init?.method ?? "GET") === "GET") {
        return jsonResponse({ actions: [completionAction] });
      }
      if (requestPath(request).endsWith("/evidence")) {
        return jsonResponse({ evidence: acceptanceEvidence }, 201);
      }
      return jsonResponse({
        error: { code: "EXPECTED_STATE_CONFLICT", message: "Task changed" },
      }, 409);
    }));

    await expect(moveTask(task, "done", 40, "done")).rejects.toMatchObject({
      code: "EXPECTED_STATE_CONFLICT",
      status: 409,
    });
    expect(requests.filter((request) => request.init?.method === "POST")).toHaveLength(2);
  });

  it("recognizes an Access redirect before attempting a mutation", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, {
      status: 302,
      headers: { Location: "https://login.example.test/" },
    })));

    await expect(moveTask(task, "done", 40, "done")).rejects.toMatchObject({
      code: "ACCESS_AUTHENTICATION_REQUIRED",
      status: 401,
    });
  });
});

describe("task mutation failures", () => {
  it("keeps business blockers separate from service availability", () => {
    const blocker = new ApiError(409, {
      error: {
        code: "REQUIRED_DESCENDANT_INCOMPLETE",
        message: "Required descendants remain open",
        details: { taskIds: ["child-1", "child-2"] },
      },
    });

    expect(classifyTaskMutationFailure(blocker)).toEqual({
      kind: "blocker",
      taskIds: ["child-1", "child-2"],
    });
    expect(classifyTaskMutationFailure(new ApiError(401, {
      error: { code: "ACCESS_AUTHENTICATION_REQUIRED" },
    }))).toEqual({ kind: "authentication" });
    expect(classifyTaskMutationFailure(new ApiError(403, {
      error: { code: "HUMAN_ACTOR_REQUIRED" },
    }))).toEqual({ kind: "authentication" });
    expect(classifyTaskMutationFailure(new ApiError(409, {
      error: { code: "EXPECTED_STATE_CONFLICT" },
    }))).toEqual({ kind: "conflict" });
    expect(classifyTaskMutationFailure(new ApiError(0, {
      error: { code: "SERVICE_UNAVAILABLE" },
    }))).toEqual({ kind: "unavailable" });
    expect(classifyTaskMutationFailure(new ApiError(409, {
      error: { code: "ACTION_NOT_FOUND" },
    }))).toEqual({ kind: "other" });
  });
});
