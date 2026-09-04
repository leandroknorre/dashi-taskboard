import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import {
  buildWorkspaceUrl,
  buildRootWorkspaceUrl,
  buildIssueUrl,
  readIssueIdentifier,
  readWorkspaceRootExtra,
  readWorkspaceRootProjectId,
  readWorkspaceIdentifier,
  readWorkspaceView,
} from "../web/src/issueRoute.ts";

const appSource = await readFile(new URL("../web/src/App.tsx", import.meta.url), "utf8");

test("issue detail URLs preserve project context and unrelated query parameters", () => {
  const url = buildIssueUrl(
    "http://127.0.0.1:47823/?host=codex&project=other&status=todo",
    "local",
    "LOCAL-72",
  );

  assert.equal(url.searchParams.get("project"), "local");
  assert.equal(url.searchParams.get("issue"), "LOCAL-72");
  assert.equal(url.searchParams.get("host"), "codex");
  assert.equal(url.searchParams.get("status"), "todo");
  assert.equal(readIssueIdentifier(url.search), "LOCAL-72");
});

test("closing issue detail removes only the issue route", () => {
  const url = buildIssueUrl(
    "http://127.0.0.1:47823/?host=codex&project=local&issue=LOCAL-72&label=缺陷",
    "local",
    null,
  );

  assert.equal(url.searchParams.has("issue"), false);
  assert.equal(url.searchParams.get("project"), "local");
  assert.equal(url.searchParams.get("host"), "codex");
  assert.deepEqual(url.searchParams.getAll("label"), ["缺陷"]);
});

test("nested workspace route clears issue context and accepts public projection views", () => {
  const url = buildWorkspaceUrl(
    "http://127.0.0.1:47823/?host=codex&project=local&issue=LOCAL-72&filter=mine",
    "LOCAL-73",
    "tree",
  );

  assert.equal(readWorkspaceIdentifier(url.search), "LOCAL-73");
  assert.equal(readWorkspaceView(url.search), "tree");
  assert.equal(readIssueIdentifier(url.search), null);
  assert.equal(url.searchParams.has("issue"), false);
  assert.equal(url.searchParams.get("host"), "codex");
  assert.equal(url.searchParams.get("filter"), "mine");
  assert.equal(readWorkspaceView("?workspace=LOCAL-73&view=timeline"), "timeline");
  assert.equal(readWorkspaceView("?workspace=LOCAL-73&view=mindmap"), "mindmap");
  assert.equal(readWorkspaceView("?workspace=LOCAL-73&view=unknown"), "overview");
});

test("root and task workspaces are mutually exclusive deep-link routes", () => {
  const rootUrl = buildRootWorkspaceUrl(
    "http://127.0.0.1:47823/?host=codex&project=alpha&issue=ALPHA-72&workspace=ALPHA-73&filter=mine",
    "alpha",
    "timeline",
  );

  assert.equal(readWorkspaceRootProjectId(rootUrl.search), "alpha");
  assert.equal(readWorkspaceIdentifier(rootUrl.search), null);
  assert.equal(readIssueIdentifier(rootUrl.search), null);
  assert.equal(readWorkspaceView(rootUrl.search), "timeline");
  assert.equal(rootUrl.searchParams.get("project"), "alpha");
  assert.equal(rootUrl.searchParams.get("host"), "codex");
  assert.equal(rootUrl.searchParams.get("filter"), "mine");

  const ganttUrl = buildRootWorkspaceUrl(rootUrl.href, "alpha", "timeline", "gantt");
  assert.equal(readWorkspaceRootExtra(ganttUrl.search), "gantt");
  assert.equal(readWorkspaceView(ganttUrl.search), "timeline");
  assert.equal(ganttUrl.searchParams.get("workspaceExtra"), "gantt");

  const taskUrl = buildWorkspaceUrl(ganttUrl.href, "ALPHA-73", "board");
  assert.equal(readWorkspaceIdentifier(taskUrl.search), "ALPHA-73");
  assert.equal(readWorkspaceRootProjectId(taskUrl.search), null);
  assert.equal(readWorkspaceRootExtra(taskUrl.search), null);
  assert.equal(readIssueIdentifier(taskUrl.search), null);
  assert.equal(readWorkspaceView(taskUrl.search), "board");

  const detailUrl = buildIssueUrl(taskUrl.href, "alpha", "ALPHA-72");
  assert.equal(readIssueIdentifier(detailUrl.search), "ALPHA-72");
  assert.equal(readWorkspaceIdentifier(detailUrl.search), "ALPHA-73");
  assert.equal(readWorkspaceRootProjectId(detailUrl.search), null);
  assert.equal(readWorkspaceView(detailUrl.search), "board");

  const rootDetailUrl = buildIssueUrl(rootUrl.href, "alpha", "ALPHA-72");
  assert.equal(readIssueIdentifier(rootDetailUrl.search), "ALPHA-72");
  assert.equal(readWorkspaceIdentifier(rootDetailUrl.search), null);
  assert.equal(readWorkspaceRootProjectId(rootDetailUrl.search), "alpha");
  assert.equal(readWorkspaceView(rootDetailUrl.search), "timeline");
});

