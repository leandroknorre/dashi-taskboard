import { useEffect, useMemo, useState } from "react";
import type {
  SourceRecordAction,
  SourceRecordMutationResult,
} from "../api";
import { buildIssueUrl } from "../issueRoute";
import { useTaskboardI18n } from "../i18n";
import {
  isSourceRecord,
  type Task,
  type TaskRelationSummary,
} from "../types";
import copyIdIcon from "../assets/figma-taskboard/copy-id.svg";
import copyLinkIcon from "../assets/figma-taskboard/copy-link.svg";
import { DescriptionDocument } from "./DescriptionDocument";
import { LinearIcon } from "./LinearIcon";
import { SourceRecordBadge } from "./SourceRecordBadge";

type SourceRecordDetailError = string | readonly [string, string];

interface SourceRecordDetailProps {
  task: Task;
  tasks: Task[];
  referenceTasks: Task[];
  onAction: (
    task: Task,
    action: SourceRecordAction,
    targetTaskId?: string,
  ) => Promise<SourceRecordMutationResult>;
  onOpenTask: (task: TaskRelationSummary) => void;
  onCopy: (value: string, announcement: string) => void;
  onError: (message: SourceRecordDetailError | null) => void;
}

function sourceActionError(error: unknown): SourceRecordDetailError {
  if (error instanceof Error) return error.message;
  return ["候选操作未完成，请重试。", "A ação sobre a referência não foi concluída. Tente novamente."];
}

function displayDate(value: string | null | undefined, locale: string) {
  if (!value) return "—";
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" })
    .format(new Date(value));
}

