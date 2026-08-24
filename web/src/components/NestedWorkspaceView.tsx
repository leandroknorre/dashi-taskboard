import type { CSSProperties } from "react";
import type { NestedWorkspace, NestedWorkspaceItem, TaskRollup } from "../types";
import type { WorkspaceView } from "../issueRoute";
import { useTaskboardI18n } from "../i18n";
import { StatusIcon } from "./SemanticIcons";

interface NestedWorkspaceViewProps {
  workspace: NestedWorkspace;
  rollup: TaskRollup | null;
  view: WorkspaceView;
  descendants: boolean;
  loadingMore: boolean;
  onViewChange: (view: WorkspaceView) => void;
  onDescendantsChange: (descendants: boolean) => void;
  onLoadMore: () => void;
  onOpenTask: (item: Pick<NestedWorkspaceItem, "identifier" | "projectId">) => void;
  onOpenWorkspace: (identifier: string) => void;
}

const MACRO_BUCKET_LABELS: Record<NestedWorkspaceItem["macroBucket"], string> = {
  planned: "Planned",
  ready: "Ready",
  active: "Active",
  review: "Review",
  blocked: "Blocked",
  closed: "Closed",
};

function StatusChip({ item }: { item: Pick<NestedWorkspaceItem, "status" | "macroBucket"> }) {
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
}: {
  item: NestedWorkspaceItem;
  onOpenTask: NestedWorkspaceViewProps["onOpenTask"];
}) {
  return (
    <button className="nested-workspace-item" type="button" onClick={() => onOpenTask(item)}>
      <span className="nested-workspace-item-copy">
        <small>{item.identifier}</small>
        <strong>{item.title}</strong>
      </span>
      <StatusChip item={item} />
    </button>
  );
}

function WorkspaceOverview({ workspace, rollup }: Pick<NestedWorkspaceViewProps, "workspace" | "rollup">) {
  const { text } = useTaskboardI18n();
  const root = workspace.overview;
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
        ) : <p>{text("正在读取汇总…", "Loading rollup…")}</p>}
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
        ) : <p>{text("尚无来源信息。", "No provenance available.")}</p>}
      </section>
    </div>
  );
}

function WorkspaceBoard({ items, onOpenTask }: { items: NestedWorkspaceItem[]; onOpenTask: NestedWorkspaceViewProps["onOpenTask"] }) {
  return (
    <div className="nested-workspace-board">
      {(Object.keys(MACRO_BUCKET_LABELS) as NestedWorkspaceItem["macroBucket"][]).map((bucket) => {
        const bucketItems = items.filter((item) => item.macroBucket === bucket);
        if (!bucketItems.length) return null;
        return (
          <section className="nested-workspace-column" key={bucket}>
            <h2>{MACRO_BUCKET_LABELS[bucket]} <small>{bucketItems.length}</small></h2>
            <div>{bucketItems.map((item) => <WorkspaceItemButton item={item} key={item.id} onOpenTask={onOpenTask} />)}</div>
          </section>
        );
      })}
    </div>
  );
}

function WorkspaceList({ items, onOpenTask }: { items: NestedWorkspaceItem[]; onOpenTask: NestedWorkspaceViewProps["onOpenTask"] }) {
  return <div className="nested-workspace-list">{items.map((item) => <WorkspaceItemButton item={item} key={item.id} onOpenTask={onOpenTask} />)}</div>;
}

function WorkspaceTree({ items, onOpenTask }: { items: NestedWorkspaceItem[]; onOpenTask: NestedWorkspaceViewProps["onOpenTask"] }) {
  return (
    <div className="nested-workspace-tree">
      {items.map((item) => (
        <div className="nested-workspace-tree-node" style={{ "--nested-depth": item.depth } as CSSProperties} key={item.id}>
          <WorkspaceItemButton item={item} onOpenTask={onOpenTask} />
        </div>
      ))}
    </div>
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
  onOpenWorkspace,
}: NestedWorkspaceViewProps) {
  const { text } = useTaskboardI18n();
  const page = descendants ? workspace.descendants ?? workspace.children : workspace.children;
  const items = page.items;
  const root = workspace.overview;
  return (
    <div className="nested-workspace-view">
      <nav className="nested-workspace-breadcrumb" aria-label={text("工作区层级", "Workspace hierarchy")}>
        {workspace.breadcrumb.map((item, index) => (
          <span key={item.id}>
            {index > 0 && <i aria-hidden="true">/</i>}
            <button type="button" onClick={() => onOpenWorkspace(item.identifier)}>{item.title}</button>
          </span>
        ))}
      </nav>

      <button className="nested-workspace-super-card" type="button" onClick={() => onOpenTask(root)}>
        <span><small>{root.identifier}</small><strong>{root.title}</strong></span>
        <StatusChip item={root} />
      </button>

      <div className="nested-workspace-toolbar">
        <div className="view-tabs" aria-label={text("工作区视图", "Workspace views")}>
          {(["overview", "board", "list", "tree"] as const).map((candidate) => (
            <button className={`view-tab${view === candidate ? " active" : ""}`} type="button" key={candidate} onClick={() => onViewChange(candidate)}>
              {candidate[0].toUpperCase() + candidate.slice(1)}
            </button>
          ))}
        </div>
        {view !== "overview" && (
          <label className="nested-workspace-descendants-toggle">
            <input type="checkbox" checked={descendants} onChange={(event) => onDescendantsChange(event.target.checked)} />
            {text("全部后代", "All descendants")}
          </label>
        )}
      </div>

      {view === "overview" ? <WorkspaceOverview workspace={workspace} rollup={rollup} />
        : items.length === 0 ? <p className="nested-workspace-empty">{text("没有可显示的子项。", "No child items to show.")}</p>
        : view === "board" ? <WorkspaceBoard items={items} onOpenTask={onOpenTask} />
        : view === "list" ? <WorkspaceList items={items} onOpenTask={onOpenTask} />
        : <WorkspaceTree items={items} onOpenTask={onOpenTask} />}

      {view !== "overview" && page.nextCursor && (
        <button className="button secondary nested-workspace-load-more" type="button" disabled={loadingMore} onClick={onLoadMore}>
          {loadingMore ? text("正在加载…", "Loading…") : text("加载更多", "Load more")}
        </button>
      )}
    </div>
  );
}
