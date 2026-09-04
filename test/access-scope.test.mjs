import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";

import { createTaskboardServer } from "../server/app.mjs";
import { computeUserScope, parseConfiguredUserScopes, scopeAllowsPilar } from "../server/access-scope.mjs";

// Cloudflare Access verifies the human's identity and forwards it as
// cf-access-authenticated-user-email; that is the ONLY identity this
// per-pillar scoping ever restricts. Agents/scripts using
// x-taskboard-user-id are never scoped. Test emails are fictitious, per
// the rule against writing a real person's email into a test fixture.
const OWNER = "leandro@example.com";
const FELIPE = "felipe@example.com";
const ARDELITA = "ardelita@example.com";
const SCOPES = `${FELIPE}=automatix,${ARDELITA}=dsadv`;

const runningApps = [];

afterEach(async () => {
  while (runningApps.length > 0) {
    const { app, directory } = runningApps.pop();
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});

async function startServer(extraEnv = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "taskboard-access-scope-test-"));
  const app = createTaskboardServer({
    dataDirectory: directory,
    processEnv: {
      ...process.env,
      TASKBOARD_OWNER_EMAIL: OWNER,
      TASKBOARD_USER_SCOPES: SCOPES,
      ...extraEnv,
    },
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

function asEmail(email) {
  return { "cf-access-authenticated-user-email": email };
}

// Agents/scripts create fixture data with their own explicit identity so it
// never goes through (and is never restricted by) the human pillar scope.
const AGENT_HEADERS = { "x-taskboard-user-id": "fixture-agent", "x-taskboard-user-name": "Fixture" };

async function createTask(baseUrl, { title, labels = [] }) {
  const result = await request(baseUrl, "/api/tasks", {
    method: "POST",
    headers: AGENT_HEADERS,
    body: { title, labels },
  });
  assert.equal(result.response.status, 201, JSON.stringify(result.body));
  return result.body.task;
}

async function startServerWithApp(extraEnv = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "taskboard-access-scope-test-"));
  const app = createTaskboardServer({
    dataDirectory: directory,
    processEnv: {
      ...process.env,
      TASKBOARD_OWNER_EMAIL: OWNER,
      TASKBOARD_USER_SCOPES: SCOPES,
      ...extraEnv,
    },
  });
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  runningApps.push({ app, directory });
  return { app, baseUrl: `http://127.0.0.1:${address.port}` };
}

async function linkParent(baseUrl, child, parentId) {
  const result = await request(baseUrl, `/api/tasks/${child.id}/relations/parent/${parentId}`, {
    method: "POST",
    headers: AGENT_HEADERS,
    body: { version: child.version },
  });
  assert.equal(result.response.status, 200, JSON.stringify(result.body));
  return result.body;
}

test("parseConfiguredUserScopes accepts well-formed entries and drops malformed ones", () => {
  assert.deepEqual(parseConfiguredUserScopes(undefined), new Map());
  assert.deepEqual(
    parseConfiguredUserScopes("felipe@example.com=automatix,ardelita@example.com=dsadv"),
    new Map([["felipe@example.com", new Set(["automatix"])], ["ardelita@example.com", new Set(["dsadv"])]]),
  );
  // Case-insensitive email, whitespace tolerated, '+' joins multiple pillars.
  assert.deepEqual(
    parseConfiguredUserScopes(" Multi@Example.com = dsadv+automatix "),
    new Map([["multi@example.com", new Set(["dsadv", "automatix"])]]),
  );
  // Malformed entries are dropped, not fatal: no '=', invalid email, empty
  // pillar list, invalid pillar slug, duplicate email.
  assert.deepEqual(
    parseConfiguredUserScopes(
      "no-equals-sign,not-an-email=dsadv,felipe@example.com=,felipe@example.com=Bad_Slug,"
      + "felipe@example.com=automatix,felipe@example.com=dsadv",
    ),
    new Map([["felipe@example.com", new Set(["automatix"])]]),
  );
});

