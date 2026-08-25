import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { useEffect, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Task, WorkflowStage } from "../types";

const gantt = vi.hoisted(() => {
  let container: HTMLElement | null = null;
  let scroll = { x: 0, y: 0 };
  const tasks = new Map<string, Record<string, unknown>>();
  const config: Record<string, unknown> = { columns: [], show_grid: true, grid_width: 360 };
  const paint = () => {
    if (!container) return;
    let output = container.querySelector<HTMLElement>("[data-testid='gantt-rendered-groups']");
    if (!output) {
      output = document.createElement("output");
      output.dataset.testid = "gantt-rendered-groups";
      container.append(output);
    }
    output.textContent = [...tasks.values()]
      .filter((task) => task.taskboardGroup)
      .map((task) => task.taskboardTitle)
      .join(" | ");
  };
  const instance = {
    config,
    templates: {} as Record<string, unknown>,
    ext: { zoom: { init: vi.fn(), setLevel: vi.fn() } },
    event: vi.fn(),
    attachEvent: vi.fn(),
    init: vi.fn((node: HTMLElement) => { container = node; }),
    destructor: vi.fn(),
    getScrollState: vi.fn(() => ({ ...scroll })),
    isTaskExists: vi.fn((id: string) => tasks.has(id)),
    getTask: vi.fn((id: string) => tasks.get(id)),
    refreshData: vi.fn(),
    render: vi.fn(paint),
    clearAll: vi.fn(() => tasks.clear()),
    parse: vi.fn(({ data }: { data: Array<Record<string, unknown>> }) => {
      tasks.clear();
      data.forEach((task) => tasks.set(String(task.id), { ...task, $open: task.open }));
      paint();
    }),
    dateFromPos: vi.fn(() => new Date("2026-08-24T00:00:00")),
    posFromDate: vi.fn(() => 0),
    showDate: vi.fn(),
    scrollTo: vi.fn((x: number, y: number) => { scroll = { x, y }; }),
    setSizes: vi.fn(),
  };
  return {
    instance,
    reset() {
      container = null;
      scroll = { x: 0, y: 0 };
      tasks.clear();
      Object.assign(config, { columns: [], show_grid: true, grid_width: 360 });
      vi.clearAllMocks();
    },
  };
});

vi.mock("dhtmlx-gantt", () => ({
  Gantt: { getGanttInstance: () => gantt.instance },
}));

import { GanttView } from "./GanttView";

const emptyPresentations = {};
const noop = () => {};

function task(id: string, title: string, stageId: string): Task {
  return {
    id,
    identifier: id,
    projectId: "project-1",
    title,
    description: "",
    status: "todo",
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
    activityKey: id,
    activityUpdatedAt: "2026-08-24T00:00:00.000Z",
    creatorType: "user",
    creatorId: "user",
    creatorName: "User",
    creatorAvatarUrl: null,
    assignee: { type: "user", id: "user", name: "User", avatarUrl: null },
    developmentContext: null,
    startDate: null,
    dueDate: null,
    recurrence: null,
    source: "local",
    externalUrl: null,
    archivedAt: null,
    relations: { parent: null, subIssues: [], blockedBy: [], blocks: [], related: [] },
    version: 1,
    createdAt: "2026-08-24T00:00:00.000Z",
    updatedAt: "2026-08-24T00:00:00.000Z",
  };
}

const workflowStages: WorkflowStage[] = [
  {
    stageId: "stage-9",
    canonicalStatus: "todo",
    name: "Stage 9",
    order: 8,
    boardVisible: true,
    active: true,
    isDefaultForStatus: false,
    terminalKind: "none",
  },
  {
    stageId: "stage-14",
    canonicalStatus: "todo",
    name: "Stage 14",
    order: 13,
    boardVisible: true,
    active: true,
    isDefaultForStatus: false,
    terminalKind: "none",
  },
];

function DelayedWorkflowGantt({ workflow }: { workflow: Promise<WorkflowStage[]> }) {
  const [loadedStages, setLoadedStages] = useState<WorkflowStage[] | undefined>();
  useEffect(() => {
    void workflow.then(setLoadedStages);
  }, [workflow]);
  return (
    <GanttView
      tasks={[task("issue-9", "Card 9", "stage-9"), task("issue-14", "Card 14", "stage-14")]}
      presentations={emptyPresentations}
      hasActiveFilters={false}
      zoom="week"
      hideCompleted={false}
      todayRequest={0}
      workflowStages={loadedStages}
      onOpenTask={noop}
      onUpdate={async (current) => current}
    />
  );
}

describe("GanttView workflow stages", () => {
  beforeEach(() => {
    class ResizeObserver {
      observe() {}
      disconnect() {}
    }
    vi.stubGlobal("ResizeObserver", ResizeObserver);
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    gantt.reset();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("repaints custom groups when a workflow arrives after the Gantt has mounted", async () => {
    let resolveWorkflow: (value: WorkflowStage[]) => void = () => {};
    const workflow = new Promise<WorkflowStage[]>((resolve) => { resolveWorkflow = resolve; });

    render(<DelayedWorkflowGantt workflow={workflow} />);
    await waitFor(() => expect(gantt.instance.parse).toHaveBeenCalled());

    resolveWorkflow(workflowStages);

    await waitFor(() => {
      const rendered = screen.getByTestId("gantt-rendered-groups").textContent;
      expect(rendered).toContain("Stage 9");
      expect(rendered).toContain("Stage 14");
    });
    expect(gantt.instance.parse).toHaveBeenLastCalledWith(expect.objectContaining({
      data: expect.arrayContaining([
        expect.objectContaining({ id: "gantt-group-stage-9", taskboardGroup: true }),
        expect.objectContaining({ id: "gantt-group-stage-14", taskboardGroup: true }),
      ]),
    }));
  });

  it("restores a virtualized 60-card Gantt viewport after parsing", async () => {
    const onRestoreViewport = vi.fn();
    const cards = Array.from({ length: 60 }, (_, index) => task(
      `issue-${index + 1}`,
      `Card ${index + 1}`,
      "todo",
    ));
    render(
      <GanttView
        tasks={cards}
        presentations={emptyPresentations}
        hasActiveFilters={false}
        zoom="week"
        hideCompleted={false}
        todayRequest={0}
        restoreViewport={{ x: 0, y: 3247 }}
        onRestoreViewport={onRestoreViewport}
        onOpenTask={noop}
        onUpdate={async (current) => current}
      />,
    );
    await waitFor(() => expect(gantt.instance.parse).toHaveBeenCalled());
    expect(gantt.instance.config.smart_rendering).toBe(true);
    expect(gantt.instance.scrollTo).toHaveBeenCalledWith(0, 3247);
    expect(gantt.instance.getScrollState()).toEqual({ x: 0, y: 3247 });
    expect(onRestoreViewport).toHaveBeenCalledOnce();
  });
});