export function SourceRecordDetail({
  task,
  tasks,
  referenceTasks,
  onAction,
  onOpenTask,
  onCopy,
  onError,
}: SourceRecordDetailProps) {
  const { locale, text } = useTaskboardI18n();
  const [currentTask, setCurrentTask] = useState(task);
  const [runningAction, setRunningAction] = useState<SourceRecordAction | null>(null);
  const [resolvedTarget, setResolvedTarget] = useState<Task | null>(null);
  const workCards = useMemo(() => tasks.filter((candidate) => (
    candidate.id !== currentTask.id
    && candidate.archivedAt === null
    && !isSourceRecord(candidate)
  )), [currentTask.id, tasks]);
  const [mergeTargetId, setMergeTargetId] = useState("");

  useEffect(() => {
    setCurrentTask(task);
    setResolvedTarget(null);
  }, [task]);

  useEffect(() => {
    if (workCards.some((candidate) => candidate.id === mergeTargetId)) return;
    setMergeTargetId(workCards[0]?.id ?? "");
  }, [mergeTargetId, workCards]);

  const candidateState = currentTask.candidateState ?? "available";
  const targetTask = resolvedTarget
    ?? referenceTasks.find((candidate) => candidate.id === currentTask.candidateTargetTaskId)
    ?? null;
  const displayIdentifier = currentTask.externalKey ?? currentTask.identifier;

  async function runAction(action: SourceRecordAction) {
    setRunningAction(action);
    onError(null);
    try {
      const result = await onAction(
        currentTask,
        action,
        action === "merge" ? mergeTargetId : undefined,
      );
      setCurrentTask(result.sourceRecord);
      setResolvedTarget(result.workCard
        ?? referenceTasks.find((candidate) => candidate.id === result.targetTaskId)
        ?? null);
    } catch (error) {
      onError(sourceActionError(error));
    } finally {
      setRunningAction(null);
    }
  }

  return (
    <section
      className="issue-detail source-record-detail"
      aria-label={text(`${displayIdentifier} 只读引用详情`, `${displayIdentifier} — Referência somente leitura`)}
    >
      <div className="issue-detail-scroll">
        <div className="issue-detail-layout">
          <div className="issue-detail-main">
            <article className="issue-editor source-record-document" aria-label={text("只读引用内容", "Conteúdo da referência")}>
              <div className="issue-editor-content">
                <SourceRecordBadge item={currentTask} />
                <h1>{currentTask.title}</h1>
                <div className={`issue-description-read${currentTask.description ? "" : " empty"}`}>
                  {currentTask.description
                    ? <DescriptionDocument value={currentTask.description} referenceTasks={referenceTasks} onOpenTask={onOpenTask} />
                    : text("暂无来源摘要。", "Nenhum resumo foi fornecido pela fonte.")}
                </div>
              </div>
            </article>

            <section className="source-record-actions" aria-labelledby="source-record-actions-title">
              <h2 id="source-record-actions-title">{text("候选操作", "Decisão sobre esta referência")}</h2>
              {candidateState === "available" ? (
                <>
                  <p>{text(
                    "采用会创建可编辑的工作卡；合并只会链接到现有工作卡。",
                    "Adotar cria um card operacional editável; mesclar apenas vincula esta referência a um card existente.",
                  )}</p>
                  <div className="source-record-action-row">
                    <button
                      className="button primary"
                      type="button"
                      disabled={runningAction !== null}
                      onClick={() => void runAction("adopt")}
                    >
                      {runningAction === "adopt" ? text("采用中…", "Adotando…") : text("采用", "Adotar")}
                    </button>
                    <label>
                      <span>{text("现有工作卡", "Card operacional existente")}</span>
                      <select
                        value={mergeTargetId}
                        disabled={runningAction !== null || workCards.length === 0}
                        onChange={(event) => setMergeTargetId(event.target.value)}
                      >
                        {workCards.length === 0 && <option value="">{text("无可用工作卡", "Nenhum card disponível")}</option>}
                        {workCards.map((candidate) => (
                          <option value={candidate.id} key={candidate.id}>
                            {candidate.identifier} — {candidate.title}
                          </option>
                        ))}
                      </select>
                    </label>
                    <button
                      className="button secondary"
                      type="button"
                      disabled={runningAction !== null || !mergeTargetId}
                      onClick={() => void runAction("merge")}
                    >
                      {runningAction === "merge" ? text("合并中…", "Mesclando…") : text("合并", "Mesclar")}
                    </button>
                    <button
                      className="button danger"
                      type="button"
                      disabled={runningAction !== null}
                      onClick={() => void runAction("discard")}
                    >
                      {runningAction === "discard" ? text("丢弃中…", "Descartando…") : text("丢弃", "Descartar")}
                    </button>
                  </div>
                </>
              ) : candidateState === "discarded" ? (
                <div className="source-record-action-row">
                  <p>{text("此引用已从默认候选列表中隐藏。", "Esta referência foi ocultada da lista padrão de candidatos.")}</p>
                  <button
                    className="button primary"
                    type="button"
                    disabled={runningAction !== null}
                    onClick={() => void runAction("restore")}
                  >
                    {runningAction === "restore" ? text("恢复中…", "Restaurando…") : text("恢复", "Restaurar")}
                  </button>
                </div>
              ) : (
                <div className="source-record-resolution">
                  <strong>{candidateState === "adopted"
                    ? text("已采用", "Referência adotada")
                    : text("已合并", "Referência mesclada")}</strong>
                  {targetTask && (
                    <button type="button" onClick={() => onOpenTask(targetTask)}>
                      {text("打开工作卡", "Abrir card operacional")}: {targetTask.identifier} — {targetTask.title}
                    </button>
                  )}
                </div>
              )}
            </section>
          </div>

          <aside className="issue-properties source-record-properties" aria-label={text("引用属性", "Propriedades da referência")}>
            <div className="detail-primary-actions">
              {currentTask.externalUrl && (
                <a className="detail-copy-action detail-external-action" href={currentTask.externalUrl} target="_blank" rel="noreferrer">
                  <span className="detail-copy-action-icon" aria-hidden="true"><LinearIcon name="openExternal" /></span>
                  <span className="detail-copy-action-label">{text("打开来源", "Abrir fonte")}</span>
                </a>
              )}
              <button
                className="detail-copy-action"
                type="button"
                onClick={() => onCopy(displayIdentifier, text(`${displayIdentifier} 已复制。`, `${displayIdentifier} copiado.`))}
              >
                <span className="detail-copy-action-icon" aria-hidden="true"><img src={copyIdIcon} alt="" /></span>
                <span className="detail-copy-action-label">{text("复制 ID", "Copiar ID")}</span>
                <span className="detail-copy-identifier">{displayIdentifier}</span>
              </button>
              <button
                className="detail-copy-action"
                type="button"
                onClick={() => onCopy(
                  buildIssueUrl(document.baseURI, currentTask.projectId, currentTask.identifier).href,
                  text("引用链接已复制。", "Link da referência copiado."),
                )}
              >
                <span className="detail-copy-action-icon" aria-hidden="true"><img src={copyLinkIcon} alt="" /></span>
                <span className="detail-copy-action-label">{text("复制链接", "Copiar link")}</span>
              </button>
            </div>
            <h2>{text("来源", "Origem")}</h2>
            <dl className="source-record-facts">
              <div><dt>{text("系统", "Sistema")}</dt><dd>{currentTask.sourceSystem ?? "—"}</dd></div>
              <div><dt>{text("版本", "Versão")}</dt><dd>{currentTask.externalVersion ?? "—"}</dd></div>
              <div><dt>{text("来源空间", "Âmbito de origem")}</dt><dd>{currentTask.externalOrigin ?? "—"}</dd></div>
              <div><dt>{text("外部 ID", "ID externo")}</dt><dd>{currentTask.externalId ?? "—"}</dd></div>
              <div><dt>{text("候选状态", "Estado da candidatura")}</dt><dd>{candidateState}</dd></div>
              <div><dt>{text("来源更新时间", "Atualização da fonte")}</dt><dd>{displayDate(currentTask.updatedAt, locale)}</dd></div>
            </dl>
          </aside>
        </div>
      </div>
    </section>
  );
}
