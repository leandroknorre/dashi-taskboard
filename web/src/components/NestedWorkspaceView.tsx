import { useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent, type ReactNode, type WheelEvent } from "react";
import { isSourceRecord, type NestedWorkspaceItem, type TaskRollup } from "../types";
import type { WorkspaceRootExtra, WorkspaceView } from "../issueRoute";
import type { WorkspaceDescriptor, WorkspaceNavigationTarget, WorkspaceRoot } from "../workspaceDescriptor";
import { useTaskboardI18n } from "../i18n";
import { StatusIcon } from "./SemanticIcons";
import { SourceRecordBadge } from "./SourceRecordBadge";

interface NestedWorkspaceViewProps {
  workspace: WorkspaceDescriptor;
  rollup: TaskRollup | null;
  view: WorkspaceView;
  descendants: boolean;
  loadingMore: boolean;
  onViewChange: (view: WorkspaceView) => void;
  onDescendantsChange: (descendants: boolean) => void;
  onLoadMore: () => void;
  onOpenTask: (item: Pick<NestedWorkspaceItem, "identifier" | "projectId">) => void;
  onOpenTaskDetail: (item: Pick<NestedWorkspaceItem, "identifier" | "projectId">) => void;
  onOpenWorkspace: (target: WorkspaceNavigationTarget) => void;
  /** Deliberate root-only extras such as the legacy Gantt and project docs. */
  projectExtras?: ReadonlyArray<{ id: WorkspaceRootExtra; label: string }>;
  activeProjectExtra?: WorkspaceRootExtra | null;
  onProjectExtraChange?: (extra: WorkspaceRootExtra) => void;
  projectExtraContent?: ReactNode;
  /**
   * The project root is the one workspace whose Board is an operational
   * projection: physical workflow stages, draggable cards and per-rail
   * scrolling. Task workspaces deliberately retain the macro-bucket Board.
   */
  projectBoardContent?: ReactNode;
}

const MACRO_BUCKET_LABELS: Record<NestedWorkspaceItem["macroBucket"], string> = {
  planned: "Planned",
  ready: "Ready",
  active: "Active",
  review: "Review",
  blocked: "Blocked",
  closed: "Closed",
};

function StatusChip({ item }: { item: Pick<NestedWorkspaceItem, "status" | "macroBucket"> | WorkspaceRoot }) {
  if (!item.status || !item.macroBucket) return null;
  return (
    <span className={`nested-workspace-status status-${item.status}`} title={`Actual stage: ${item.status}`}>
      <StatusIcon status={item.status} size={13} color="currentColor" />
      {item.status.replace(/_/g, " ")}
    </span>
  );
}

function WorkspaceItemButton({
  item,
  onOpenTask,
  onOpenTaskDetail,
}: {
  item: NestedWorkspaceItem;
  onOpenTask: NestedWorkspaceViewProps["onOpenTask"];
  onOpenTaskDetail: NestedWorkspaceViewProps["onOpenTaskDetail"];
}) {
  const { text } = useTaskboardI18n();
  return (
    <div className="nested-workspace-item-wrap">
      <button className="nested-workspace-item" type="button" onClick={() => onOpenTask(item)}>
        <span className="nested-workspace-item-copy">
          <small>{item.identifier}</small>
          <strong>{item.title}</strong>
          {isSourceRecord(item) && <SourceRecordBadge item={item} compact />}
        </span>
        <StatusChip item={item} />
      </button>
      <button
        className="nested-workspace-item-detail"
        type="button"
        aria-label={text(`打开 ${item.identifier} 详情`, `Open details ${item.identifier}`)}
        onClick={() => onOpenTaskDetail(item)}
      >
        {text("详情", "Details")}
      </button>
    </div>
  );
}

