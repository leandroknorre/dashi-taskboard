const ISSUE_QUERY_PARAM = "issue";
const WORKSPACE_QUERY_PARAM = "workspace";
const WORKSPACE_ROOT_QUERY_PARAM = "workspaceRoot";
const WORKSPACE_ROOT_EXTRA_QUERY_PARAM = "workspaceExtra";
const WORKSPACE_DESCENDANTS_QUERY_PARAM = "descendants";
const GROUP_BY_PARENT_QUERY_PARAM = "agrupar";

export const WORKSPACE_VIEWS = ["overview", "board", "list", "tree", "mindmap", "timeline"] as const;
export type WorkspaceView = (typeof WORKSPACE_VIEWS)[number];
export const WORKSPACE_ROOT_EXTRAS = ["gantt", "docs"] as const;
export type WorkspaceRootExtra = (typeof WORKSPACE_ROOT_EXTRAS)[number];

export function readIssueIdentifier(search: string): string | null {
  const identifier = new URLSearchParams(search).get(ISSUE_QUERY_PARAM)?.trim().toUpperCase();
  return identifier || null;
}

export function readWorkspaceIdentifier(search: string): string | null {
  return new URLSearchParams(search).get(WORKSPACE_QUERY_PARAM)?.trim() || null;
}

/** A project-root workspace is distinct from task-owned nested workspaces. */
export function readWorkspaceRootProjectId(search: string): string | null {
  if (readWorkspaceIdentifier(search)) return null;
  return new URLSearchParams(search).get(WORKSPACE_ROOT_QUERY_PARAM)?.trim() || null;
}

/** Extra root-only surfaces stay outside the canonical six workspace views. */
export function readWorkspaceRootExtra(search: string): WorkspaceRootExtra | null {
  if (!readWorkspaceRootProjectId(search)) return null;
  const value = new URLSearchParams(search).get(WORKSPACE_ROOT_EXTRA_QUERY_PARAM);
  return WORKSPACE_ROOT_EXTRAS.includes(value as WorkspaceRootExtra)
    ? value as WorkspaceRootExtra
    : null;
}

export function readWorkspaceView(search: string): WorkspaceView {
  const value = new URLSearchParams(search).get("view");
  return WORKSPACE_VIEWS.includes(value as WorkspaceView) ? value as WorkspaceView : "overview";
}

/** Bookmarkable state for the "All descendants" toggle on a nested workspace's Board/List. */
export function readWorkspaceDescendants(search: string): boolean {
  return new URLSearchParams(search).get(WORKSPACE_DESCENDANTS_QUERY_PARAM) === "1";
}

export function writeWorkspaceDescendants(descendants: boolean) {
  const url = new URL(window.location.href);
  if (descendants) url.searchParams.set(WORKSPACE_DESCENDANTS_QUERY_PARAM, "1");
  else url.searchParams.delete(WORKSPACE_DESCENDANTS_QUERY_PARAM);
  window.history.replaceState(window.history.state, "", url);
}

/**
 * Bookmarkable state for the "Group by parent" toggle on the project root's
 * Board. `null` means no explicit choice was ever made — the caller decides
 * the default (on once any column has too many cards).
 */
export function readGroupByParent(search: string): boolean | null {
  const value = new URLSearchParams(search).get(GROUP_BY_PARENT_QUERY_PARAM);
  if (value === "1") return true;
  if (value === "0") return false;
  return null;
}

export function writeGroupByParent(value: boolean | null) {
  const url = new URL(window.location.href);
  if (value === null) url.searchParams.delete(GROUP_BY_PARENT_QUERY_PARAM);
  else url.searchParams.set(GROUP_BY_PARENT_QUERY_PARAM, value ? "1" : "0");
  window.history.replaceState(window.history.state, "", url);
}

/** Changes nested-workspace route state, preserving project and host context.
 *
 * A task detail and a nested workspace are mutually exclusive screens.  In
 * particular, entering a workspace from its detail must not leave a stale
 * `issue` query parameter behind for history/navigation to interpret.
 */
export function buildWorkspaceUrl(
  href: string,
  workspaceIdentifier: string | null,
  view: WorkspaceView = "overview",
): URL {
  const url = new URL(href);
  if (workspaceIdentifier) {
    url.searchParams.delete(ISSUE_QUERY_PARAM);
    url.searchParams.delete(WORKSPACE_ROOT_QUERY_PARAM);
    url.searchParams.delete(WORKSPACE_ROOT_EXTRA_QUERY_PARAM);
    url.searchParams.set(WORKSPACE_QUERY_PARAM, workspaceIdentifier);
    url.searchParams.set("view", view);
  } else {
    url.searchParams.delete(WORKSPACE_QUERY_PARAM);
    url.searchParams.delete(WORKSPACE_ROOT_QUERY_PARAM);
    url.searchParams.delete(WORKSPACE_ROOT_EXTRA_QUERY_PARAM);
    url.searchParams.delete("view");
  }
  return url;
}

/** Changes a project-root workspace route without asking the task API for a fake task. */
export function buildRootWorkspaceUrl(
  href: string,
  projectId: string | null,
  view: WorkspaceView = "overview",
  extra: WorkspaceRootExtra | null = null,
): URL {
  const url = new URL(href);
  if (projectId) {
    url.searchParams.delete(ISSUE_QUERY_PARAM);
    url.searchParams.delete(WORKSPACE_QUERY_PARAM);
    url.searchParams.set("project", projectId);
    url.searchParams.set(WORKSPACE_ROOT_QUERY_PARAM, projectId);
    url.searchParams.set("view", view);
    if (extra) url.searchParams.set(WORKSPACE_ROOT_EXTRA_QUERY_PARAM, extra);
    else url.searchParams.delete(WORKSPACE_ROOT_EXTRA_QUERY_PARAM);
  } else {
    url.searchParams.delete(WORKSPACE_QUERY_PARAM);
    url.searchParams.delete(WORKSPACE_ROOT_QUERY_PARAM);
    url.searchParams.delete(WORKSPACE_ROOT_EXTRA_QUERY_PARAM);
    url.searchParams.delete("view");
  }
  return url;
}

export function buildIssueUrl(
  href: string,
  projectId: string | null,
  issueIdentifier: string | null,
): URL {
  const url = new URL(href);

  if (projectId) url.searchParams.set("project", projectId);
  else url.searchParams.delete("project");

  if (issueIdentifier) url.searchParams.set(ISSUE_QUERY_PARAM, issueIdentifier.trim().toUpperCase());
  else url.searchParams.delete(ISSUE_QUERY_PARAM);

  return url;
}
