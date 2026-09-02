import { describe, expect, it } from "vitest";
import type { WorkflowAuthoringRecord } from "./types";
import { workflowDisplayStages } from "./workflowAuthoring";

function workflow(): WorkflowAuthoringRecord {
  return {
    projectId: "project-1",
    workflowId: "project-1-workflow",
    revisionId: "11111111-1111-4111-8111-111111111111",
    revision: 2,
    definition: {
      schemaVersion: 2,
      stages: [
        {
          stageId: "current",
          canonicalStatus: "todo",
          name: "Current",
          order: 0,
          boardVisible: true,
          active: true,
          isDefaultForStatus: true,
          terminalKind: "none",
        },
        {
          stageId: null,
          canonicalStatus: "todo",
          name: "Draft not yet published",
          order: 1,
          boardVisible: true,
          active: true,
          isDefaultForStatus: false,
          terminalKind: "none",
        },
      ],
    },
    legacyOccupiedStages: [
      {
        stageId: "legacy",
        canonicalStatus: "in_review",
        name: "Legacy review",
        terminalKind: "none",
        taskCount: 3,
      },
      {
        stageId: "current",
        canonicalStatus: "todo",
        name: "Duplicate current",
        terminalKind: "none",
        taskCount: 1,
      },
    ],
    projectUpdatedAt: "2026-09-01T22:00:00.000Z",
  };
}

describe("workflow display stages", () => {
  it("combines current and occupied legacy stages once while excluding unpublished null ids", () => {
    expect(workflowDisplayStages(workflow())).toEqual([
      expect.objectContaining({ stageId: "current", legacy: false }),
      expect.objectContaining({
        stageId: "legacy",
        legacy: true,
        active: false,
        boardVisible: true,
        issueCount: 3,
      }),
    ]);
  });
});
