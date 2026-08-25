import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import {
  buildWorkspaceUrl,
  buildIssueUrl,
  readIssueIdentifier,
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

test("the app restores issue detail from the URL and follows browser history", () => {
  assert.match(
    appSource,
    /useState<string \| null>\(\s*\(\) => readIssueIdentifier\(window\.location\.search\),?\s*\)/,
  );
  assert.match(appSource, /task\.identifier === detailTaskIdentifier/);
  assert.match(appSource, /window\.addEventListener\("popstate", syncRouteFromLocation\)/);
  assert.match(appSource, /window\.removeEventListener\("popstate", syncRouteFromLocation\)/);
  assert.match(appSource, /setWorkspaceIdentifier\(routeWorkspaceIdentifier\)/);
  assert.match(appSource, /setWorkspaceView\(readWorkspaceView\(url\.search\)\)/);
  const openTaskSource = appSource.slice(
    appSource.indexOf("function openTaskDetail"),
    appSource.indexOf("function closeTaskDetail"),
  );
  assert.match(openTaskSource, /buildIssueUrl\(window\.location\.href, selectedProjectId, null\)/);
  assert.match(openTaskSource, /detailWorkspaceOriginScrollRef\.current = !workspaceIdentifier && !currentIssue[\s\S]*?captureWorkspaceOriginScroll\(\)/);
  assert.match(openTaskSource, /window\.history\.replaceState/);
  assert.match(openTaskSource, /window\.history\.pushState/);
  assert.match(appSource, /function closeTaskDetail\(\)[\s\S]*?window\.history\.replaceState/);
  assert.match(appSource, /onEdit=\{openTaskDetail\}/);
  assert.match(appSource, /function openNestedWorkspaceFromDetail[\s\S]*?setDetailTaskIdentifier\(null\)/);
  assert.match(appSource, /function openNestedWorkspaceFromDetail[\s\S]*?detailOriginScroll \?\? captureWorkspaceOriginScroll\(\)/);
  assert.match(appSource, /onOpenWorkspace=\{openNestedWorkspaceFromDetail\}/);
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
  assert.match(workspaceSource, /onClick=\{\(\) => onOpenWorkspace\(root\.identifier\)\}/);
  assert.doesNotMatch(workspaceSource, /nested-workspace-super-card[\s\S]{0,300}onOpenTask\(root\)/);
});