function WorkspaceOverview({ workspace, rollup }: Pick<NestedWorkspaceViewProps, "workspace" | "rollup">) {
  const { text } = useTaskboardI18n();
  const root = workspace.root;
  const sourceCount = rollup?.provenance.sourceTaskIds.length ?? 0;
  return (
    <div className="nested-workspace-overview">
      <section>
        <h2>{text("手动目的", "Manual purpose")}</h2>
        <p>{root.description.trim() || text("尚未记录手动目的。", "No manual purpose has been recorded.")}</p>
      </section>
      <section>
        <h2>{text("汇总", "Rollup")}</h2>
        {rollup ? (
          <dl className="nested-workspace-facts">
            <div><dt>{text("手动阶段", "Manual stage")}</dt><dd>{rollup.stage.replace(/_/g, " ")}</dd></div>
            <div><dt>{text("完成", "Completed")}</dt><dd>{rollup.progress.completed}/{rollup.progress.total}</dd></div>
            <div><dt>{text("视觉状态", "Visual state")}</dt><dd>{rollup.visual.state}</dd></div>
          </dl>
        ) : <p>{workspace.kind === "project"
          ? text("项目根目录没有任务汇总。", "A project root has no task rollup.")
          : text("正在读取汇总…", "Loading rollup…")}</p>}
      </section>
      <section>
        <h2>{text("来源与新鲜度", "Narrative provenance & freshness")}</h2>
        {rollup ? (
          <p>
            {text("由", "Derived from ")}<strong>{sourceCount}</strong>{text(" 个结构性子项。", " structural descendant(s).")}
            {rollup.freshness.stale
              ? <em className="nested-workspace-stale"> {text("数据可能过期。", "This read model may be stale.")}</em>
              : <span> {text("数据是最新的。", "Fresh at read time.")}</span>}
          </p>
        ) : <p>{workspace.kind === "project"
          ? text("项目根目录没有任务来源信息。", "A project root has no task provenance.")
          : text("尚无来源信息。", "No provenance available.")}</p>}
      </section>
    </div>
  );
}

function WorkspaceBoard({
  items,
  onOpenTask,
  onOpenTaskDetail,
}: {
  items: NestedWorkspaceItem[];
  onOpenTask: NestedWorkspaceViewProps["onOpenTask"];
  onOpenTaskDetail: NestedWorkspaceViewProps["onOpenTaskDetail"];
}) {
  return (
    <div className="nested-workspace-board">
      {(Object.keys(MACRO_BUCKET_LABELS) as NestedWorkspaceItem["macroBucket"][]).map((bucket) => {
        const bucketItems = items.filter((item) => item.macroBucket === bucket);
        if (!bucketItems.length) return null;
        return (
          <section className="nested-workspace-column" key={bucket}>
            <h2>{MACRO_BUCKET_LABELS[bucket]} <small>{bucketItems.length}</small></h2>
            <div>{bucketItems.map((item) => <WorkspaceItemButton item={item} key={item.id} onOpenTask={onOpenTask} onOpenTaskDetail={onOpenTaskDetail} />)}</div>
          </section>
        );
      })}
    </div>
  );
}

function WorkspaceList({
  items,
  onOpenTask,
  onOpenTaskDetail,
}: {
  items: NestedWorkspaceItem[];
  onOpenTask: NestedWorkspaceViewProps["onOpenTask"];
  onOpenTaskDetail: NestedWorkspaceViewProps["onOpenTaskDetail"];
}) {
  return <div className="nested-workspace-list">{items.map((item) => <WorkspaceItemButton item={item} key={item.id} onOpenTask={onOpenTask} onOpenTaskDetail={onOpenTaskDetail} />)}</div>;
}

function WorkspaceTree({
  items,
  onOpenTask,
  onOpenTaskDetail,
}: {
  items: NestedWorkspaceItem[];
  onOpenTask: NestedWorkspaceViewProps["onOpenTask"];
  onOpenTaskDetail: NestedWorkspaceViewProps["onOpenTaskDetail"];
}) {
  return (
    <div className="nested-workspace-tree">
      {items.map((item) => (
        <div className="nested-workspace-tree-node" style={{ "--nested-depth": item.depth } as CSSProperties} key={item.id}>
          <WorkspaceItemButton item={item} onOpenTask={onOpenTask} onOpenTaskDetail={onOpenTaskDetail} />
        </div>
      ))}
    </div>
  );
}

type MindMapNode = Omit<Pick<NestedWorkspaceItem, "id" | "identifier" | "projectId" | "title" | "status" | "macroBucket" | "parentId" | "depth" | "path" | "kind" | "readOnly" | "sourceSystem" | "externalVersion">, "status" | "macroBucket"> & {
  status: NestedWorkspaceItem["status"] | null;
  macroBucket: NestedWorkspaceItem["macroBucket"] | null;
  target: WorkspaceNavigationTarget | null;
};

