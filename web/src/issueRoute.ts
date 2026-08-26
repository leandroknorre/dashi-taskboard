const ISSUE_QUERY_PARAM = "issue";
const WORKSPACE_QUERY_PARAM = "workspace";
const WORKSPACE_ROOT_QUERY_PARAM = "workspaceRoot";
const WORKSPACE_ROOT_EXTRA_QUERY_PARAM = "workspaceExtra";

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