test("computeUserScope / scopeAllowsPilar", () => {
  const config = { ownerEmail: OWNER, userScopes: parseConfiguredUserScopes(SCOPES) };

  // No proxy-authenticated email at all (agent/script/local dev) -> unrestricted.
  assert.deepEqual(computeUserScope(null, config), { restricted: false, denied: false, pilares: null });

  // The configured owner is unrestricted even with no scope entry.
  const ownerScope = computeUserScope(OWNER, config);
  assert.equal(ownerScope.restricted, false);
  assert.ok(scopeAllowsPilar(ownerScope, "automatix"));
  assert.ok(scopeAllowsPilar(ownerScope, "anything-at-all"));

  // A configured user is restricted to their pillar(s).
  const felipeScope = computeUserScope(FELIPE, config);
  assert.deepEqual(felipeScope, { restricted: true, denied: false, pilares: new Set(["automatix"]) });
  assert.ok(scopeAllowsPilar(felipeScope, "automatix"));
  assert.ok(!scopeAllowsPilar(felipeScope, "dsadv"));
  assert.ok(!scopeAllowsPilar(felipeScope, null));

  // An unknown email (not owner, no scope entry) is denied outright - fail-closed.
  const unknownScope = computeUserScope("stranger@example.com", config);
  assert.equal(unknownScope.restricted, true);
  assert.equal(unknownScope.denied, true);
  assert.ok(!scopeAllowsPilar(unknownScope, "automatix"));
});

test("scoped read: a user only sees tasks in their own pillar, including unlabeled descendants", async () => {
  const baseUrl = await startServer();
  const automatixRoot = await createTask(baseUrl, { title: "Automatix root", labels: ["pilar:automatix"] });
  const automatixChild = await createTask(baseUrl, { title: "Automatix child" });
  await linkParent(baseUrl, automatixChild, automatixRoot.id);
  const dsadvRoot = await createTask(baseUrl, { title: "dSAdv root", labels: ["pilar:dsadv"] });

  const felipeList = await request(baseUrl, "/api/tasks", { headers: asEmail(FELIPE) });
  assert.equal(felipeList.response.status, 200);
  const felipeIds = felipeList.body.tasks.map((task) => task.id);
  assert.ok(felipeIds.includes(automatixRoot.id));
  assert.ok(felipeIds.includes(automatixChild.id), "unlabeled child inherits its ancestor's pillar");
  assert.ok(!felipeIds.includes(dsadvRoot.id));

  const ownerList = await request(baseUrl, "/api/tasks", { headers: asEmail(OWNER) });
  const ownerIds = ownerList.body.tasks.map((task) => task.id);
  assert.ok(ownerIds.includes(automatixRoot.id) && ownerIds.includes(dsadvRoot.id), "owner sees every pillar");
});

test("scoped write: allowed inside the pillar, refused (403) outside it", async () => {
  const baseUrl = await startServer();
  const automatixRoot = await createTask(baseUrl, { title: "Automatix root", labels: ["pilar:automatix"] });
  const dsadvRoot = await createTask(baseUrl, { title: "dSAdv root", labels: ["pilar:dsadv"] });

  const readOwn = await request(baseUrl, `/api/tasks/${automatixRoot.id}`, { headers: asEmail(FELIPE) });
  assert.equal(readOwn.response.status, 200);

  const patchOwn = await request(baseUrl, `/api/tasks/${automatixRoot.id}`, {
    method: "PATCH",
    headers: asEmail(FELIPE),
    body: { version: automatixRoot.version, title: "Automatix root (edited)" },
  });
  assert.equal(patchOwn.response.status, 200);

  const commentOwn = await request(baseUrl, `/api/tasks/${automatixRoot.id}/comments`, {
    method: "POST",
    headers: asEmail(FELIPE),
    body: { body: "Comment from Felipe" },
  });
  assert.equal(commentOwn.response.status, 201, JSON.stringify(commentOwn.body));

  const readOther = await request(baseUrl, `/api/tasks/${dsadvRoot.id}`, { headers: asEmail(FELIPE) });
  assert.equal(readOther.response.status, 403);
  assert.equal(readOther.body.error.code, "SCOPE_FORBIDDEN");

  const patchOther = await request(baseUrl, `/api/tasks/${dsadvRoot.id}`, {
    method: "PATCH",
    headers: asEmail(FELIPE),
    body: { version: dsadvRoot.version, title: "Hijacked" },
  });
  assert.equal(patchOther.response.status, 403);

  const createOutsidePilar = await request(baseUrl, "/api/tasks", {
    method: "POST",
    headers: asEmail(FELIPE),
    body: { title: "Sneaky", labels: ["pilar:dsadv"] },
  });
  assert.equal(createOutsidePilar.response.status, 403);
});

