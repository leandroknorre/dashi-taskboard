import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { request as httpRequest, createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import test from "node:test";
import WebSocket from "ws";

import { createTaskboardServer } from "../server/index.mjs";
import { TaskboardDatabase } from "../server/database.mjs";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const delayMs = 1_800;

function chromeExecutable() {
  return [
    process.env.CHROME_BIN,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ].find((candidate) => candidate && existsSync(candidate));
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function eventually(action, message, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await action();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await wait(100);
  }
  throw new Error(`${message}${lastError ? `: ${lastError.message}` : ""}`);
}

function seedWorkflowFixture(directory) {
  const database = new TaskboardDatabase(path.join(directory, "taskboard.sqlite"));
  const actor = { type: "user", id: "user", name: "User", avatarUrl: null };
  try {
    database.createProject({ id: "alpha", name: "Alpha", workspacePath: null });
    const initial = database.getStageWorkflow("alpha");
    const extras = Array.from({ length: 7 }, (_, index) => ({
      stageId: randomUUID(),
      canonicalStatus: "todo",
      name: `Stage ${index + 8}`,
      order: initial.definition.stages.length + index,
      boardVisible: true,
      active: true,
      isDefaultForStatus: false,
      terminalKind: "none",
    }));
    const workflow = database.saveStageWorkflow("alpha", initial.version, {
      schemaVersion: 2,
      stages: [...initial.definition.stages, ...extras],
    });
    for (let index = 0; index < 35; index += 1) {
      const stage = workflow.definition.stages[index % workflow.definition.stages.length];
      database.createTask({
        projectId: "alpha",
        title: `Card ${index + 1}`,
        description: "",
        status: stage.canonicalStatus,
        stageId: stage.stageId,
        priority: "none",
        labels: [],
        actor,
        assignee: actor,
        developmentContext: null,
        startDate: null,
        dueDate: null,
        recurrence: null,
      });
    }
  } finally {
    database.close();
  }
}

function seedBoardScrollFixture(directory) {
  const database = new TaskboardDatabase(path.join(directory, "taskboard.sqlite"));
  const actor = { type: "user", id: "user", name: "User", avatarUrl: null };
  try {
    database.createProject({ id: "alpha", name: "Alpha", workspacePath: null });
    const initial = database.getStageWorkflow("alpha");
    const stages = [
      ...initial.definition.stages,
      {
        stageId: randomUUID(),
        canonicalStatus: "todo",
        name: "First todo rail",
        order: initial.definition.stages.length,
        boardVisible: true,
        active: true,
        isDefaultForStatus: false,
        terminalKind: "none",
      },
      {
        stageId: randomUUID(),
        canonicalStatus: "todo",
        name: "Second todo rail",
        order: initial.definition.stages.length + 1,
        boardVisible: true,
        active: true,
        isDefaultForStatus: false,
        terminalKind: "none",
      },
    ];
    const workflow = database.saveStageWorkflow("alpha", initial.version, {
      schemaVersion: 2,
      stages,
    });
    const [firstStage, secondStage] = workflow.definition.stages.filter((stage) => (
      stage.name === "First todo rail" || stage.name === "Second todo rail"
    ));
    assert.ok(firstStage && secondStage, "fixture must retain both custom todo stages");
    for (const [stage, prefix] of [[firstStage, "First"], [secondStage, "Second"]]) {
      for (let index = 0; index < 14; index += 1) {
        database.createTask({
          projectId: "alpha",
          title: `${prefix} rail card ${index + 1}`,
          description: "",
          status: stage.canonicalStatus,
          stageId: stage.stageId,
          priority: "none",
          labels: [],
          actor,
          assignee: actor,
          developmentContext: null,
          startDate: null,
          dueDate: null,
          recurrence: null,
        });
      }
    }
  } finally {
    database.close();
  }
}

async function startDelayedProxy(targetOrigin) {
  let delayedWorkflowResponses = 0;
  let releasedWorkflowResponses = 0;
  const proxy = createServer((request, response) => {
    const target = new URL(request.url ?? "/", targetOrigin);
    const upstream = httpRequest(target, {
      method: request.method,
      headers: { ...request.headers, host: target.host },
    }, (upstreamResponse) => {
      const forward = () => {
        if (response.destroyed) return;
        response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
        upstreamResponse.pipe(response);
      };
      if (request.method === "GET" && target.pathname === "/api/projects/alpha/stage-workflow") {
        delayedWorkflowResponses += 1;
        setTimeout(() => {
          releasedWorkflowResponses += 1;
          forward();
        }, delayMs);
      } else {
        forward();
      }
    });
    upstream.on("error", () => {
      if (!response.headersSent && !response.destroyed) response.writeHead(502).end();
    });
    request.pipe(upstream);
  });
  await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  const address = proxy.address();
  assert.ok(address && typeof address === "object");
  return {
    origin: `http://127.0.0.1:${address.port}`,
    delayedWorkflowResponses: () => delayedWorkflowResponses,
    releasedWorkflowResponses: () => releasedWorkflowResponses,
    close: () => new Promise((resolve, reject) => proxy.close((error) => error ? reject(error) : resolve())),
  };
}

async function chromeDebugPort(profile) {
  const value = await eventually(async () => {
    try {
      const lines = (await readFile(path.join(profile, "DevToolsActivePort"), "utf8")).trim().split("\n");
      return Number(lines[0]) || null;
    } catch {
      return null;
    }
  }, "Chrome did not publish its DevTools port");
  return value;
}

async function connectCdp(port) {
  const targets = await eventually(async () => {
    const response = await fetch(`http://127.0.0.1:${port}/json/list`);
    if (!response.ok) return null;
    const pages = await response.json();
    return pages.find((candidate) => candidate.type === "page") ?? null;
  }, "Chrome page target did not become available");
  const socket = new WebSocket(targets.webSocketDebuggerUrl);
  await once(socket, "open");
  let sequence = 0;
  const pending = new Map();
  socket.on("message", (raw) => {
    const message = JSON.parse(raw);
    if (!message.id || !pending.has(message.id)) return;
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) reject(new Error(message.error.message));
    else resolve(message.result);
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
  return {
    async evaluate(expression) {
      const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
      return result.result.value;
    },
    send,
    close() {
      socket.close();
    },
  };
}

async function stop(child) {
  if (!child || child.exitCode !== null) return;
  child.kill("SIGTERM");
  const exited = once(child, "exit");
  let timeout;
  await Promise.race([exited, new Promise((resolve) => { timeout = setTimeout(resolve, 5_000); })]);
  clearTimeout(timeout);
  if (child.exitCode === null) {
    child.kill("SIGKILL");
    await exited;
  }
}

test("App repaints real DHTMLX Gantt when the project workflow arrives late", { timeout: 60_000 }, async (t) => {
  const chrome = chromeExecutable();
  assert.ok(chrome, "Chrome or Chromium is required for the Gantt workflow acceptance test");
  if (!existsSync(path.join(projectRoot, "dist", "web", "index.html"))) {
    t.skip("built web assets unavailable; run npm run test:gantt-workflow");
    return;
  }

  const directory = await mkdtemp(path.join(os.tmpdir(), "taskboard-gantt-workflow-"));
  let app;
  let proxy;
  let child;
  let cdp;
  try {
    seedWorkflowFixture(directory);
    app = createTaskboardServer({ dataDirectory: directory });
    const appAddress = await app.listen({ host: "127.0.0.1", port: 0 });
    proxy = await startDelayedProxy(`http://127.0.0.1:${appAddress.port}`);
    const profile = path.join(directory, "chrome");
    child = spawn(chrome, [
      "--headless=new",
      "--disable-background-networking",
      "--disable-gpu",
      "--no-first-run",
      "--no-sandbox",
      "--remote-debugging-address=127.0.0.1",
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
      "about:blank",
    ], { stdio: "ignore" });
    const debugPort = await chromeDebugPort(profile);
    cdp = await connectCdp(debugPort);
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: 1366,
      height: 768,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await cdp.send("Page.navigate", { url: `${proxy.origin}/?project=alpha` });
    await eventually(async () => cdp.evaluate(`(() => {
      const gantt = [...document.querySelectorAll("button, a")].find((node) => node.textContent?.trim() === "Gantt");
      if (!gantt) return false;
      gantt.click();
      return true;
    })()`), "Gantt navigation did not become available");
    await eventually(
      () => proxy.delayedWorkflowResponses() > 0,
      "App did not request the project workflow",
    );
    const before = await eventually(async () => {
      const gridText = await cdp.evaluate(`document.querySelector(".gantt_grid_data")?.innerText ?? ""`);
      return /To do|In progress/.test(gridText) && !/Stage 14/.test(gridText) ? gridText : null;
    }, "Canonical Gantt groups did not render before the delayed workflow arrives", delayMs - 250);
    assert.equal(proxy.releasedWorkflowResponses(), 0, "Gantt must open before the delayed workflow arrives");
    assert.match(before, /To do|In progress/);
    assert.doesNotMatch(before, /Stage 14/);

    await eventually(
      () => proxy.releasedWorkflowResponses() > 0,
      "Delayed workflow response was not released",
      delayMs + 2_000,
    );
    const bottom = await eventually(async () => cdp.evaluate(`(() => {
      const scroller = document.querySelector(".gantt_ver_scroll");
      if (!(scroller instanceof HTMLElement)) return { error: "Gantt vertical scroller missing" };
      scroller.scrollTop = scroller.scrollHeight;
      scroller.dispatchEvent(new Event("scroll", { bubbles: true }));
      return {
        text: document.querySelector(".gantt_grid_data")?.innerText ?? "",
        scrollTop: scroller.scrollTop,
        maxScrollTop: scroller.scrollHeight - scroller.clientHeight,
      };
    })()`), "Custom workflow did not repaint the virtualized Gantt after its delayed response");
    assert.equal(bottom.error, undefined);
    assert.ok(bottom.scrollTop > 0, "fixture must exercise the virtualized Gantt scroll");
    assert.match(bottom.text, /Stage 14/);
    assert.match(bottom.text, /Card 14/);
  } finally {
    cdp?.close();
    await stop(child);
    await proxy?.close();
    await app?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("Board restores each custom stage rail independently when stages share a canonical status", { timeout: 60_000 }, async (t) => {
  const chrome = chromeExecutable();
  assert.ok(chrome, "Chrome or Chromium is required for the Board scroll acceptance test");
  if (!existsSync(path.join(projectRoot, "dist", "web", "index.html"))) {
    t.skip("built web assets unavailable; run npm run test:gantt-workflow");
    return;
  }

  const directory = await mkdtemp(path.join(os.tmpdir(), "taskboard-board-scroll-"));
  let app;
  let child;
  let cdp;
  try {
    seedBoardScrollFixture(directory);
    app = createTaskboardServer({ dataDirectory: directory });
    const appAddress = await app.listen({ host: "127.0.0.1", port: 0 });
    const profile = path.join(directory, "chrome");
    child = spawn(chrome, [
      "--headless=new",
      "--disable-background-networking",
      "--disable-gpu",
      "--no-first-run",
      "--no-sandbox",
      "--remote-debugging-address=127.0.0.1",
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
      "about:blank",
    ], { stdio: "ignore" });
    const debugPort = await chromeDebugPort(profile);
    cdp = await connectCdp(debugPort);
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: 1366,
      height: 768,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await cdp.send("Page.navigate", { url: `http://127.0.0.1:${appAddress.port}/?project=alpha` });
    await eventually(async () => cdp.evaluate(`(() => {
      const railFor = (label) => {
        const column = [...document.querySelectorAll(".board-column")].find((node) => (
          node.querySelector("h2")?.textContent?.includes(label)
        ));
        return column?.querySelector(".column-list");
      };
      const first = railFor("First todo rail");
      const second = railFor("Second todo rail");
      return first instanceof HTMLElement
        && second instanceof HTMLElement
        && first.scrollHeight > first.clientHeight
        && second.scrollHeight > second.clientHeight;
    })()`), "Custom todo rails did not render with independent vertical scroll ranges");

    async function saveScrollAndOpen(label, preferredScrollTop) {
      const saved = await cdp.evaluate(`(() => {
        const column = [...document.querySelectorAll(".board-column")].find((node) => (
          node.querySelector("h2")?.textContent?.includes(${JSON.stringify(label)})
        ));
        const rail = column?.querySelector(".column-list");
        if (!(rail instanceof HTMLElement)) return null;
        rail.scrollTop = Math.min(${preferredScrollTop}, rail.scrollHeight - rail.clientHeight);
        rail.dispatchEvent(new Event("scroll", { bubbles: true }));
        const openButton = rail.querySelector("button.task-card-open");
        if (!(openButton instanceof HTMLButtonElement)) return null;
        const scrollTop = rail.scrollTop;
        openButton.click();
        return scrollTop;
      })()`);
      assert.ok(Number.isFinite(saved) && saved > 0, `${label} must capture a nonzero rail position`);
      await eventually(
        () => cdp.evaluate(`document.querySelector("button.detail-back-button") instanceof HTMLButtonElement`),
        `${label} task detail did not open`,
      );
      const closed = await cdp.evaluate(`(() => {
        const button = document.querySelector("button.detail-back-button");
        if (!(button instanceof HTMLButtonElement)) return false;
        button.click();
        return true;
      })()`);
      assert.equal(closed, true, `${label} task detail must close`);
      await eventually(async () => cdp.evaluate(`(() => {
        const column = [...document.querySelectorAll(".board-column")].find((node) => (
          node.querySelector("h2")?.textContent?.includes(${JSON.stringify(label)})
        ));
        const rail = column?.querySelector(".column-list");
        return rail instanceof HTMLElement && rail.scrollTop === ${saved};
      })()`), `${label} did not restore its own rail position`);
      return saved;
    }

    const firstSaved = await saveScrollAndOpen("First todo rail", 120);
    const secondSaved = await saveScrollAndOpen("Second todo rail", 260);
    assert.notEqual(firstSaved, secondSaved, "the fixture must distinguish the two rail positions");
  } finally {
    cdp?.close();
    await stop(child);
    await app?.close();
    await rm(directory, { recursive: true, force: true });
  }
});
