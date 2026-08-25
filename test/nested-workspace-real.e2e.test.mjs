import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, request as httpRequest } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import WebSocket from "ws";

import { createTaskboardServer } from "../server/index.mjs";
import { TaskboardDatabase } from "../server/database.mjs";
import { captureStderrTail, waitForChromeDebugPort } from "./helpers/chrome-diagnostics.mjs";
import { stopChild } from "./helpers/stop-child.mjs";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const actor = { type: "user", id: "workspace-e2e", name: "Workspace E2E", avatarUrl: null };
const cdpTimeoutMs = 10_000;
const teardownTimeoutMs = 5_000;

function chromeExecutable() {
  return [process.env.CHROME_BIN, "/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser"]
    .find((candidate) => candidate && existsSync(candidate));
}

function wait(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function withTimeout(promise, timeoutMs, message) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

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

async function chromeDebugPort(profile, child, stderrCapture, getStartupError) {
  return waitForChromeDebugPort({
    child,
    stderrTail: stderrCapture.read,
    getStartupError,
    paths: {
      profile,
      tempDirectory: path.dirname(profile),
      tempRoot: os.tmpdir(),
      homeDirectory: process.env.HOME,
    },
    timeoutMs: 12_000,
    readPort: async () => {
      const lines = (await readFile(path.join(profile, "DevToolsActivePort"), "utf8")).trim().split("\n");
      return Number(lines[0]) || null;
    },
  });
}

async function connectCdp(port) {
  const target = await eventually(async () => {
    const response = await fetch(`http://127.0.0.1:${port}/json/list`, {
      signal: AbortSignal.timeout(cdpTimeoutMs),
    });
    if (!response.ok) return null;
    return (await response.json()).find((entry) => entry.type === "page") ?? null;
  }, "Chrome page target did not become available");
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      socket.terminate();
      reject(new Error("Chrome DevTools WebSocket did not open"));
    }, cdpTimeoutMs);
    const cleanup = () => {
      clearTimeout(timeout);
      socket.off("open", onOpen);
      socket.off("error", onError);
    };
    const onOpen = () => { cleanup(); resolve(); };
    const onError = (error) => { cleanup(); reject(error); };
    socket.once("open", onOpen);
    socket.once("error", onError);
  });
  let sequence = 0;
  const pending = new Map();
  let disposed = false;
  let disposePromise;
  let resolveClosed;
  const closed = new Promise((resolve) => { resolveClosed = resolve; });
  const rejectPending = (error) => {
    for (const { reject, timer } of pending.values()) {
      clearTimeout(timer);
      reject(error);
    }
    pending.clear();
  };
  const onError = (error) => rejectPending(error);
  const onClose = () => {
    rejectPending(new Error("Chrome DevTools WebSocket closed"));
    resolveClosed();
  };
  socket.on("message", (raw) => {
    let message;
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    clearTimeout(request.timer);
    if (message.error) request.reject(new Error(message.error.message));
    else request.resolve(message.result);
  });
  socket.on("error", onError);
  socket.once("close", onClose);
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    if (disposed || socket.readyState !== WebSocket.OPEN) {
      reject(new Error(`Chrome DevTools WebSocket is unavailable for ${method}`));
      return;
    }
    const id = ++sequence;
    const fail = (error) => {
      const request = pending.get(id);
      if (!request) return;
      pending.delete(id);
      clearTimeout(request.timer);
      request.reject(error);
    };
    const timer = setTimeout(() => fail(new Error(`Chrome DevTools command timed out: ${method}`)), cdpTimeoutMs);
    pending.set(id, { resolve, reject, timer });
    try {
      socket.send(JSON.stringify({ id, method, params }), (error) => {
        if (error) fail(error);
      });
    } catch (error) {
      fail(error);
    }
  });
  return {
    send,
    async evaluate(expression) {
      const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
      return result.result.value;
    },
    async close() {
      if (disposePromise) return disposePromise;
      disposed = true;
      rejectPending(new Error("Chrome DevTools client disposed"));
      disposePromise = (async () => {
        if (socket.readyState !== WebSocket.CLOSED) socket.close();
        try {
          await withTimeout(closed, teardownTimeoutMs, "Chrome DevTools WebSocket did not close");
        } catch (closeError) {
          socket.terminate();
          try {
            await withTimeout(closed, teardownTimeoutMs, "Chrome DevTools WebSocket did not terminate");
          } catch (terminateError) {
            throw new AggregateError([closeError, terminateError], "Chrome DevTools WebSocket teardown failed");
          }
          throw closeError;
        } finally {
          socket.off("error", onError);
          socket.off("close", onClose);
        }
      })();
      return disposePromise;
    },
  };
}

