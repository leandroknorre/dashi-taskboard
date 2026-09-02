import { useEffect, useState } from "react";
import {
  ApiError,
  getWorkflowAuthoring,
  publishWorkflowAuthoring,
  validateWorkflowAuthoring,
} from "../api";
import { taskStatusLabel, useTaskboardI18n } from "../i18n";
import {
  TASK_STATUSES,
  type TaskStatus,
  type WorkflowAuthoringDefinition,
  type WorkflowAuthoringRecord,
  type WorkflowAuthoringStage,
} from "../types";

type DraftWorkflowStage = WorkflowAuthoringStage & { clientKey: string };

function draftStage(stage: WorkflowAuthoringStage): DraftWorkflowStage {
  return {
    ...stage,
    clientKey: stage.stageId ?? crypto.randomUUID(),
  };
}

function newStage(order: number): DraftWorkflowStage {
  return {
    clientKey: crypto.randomUUID(),
    stageId: null,
    canonicalStatus: "todo",
    name: "New stage",
    boardVisible: true,
    order,
    active: true,
    isDefaultForStatus: false,
    terminalKind: "none",
  };
}

function normalized(stages: DraftWorkflowStage[]): WorkflowAuthoringDefinition {
  return {
    schemaVersion: 2,
    stages: stages.map(({ clientKey: _clientKey, ...stage }, order) => ({
      ...stage,
      name: stage.name.trim() || "Untitled stage",
      order,
      terminalKind: stage.canonicalStatus === "done"
        ? "done" as const
        : stage.canonicalStatus === "canceled"
          ? "canceled" as const
          : "none" as const,
    })),
  };
}

