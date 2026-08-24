import { useEffect, useMemo, useState } from "react";
import { getStageWorkflow, saveStageWorkflow } from "../api";
import { taskStatusLabel, useTaskboardI18n } from "../i18n";
import { TASK_STATUSES, type StageWorkflowRecord, type TaskStatus, type WorkflowStage } from "../types";

function newStage(order: number): WorkflowStage {
  return {
    stageId: crypto.randomUUID(),
    canonicalStatus: "todo",
    name: "New stage",
    boardVisible: true,
    order,
    active: true,
    isDefaultForStatus: false,
    terminalKind: "none",
  };
}

function normalized(stages: WorkflowStage[]) {
  return {
    schemaVersion: 2 as const,
    stages: stages.map((stage, order) => ({
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
  onSaved: (workflow: StageWorkflowRecord) => void;
}) {
  const { language, text } = useTaskboardI18n();
  const [record, setRecord] = useState<StageWorkflowRecord | null>(null);
  const [stages, setStages] = useState<WorkflowStage[]>([]);
  const [remaps, setRemaps] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    void getStageWorkflow(projectId, controller.signal).then((workflow) => {
      if (controller.signal.aborted) return;
      setRecord(workflow);
      setStages(workflow.definition.stages);
    }).catch((cause) => {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "Could not load workflow");
    });
    return () => controller.abort();
  }, [projectId]);

  const removed = useMemo(
    () => record?.definition.stages.filter((saved) => !stages.some((stage) => stage.stageId === saved.stageId)) ?? [],
    [record, stages],
  );
  const dirty = record !== null && (
    JSON.stringify(normalized(stages)) !== JSON.stringify(record.definition)
    || removed.length > 0
  );
  const update = (next: WorkflowStage[]) => setStages(normalized(next).stages);
  const move = (index: number, offset: -1 | 1) => {
    const destination = index + offset;
    if (destination < 0 || destination >= stages.length) return;
    const next = [...stages];
    [next[index], next[destination]] = [next[destination], next[index]];
    update(next);
  };
  const remove = (stageId: string) => {
    setStages((current) => current.filter((stage) => stage.stageId !== stageId));
    setRemaps((current) => {
      const next = { ...current };
      delete next[stageId];
      return next;
    });
  };
  const save = async () => {
    if (!record || !dirty || saving) return;
    const removals = removed.map((stage) => ({
      stageId: stage.stageId,
      destinationStageId: remaps[stage.stageId] ?? "",
    }));
    if (removals.some((removal) => !removal.destinationStageId)) {
      setError(text("Escolha o estágio que receberá os cartões antes de remover uma etapa.", "Choose a destination stage before removing a stage."));
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const workflow = await saveStageWorkflow(projectId, normalized(stages), record.version, removals);
      setRecord(workflow);
      setStages(workflow.definition.stages);
      setRemaps({});
      onSaved(workflow);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : text("Não foi possível salvar o fluxo.", "Could not save the workflow."));
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
            <p>{text("Adicione, renomeie, reordene, oculte ou remova as etapas deste projeto.", "Add, rename, reorder, hide, or remove this project's stages.")}</p>
          </div>
          <button className="dialog-close" type="button" disabled={saving} onClick={onClose} aria-label={text("关闭", "Close")}>×</button>
        </header>
        <main className="board-workflow-body">
          <div className="board-workflow-preview" aria-label={text("阶段预览", "Stage preview")}>
            {stages.filter((stage) => stage.active && stage.boardVisible).map((stage) => <span key={stage.stageId}>{stage.name}</span>)}
          </div>
          <button className="button secondary board-workflow-add" type="button" onClick={() => update([...stages, newStage(stages.length)])}>{text("添加阶段", "Add stage")}</button>
          <div className="board-workflow-stages" aria-label={text("流程阶段", "Workflow stages")}>
            {stages.map((stage, index) => (
              <div className="board-workflow-stage board-workflow-stage-v2" key={stage.stageId}>
                <div className="board-workflow-stage-order">
                  <button type="button" disabled={index === 0} onClick={() => move(index, -1)} aria-label={text("上移", "Move up")}>↑</button>
                  <button type="button" disabled={index === stages.length - 1} onClick={() => move(index, 1)} aria-label={text("下移", "Move down")}>↓</button>
                </div>
                <label className="board-workflow-stage-label">
                  <input value={stage.name} maxLength={120} aria-label={text("阶段名称", "Stage name")} onChange={(event) => update(stages.map((item) => item.stageId === stage.stageId ? { ...item, name: event.target.value } : item))} />
                  <select value={stage.canonicalStatus} disabled={stage.isDefaultForStatus} aria-label={text("兼容状态", "Compatibility status")} onChange={(event) => update(stages.map((item) => item.stageId === stage.stageId ? { ...item, canonicalStatus: event.target.value as TaskStatus } : item))}>
                    {TASK_STATUSES.map((status) => <option key={status} value={status}>{taskStatusLabel(language, status)}</option>)}
                  </select>
                </label>
                <label className="board-workflow-visibility">
                  <input type="checkbox" checked={stage.boardVisible} onChange={(event) => update(stages.map((item) => item.stageId === stage.stageId ? { ...item, boardVisible: event.target.checked } : item))} />
                  <span>{text("显示", "Show")}</span>
                </label>
                <button className="board-workflow-remove" type="button" disabled={stage.isDefaultForStatus} onClick={() => remove(stage.stageId)}>{text("移除", "Remove")}</button>
              </div>
            ))}
          </div>
          {removed.map((stage) => (
            <label className="board-workflow-remap" key={stage.stageId}>
              <span>{text(`迁移 “${stage.name}” 中的任务至`, `Move issues from “${stage.name}” to`)}</span>
              <select value={remaps[stage.stageId] ?? ""} onChange={(event) => setRemaps((current) => ({ ...current, [stage.stageId]: event.target.value }))}>
                <option value="">{text("选择阶段", "Choose stage")}</option>
                {stages.filter((candidate) => candidate.active).map((candidate) => <option key={candidate.stageId} value={candidate.stageId}>{candidate.name}</option>)}
              </select>
            </label>
          ))}
          {error && <p className="project-dialog-error" role="alert">{error}</p>}
        </main>
        <footer className="board-workflow-actions">
          <button className="button secondary" type="button" disabled={saving} onClick={onClose}>{text("取消", "Cancel")}</button>
          <button className="button primary" type="button" disabled={!dirty || saving} onClick={() => void save()}>{saving ? text("保存中…", "Saving…") : text("保存流程", "Save workflow")}</button>
        </footer>
      </section>
    </div>
  );
}
