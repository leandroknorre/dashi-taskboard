import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getWorkflowAuthoring,
  publishWorkflowAuthoring,
  renameProject,
  validateWorkflowAuthoring,
} from "./api";
import type {
  Project,
  WorkflowAuthoringDefinition,
  WorkflowAuthoringRecord,
} from "./types";

type RecordedRequest = { input: RequestInfo | URL; init?: RequestInit };

const definition: WorkflowAuthoringDefinition = {
  schemaVersion: 2,
  stages: [{
    stageId: "todo",
    canonicalStatus: "todo",
    name: "To do",
    order: 0,
    boardVisible: true,
    active: true,
    isDefaultForStatus: true,
    terminalKind: "none",
  }],
};

const workflow: WorkflowAuthoringRecord = {
  projectId: "project-1",
  workflowId: "project-1-workflow",
  revisionId: "11111111-1111-4111-8111-111111111111",
  revision: 1,
  definition,
  legacyOccupiedStages: [],
  projectUpdatedAt: "2026-09-01T22:00:00.000Z",
};

const project: Project = {
  id: "project-1",
  name: "Old name",
  workspacePath: null,
  source: "local",
  labels: [],
  issueCount: 0,
  archivedAt: null,
  version: 1,
  createdAt: "2026-09-01T21:00:00.000Z",
  updatedAt: "2026-09-01T22:00:00.000Z",
};

afterEach(() => vi.unstubAllGlobals());

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

describe("versioned workflow authoring API", () => {
  it("reads, validates, and publishes through the versioned contract without legacy PUT", async () => {
    const requests: RecordedRequest[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = { input, init };
      requests.push(request);
      const path = pathOf(request);
      if (path.endsWith("/validate")) {
        return json({ validation: {
          valid: true,
          projectId: "project-1",
          expectedRevisionId: workflow.revisionId,
          nextRevision: 2,
          definition,
          legacyOccupiedStages: [],
        } });
      }
      if (path.endsWith("/publish")) {
        return json({ workflow: { ...workflow, revision: 2 } }, 201);
      }
      return json({ workflow });
    }));

    await expect(getWorkflowAuthoring("project-1")).resolves.toEqual(workflow);
    await expect(validateWorkflowAuthoring("project-1", workflow.revisionId, definition))
      .resolves.toMatchObject({ valid: true, nextRevision: 2 });
    await expect(publishWorkflowAuthoring("project-1", workflow.revisionId, definition))
      .resolves.toMatchObject({ revision: 2 });

    expect(requests.map(pathOf)).toEqual([
      "/api/projects/project-1/workflow-authoring",
      "/api/projects/project-1/workflow-authoring/validate",
      "/api/projects/project-1/workflow-authoring/publish",
    ]);
    expect(requests.map((request) => request.init?.method ?? "GET")).toEqual([
      "GET",
      "POST",
      "POST",
    ]);
    expect(bodyOf(requests[1]!)).toEqual({
      expectedRevisionId: workflow.revisionId,
      definition,
    });
    expect(bodyOf(requests[2]!)).toEqual(bodyOf(requests[1]!));
    expect(requests.every((request) => !pathOf(request).endsWith("/stage-workflow"))).toBe(true);
  });

  it("sends project rename as a CAS PATCH keyed by updatedAt", async () => {
    const requests: RecordedRequest[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ input, init });
      return json({ project: { ...project, name: "New name", version: 2 } });
    }));

    await expect(renameProject(project, "New name")).resolves.toMatchObject({ name: "New name" });
    expect(pathOf(requests[0]!)).toBe("/api/projects/project-1");
    expect(requests[0]!.init?.method).toBe("PATCH");
    expect(bodyOf(requests[0]!)).toEqual({
      name: "New name",
      expectedUpdatedAt: project.updatedAt,
    });
  });
});