export function BoardWorkflowDialog({
  projectId,
  onClose,
  onSaved,
}: {
  projectId: string;
  onClose: () => void;
  onSaved: (workflow: WorkflowAuthoringRecord) => void;
}) {
  const { language, text } = useTaskboardI18n();
  const [record, setRecord] = useState<WorkflowAuthoringRecord | null>(null);
  const [stages, setStages] = useState<DraftWorkflowStage[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    void getWorkflowAuthoring(projectId, controller.signal).then((workflow) => {
      if (controller.signal.aborted) return;
      setRecord(workflow);
      setStages(workflow.definition.stages.map(draftStage));
    }).catch((cause) => {
      if (!controller.signal.aborted) {
        setError(cause instanceof Error ? cause.message : text(
          "无法加载流程。",
          "Could not load the workflow.",
        ));
      }
    });
    return () => controller.abort();
  }, [projectId, text]);

  const dirty = record !== null && (
    record.revisionId === null
    || JSON.stringify(normalized(stages)) !== JSON.stringify(record.definition)
  );
  const reorder = (next: DraftWorkflowStage[]) => setStages(next.map((stage, order) => ({
    ...stage,
    order,
  })));
  const move = (index: number, offset: -1 | 1) => {
    const destination = index + offset;
    if (destination < 0 || destination >= stages.length) return;
    const next = [...stages];
    [next[index], next[destination]] = [next[destination]!, next[index]!];
    reorder(next);
  };
  const updateStage = (clientKey: string, changes: Partial<WorkflowAuthoringStage>) => {
    setStages((current) => current.map((stage) => (
      stage.clientKey === clientKey ? { ...stage, ...changes } : stage
    )));
  };
  const remove = (clientKey: string) => {
    reorder(stages.filter((stage) => stage.clientKey !== clientKey));
  };
  const save = async () => {
    if (!record || !dirty || saving) return;
    const definition = normalized(stages);
    setSaving(true);
    setError(null);
    try {
      await validateWorkflowAuthoring(projectId, record.revisionId, definition);
      const workflow = await publishWorkflowAuthoring(
        projectId,
        record.revisionId,
        definition,
      );
      setRecord(workflow);
      setStages(workflow.definition.stages.map(draftStage));
      onSaved(workflow);
    } catch (cause) {
      if (cause instanceof ApiError && (
        cause.code === "WORKFLOW_REVISION_CONFLICT"
        || cause.code === "VERSION_CONFLICT"
        || cause.code === "STATE_CONFLICT"
      )) {
        setError(text(
          "流程已在其他位置更新。关闭此窗口并重新打开后再试。",
          "This workflow changed elsewhere. Close and reopen the editor before trying again.",
        ));
      } else if (cause instanceof ApiError && cause.code === "PROJECT_ARCHIVED") {
        setError(text(
          "已归档项目不能发布新流程。",
          "Archived projects cannot publish a new workflow.",
        ));
      } else {
        setError(cause instanceof Error ? cause.message : text(
          "无法发布流程。",
          "Could not publish the workflow.",
        ));
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="delete-backdrop board-workflow-backdrop" onPointerDown={(event) => {
      if (event.target === event.currentTarget && !saving) onClose();
    }}>
      <section className="delete-dialog board-workflow-dialog" role="dialog" aria-modal="true" aria-labelledby="board-workflow-title">
        <header className="board-workflow-header">
          <div>
            <h2 id="board-workflow-title">{text("配置阶段", "Configure stages")}</h2>
            <p>{text("添加、重命名、重新排序、隐藏或删除此项目的阶段。", "Add, rename, reorder, hide, or remove this project's stages.")}</p>
            {record && (
              <p className="board-workflow-revision">
                {record.revisionId === null
                  ? text("尚未发布流程", "No workflow revision published yet")
                  : text(`当前版本 ${record.revision}`, `Current revision ${record.revision}`)}
              </p>
            )}
          </div>
          <button className="dialog-close" type="button" disabled={saving} onClick={onClose} aria-label={text("关闭", "Close")}>×</button>
        </header>
        <main className="board-workflow-body">
          {!record && !error && <p>{text("正在加载流程…", "Loading workflow…")}</p>}
          <div className="board-workflow-preview" aria-label={text("阶段预览", "Stage preview")}>
            {stages.filter((stage) => stage.active && stage.boardVisible).map((stage) => <span key={stage.clientKey}>{stage.name}</span>)}
          </div>
          <button
            className="button secondary board-workflow-add"
            type="button"
            disabled={!record || saving}
            onClick={() => reorder([...stages, newStage(stages.length)])}
          >
            {text("添加阶段", "Add stage")}
          </button>
          <div className="board-workflow-stages" aria-label={text("流程阶段", "Workflow stages")}>
            {stages.map((stage, index) => (
              <div className="board-workflow-stage board-workflow-stage-v2" key={stage.clientKey}>
                <div className="board-workflow-stage-order">
                  <button type="button" disabled={saving || index === 0} onClick={() => move(index, -1)} aria-label={text("上移", "Move up")}>↑</button>
                  <button type="button" disabled={saving || index === stages.length - 1} onClick={() => move(index, 1)} aria-label={text("下移", "Move down")}>↓</button>
                </div>
                <label className="board-workflow-stage-label">
                  <input
                    value={stage.name}
                    maxLength={120}
                    disabled={saving}
                    aria-label={text("阶段名称", "Stage name")}
                    onChange={(event) => updateStage(stage.clientKey, { name: event.target.value })}
                  />
                  <select
                    value={stage.canonicalStatus}
                    disabled={saving || stage.isDefaultForStatus}
                    aria-label={text("兼容状态", "Compatibility status")}
                    onChange={(event) => updateStage(stage.clientKey, {
                      canonicalStatus: event.target.value as TaskStatus,
                    })}
                  >
                    {TASK_STATUSES.map((status) => <option key={status} value={status}>{taskStatusLabel(language, status)}</option>)}
                  </select>
                </label>
                <label className="board-workflow-visibility">
                  <input
                    type="checkbox"
                    checked={stage.boardVisible}
                    disabled={saving}
                    onChange={(event) => updateStage(stage.clientKey, { boardVisible: event.target.checked })}
                  />
                  <span>{text("显示", "Show")}</span>
                </label>
                <button
                  className="board-workflow-remove"
                  type="button"
                  disabled={saving || stage.isDefaultForStatus}
                  onClick={() => remove(stage.clientKey)}
                >
                  {text("移除", "Remove")}
                </button>
              </div>
            ))}
          </div>
          {record && record.legacyOccupiedStages.length > 0 && (
            <section className="board-workflow-legacy" aria-label={text("旧版占用阶段", "Occupied legacy stages")}>
              <h3>{text("旧版占用阶段", "Occupied legacy stages")}</h3>
              <p>{text(
                "这些阶段仍包含旧版本卡片。它们只读，卡片流转后会自动消失。",
                "These stages still contain cards pinned to older revisions. They are read-only and disappear after those cards move on.",
              )}</p>
              <div>
                {record.legacyOccupiedStages.map((stage) => (
                  <span key={stage.stageId}>
                    {stage.name} · {stage.taskCount}
                    <small>{text("旧版", "Legacy")}</small>
                  </span>
                ))}
              </div>
            </section>
          )}
          {error && <p className="project-dialog-error" role="alert">{error}</p>}
        </main>
        <footer className="board-workflow-actions">
          <button className="button secondary" type="button" disabled={saving} onClick={onClose}>{text("取消", "Cancel")}</button>
          <button className="button primary" type="button" disabled={!dirty || saving} onClick={() => void save()}>{saving ? text("发布中…", "Publishing…") : text("发布新版本", "Publish new revision")}</button>
        </footer>
      </section>
    </div>
  );
}
