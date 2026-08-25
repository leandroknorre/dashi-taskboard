import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, request as httpRequest } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import test from "node:test";
import WebSocket from "ws";

import { createTaskboardServer } from "../server/index.mjs";
import { TaskboardDatabase } from "../server/database.mjs";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const actor = { type: "user", id: "workspace-e2e", name: "Workspace E2E", avatarUrl: null };

function chromeExecutable() {
  return [process.env.CHROME_BIN, "/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser"]
    .find((candidate) => candidate && existsSync(candidate));
}

function wait(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function eventually(action, message, timeoutMs = 12_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await action();
      if (value) return value;
    } catch (error) { lastError = error; }
    await wait(100);
  }
  throw new Error(`${message}${lastError ? `: ${lastError.message}` : ""}`);
}

async function chromeDebugPort(profile) {
  return eventually(async () => {
    try {
      const lines = (await readFile(path.join(profile, "DevToolsActivePort"), "utf8")).trim().split("\n");
      return Number(lines[0]) || null;
    } catch { return null; }
  }, "Chrome did not publish a DevTools port");
}

async function connectCdp(port) {
  const target = await eventually(async () => {
    const response = await fetch(`http://127.0.0.1:${port}/json/list`);
    if (!response.ok) return null;
    return (await response.json()).find((entry) => entry.type === "page") ?? null;
  }, "Chrome page target did not become available");
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await once(socket, "open");
  let sequence = 0;
  const pending = new Map();
  socket.on("message", (raw) => {
    const message = JSON.parse(raw);
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.error) request.reject(new Error(message.error.message));
    else request.resolve(message.result);
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
  return {
    send,
    async evaluate(expression) {
      const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
      return result.result.value;
    },
    close: () => socket.close(),
  };
}

async function stop(child) {
  if (!child || child.exitCode !== null) return;
  child.kill("SIGTERM");
  const exited = once(child, "exit");
  await Promise.race([exited, wait(5_000)]);
  if (child.exitCode === null) {
    child.kill("SIGKILL");
    await exited;
  }
}

async function startReadOnlyProxy(targetOrigin) {
  const methods = [];
  const rejected = [];
  const requests = [];
  const proxy = createServer((request, response) => {
    methods.push(request.method);
    requests.push({ method: request.method, url: request.url ?? "/" });
    if (request.method !== "GET") {
      rejected.push(`${request.method} ${request.url}`);
      response.writeHead(405, { "Content-Type": "application/json" }).end('{"error":"read-only proxy"}');
      request.resume();
      return;
    }
    const target = new URL(request.url ?? "/", targetOrigin);
    const upstream = httpRequest(target, { method: "GET", headers: { ...request.headers, host: target.host } }, (upstreamResponse) => {
      response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
      upstreamResponse.pipe(response);
    });
    upstream.on("error", () => response.destroy());
    request.pipe(upstream);
  });
  await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  const address = proxy.address();
  assert.ok(address && typeof address === "object");
  return {
    origin: `http://127.0.0.1:${address.port}`,
    methods,
    rejected,
    requests,
    close: () => new Promise((resolve, reject) => proxy.close((error) => error ? reject(error) : resolve())),
  };
}

function seedWorkspace(directory) {
  const database = new TaskboardDatabase(path.join(directory, "taskboard.sqlite"));
  const create = (title, status, stageId, description = "") => database.createTask({
    projectId: "alpha", title, description, status, stageId, priority: "none", labels: [], actor,
    assignee: actor, developmentContext: null, startDate: null, dueDate: null, recurrence: null,
  });
  const relate = (child, parent, metadata = undefined) => database.addTaskRelation(
    child.id, child.version, "parent", parent.id, null, null, actor, "manual", metadata,
  ).task;
  try {
    database.createProject({ id: "alpha", name: "Alpha", workspacePath: null });
    const initial = database.getStageWorkflow("alpha");
    const firstTodo = { stageId: randomUUID(), canonicalStatus: "todo", name: "Workspace todo A", order: initial.definition.stages.length, boardVisible: true, active: true, isDefaultForStatus: false, terminalKind: "none" };
    const secondTodo = { stageId: randomUUID(), canonicalStatus: "todo", name: "Workspace todo B", order: initial.definition.stages.length + 1, boardVisible: true, active: true, isDefaultForStatus: false, terminalKind: "none" };
    const workflow = database.saveStageWorkflow("alpha", initial.version, { schemaVersion: 2, stages: [...initial.definition.stages, firstTodo, secondTodo] });
    const stageFor = (status) => workflow.definition.stages.find((stage) => stage.canonicalStatus === status && stage.isDefaultForStatus);
    const todoA = workflow.definition.stages.find((stage) => stage.name === firstTodo.name);
    const todoB = workflow.definition.stages.find((stage) => stage.name === secondTodo.name);
    assert.ok(stageFor("in_review") && stageFor("in_progress") && stageFor("blocked") && stageFor("done") && todoA && todoB);

    const vision = create("Vision", "todo", todoA.stageId);
    const program = relate(create("Program", "todo", todoB.stageId), vision);
    const area = relate(create("Area", "in_progress", stageFor("in_progress").stageId), program);
    const portfolio = relate(create("Portfolio", "todo", todoA.stageId), area);
    const root = relate(create("Release workspace", "in_review", stageFor("in_review").stageId, "Manual purpose: ship without moving the parent."), portfolio);
    const direct = [];
    for (let index = 0; index < 62; index += 1) {
      const status = ["todo", "in_progress", "in_review", "blocked", "done"][index % 5];
      const stageId = status === "todo" ? (index % 2 ? todoA.stageId : todoB.stageId) : stageFor(status).stageId;
      direct.push(relate(create(`Direct child ${String(index + 1).padStart(2, "0")}`, status, stageId), root));
    }
    const deepOne = relate(create("Deep descendant one", "in_progress", stageFor("in_progress").stageId), direct[0]);
    const deepTwo = relate(create("Deep descendant two", "todo", todoA.stageId), deepOne);
    const deepThree = relate(create("Deep descendant three", "done", stageFor("done").stageId), deepTwo);
    const ignored = relate(create("Non-rollup descendant", "todo", todoB.stageId), root, { required: false, rollup: false });
    const snapshot = {
      tasks: database.database.prepare("SELECT * FROM tasks ORDER BY id").all(),
      relations: database.database.prepare("SELECT * FROM task_relations ORDER BY relation_type, source_task_id, target_task_id").all(),
    };
    return { root, program, direct, deepThree, ignored, snapshot };
  } finally { database.close(); }
}

test("nested workspace reads a deep real hierarchy without mutating it", { timeout: 90_000 }, async (t) => {
  const chrome = chromeExecutable();
  assert.ok(chrome, "Chrome or Chromium is required for the nested workspace acceptance test");
  if (!existsSync(path.join(projectRoot, "dist", "web", "index.html"))) {
    t.skip("built web assets unavailable; run npm run build first");
    return;
  }
  const directory = await mkdtemp(path.join(os.tmpdir(), "taskboard-nested-workspace-"));
  let app; let proxy; let child; let cdp;
  try {
    const fixture = seedWorkspace(directory);
    app = createTaskboardServer({ dataDirectory: directory });
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    proxy = await startReadOnlyProxy(`http://127.0.0.1:${address.port}`);
    const profile = path.join(directory, "chrome");
    child = spawn(chrome, ["--headless=new", "--disable-background-networking", "--disable-gpu", "--no-first-run", "--no-sandbox", "--remote-debugging-address=127.0.0.1", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
    cdp = await connectCdp(await chromeDebugPort(profile));
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1366, height: 768, deviceScaleFactor: 1, mobile: false });
    await cdp.send("Page.navigate", { url: `${proxy.origin}/?project=alpha` });
    await eventually(() => cdp.evaluate(`document.querySelectorAll(".task-card").length >= 50`), "Board did not render seeded direct children");

    const workspaceUrl = `${proxy.origin}/?project=alpha&workspace=${encodeURIComponent(fixture.root.identifier)}&view=overview`;
    async function enterWorkspace() {
      await cdp.evaluate(`history.pushState(history.state, "", ${JSON.stringify(workspaceUrl)}); dispatchEvent(new PopStateEvent("popstate")); true`);
      await eventually(() => cdp.evaluate(`document.querySelector(".nested-workspace-view")?.textContent?.includes("Manual purpose: ship without moving the parent.")`), "Workspace overview did not load");
    }
    async function goBackToSource() {
      await cdp.evaluate(`history.back(); true`);
      await eventually(() => cdp.evaluate(`!document.querySelector(".nested-workspace-view")`), "History back did not leave workspace");
    }

    await enterWorkspace();
    const overview = await cdp.evaluate(`(() => ({ breadcrumb: [...document.querySelectorAll(".nested-workspace-breadcrumb button")].map((node) => node.textContent?.trim()), text: document.querySelector(".nested-workspace-overview")?.innerText ?? "" }))()`);
    assert.deepEqual(overview.breadcrumb, ["Vision", "Program", "Area", "Portfolio", "Release workspace"]);
    assert.match(overview.text, /Manual stage\s*in review/i);
    assert.match(overview.text, /Derived from\s*65\s*structural descendant/i);

    const breadcrumbOpened = await cdp.evaluate(`(() => { const button = [...document.querySelectorAll(".nested-workspace-breadcrumb button")].find((node) => node.textContent?.trim() === "Portfolio"); if (!(button instanceof HTMLButtonElement)) return false; button.click(); return true; })()`);
    assert.equal(breadcrumbOpened, true);
    await eventually(() => cdp.evaluate(`document.querySelector(".nested-workspace-super-card")?.textContent?.includes("Portfolio")`), "Breadcrumb did not open an ancestor workspace");
    await cdp.evaluate(`history.back(); true`);
    await eventually(() => cdp.evaluate(`document.querySelector(".nested-workspace-super-card")?.textContent?.includes("Release workspace")`), "History back did not restore root workspace");
    await cdp.evaluate(`history.forward(); true`);
    await eventually(() => cdp.evaluate(`document.querySelector(".nested-workspace-super-card")?.textContent?.includes("Portfolio")`), "History forward did not restore the breadcrumb destination");
    await cdp.evaluate(`history.back(); true`);
    await eventually(() => cdp.evaluate(`document.querySelector(".nested-workspace-super-card")?.textContent?.includes("Release workspace")`), "History back did not return to root after forward");

    for (const view of ["Board", "List", "Tree"]) {
      await cdp.evaluate(`(() => { const button = [...document.querySelectorAll(".view-tab")].find((node) => node.textContent?.trim() === ${JSON.stringify(view)}); if (!(button instanceof HTMLButtonElement)) return false; button.click(); return true; })()`);
      await eventually(() => cdp.evaluate(`document.querySelector("#nested-workspace-panel-${view.toLowerCase()}")?.textContent?.includes("Direct child")`), `${view} tab did not render direct children`);
    }
    await cdp.evaluate(`document.querySelector(".nested-workspace-super-card")?.click(); true`);
    await eventually(() => cdp.evaluate(`document.querySelector("#nested-workspace-panel-overview")?.textContent?.includes("Manual purpose")`), "Super-card did not return the current workspace to Overview");
    await cdp.evaluate(`document.querySelector("#nested-workspace-tab-tree")?.click(); true`);
    await eventually(() => cdp.evaluate(`document.querySelector("#nested-workspace-panel-tree")?.textContent?.includes("Direct child")`), "Tree did not return after the super-card overview route");
    await cdp.evaluate(`(() => { const input = document.querySelector(".nested-workspace-descendants-toggle input"); if (!(input instanceof HTMLInputElement)) return false; input.click(); return true; })()`);
    await eventually(() => cdp.evaluate(`document.querySelector(".nested-workspace-load-more") instanceof HTMLButtonElement`), "Descendants pagination control did not appear");
    await cdp.evaluate(`(() => { const button = document.querySelector(".nested-workspace-load-more"); if (!(button instanceof HTMLButtonElement)) return false; button.click(); return true; })()`);
    await eventually(() => cdp.evaluate(`document.querySelector(".nested-workspace-tree")?.textContent?.includes("Deep descendant three")`), "Descendant pagination did not expose deep descendants");
    await cdp.evaluate(`(() => { const input = document.querySelector(".nested-workspace-descendants-toggle input"); if (!(input instanceof HTMLInputElement) || !input.checked) return false; input.click(); return true; })()`);
    await eventually(() => cdp.evaluate(`document.querySelector(".nested-workspace-load-more") instanceof HTMLButtonElement`), "Direct-children pagination control did not return");
    await cdp.evaluate(`document.querySelector(".nested-workspace-load-more")?.click(); true`);
    await eventually(() => cdp.evaluate(`document.querySelector(".nested-workspace-tree")?.textContent?.includes("Direct child 62")`), "Children pagination did not load the later page");

    await goBackToSource();
    const boardScroll = await cdp.evaluate(`(() => { const rails = [...document.querySelectorAll(".board-column")].filter((column) => /Workspace todo [AB]/.test(column.textContent ?? "")).map((column) => column.querySelector(".column-list")).filter((node) => node instanceof HTMLElement); if (rails.length !== 2) return false; rails.forEach((rail, index) => { rail.scrollTop = 120 + index * 80; rail.dispatchEvent(new Event("scroll", { bubbles: true })); }); return rails.map((rail) => rail.scrollTop); })()`);
    assert.ok(Array.isArray(boardScroll) && boardScroll.every((value) => value > 0), "Board fixture must scroll both same-status rails");
    await enterWorkspace(); await goBackToSource();
    const restoredBoard = await cdp.evaluate(`(() => [...document.querySelectorAll(".board-column")].filter((column) => /Workspace todo [AB]/.test(column.textContent ?? "")).map((column) => column.querySelector(".column-list")?.scrollTop))()`);
    assert.deepEqual(restoredBoard, boardScroll, "Board history restoration must retain distinct stage rails");

    for (const [label, selector] of [["List", ".issue-list-view"], ["Gantt", ".gantt_ver_scroll"]]) {
      await cdp.evaluate(`(() => { const button = [...document.querySelectorAll("button, a")].find((node) => node.textContent?.trim() === ${JSON.stringify(label)}); if (!(button instanceof HTMLElement)) return false; button.click(); return true; })()`);
      const saved = await eventually(async () => cdp.evaluate(`(() => { const scroller = document.querySelector(${JSON.stringify(selector)}); if (!(scroller instanceof HTMLElement) || scroller.scrollHeight <= scroller.clientHeight) return null; scroller.scrollTop = Math.min(180, scroller.scrollHeight - scroller.clientHeight); scroller.dispatchEvent(new Event("scroll", { bubbles: true })); return scroller.scrollTop; })()`), `${label} source must have a vertical scroll range`);
      await enterWorkspace(); await goBackToSource();
      await eventually(() => cdp.evaluate(`document.querySelector(${JSON.stringify(selector)})?.scrollTop === ${saved}`), `${label} history restoration lost source scroll`);
    }

    assert.equal(proxy.rejected.length, 0, `Workspace UI attempted a mutation: ${proxy.rejected.join(", ")}`);
    assert.ok(proxy.methods.length > 0 && proxy.methods.every((method) => method === "GET"), "Only GET requests may reach the read-only proxy");
    const rootApi = `/api/tasks/${encodeURIComponent(fixture.root.identifier)}`;
    assert.ok(proxy.requests.some((request) => request.method === "GET" && request.url === `${rootApi}/workspace`), "UI must read the real workspace endpoint");
    assert.ok(proxy.requests.some((request) => request.method === "GET" && request.url === `${rootApi}/rollup`), "UI must read real rollup provenance");
    assert.ok(proxy.requests.some((request) => request.url.startsWith(`${rootApi}/workspace?`) && request.url.includes("childrenCursor=")), "Children pagination must use its scoped cursor");
    assert.ok(proxy.requests.some((request) => request.url.startsWith(`${rootApi}/workspace?`) && request.url.includes("descendants=true") && request.url.includes("descendantsCursor=")), "Descendants pagination must use descendants=true and its scoped cursor");
    const database = new TaskboardDatabase(path.join(directory, "taskboard.sqlite"));
    try {
      const root = database.getTask(fixture.root.id);
      assert.equal(root.status, "in_review");
      assert.equal(root.description, "Manual purpose: ship without moving the parent.");
      assert.equal(root.version, fixture.root.version, "Read projection must not move or edit its parent");
      assert.deepEqual(database.database.prepare("SELECT * FROM tasks ORDER BY id").all(), fixture.snapshot.tasks, "Read projection must not mutate any task row");
      assert.deepEqual(database.database.prepare("SELECT * FROM task_relations ORDER BY relation_type, source_task_id, target_task_id").all(), fixture.snapshot.relations, "Read projection must not mutate relations");
    } finally { database.close(); }
  } finally {
    cdp?.close();
    await stop(child);
    await proxy?.close();
    await app?.close();
    await rm(directory, { recursive: true, force: true });
  }
});