test("scoped write: reparenting across a pillar boundary is refused on either end", async () => {
  const baseUrl = await startServer();
  const automatixRoot = await createTask(baseUrl, { title: "Automatix root", labels: ["pilar:automatix"] });
  const automatixChild = await createTask(baseUrl, { title: "Automatix child", labels: ["pilar:automatix"] });
  const dsadvRoot = await createTask(baseUrl, { title: "dSAdv root", labels: ["pilar:dsadv"] });

  // Felipe cannot attach his own card under a dSAdv parent (escapes his pillar).
  const reparentOut = await request(baseUrl, `/api/tasks/${automatixChild.id}/relations/parent/${dsadvRoot.id}`, {
    method: "POST",
    headers: asEmail(FELIPE),
    body: { version: automatixChild.version },
  });
  assert.equal(reparentOut.response.status, 403);

  // Felipe cannot pull a dSAdv card into his own pillar either.
  const reparentIn = await request(baseUrl, `/api/tasks/${dsadvRoot.id}/relations/parent/${automatixRoot.id}`, {
    method: "POST",
    headers: asEmail(FELIPE),
    body: { version: dsadvRoot.version },
  });
  assert.equal(reparentIn.response.status, 403);
});

test("an unknown authenticated email is denied outright, not shown an empty board", async () => {
  const baseUrl = await startServer();
  await createTask(baseUrl, { title: "Automatix root", labels: ["pilar:automatix"] });

  const list = await request(baseUrl, "/api/tasks", { headers: asEmail("stranger@example.com") });
  assert.equal(list.response.status, 403);
  assert.equal(list.body.error.code, "SCOPE_UNKNOWN_USER");
});

test("without TASKBOARD_OWNER_EMAIL/TASKBOARD_USER_SCOPES configured, behavior is unchanged", async () => {
  const baseUrl = await startServer({ TASKBOARD_OWNER_EMAIL: "", TASKBOARD_USER_SCOPES: "" });
  const task = await createTask(baseUrl, { title: "Unscoped deployment" });

  const list = await request(baseUrl, "/api/tasks", { headers: asEmail("anyone@example.com") });
  assert.equal(list.response.status, 200);
  assert.ok(list.body.tasks.some((row) => row.id === task.id));
});

test("scoped write: deleting/reading an attachment on a task outside the pillar is refused (403)", async () => {
  const baseUrl = await startServer();
  const automatixRoot = await createTask(baseUrl, { title: "Automatix root", labels: ["pilar:automatix"] });

  const contents = "attachment contents\n";
  const upload = await fetch(`${baseUrl}/api/tasks/${automatixRoot.id}/attachments`, {
    method: "POST",
    headers: {
      ...AGENT_HEADERS,
      "content-type": "text/plain; charset=utf-8",
      "x-taskboard-filename": encodeURIComponent("nota.txt"),
      "x-taskboard-attachment-kind": "attachment",
    },
    body: contents,
  });
  assert.equal(upload.status, 201);
  const attachment = (await upload.json()).attachment;

  // Ardelita is scoped to dSAdv; this attachment belongs to an Automatix task.
  const readOutside = await fetch(`${baseUrl}/api/attachments/${attachment.id}/content`, {
    headers: asEmail(ARDELITA),
  });
  assert.equal(readOutside.status, 403);
  assert.equal((await readOutside.json()).error.code, "SCOPE_FORBIDDEN");

  const deleteOutside = await fetch(`${baseUrl}/api/attachments/${attachment.id}`, {
    method: "DELETE",
    headers: asEmail(ARDELITA),
  });
  assert.equal(deleteOutside.status, 403);
  assert.equal((await deleteOutside.json()).error.code, "SCOPE_FORBIDDEN");

  // Felipe (Automatix) can still reach it - the guard is per-pillar, not a blanket lock.
  const readInside = await fetch(`${baseUrl}/api/attachments/${attachment.id}/content`, {
    headers: asEmail(FELIPE),
  });
  assert.equal(readInside.status, 200);
});

