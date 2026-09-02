import { useState } from "react";
import { ApiError, renameProject } from "../api";
import { useTaskboardI18n } from "../i18n";
import type { Project } from "../types";

export function ProjectRenameDialog({
  project,
  onClose,
  onSaved,
}: {
  project: Project;
  onClose: () => void;
  onSaved: (project: Project) => void;
}) {
  const { text } = useTaskboardI18n();
  const [name, setName] = useState(project.name);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const normalizedName = name.trim();

  const save = async () => {
    if (!normalizedName || normalizedName === project.name || saving) return;
    setSaving(true);
    setError(null);
    try {
      onSaved(await renameProject(project, normalizedName));
    } catch (cause) {
      if (cause instanceof ApiError && cause.code === "PROJECT_UPDATED_AT_CONFLICT") {
        setError(text(
          "项目已在其他位置更新。关闭并重新打开此窗口后再试。",
          "This project changed elsewhere. Close and reopen this dialog before trying again.",
        ));
      } else if (cause instanceof ApiError && (
        cause.code === "PROJECT_ARCHIVED"
        || cause.code === "PROJECT_RENAME_UNAVAILABLE"
      )) {
        setError(text(
          "此项目当前不能重命名。",
          "This project cannot be renamed in its current state.",
        ));
      } else {
        setError(cause instanceof Error ? cause.message : text(
          "无法重命名项目。",
          "Could not rename the project.",
        ));
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="delete-backdrop" onPointerDown={(event) => {
      if (event.target === event.currentTarget && !saving) onClose();
    }}>
      <form
        className="delete-dialog project-rename-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="project-rename-title"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape" && !saving) onClose();
        }}
      >
        <h2 id="project-rename-title">{text("重命名项目", "Rename project")}</h2>
        <label>
          <span>{text("项目名称", "Project name")}</span>
          <input
            autoFocus
            maxLength={120}
            required
            value={name}
            disabled={saving}
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        {error && <p className="project-dialog-error" role="alert">{error}</p>}
        <div>
          <button className="button secondary" type="button" disabled={saving} onClick={onClose}>
            {text("取消", "Cancel")}
          </button>
          <button
            className="button primary"
            type="submit"
            disabled={!normalizedName || normalizedName === project.name || saving}
          >
            {saving ? text("保存中…", "Saving…") : text("保存", "Save")}
          </button>
        </div>
      </form>
    </div>
  );
}