async function stop(child) {
  await stopChild(child, { timeoutMs: teardownTimeoutMs, name: "Chrome" });
}

async function startReadOnlyProxy(targetOrigin) {
  const methods = [];
  const rejected = [];
  const requests = [];
  const clientRequests = new Set();
  const sockets = new Set();
  const trackSocket = (socket) => {
    if (sockets.has(socket)) return;
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  };
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
    clientRequests.add(upstream);
    const abortUpstream = () => {
      if (!upstream.destroyed) upstream.destroy();
    };
    request.once("aborted", abortUpstream);
    response.once("close", abortUpstream);
    upstream.once("close", () => {
      clientRequests.delete(upstream);
      request.off("aborted", abortUpstream);
      response.off("close", abortUpstream);
    });
    upstream.on("socket", trackSocket);
    upstream.on("error", () => response.destroy());
    request.pipe(upstream);
  });
  proxy.on("connection", trackSocket);
  await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  const address = proxy.address();
  assert.ok(address && typeof address === "object");
  return {
    origin: `http://127.0.0.1:${address.port}`,
    methods,
    rejected,
    requests,
    async close() {
      const closed = new Promise((resolve, reject) => {
        proxy.close((error) => error ? reject(error) : resolve());
      });
      for (const request of clientRequests) request.destroy();
      for (const socket of sockets) socket.destroy();
      await closed;
      proxy.off("connection", trackSocket);
      clientRequests.clear();
      sockets.clear();
    },
  };
}