test("scoped write: an automation run on a task outside the pillar is refused (403)", async () => {
  const { app, baseUrl } = await startServerWithApp();
  const automatixRoot = await createTask(baseUrl, { title: "Automatix root", labels: ["pilar:automatix"] });

  const { TransitionService } = await import("../server/transition-service.mjs");
  const transitions = new TransitionService(app.database);
  const action = transitions.listActions(automatixRoot.id).find((candidate) => candidate.toTerminalKind === "none");
  assert.ok(action, "fixture must expose a non-terminal action");

  const created = await request(baseUrl, `/api/tasks/${automatixRoot.id}/transitions`, {
    method: "POST",
    headers: { ...AGENT_HEADERS, "idempotency-key": "access-scope-automation-run" },
    body: { expectedStateVersion: automatixRoot.version, actionKey: action.actionKey, gateEvidence: [] },
  });
  assert.equal(created.response.status, 200, JSON.stringify(created.body));
  const runId = created.body.automationRun.runId;

  // Ardelita (dSAdv) cannot see or act on an automation run tied to an Automatix task.
  const readOutside = await request(baseUrl, `/api/automation-runs/${runId}`, { headers: asEmail(ARDELITA) });
  assert.equal(readOutside.response.status, 403);
  assert.equal(readOutside.body.error.code, "SCOPE_FORBIDDEN");

  const dispatchOutside = await request(baseUrl, `/api/automation-runs/${runId}/dispatch`, {
    method: "POST",
    headers: asEmail(ARDELITA),
    body: { leaseDurationMs: 60_000 },
  });
  assert.equal(dispatchOutside.response.status, 403);

  // Felipe (Automatix) can still read it.
  const readInside = await request(baseUrl, `/api/automation-runs/${runId}`, { headers: asEmail(FELIPE) });
  assert.equal(readInside.response.status, 200);
});

test("the x-taskboard-proxy-user-email dev alias is ignored unless TASKBOARD_TRUST_PROXY_EMAIL_HEADER=1", async () => {
  // Nothing upstream of this origin (Cloudflare Access, this deployment's
  // runner) strips a client-supplied x-taskboard-proxy-user-email header, so
  // trusting it the same as the real cf-access-authenticated-user-email
  // header would let anyone claim to be the owner just by sending it.
  const untrusted = await startServer();
  const impersonate = { "x-taskboard-proxy-user-email": OWNER };

  const whoamiUntrusted = await request(untrusted, "/api/local/whoami", { headers: impersonate });
  assert.equal(whoamiUntrusted.response.status, 200);
  assert.notEqual(whoamiUntrusted.body.user.id, OWNER);
  assert.equal(whoamiUntrusted.body.user.id, "local-user");

  // The scope computation never even sees an email, so it treats the
  // request the same as any unauthenticated agent/script call - not as
  // the owner specifically, and not as any scoped pillar identity either.
  const listUntrusted = await request(untrusted, "/api/tasks", { headers: impersonate });
  assert.equal(listUntrusted.response.status, 200);

  const trusted = await startServer({ TASKBOARD_TRUST_PROXY_EMAIL_HEADER: "1" });
  const whoamiTrusted = await request(trusted, "/api/local/whoami", { headers: impersonate });
  assert.equal(whoamiTrusted.response.status, 200);
  assert.equal(whoamiTrusted.body.user.id, OWNER);
});
