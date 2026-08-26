import assert from "node:assert/strict";
import { spawn } from "node:child_process";
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
  const create = (title, status, stageId, description = "", options = {}) => {
    const { sortOrder, startDate = null, dueDate = null } = options;
    return database.createTask({
      projectId: "alpha", title, description, status, stageId, priority: "none", labels: [], actor,
      assignee: actor, developmentContext: null, startDate, dueDate, recurrence: null, sortOrder,
    });
  };
  const relate = (child, parent, metadata = undefined) => database.addTaskRelation(
    child.id, child.version, "parent", parent.id, null, null, actor, "manual", metadata,
  ).task;
  try {
    database.createProject({ id: "alpha", name: "Alpha", workspacePath: null });
    // Project creation now publishes the immutable default workflow before
    // any task is accepted. This fixture deliberately uses that public,
    // already-pinned workflow instead of trying to author physical stages.
    const workflow = database.getStageWorkflow("alpha");
    const stageFor = (status) => workflow.definition.stages.find((stage) => stage.canonicalStatus === status && stage.isDefaultForStatus);
    const todo = stageFor("todo");
    assert.ok(stageFor("in_review") && stageFor("in_progress") && stageFor("blocked") && stageFor("done") && todo);

    const vision = create("Vision", "todo", todo.stageId);
    const program = relate(create("Program", "todo", todo.stageId), vision);
    const area = relate(create("Area", "in_progress", stageFor("in_progress").stageId), program);
    const portfolio = relate(create("Portfolio", "todo", todo.stageId), area);
    const root = relate(create("Release workspace", "in_review", stageFor("in_review").stageId, "Manual purpose: ship without moving the parent."), portfolio);
    const direct = [];
    for (let index = 0; index < 62; index += 1) {
      const status = ["todo", "in_progress", "in_review", "blocked", "done"][index % 5];
      const stageId = status === "todo" ? todo.stageId : stageFor(status).stageId;
      const options = {
        sortOrder: index,
        ...(index % 2 === 0 ? { startDate: `2026-08-${String((index % 28) + 1).padStart(2, "0")}` } : {}),
      };
      direct.push(relate(create(`Direct child ${String(index + 1).padStart(2, "0")}`, status, stageId, "", options), root));
    }
    const deepOne = relate(create("Deep descendant one", "in_progress", stageFor("in_progress").stageId), direct[0]);
    const deepTwo = relate(create("Deep descendant two", "todo", todo.stageId), deepOne);
    const deepThree = relate(create("Deep descendant three", "done", stageFor("done").stageId), deepTwo);
    const ignored = relate(create("Non-rollup descendant", "todo", todo.stageId), root, { required: false, rollup: false });
    const snapshot = {
      tasks: database.database.prepare("SELECT * FROM tasks ORDER BY id").all(),
      relations: database.database.prepare("SELECT * FROM task_relations ORDER BY relation_type, source_task_id, target_task_id").all(),
    };
    return { vision, root, program, direct, deepThree, ignored, snapshot };
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
    await cdp.send("Page.navigate", { url: `${proxy.origin}/?project=alpha&workspaceRoot=alpha&view=board` });
    await eventually(() => cdp.evaluate(`document.querySelector("#nested-workspace-panel-board")?.textContent?.includes("Vision")`), "Root Board did not render its immediate task");

    async function selectWorkspaceTab(label) {
      // URL navigation commits before the asynchronously-loaded workspace toolbar
      // is rendered.  Wait for the real tab rather than treating that transient
      // render gap as a missing view.
      await eventually(() => cdp.evaluate(`[
        ...document.querySelectorAll(".view-tab"),
      ].some((node) => node instanceof HTMLButtonElement && node.textContent?.trim() === ${JSON.stringify(label)})`), `Workspace did not expose ${label}`);
      const switched = await cdp.evaluate(`(() => {
        const tab = [...document.querySelectorAll(".view-tab")].find((node) => node.textContent?.trim() === ${JSON.stringify(label)});
        if (!(tab instanceof HTMLButtonElement)) return false;
        tab.click();
        return true;
      })()`);
      assert.equal(switched, true, `Workspace must expose ${label}`);
      const panel = label === "Mind Map" ? "mindmap" : label.toLowerCase();
      await eventually(() => cdp.evaluate(`document.querySelector("#nested-workspace-panel-${panel}") instanceof HTMLElement`), `${label} panel did not render`);
    }

    for (const label of ["Overview", "Board", "List", "Tree", "Mind Map", "Timeline"]) {
      await selectWorkspaceTab(label);
    }
    const rootTabOrder = await cdp.evaluate(`[
      ...document.querySelectorAll(".nested-workspace-toolbar .view-tab"),
    ].map((node) => node.textContent?.trim())`);
    assert.deepEqual(
      rootTabOrder,
      ["Overview", "Board", "List", "Tree", "Mind Map", "Timeline", "Gantt", "Project Docs"],
      "Root-only extras must follow, not replace, the canonical six workspace tabs",
    );
    await cdp.evaluate(`document.querySelector("#nested-workspace-extra-docs")?.click(); true`);
    await eventually(() => cdp.evaluate(`document.querySelector("#nested-workspace-panel-extra-docs .project-readme-container") instanceof HTMLElement`), "Project Docs extra did not render its surface");
    await selectWorkspaceTab("Board");
    await cdp.evaluate(`document.querySelector("#nested-workspace-extra-gantt")?.click(); true`);
    await eventually(() => cdp.evaluate(`document.querySelector("#nested-workspace-panel-extra-gantt .gantt-view") instanceof HTMLElement`), "Gantt extra did not render its surface");
    const ganttExtraRoute = await cdp.evaluate(`(() => {
      const url = new URL(location.href);
      return { workspaceRoot: url.searchParams.get("workspaceRoot"), workspaceExtra: url.searchParams.get("workspaceExtra") };
    })()`);
    assert.deepEqual(ganttExtraRoute, { workspaceRoot: "alpha", workspaceExtra: "gantt" });
    await selectWorkspaceTab("Board");
    for (const panel of ["board", "list"]) {
      await selectWorkspaceTab(panel[0].toUpperCase() + panel.slice(1));
      const rootItems = await cdp.evaluate(`(() => {
        const text = document.querySelector("#nested-workspace-panel-${panel}")?.textContent ?? "";
        return { vision: text.includes("Vision"), program: text.includes("Program") };
      })()`);
      assert.deepEqual(rootItems, { vision: true, program: false }, `Root ${panel} must contain only immediate tasks`);
    }
    await selectWorkspaceTab("Tree");
    await eventually(() => cdp.evaluate(`document.querySelector("#nested-workspace-panel-tree")?.textContent?.includes("Vision") && document.querySelector("#nested-workspace-panel-tree")?.textContent?.includes("Program")`), "Root Tree must include descendants");
    await selectWorkspaceTab("Mind Map");
    await eventually(() => cdp.evaluate(`document.querySelector("#nested-workspace-panel-mindmap")?.textContent?.includes("Vision") && document.querySelector("#nested-workspace-panel-mindmap")?.textContent?.includes("Program")`), "Root Mind Map must include descendants");

    await selectWorkspaceTab("List");

    const visionDetail = await cdp.evaluate(`(() => {
      const button = [...document.querySelectorAll(".nested-workspace-item-detail")].find((node) => node.textContent?.includes("Details"));
      if (!(button instanceof HTMLButtonElement)) return false;
      button.click();
      return true;
    })()`);
    assert.equal(visionDetail, true, "Project cards retain an explicit detail affordance");
    await eventually(() => cdp.evaluate(`document.querySelector(".issue-detail")?.textContent?.includes("Vision")`), "Explicit project-card detail did not open");
    await cdp.evaluate(`history.back(); true`);
    await eventually(() => cdp.evaluate(`document.querySelector("#nested-workspace-panel-list")?.textContent?.includes("Vision")`), "Back did not restore the root List workspace");

    const openedVisionFromList = await cdp.evaluate(`(() => {
      const item = [...document.querySelectorAll(".nested-workspace-item")].find((node) => node.textContent?.includes("Vision"));
      if (!(item instanceof HTMLButtonElement)) return false;
      item.click();
      return true;
    })()`);
    assert.equal(openedVisionFromList, true, "Normal click on a root List parent-card must open its nested workspace");
    await eventually(() => cdp.evaluate(`new URL(location.href).searchParams.get("workspace") === ${JSON.stringify(fixture.vision.identifier)}`), "Root List parent-card did not open its nested workspace");
    await cdp.evaluate(`history.back(); true`);
    await eventually(() => cdp.evaluate(`new URL(location.href).searchParams.get("workspaceRoot") === "alpha" && new URL(location.href).searchParams.get("workspace") === null && document.querySelector("#nested-workspace-panel-list") instanceof HTMLElement`), "Browser Back did not restore the root List workspace");

    await selectWorkspaceTab("Board");
    const openedVision = await cdp.evaluate(`(() => {
      const item = [...document.querySelectorAll(".nested-workspace-item")].find((node) => node.textContent?.includes("Vision"));
      if (!(item instanceof HTMLButtonElement)) return false;
      item.click();
      return true;
    })()`);
    assert.equal(openedVision, true, "Normal click on a root supra-card must open its nested workspace");
    await eventually(() => cdp.evaluate(`new URL(location.href).searchParams.get("workspace") === ${JSON.stringify(fixture.vision.identifier)}`), "Root supra-card did not open its child workspace");

    await eventually(() => cdp.evaluate(`[
      ...document.querySelectorAll(".nested-workspace-breadcrumb button"),
    ].some((node) => node.textContent?.trim() === "Alpha")`), "Nested workspace must expose the root breadcrumb");
    const breadcrumbLabels = await cdp.evaluate(`[
      ...document.querySelectorAll(".nested-workspace-breadcrumb button"),
    ].map((node) => node.textContent?.trim())`);
    const breadcrumbToRoot = await cdp.evaluate(`(() => {
      const button = [...document.querySelectorAll(".nested-workspace-breadcrumb button")].find((node) => node.textContent?.trim() === "Alpha");
      if (!(button instanceof HTMLButtonElement)) return false;
      button.click();
      return true;
    })()`);
    assert.equal(breadcrumbToRoot, true, `Nested workspace must expose the root breadcrumb (found: ${breadcrumbLabels.join(", ")})`);
    await eventually(() => cdp.evaluate(`new URL(location.href).searchParams.get("workspaceRoot") === "alpha" && new URL(location.href).searchParams.get("workspace") === null`), "Root breadcrumb did not return to the root workspace");
    await selectWorkspaceTab("Board");
    const reopenedVision = await cdp.evaluate(`(() => {
      const item = [...document.querySelectorAll(".nested-workspace-item")].find((node) => node.textContent?.includes("Vision"));
      if (!(item instanceof HTMLButtonElement)) return false;
      item.click();
      return true;
    })()`);
    assert.equal(reopenedVision, true);
    await eventually(() => cdp.evaluate(`new URL(location.href).searchParams.get("workspace") === ${JSON.stringify(fixture.vision.identifier)}`), "Root Board did not reopen Vision after breadcrumb return");

    for (const title of ["Program", "Area", "Portfolio", "Release workspace"]) {
      await selectWorkspaceTab("Board");
      const opened = await cdp.evaluate(`(() => {
        const item = [...document.querySelectorAll(".nested-workspace-item")].find((node) => node.textContent?.includes(${JSON.stringify(title)}));
        if (!(item instanceof HTMLButtonElement)) return false;
        item.click();
        return true;
      })()`);
      assert.equal(opened, true, `${title} must be a direct nested-workspace step`);
      await eventually(() => cdp.evaluate(`document.querySelector(".nested-workspace-super-card")?.textContent?.includes(${JSON.stringify(title)})`), `${title} workspace did not open`);
    }

    await selectWorkspaceTab("List");
    await eventually(() => cdp.evaluate(`document.querySelector("#nested-workspace-panel-list")?.textContent?.includes("Direct child 02")`), "Release workspace did not list a fixture leaf");
    const leafOpened = await cdp.evaluate(`(() => {
      const item = [...document.querySelectorAll(".nested-workspace-item")].find((node) => node.textContent?.includes("Direct child 02"));
      if (!(item instanceof HTMLButtonElement)) return false;
      item.click();
      return true;
    })()`);
    assert.equal(leafOpened, true);
    await eventually(() => cdp.evaluate(`document.querySelector(".issue-detail")?.textContent?.includes("Direct child 02")`), "Leaf normal click must open detail");
    await cdp.evaluate(`history.back(); true`);
    await eventually(() => cdp.evaluate(`document.querySelector("#nested-workspace-panel-list")?.textContent?.includes("Direct child 02")`), "Back did not restore the release List workspace");

    const leafDetail = await cdp.evaluate(`(() => {
      const button = [...document.querySelectorAll(".nested-workspace-item-detail")].find((node) => node.getAttribute("aria-label")?.endsWith(${JSON.stringify(fixture.direct[1].identifier)}));
      if (!(button instanceof HTMLButtonElement)) return false;
      button.click();
      return true;
    })()`);
    assert.equal(leafDetail, true, "Leaf must retain an explicit detail action");
    await eventually(() => cdp.evaluate(`document.querySelector(".issue-detail")?.textContent?.includes("Direct child 02")`), "Explicit leaf detail did not open");
    await cdp.evaluate(`history.back(); true`);

    await selectWorkspaceTab("Tree");
    await cdp.evaluate(`document.querySelector(".nested-workspace-descendants-toggle input")?.click(); true`);
    await eventually(() => cdp.evaluate(`document.querySelector(".nested-workspace-load-more") instanceof HTMLButtonElement`), "Descendant pagination did not appear");
    await cdp.evaluate(`document.querySelector(".nested-workspace-load-more")?.click(); true`);
    await eventually(() => cdp.evaluate(`document.querySelector(".nested-workspace-tree")?.textContent?.includes("Deep descendant three")`), "Descendant pagination did not expose the deep hierarchy");

    const releaseUrl = await cdp.evaluate("location.href");
    await cdp.send("Page.navigate", { url: "about:blank" });
    await cdp.send("Page.navigate", { url: releaseUrl });
    await eventually(() => cdp.evaluate(`document.querySelector(".nested-workspace-super-card")?.textContent?.includes("Release workspace")`), "Task-workspace cold deep link did not reload");
    await cdp.send("Page.navigate", { url: `${proxy.origin}/?project=alpha&workspaceRoot=alpha&view=timeline` });
    await eventually(() => cdp.evaluate(`document.querySelector("#nested-workspace-panel-timeline") instanceof HTMLElement`), "Root-project cold deep link did not retain Timeline");
    await cdp.send("Page.reload");
    await eventually(() => cdp.evaluate(`document.querySelector("#nested-workspace-panel-timeline") instanceof HTMLElement`), "Root-project reload did not retain Timeline");

    assert.equal(proxy.rejected.length, 0, `Workspace UI attempted a mutation: ${proxy.rejected.join(", ")}`);
    assert.ok(proxy.methods.length > 0 && proxy.methods.every((method) => method === "GET"), "Only GET requests may reach the read-only proxy");
    const database = new TaskboardDatabase(path.join(directory, "taskboard.sqlite"));
    try {
      assert.deepEqual(database.database.prepare("SELECT * FROM tasks ORDER BY id").all(), fixture.snapshot.tasks, "Read projections must not mutate task rows");
      assert.deepEqual(database.database.prepare("SELECT * FROM task_relations ORDER BY relation_type, source_task_id, target_task_id").all(), fixture.snapshot.relations, "Read projections must not mutate relations");
    } finally { database.close(); }

  } finally {
    t.signal.removeEventListener("abort", onAbort);
    await cleanup();
  }
});