function seedWorkspace(directory) {
  const database = new TaskboardDatabase(path.join(directory, "taskboard.sqlite"));
  const create = (title, status, stageId, description = "", dates = {}) => database.createTask({
    projectId: "alpha", title, description, status, stageId, priority: "none", labels: [], actor,
    assignee: actor, developmentContext: null, startDate: dates.startDate ?? null, dueDate: dates.dueDate ?? null, recurrence: null,
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
      const dates = index % 2 === 0 ? { startDate: `2026-08-${String((index % 28) + 1).padStart(2, "0")}` } : {};
      direct.push(relate(create(`Direct child ${String(index + 1).padStart(2, "0")}`, status, stageId, "", dates), root));
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
  let stderrCapture;
  let cleanupPromise;
  const cleanup = () => {
    if (cleanupPromise) return cleanupPromise;
    cleanupPromise = (async () => {
      let firstError;
      const attempt = async (operation) => {
        try { await operation(); } catch (error) { firstError ??= error; }
      };
      await attempt(() => cdp?.close());
      await attempt(() => stop(child));
      await attempt(() => stderrCapture?.dispose());
      await attempt(() => proxy?.close());
      await attempt(() => app?.server.closeAllConnections?.());
      await attempt(() => app?.close());
      await attempt(() => rm(directory, { recursive: true, force: true }));
      if (firstError) throw firstError;
    })();
    return cleanupPromise;
  };
  const onAbort = () => { void cleanup().catch(() => {}); };
  t.signal.addEventListener("abort", onAbort, { once: true });
  try {
    const fixture = seedWorkspace(directory);
    app = createTaskboardServer({ dataDirectory: directory });
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    proxy = await startReadOnlyProxy(`http://127.0.0.1:${address.port}`);
    const profile = path.join(directory, "chrome");
    child = spawn(chrome, ["--headless=new", "--disable-background-networking", "--disable-gpu", "--no-first-run", "--no-sandbox", "--remote-debugging-address=127.0.0.1", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
    stderrCapture = captureStderrTail(child.stderr);
    let chromeStartupError;
    child.once("error", (error) => { chromeStartupError = error; });
    cdp = await connectCdp(await chromeDebugPort(profile, child, stderrCapture, () => chromeStartupError));
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1366, height: 768, deviceScaleFactor: 1, mobile: false });
    await cdp.send("Page.navigate", { url: `${proxy.origin}/?project=alpha` });
    await eventually(() => cdp.evaluate(`document.querySelectorAll(".task-card").length >= 50`), "Board did not render seeded direct children");

    async function openRootDetail(sourceView) {
      if (sourceView === "board") {
        const opened = await cdp.evaluate(`(() => {
          const card = [...document.querySelectorAll(".task-card")].find((node) => node.textContent?.includes("Release workspace"));
          const button = card?.querySelector(".task-card-open");
          if (!(button instanceof HTMLButtonElement)) return false;
          button.click();
          return true;
        })()`);
        assert.equal(opened, true, "Fixture root card must open its detail from Board");
      } else if (sourceView === "list") {
        const opened = await cdp.evaluate(`(() => {
          const row = [...document.querySelectorAll(".issue-list-row")].find((node) => node.querySelector(".issue-list-title-cell strong")?.textContent?.trim() === "Release workspace");
          if (!(row instanceof HTMLElement)) return false;
          row.click();
          return true;
        })()`);
        assert.equal(opened, true, "Fixture root row must open its detail from List");
      } else if (sourceView === "gantt") {
        const opened = await eventually(() => cdp.evaluate(`(() => {
          const taskId = ${JSON.stringify(fixture.root.id)};
          const row = document.querySelector('.gantt_row[task_id="' + taskId + '"]');
          if (!(row instanceof HTMLElement) || !row.textContent?.includes("Release workspace")) return false;
          row.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true, detail: 2 }));
          return true;
        })()`), "Fixture root must render as a Gantt row");
        assert.equal(opened, true, "Fixture root Gantt row must receive a double-click");
      } else {
        throw new Error(`Unsupported workspace source view: ${sourceView}`);
      }
      await eventually(() => cdp.evaluate(`document.querySelector(".issue-detail")?.textContent?.includes("Release workspace")`), `Fixture root detail did not open from ${sourceView}`);
    }

    async function enterWorkspace(sourceView) {
      await openRootDetail(sourceView);
      await eventually(() => cdp.evaluate(`document.querySelector("button[aria-label='Abrir fluxo aninhado']") instanceof HTMLButtonElement`), "Supra-item detail did not expose the nested-workspace entry point");
      const openedWorkspace = await cdp.evaluate(`(() => {
        const button = document.querySelector("button[aria-label='Abrir fluxo aninhado']");
        if (!(button instanceof HTMLButtonElement)) return false;
        button.click();
        return true;
      })()`);
      assert.equal(openedWorkspace, true, "Nested-workspace entry point must be clickable");
      await eventually(() => cdp.evaluate(`document.querySelector(".nested-workspace-view")?.textContent?.includes("Manual purpose: ship without moving the parent.")`), "Workspace overview did not load");
      const route = await cdp.evaluate(`({ issue: new URL(location.href).searchParams.get("issue"), workspace: new URL(location.href).searchParams.get("workspace"), view: new URL(location.href).searchParams.get("view") })`);
      assert.deepEqual(route, { issue: null, workspace: fixture.root.identifier, view: "overview" });
    }
    async function goBackToSource(sourceView) {
      await cdp.evaluate(`history.back(); true`);
      const selector = sourceView === "board"
        ? ".board-column"
        : sourceView === "list"
          ? ".issue-list-view"
          : ".gantt_ver_scroll";
      const restored = await eventually(() => cdp.evaluate(`(() => {
        const url = new URL(location.href);
        if (document.querySelector(".nested-workspace-view") || !document.querySelector(${JSON.stringify(selector)})) return null;
        if (url.searchParams.get("issue") || url.searchParams.get("workspace") || url.searchParams.get("view")) return null;
        return {
          issue: url.searchParams.get("issue"),
          workspace: url.searchParams.get("workspace"),
          view: url.searchParams.get("view"),
          sourceView: ${JSON.stringify(sourceView)},
        };
      })()`), `History back did not restore the ${sourceView} source view`);
      assert.deepEqual(restored, {
        issue: null,
        workspace: null,
        view: null,
        sourceView,
      });
    }

    await enterWorkspace("board");
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

    for (const view of ["Overview", "Board", "List", "Tree", "Mind Map", "Timeline"]) {
      await cdp.evaluate(`(() => { const button = [...document.querySelectorAll(".view-tab")].find((node) => node.textContent?.trim() === ${JSON.stringify(view)}); if (!(button instanceof HTMLButtonElement)) return false; button.click(); return true; })()`);
      const panel = view === "Mind Map" ? "mindmap" : view.toLowerCase();
      const expectedText = view === "Overview" ? "Manual purpose" : "Direct child";
      await eventually(() => cdp.evaluate(`document.querySelector("#nested-workspace-panel-${panel}")?.textContent?.includes(${JSON.stringify(expectedText)})`), `${view} tab did not render its expected projection`);
    }
    await cdp.evaluate(`document.querySelector("#nested-workspace-tab-mindmap")?.click(); true`);
    const mapNodes = await cdp.evaluate(`document.querySelectorAll(".workspace-mindmap-node").length`);
    assert.ok(mapNodes > 1, "Mind Map must render the root and loaded workspace items");
    await cdp.evaluate(`document.querySelector("#nested-workspace-tab-timeline")?.click(); true`);
    const projectionDesktop = await cdp.evaluate(`(() => ({
      timelineRows: document.querySelectorAll(".workspace-timeline li").length,
      undated: document.querySelectorAll(".workspace-timeline .is-undated").length,
    }))()`);
    assert.ok(
      projectionDesktop.timelineRows > 0
        && projectionDesktop.undated > 0
        && projectionDesktop.undated < projectionDesktop.timelineRows,
      `Timeline must render both persisted scheduled and unscheduled items: ${JSON.stringify(projectionDesktop)}`,
    );
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: false });
    const projectionNarrow = await cdp.evaluate(`(() => ({
      timelineExists: Boolean(document.querySelector(".workspace-timeline")),
      timelineOverflow: document.querySelector(".workspace-timeline")?.scrollWidth > innerWidth,
    }))()`);
    assert.equal(projectionNarrow.timelineExists, true, "Timeline must remain visible at narrow width");
    assert.equal(projectionNarrow.timelineOverflow, false, "Timeline must fit a narrow desktop viewport");
    await cdp.evaluate(`document.querySelector("#nested-workspace-tab-mindmap")?.click(); true`);
    assert.equal(await cdp.evaluate(`document.querySelector(".workspace-mindmap-viewport")?.getAttribute("tabindex")`), "0", "Mind Map pan/zoom surface must remain keyboard focusable at narrow width");
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1366, height: 768, deviceScaleFactor: 1, mobile: false });
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

    await goBackToSource("board");
    const boardScroll = await cdp.evaluate(`(() => { const rails = [...document.querySelectorAll(".board-column")].filter((column) => /Workspace todo [AB]/.test(column.textContent ?? "")).map((column) => column.querySelector(".column-list")).filter((node) => node instanceof HTMLElement); if (rails.length !== 2) return false; rails.forEach((rail, index) => { rail.scrollTop = 120 + index * 80; rail.dispatchEvent(new Event("scroll", { bubbles: true })); }); return rails.map((rail) => rail.scrollTop); })()`);
    assert.deepEqual(boardScroll, [120, 200], "Board fixture must preserve distinct exact same-status rail positions");
    await enterWorkspace("board"); await goBackToSource("board");
    const restoredBoard = await eventually(async () => {
      const values = await cdp.evaluate(`(() => [...document.querySelectorAll(".board-column")].filter((column) => /Workspace todo [AB]/.test(column.textContent ?? "")).map((column) => column.querySelector(".column-list")?.scrollTop))()`);
      return JSON.stringify(values) === JSON.stringify(boardScroll) ? values : null;
    }, "Board history restoration must retain distinct stage rails");
    assert.deepEqual(restoredBoard, boardScroll, "Board history restoration must retain distinct stage rails");

    for (const [label, selector, sourceView] of [["List", ".issue-list-view", "list"], ["Gantt", ".gantt_ver_scroll", "gantt"]]) {
      await cdp.evaluate(`(() => { const button = [...document.querySelectorAll("button, a")].find((node) => node.textContent?.trim() === ${JSON.stringify(label)}); if (!(button instanceof HTMLElement)) return false; button.click(); return true; })()`);
      const saved = sourceView === "gantt"
        ? await eventually(() => cdp.evaluate(`(async () => {
          const scroller = document.querySelector(".gantt_ver_scroll");
          const taskId = ${JSON.stringify(fixture.root.id)};
          if (!(scroller instanceof HTMLElement) || scroller.scrollHeight <= scroller.clientHeight) return null;
          const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));
          for (let top = 0; top <= scroller.scrollHeight - scroller.clientHeight; top += 180) {
            scroller.scrollTop = top;
            scroller.dispatchEvent(new Event("scroll", { bubbles: true }));
            await frame();
            const row = document.querySelector('.gantt_row[task_id="' + taskId + '"]');
            if (!(row instanceof HTMLElement)) continue;
            const rowRect = row.getBoundingClientRect();
            const scrollerRect = scroller.getBoundingClientRect();
            const max = scroller.scrollHeight - scroller.clientHeight;
            const target = Math.max(1, Math.min(max, scroller.scrollTop + rowRect.top - scrollerRect.top - 24));
            scroller.scrollTop = target;
            scroller.dispatchEvent(new Event("scroll", { bubbles: true }));
            await frame();
            return document.querySelector('.gantt_row[task_id="' + taskId + '"]') instanceof HTMLElement
              ? scroller.scrollTop
              : null;
          }
          return null;
        })()`), "Gantt source must scroll while keeping the fixture root rendered")
        : await eventually(async () => cdp.evaluate(`(() => { const scroller = document.querySelector(${JSON.stringify(selector)}); if (!(scroller instanceof HTMLElement) || scroller.scrollHeight <= scroller.clientHeight) return null; scroller.scrollTop = Math.min(180, scroller.scrollHeight - scroller.clientHeight); scroller.dispatchEvent(new Event("scroll", { bubbles: true })); return scroller.scrollTop; })()`), `${label} source must have a vertical scroll range`);
      await enterWorkspace(sourceView); await goBackToSource(sourceView);
      await eventually(() => cdp.evaluate(`document.querySelector(${JSON.stringify(selector)})?.scrollTop === ${saved}`), `${label} history restoration lost source scroll`);
    }

    await enterWorkspace("gantt");
    const workspaceUrl = await cdp.evaluate("location.href");
    await cdp.send("Page.navigate", { url: "about:blank" });
    await cdp.send("Page.navigate", { url: workspaceUrl });
    await eventually(() => cdp.evaluate(`document.querySelector(".nested-workspace-view")?.textContent?.includes("Manual purpose: ship without moving the parent.")`), "Cold nested-workspace deep link did not load its overview");
    const coldRoute = await cdp.evaluate(`({ issue: new URL(location.href).searchParams.get("issue"), workspace: new URL(location.href).searchParams.get("workspace"), view: new URL(location.href).searchParams.get("view"), root: document.querySelector(".nested-workspace-super-card")?.textContent?.includes("Release workspace") })`);
    assert.deepEqual(coldRoute, { issue: null, workspace: fixture.root.identifier, view: "overview", root: true });
    await cdp.send("Page.reload");
    await eventually(() => cdp.evaluate(`document.querySelector(".nested-workspace-view")?.textContent?.includes("Manual purpose: ship without moving the parent.")`), "Reloaded nested-workspace deep link did not restore its overview");
    const reloadedRoute = await cdp.evaluate(`({ issue: new URL(location.href).searchParams.get("issue"), workspace: new URL(location.href).searchParams.get("workspace"), view: new URL(location.href).searchParams.get("view"), root: document.querySelector(".nested-workspace-super-card")?.textContent?.includes("Release workspace") })`);
    assert.deepEqual(reloadedRoute, { issue: null, workspace: fixture.root.identifier, view: "overview", root: true });

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
    t.signal.removeEventListener("abort", onAbort);
    await cleanup();
  }
});