test("the app restores issue detail from the URL and follows browser history", () => {
  assert.match(
    appSource,
    /useState<string \| null>\(\s*\(\) => readIssueIdentifier\(window\.location\.search\),?\s*\)/,
  );
  assert.match(appSource, /task\.identifier === detailTaskIdentifier/);
  assert.match(appSource, /window\.addEventListener\("popstate", syncRouteFromLocation\)/);
  assert.match(appSource, /window\.removeEventListener\("popstate", syncRouteFromLocation\)/);
  assert.match(appSource, /setWorkspaceIdentifier\(routeWorkspaceIdentifier\)/);
  assert.match(appSource, /setWorkspaceRootProjectId\(routeWorkspaceRootProjectId\)/);
  assert.match(appSource, /setWorkspaceView\(readWorkspaceView\(url\.search\)\)/);
  const openTaskSource = appSource.slice(
    appSource.indexOf("function openTaskDetail"),
    appSource.indexOf("function closeTaskDetail"),
  );
  assert.match(openTaskSource, /buildIssueUrl\(window\.location\.href, selectedProjectId, null\)/);
  assert.match(openTaskSource, /detailWorkspaceOriginScrollRef\.current = !workspaceActive && !currentIssue[\s\S]*?captureWorkspaceOriginScroll\(\)/);
  assert.match(openTaskSource, /window\.history\.replaceState/);
  assert.match(openTaskSource, /window\.history\.pushState/);
  assert.match(appSource, /function closeTaskDetail\(\)[\s\S]*?window\.history\.replaceState/);
  assert.match(appSource, /onEdit=\{openTaskDetail\}/);
  assert.match(appSource, /function openNestedWorkspaceFromDetail[\s\S]*?setDetailTaskIdentifier\(null\)/);
  assert.match(appSource, /function openNestedWorkspaceFromDetail[\s\S]*?detailOriginScroll \?\? captureWorkspaceOriginScroll\(\)/);
  assert.match(appSource, /onOpenWorkspace=\{openNestedWorkspaceFromDetail\}/);
});

test("every card click opens the detail route, even for tasks with sub-issues", async () => {
  const workspaceSource = await readFile(new URL("../web/src/components/NestedWorkspaceView.tsx", import.meta.url), "utf8");
  const ganttSource = await readFile(new URL("../web/src/components/GanttView.tsx", import.meta.url), "utf8");

  const openTaskOrWorkspaceSource = appSource.slice(
    appSource.indexOf("function openTaskOrWorkspace"),
    appSource.indexOf("function openTaskOrWorkspace") + 200,
  );
  assert.doesNotMatch(openTaskOrWorkspaceSource, /relations\.subIssues\.length/);
  assert.doesNotMatch(openTaskOrWorkspaceSource, /openNestedWorkspace\(/);
  assert.match(appSource, /function openTaskOrWorkspace[\s\S]*?openTaskDetail\(task\)/);
  assert.match(appSource, /onOpenTask=\{openTaskOrWorkspace\}/);
  assert.match(workspaceSource, /className="nested-workspace-item-detail"[\s\S]*?onClick=\{\(\) => onOpenTaskDetail\(item\)\}/);
  assert.match(ganttSource, /attachEvent\("onTaskClick",[\s\S]*?onOpenTaskRef\.current\(task\)/);
  assert.match(ganttSource, /attachEvent\("onTaskDblClick",[\s\S]*?onOpenTaskDetailRef\.current\(task\)/);
});

test("only supra-items expose the nested-workspace entry point", async () => {
  const detailSource = await readFile(new URL("../web/src/components/TaskDetail.tsx", import.meta.url), "utf8");
  assert.match(detailSource, /currentTask\.relations\.subIssues\.length > 0/);
  assert.match(detailSource, /Abrir fluxo aninhado/);
  assert.match(detailSource, /onOpenWorkspace\(currentTask\.identifier\)/);
});

test("workspace changes replace the read record atomically and scope pagination cursors", () => {
  assert.match(appSource, /setNestedWorkspaceLoad\(\{\s*key: requestKey,\s*workspace: null,\s*rollup: null,/);
  assert.match(appSource, /requestId !== nestedWorkspaceRequestRef\.current/);
  assert.match(appSource, /requestId !== nestedWorkspacePageRequestRef\.current/);
  assert.match(appSource, /childrenCursor: page\.nextCursor/);
  assert.match(appSource, /descendantsCursor: page\.nextCursor/);
  assert.doesNotMatch(appSource, /cursor:\s*page\.nextCursor/);
});

test("workspace history saves and restores an origin viewport without opening the issue detail", async () => {
  const workspaceSource = await readFile(new URL("../web/src/components/NestedWorkspaceView.tsx", import.meta.url), "utf8");
  assert.match(appSource, /function saveWorkspaceOriginScroll[\s\S]*?window\.history\.replaceState/);
  assert.match(appSource, /saveWorkspaceOriginScroll\(captureWorkspaceOriginScroll\(\)\)[\s\S]*?window\.history\.pushState/);
  assert.match(appSource, /nestedWorkspaceSourceScroll/);
  assert.match(appSource, /restoreViewport=\{workspaceGanttRestore\}/);
  assert.match(workspaceSource, /onClick=\{\(\) => onOpenWorkspace\(root\.target!\)\}/);
  assert.doesNotMatch(workspaceSource, /nested-workspace-super-card[\s\S]{0,300}onOpenTask\(root\)/);
});

test("the root project workspace reuses the canonical six projections", async () => {
  const workspaceSource = await readFile(new URL("../web/src/components/NestedWorkspaceView.tsx", import.meta.url), "utf8");
  for (const view of ["overview", "board", "list", "tree", "mindmap", "timeline"]) {
    assert.match(workspaceSource, new RegExp(`\\["${view}"|"${view}"`));
  }
  assert.match(appSource, /buildRootWorkspaceUrl\(window\.location\.href, [^,]+, view\)/);
  assert.match(appSource, /workspaceRootProjectId/);
  assert.match(appSource, /workspaceRootExtra/);
  assert.match(appSource, /id: "gantt", label: "Gantt"/);
  assert.match(appSource, /id: "docs", label: text\("项目文档", "Project Docs"\)/);
  assert.match(workspaceSource, /projectExtras\?\.map/);
});