function WorkspaceMindMap({
  workspace,
  items,
  onOpenTask,
  onOpenWorkspace,
}: Pick<NestedWorkspaceViewProps, "workspace" | "onOpenTask" | "onOpenWorkspace"> & { items: NestedWorkspaceItem[] }) {
  const { text } = useTaskboardI18n();
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 24, y: 24 });
  const drag = useRef<{ x: number; y: number; panX: number; panY: number } | null>(null);
  const root: MindMapNode = useMemo(() => ({
    id: workspace.root.id,
    identifier: workspace.root.identifier ?? text("项目", "Project"),
    projectId: workspace.root.projectId,
    title: workspace.root.title,
    status: workspace.root.status,
    macroBucket: workspace.root.macroBucket,
    parentId: null,
    depth: 0,
    path: [workspace.root.id],
    kind: workspace.root.kind,
    readOnly: workspace.root.readOnly,
    sourceSystem: workspace.root.sourceSystem,
    externalVersion: workspace.root.externalVersion,
    target: workspace.root.target,
  }), [text, workspace.root]);
  const nodes = useMemo(() => [
    root,
    ...items.filter((item) => item.id !== root.id).map((item) => ({ ...item, target: null })),
  ], [items, root]);
  const layout = useMemo(() => {
    const positions = new Map<string, { x: number; y: number }>();
    nodes.forEach((node, index) => positions.set(node.id, { x: node.depth * 236, y: index * 100 }));
    return positions;
  }, [nodes]);
  const canvasWidth = Math.max(640, ...nodes.map((node) => (layout.get(node.id)?.x ?? 0) + 220));
  const canvasHeight = Math.max(220, nodes.length * 100);
  const setClampedZoom = (value: number) => setZoom(Math.min(2, Math.max(0.5, Number(value.toFixed(2)))));
  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    drag.current = { x: event.clientX, y: event.clientY, panX: pan.x, panY: pan.y };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    setPan({ x: drag.current.panX + event.clientX - drag.current.x, y: drag.current.panY + event.clientY - drag.current.y });
  };
  const endPointer = () => { drag.current = null; };
  const onWheel = (event: WheelEvent<HTMLDivElement>) => {
    event.preventDefault();
    setClampedZoom(zoom + (event.deltaY < 0 ? 0.1 : -0.1));
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = 36;
    if (event.key === "+" || event.key === "=") { event.preventDefault(); setClampedZoom(zoom + 0.1); }
    else if (event.key === "-") { event.preventDefault(); setClampedZoom(zoom - 0.1); }
    else if (event.key === "ArrowLeft") { event.preventDefault(); setPan((current) => ({ ...current, x: current.x + step })); }
    else if (event.key === "ArrowRight") { event.preventDefault(); setPan((current) => ({ ...current, x: current.x - step })); }
    else if (event.key === "ArrowUp") { event.preventDefault(); setPan((current) => ({ ...current, y: current.y + step })); }
    else if (event.key === "ArrowDown") { event.preventDefault(); setPan((current) => ({ ...current, y: current.y - step })); }
  };
  return (
    <section className="workspace-mindmap" aria-label={text("工作区思维导图", "Workspace mind map")}>
      <div className="workspace-projection-controls" aria-label={text("思维导图控制", "Mind map controls")}>
        <button type="button" onClick={() => setClampedZoom(zoom - 0.1)}>{text("缩小", "Zoom out")}</button>
        <output aria-live="polite">{Math.round(zoom * 100)}%</output>
        <button type="button" onClick={() => setClampedZoom(zoom + 0.1)}>{text("放大", "Zoom in")}</button>
        <button type="button" onClick={() => { setZoom(1); setPan({ x: 24, y: 24 }); }}>{text("重置", "Reset view")}</button>
      </div>
      <div
        className="workspace-mindmap-viewport"
        tabIndex={0}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endPointer}
        onPointerCancel={endPointer}
        onWheel={onWheel}
        onKeyDown={onKeyDown}
        aria-label={text("思维导图。使用箭头键平移，加号和减号缩放。", "Mind map. Use arrow keys to pan and plus or minus to zoom.")}
      >
        <div className="workspace-mindmap-canvas" style={{ width: canvasWidth, height: canvasHeight, transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})` }}>
          <svg className="workspace-mindmap-edges" width={canvasWidth} height={canvasHeight} aria-hidden="true">
            {nodes.filter((node) => node.id !== root.id).map((node) => {
              const child = layout.get(node.id)!;
              const parent = layout.get(nodes.some((candidate) => candidate.id === node.parentId) ? node.parentId! : root.id)!;
              return <path key={node.id} d={`M ${parent.x + 198} ${parent.y + 31} C ${parent.x + 216} ${parent.y + 31}, ${child.x - 18} ${child.y + 31}, ${child.x} ${child.y + 31}`} />;
            })}
          </svg>
          {nodes.map((node) => {
            const position = layout.get(node.id)!;
            const isRoot = node.id === root.id;
            return (
              <button
                className={`workspace-mindmap-node${isRoot ? " is-root" : ""}`}
                type="button"
                key={node.id}
                style={{ left: position.x, top: position.y }}
                onClick={() => {
                  if (isRoot) {
                    if (node.target) onOpenWorkspace(node.target);
                    return;
                  }
                  onOpenTask(node);
                }}
              >
                <small>{node.identifier}</small>
                <strong>{node.title}</strong>
                {isSourceRecord(node) && <SourceRecordBadge item={node} compact />}
                {node.status && node.macroBucket && <span>{node.status.replace(/_/g, " ")} · {MACRO_BUCKET_LABELS[node.macroBucket]}</span>}
              </button>
            );
          })}
        </div>
      </div>
    </section>
  );
}

type TimelineItem = NestedWorkspaceItem;
const TIMELINE_DATES: Array<[keyof Pick<TimelineItem, "startDate" | "dueDate" | "createdAt" | "updatedAt">, string]> = [
  ["startDate", "Start"], ["dueDate", "Due"], ["createdAt", "Created"], ["updatedAt", "Updated"],
];

function timelineDate(item: TimelineItem) {
  for (const [key, label] of TIMELINE_DATES) {
    const value = item[key];
    const date = value && /^\d{4}-\d{2}-\d{2}$/.test(value)
      ? new Date(`${value}T00:00:00`)
      : value ? new Date(value) : null;
    if (date && !Number.isNaN(date.getTime())) return { value, label, date, time: date.getTime() };
  }
  return null;
}

function WorkspaceTimeline({
  items,
  onOpenTask,
  onOpenTaskDetail,
}: {
  items: NestedWorkspaceItem[];
  onOpenTask: NestedWorkspaceViewProps["onOpenTask"];
  onOpenTaskDetail: NestedWorkspaceViewProps["onOpenTaskDetail"];
}) {
  const { locale, text } = useTaskboardI18n();
  const ordered = useMemo(() => [...items].sort((left, right) => {
    const leftDate = timelineDate(left);
    const rightDate = timelineDate(right);
    if (leftDate && rightDate && leftDate.time !== rightDate.time) return leftDate.time - rightDate.time;
    if (leftDate && !rightDate) return -1;
    if (!leftDate && rightDate) return 1;
    return left.identifier.localeCompare(right.identifier);
  }), [items]);
  const formatDate = (date: Date) => new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(date);
  return (
    <section className="workspace-timeline" aria-label={text("工作区时间线", "Workspace timeline")}>
      <p className="workspace-projection-note">{text("按开始、截止、创建、更新时间排序；未提供日期的项目仍会显示。", "Sorted by start, due, creation, then update time; undated items remain visible.")}</p>
      <ol>
        {ordered.map((item) => {
          const date = timelineDate(item);
          const scheduled = Boolean(item.startDate || item.dueDate);
          return (
            <li className={scheduled ? "" : "is-undated"} key={item.id}>
              <span className="workspace-timeline-marker" aria-hidden="true" />
              <div className="workspace-timeline-entry">
                <button type="button" onClick={() => onOpenTask(item)}>
                  <time dateTime={date?.value ?? undefined}>
                    {date ? `${date.label}: ${formatDate(date.date)}` : text("无日期", "No date")}
                    {!scheduled && ` · ${text("未安排日期", "No scheduled date")}`}
                  </time>
                  <span className="workspace-timeline-copy"><small>{item.identifier}</small><strong>{item.title}</strong></span>
                  {isSourceRecord(item) && <SourceRecordBadge item={item} compact />}
                  <StatusChip item={item} />
                  <span className="workspace-timeline-bucket">{MACRO_BUCKET_LABELS[item.macroBucket]}</span>
                </button>
                <button className="workspace-timeline-detail" type="button" aria-label={text(`打开 ${item.identifier} 详情`, `Open details ${item.identifier}`)} onClick={() => onOpenTaskDetail(item)}>{text("详情", "Details")}</button>
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

export function NestedWorkspaceView({
  workspace,
  rollup,
  view,
  descendants,
  loadingMore,
  onViewChange,
  onDescendantsChange,
  onLoadMore,
  onOpenTask,
  onOpenTaskDetail,
  onOpenWorkspace,
  projectExtras,
  activeProjectExtra = null,
  onProjectExtraChange,
  projectExtraContent,
  projectBoardContent,
}: NestedWorkspaceViewProps) {
  const { text } = useTaskboardI18n();
  const page = descendants ? workspace.descendants ?? workspace.children : workspace.children;
  const items = page.items;
  const hierarchyItems = workspace.hierarchy?.items ?? items;
  const root = workspace.root;
  const showingProjectExtra = workspace.kind === "project"
    && activeProjectExtra !== null
    && projectExtraContent !== undefined;
  const showingProjectBoard = workspace.kind === "project"
    && view === "board"
    && projectBoardContent !== undefined;
  const panelId = showingProjectExtra
    ? `nested-workspace-panel-extra-${activeProjectExtra}`
    : `nested-workspace-panel-${view}`;
  const panelLabel = showingProjectExtra
    ? `nested-workspace-extra-${activeProjectExtra}`
    : `nested-workspace-tab-${view}`;
  return (
    <div className="nested-workspace-view">
      <nav className="nested-workspace-breadcrumb" aria-label={text("工作区层级", "Workspace hierarchy")}>
        {workspace.breadcrumb.map((item, index) => (
          <span key={item.id}>
            {index > 0 && <i aria-hidden="true">/</i>}
            <button type="button" onClick={() => onOpenWorkspace(item.target)}>{item.title}</button>
          </span>
        ))}
      </nav>

      {root.target ? (
        <button
          className="nested-workspace-super-card"
          type="button"
          aria-label={text(`打开工作区 ${root.title}`, `Open workspace ${root.title}`)}
          onClick={() => onOpenWorkspace(root.target!)}
        >
          <span><small>{root.identifier}</small><strong>{root.title}</strong></span>
          <StatusChip item={root} />
        </button>
      ) : (
        <div className="nested-workspace-super-card is-project-root">
          <span><small>{text("项目", "Project")}</small><strong>{root.title}</strong></span>
        </div>
      )}

      <div className="nested-workspace-toolbar">
        <div className="view-tabs" role="tablist" aria-label={text("工作区视图", "Workspace views")}>
          {(["overview", "board", "list", "tree", "mindmap", "timeline"] as const).map((candidate) => (
            <button
              className={`view-tab${!showingProjectExtra && view === candidate ? " active" : ""}`}
              type="button"
              role="tab"
              aria-selected={!showingProjectExtra && view === candidate}
              aria-controls={`nested-workspace-panel-${candidate}`}
              id={`nested-workspace-tab-${candidate}`}
              key={candidate}
              onClick={() => onViewChange(candidate)}
            >
              {candidate === "mindmap" ? "Mind Map" : candidate[0].toUpperCase() + candidate.slice(1)}
            </button>
          ))}
          {workspace.kind === "project" && projectExtras?.map((extra) => (
            <button
              className={`view-tab workspace-extra-tab${activeProjectExtra === extra.id ? " active" : ""}`}
              type="button"
              role="tab"
              aria-selected={activeProjectExtra === extra.id}
              aria-controls={`nested-workspace-panel-extra-${extra.id}`}
              id={`nested-workspace-extra-${extra.id}`}
              key={extra.id}
              onClick={() => onProjectExtraChange?.(extra.id)}
            >
              {extra.label}
            </button>
          ))}
        </div>
        {!showingProjectExtra && view !== "overview" && (
          <label className="nested-workspace-descendants-toggle">
            <input type="checkbox" checked={descendants} onChange={(event) => onDescendantsChange(event.target.checked)} />
            {text("全部后代", "All descendants")}
          </label>
        )}
      </div>

      <div
        id={panelId}
        role="tabpanel"
        aria-labelledby={panelLabel}
      >
        {showingProjectExtra ? projectExtraContent
          : showingProjectBoard ? projectBoardContent
          : view === "overview" ? <WorkspaceOverview workspace={workspace} rollup={rollup} />
          : view === "mindmap" ? <WorkspaceMindMap workspace={workspace} items={hierarchyItems} onOpenTask={onOpenTask} onOpenWorkspace={onOpenWorkspace} />
          : items.length === 0 ? <p className="nested-workspace-empty">{text("没有可显示的子项。", "No child items to show.")}</p>
          : view === "board" ? <WorkspaceBoard items={items} onOpenTask={onOpenTask} onOpenTaskDetail={onOpenTaskDetail} />
          : view === "list" ? <WorkspaceList items={items} onOpenTask={onOpenTask} onOpenTaskDetail={onOpenTaskDetail} />
          : view === "tree" ? <WorkspaceTree items={hierarchyItems} onOpenTask={onOpenTask} onOpenTaskDetail={onOpenTaskDetail} />
          : <WorkspaceTimeline items={items} onOpenTask={onOpenTask} onOpenTaskDetail={onOpenTaskDetail} />}
      </div>

      {!showingProjectExtra && view !== "overview" && page.nextCursor && (
        <button className="button secondary nested-workspace-load-more" type="button" disabled={loadingMore} onClick={onLoadMore}>
          {loadingMore ? text("正在加载…", "Loading…") : text("加载更多", "Load more")}
        </button>
      )}
    </div>
  );
}
