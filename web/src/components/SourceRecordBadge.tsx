import type { NestedWorkspaceItem, Task } from "../types";
import { useTaskboardI18n } from "../i18n";

type SourceRecordSummary = Pick<
  Task | NestedWorkspaceItem,
  "sourceSystem" | "externalVersion"
>;

export function SourceRecordBadge({ item, compact = false }: {
  item: SourceRecordSummary;
  compact?: boolean;
}) {
  const { text } = useTaskboardI18n();
  const source = item.sourceSystem?.trim();
  const version = item.externalVersion?.trim();
  return (
    <span
      className={`source-record-badge${compact ? " is-compact" : ""}`}
      title={text("此项目由外部来源投影，只能通过候选操作更改。", "Esta referência é projetada de uma fonte externa e não pode ser editada.")}
    >
      <span>{text("只读引用", "Referência somente leitura")}</span>
      {(source || version) && (
        <small>{[source, version ? `v${version}` : null].filter(Boolean).join(" · ")}</small>
      )}
    </span>
  );
}
