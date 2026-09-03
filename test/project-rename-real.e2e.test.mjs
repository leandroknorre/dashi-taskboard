import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
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
const actor = { type: "user", id: "rename-e2e", name: "Rename E2E", avatarUrl: null };
const cdpTimeoutMs = 10_000;
const teardownTimeoutMs = 5_000;

function chromeExecutable() {
  return [
    process.env.CHROME_BIN,
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ].find((candidate) => candidate && existsSync(candidate));
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function eventually(action, message, timeoutMs = 12_000) {
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
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  let sequence = 0;
  const pending = new Map();
  const networkEvents = [];
  socket.on("message", (raw) => {
    let message;
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }
    if (typeof message.method === "string" && message.method.startsWith("Network.")) {
      networkEvents.push(message);
    }
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    clearTimeout(request.timer);
    if (message.error) request.reject(new Error(message.error.message));
    else request.resolve(message.result);
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Chrome DevTools command timed out: ${method}`));
    }, cdpTimeoutMs);
    pending.set(id, { resolve, reject, timer });
    socket.send(JSON.stringify({ id, method, params }), (error) => {
      if (!error) return;
      clearTimeout(timer);
      pending.delete(id);
      reject(error);
    });
  });
  return {
    send,
    networkEvents,
    async evaluate(expression) {
      const result = await send("Runtime.evaluate", {
        expression,
        awaitPromise: true,
        returnByValue: true,
      });
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
      return result.result.value;
    },
    async close() {
      for (const request of pending.values()) {
        clearTimeout(request.timer);
        request.reject(new Error("Chrome DevTools client disposed"));
      }
      pending.clear();
      if (socket.readyState === WebSocket.CLOSED) return;
      await new Promise((resolve) => {
        const timer = setTimeout(() => {
          socket.terminate();
          resolve();
        }, teardownTimeoutMs);
        socket.once("close", () => {
          clearTimeout(timer);
          resolve();
        });
        socket.close();
      });
    },
  };
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

function seedProject(directory) {
  const database = new TaskboardDatabase(path.join(directory, "taskboard.sqlite"));
  try {
    database.createProject({ id: "alpha", name: "Alpha", workspacePath: null });
    const workflow = database.getStageWorkflow("alpha");
    const stage = workflow.definition.stages.find((candidate) => (
      candidate.canonicalStatus === "todo" && candidate.isDefaultForStatus
    ));
    assert.ok(stage);
    const parent = database.createTask({
      projectId: "alpha", title: "Parent", description: "", status: "todo", stageId: stage.stageId,
      priority: "none", labels: [], actor, assignee: actor, developmentContext: null,
      startDate: null, dueDate: null, recurrence: null,
    });
    const child = database.createTask({
      projectId: "alpha", title: "Child", description: "", status: "todo", stageId: stage.stageId,
      priority: "none", labels: [], actor, assignee: actor, developmentContext: null,
      startDate: null, dueDate: null, recurrence: null,
    });
    database.addTaskRelation(child.id, child.version, "parent", parent.id, null, null, actor);
    return {
      project: database.database.prepare("SELECT * FROM projects WHERE id = ?").get("alpha"),
      tasks: database.database.prepare("SELECT * FROM tasks ORDER BY id").all(),
      relations: database.database.prepare("SELECT * FROM task_relations ORDER BY source_task_id, target_task_id").all(),
    };
  } finally {
    database.close();
  }
}

function databaseState(directory) {
  const database = new TaskboardDatabase(path.join(directory, "taskboard.sqlite"));
  try {
    return {
      project: database.database.prepare("SELECT * FROM projects WHERE id = ?").get("alpha"),
      tasks: database.database.prepare("SELECT * FROM tasks ORDER BY id").all(),
      relations: database.database.prepare("SELECT * FROM task_relations ORDER BY source_task_id, target_task_id").all(),
    };
  } finally {
    database.close();
  }
}

function mutateProject(directory, sql, ...params) {
  const database = new TaskboardDatabase(path.join(directory, "taskboard.sqlite"));
  try {
    database.database.prepare(sql).run(...params);
  } finally {
    database.close();
  }
}

async function openRenameDialog(cdp) {
  await eventually(() => cdp.evaluate(`document.querySelector(".header-project-button")?.textContent?.includes("Alpha") || document.querySelector(".header-project-button")?.textContent?.includes("Beta")`), "Project header did not render");
  await cdp.evaluate(`document.querySelector(".header-project-button")?.click(); true`);
  await eventually(() => cdp.evaluate(`(() => {
    const button = [...document.querySelectorAll(".header-project-menu button")]
      .find((node) => node.textContent?.trim() === "Rename current project");
    if (!(button instanceof HTMLButtonElement)) return false;
    button.click();
    return true;
  })()`), "Project menu did not expose rename");
  await eventually(() => cdp.evaluate(`document.querySelector(".project-rename-dialog input") instanceof HTMLInputElement`), "Rename dialog did not open");
}

async function submitRename(cdp, name) {
  return cdp.evaluate(`(() => {
    const dialog = document.querySelector(".project-rename-dialog");
    const input = dialog?.querySelector("input");
    const button = [...dialog?.querySelectorAll("button") ?? []]
      .find((node) => node.textContent?.trim() === "Save");
    if (!(input instanceof HTMLInputElement) || !(button instanceof HTMLButtonElement)) return false;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, ${JSON.stringify(name)});
    input.dispatchEvent(new Event("input", { bubbles: true }));
    button.click();
    return true;
  })()`);
}

function projectPatchExchange(cdp, name) {
  const request = cdp.networkEvents.find((event) => {
    if (
      event.method !== "Network.requestWillBeSent"
      || event.params.request.method !== "PATCH"
      || new URL(event.params.request.url).pathname !== "/api/projects/alpha"
    ) return false;
    try {
      return JSON.parse(event.params.request.postData).name === name;
    } catch {
      return false;
    }
  });
  assert.ok(request, `The real UI must send the ${name} project PATCH over HTTP`);
  const response = cdp.networkEvents.find((event) => (
    event.method === "Network.responseReceived"
    && event.params.requestId === request.params.requestId
  ));
  assert.ok(response, `The ${name} project PATCH must receive an HTTP response`);
  return { request, response };
}

test("project rename UI persists identity and graph and releases Saving on conflicts", { timeout: 90_000 }, async (t) => {
  const chrome = chromeExecutable();
  if (!chrome) {
    t.skip("Chrome or Chromium unavailable; the project rename acceptance test needs CHROME_BIN or a system browser");
    return;
  }
  if (!existsSync(path.join(projectRoot, "dist", "web", "index.html"))) {
    t.skip("built web assets unavailable; run npm run build:web first");
    return;
  }
  const directory = await mkdtemp(path.join(os.tmpdir(), "taskboard-project-rename-"));
  let app; let child; let cdp; let stderrCapture;
  try {
    const before = seedProject(directory);
    app = createTaskboardServer({ dataDirectory: directory });
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const profile = path.join(directory, "chrome");
    child = spawn(chrome, [
      "--headless=new", "--disable-background-networking", "--disable-gpu", "--no-first-run", "--no-sandbox",
      "--remote-debugging-address=127.0.0.1", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank",
    ], { stdio: ["ignore", "ignore", "pipe"] });
    stderrCapture = captureStderrTail(child.stderr);
    let chromeStartupError;
    child.once("error", (error) => { chromeStartupError = error; });
    cdp = await connectCdp(await chromeDebugPort(profile, child, stderrCapture, () => chromeStartupError));
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    await cdp.send("Network.enable");
    await cdp.send("Page.navigate", { url: `http://127.0.0.1:${address.port}/?project=alpha` });

    await openRenameDialog(cdp);
    assert.equal(await submitRename(cdp, "Beta"), true);
    await eventually(() => cdp.evaluate(`document.querySelector(".project-rename-dialog") === null && document.querySelector(".header-project-button")?.textContent?.includes("Beta")`), "Rename did not complete through the real UI");
    const renamed = databaseState(directory);
    assert.equal(renamed.project.id, "alpha");
    assert.equal(renamed.project.name, "Beta");
    assert.equal(renamed.project.version, 2);
    assert.deepEqual(renamed.tasks, before.tasks);
    assert.deepEqual(renamed.relations, before.relations);
    assert.equal(await cdp.evaluate(`new URL(location.href).searchParams.get("project")`), "alpha");
    const successfulExchange = projectPatchExchange(cdp, "Beta");
    assert.equal(successfulExchange.response.params.response.status, 200);
    assert.deepEqual(JSON.parse(successfulExchange.request.params.request.postData), {
      name: "Beta",
      expectedUpdatedAt: before.project.updated_at,
    });

    await openRenameDialog(cdp);
    mutateProject(directory, "UPDATE projects SET version = version + 1, updated_at = ? WHERE id = ?", "2099-01-01T00:00:00.000Z", "alpha");
    const staleBefore = databaseState(directory);
    assert.equal(await submitRename(cdp, "Gamma"), true);
    await eventually(() => cdp.evaluate(`document.querySelector(".project-rename-dialog [role=alert]")?.textContent?.includes("changed elsewhere") && [...document.querySelectorAll(".project-rename-dialog button")].some((node) => node.textContent?.trim() === "Save" && !node.disabled)`), "Stale rename did not release Saving with a conflict");
    const staleExchange = projectPatchExchange(cdp, "Gamma");
    assert.equal(staleExchange.response.params.response.status, 409);
    assert.deepEqual(databaseState(directory), staleBefore, "A stale rename must not change any captured database state");

    mutateProject(directory, "UPDATE projects SET archived_at = ?, version = version + 1, updated_at = ? WHERE id = ?", "2099-01-02T00:00:00.000Z", "2099-01-02T00:00:00.000Z", "alpha");
    const archivedBefore = databaseState(directory);
    assert.equal(await submitRename(cdp, "Delta"), true);
    await eventually(() => cdp.evaluate(`document.querySelector(".project-rename-dialog [role=alert]")?.textContent?.includes("cannot be renamed") && [...document.querySelectorAll(".project-rename-dialog button")].some((node) => node.textContent?.trim() === "Save" && !node.disabled)`), "Archived rename did not release Saving with a state error");
    const archivedExchange = projectPatchExchange(cdp, "Delta");
    assert.equal(archivedExchange.response.params.response.status, 409);
    const finalState = databaseState(directory);
    assert.deepEqual(finalState, archivedBefore, "An archived rename must not change any captured database state");
    assert.equal(finalState.project.id, "alpha");
    assert.equal(finalState.project.name, "Beta");
    assert.deepEqual(finalState.tasks, before.tasks);
    assert.deepEqual(finalState.relations, before.relations);
    assert.equal(await cdp.evaluate(`new URL(location.href).searchParams.get("project")`), "alpha");
  } finally {
    await cdp?.close().catch(() => {});
    await stopChild(child, { timeoutMs: teardownTimeoutMs, name: "Chrome" }).catch(() => {});
    stderrCapture?.dispose();
    await app?.server.closeAllConnections?.();
    await app?.close().catch(() => {});
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
