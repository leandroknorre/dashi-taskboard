import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";

import { createTaskboardServer, parseConfiguredSessionAgents } from "../server/app.mjs";

// Session/pillar assignee targets besides the generic ones (Codex, Claude ad
// hoc, Coordenadora, Dashi) are never hardcoded in this repo - each
// deployment configures its own via the TASKBOARD_SESSION_AGENTS
// environment variable, so a public fork of this project never has to carry
// anyone's private session names in source control.

const runningApps = [];

afterEach(async () => {
  while (runningApps.length > 0) {
    const { app, directory } = runningApps.pop();
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});

async function startServer(env) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "taskboard-session-agents-test-"));
  const app = createTaskboardServer({
    dataDirectory: directory,
    processEnv: env === undefined ? process.env : { ...process.env, TASKBOARD_SESSION_AGENTS: env },
  });
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  runningApps.push({ app, directory });
  return `http://127.0.0.1:${address.port}`;
}

async function request(baseUrl, pathname, options = {}) {
  const headers = new Headers(options.headers);
  if (options.body !== undefined && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  const response = await fetch(`${baseUrl}${pathname}`, {
    ...options,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  return { response, body: text ? JSON.parse(text) : undefined };
}

test("parseConfiguredSessionAgents accepts well-formed entries and drops malformed ones", () => {
  assert.deepEqual(parseConfiguredSessionAgents(undefined), []);
  assert.deepEqual(parseConfiguredSessionAgents(""), []);
  assert.deepEqual(
    parseConfiguredSessionAgents("pillar-a-agent=Pillar A,pillar-b-agent=Pillar B"),
    [{ id: "pillar-a-agent", name: "Pillar A" }, { id: "pillar-b-agent", name: "Pillar B" }],
  );
  // Extra whitespace around entries and around '=' is tolerated.
  assert.deepEqual(
    parseConfiguredSessionAgents(" pillar-a-agent = Pillar A , pillar-b-agent=Pillar B "),
    [{ id: "pillar-a-agent", name: "Pillar A" }, { id: "pillar-b-agent", name: "Pillar B" }],
  );
  // Malformed entries (no '=', empty id, empty name, id not matching the
  // identifier pattern, or a duplicate id) are dropped, not fatal.
  assert.deepEqual(
    parseConfiguredSessionAgents("no-equals-sign,=Missing Id,pillar-a-agent=,Bad_ID=Name,pillar-a-agent=Pillar A,pillar-a-agent=Duplicate"),
    [{ id: "pillar-a-agent", name: "Pillar A" }],
  );
});

test("with TASKBOARD_SESSION_AGENTS unset, only the generic session agents are offered", async () => {
  const baseUrl = await startServer(undefined);
  const whoami = await request(baseUrl, "/api/local/whoami");
  assert.equal(whoami.response.status, 200);
  assert.deepEqual(whoami.body.sessionAgents.map((agent) => agent.id), [
    "codex-agent",
    "claude-agent",
    "coordenadora-agent",
    "dashi-agent",
  ]);

  const createResult = await request(baseUrl, "/api/tasks", {
    method: "POST",
    headers: { "x-taskboard-user-id": "test-user", "x-taskboard-user-name": "Test%20User" },
    body: { title: "Task" },
  });
  const assignResult = await request(baseUrl, `/api/tasks/${createResult.body.task.id}`, {
    method: "PATCH",
    headers: { "x-taskboard-user-id": "test-user", "x-taskboard-user-name": "Test%20User" },
    body: { version: createResult.body.task.version, assigneeTarget: "pillar-a-agent" },
  });
  assert.equal(assignResult.response.status, 400);
  assert.equal(assignResult.body.error.code, "INVALID_FIELD");
});

test("with TASKBOARD_SESSION_AGENTS set, the configured agents are offered and assignable", async () => {
  const baseUrl = await startServer("pillar-a-agent=Pillar A,pillar-b-agent=Pillar B");
  const whoami = await request(baseUrl, "/api/local/whoami");
  assert.equal(whoami.response.status, 200);
  assert.deepEqual(whoami.body.sessionAgents, [
    { id: "codex-agent", name: "Codex Agent" },
    { id: "claude-agent", name: "Claude ad hoc" },
    { id: "pillar-a-agent", name: "Pillar A" },
    { id: "pillar-b-agent", name: "Pillar B" },
    { id: "coordenadora-agent", name: "Coordenadora" },
    { id: "dashi-agent", name: "Sessão Dashi" },
  ]);

  const userHeaders = { "x-taskboard-user-id": "test-user", "x-taskboard-user-name": "Test%20User" };
  const createResult = await request(baseUrl, "/api/tasks", {
    method: "POST",
    headers: userHeaders,
    body: { title: "Task" },
  });
  assert.equal(createResult.response.status, 201);

  const assignResult = await request(baseUrl, `/api/tasks/${createResult.body.task.id}`, {
    method: "PATCH",
    headers: userHeaders,
    body: { version: createResult.body.task.version, assigneeTarget: "pillar-a-agent" },
  });
  assert.equal(assignResult.response.status, 200);
  assert.deepEqual(assignResult.body.task.assignee, {
    type: "agent",
    id: "pillar-a-agent",
    name: "Pillar A",
    avatarUrl: null,
  });

  const unknownResult = await request(baseUrl, `/api/tasks/${createResult.body.task.id}`, {
    method: "PATCH",
    headers: userHeaders,
    body: { version: assignResult.body.task.version, assigneeTarget: "pillar-c-agent" },
  });
  assert.equal(unknownResult.response.status, 400);
  assert.equal(unknownResult.body.error.code, "INVALID_FIELD");
});

test("an explicit options.sessionAgents override wins over the environment (used by other test suites)", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "taskboard-session-agents-test-"));
  const app = createTaskboardServer({
    dataDirectory: directory,
    processEnv: { ...process.env, TASKBOARD_SESSION_AGENTS: "ignored-agent=Ignored" },
    sessionAgents: [{ id: "override-agent", name: "Override" }],
  });
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  runningApps.push({ app, directory });
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const whoami = await request(baseUrl, "/api/local/whoami");
  const ids = whoami.body.sessionAgents.map((agent) => agent.id);
  assert.ok(ids.includes("override-agent"));
  assert.ok(!ids.includes("ignored-agent"));
});
