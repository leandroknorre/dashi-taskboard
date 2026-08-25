import { DurableObject } from "cloudflare:workers";

import { DEFAULT_LABEL_NAMES } from "../../shared/domain.mjs";
import {
  DEFAULT_PARENT_RELATION_METADATA_JSON,
  normalizeParentRelationMetadata,
  parentRelationMetadataFromStored,
  parentRelationMetadataJson,
} from "../../shared/relation-metadata.mjs";
import { calculateTaskRollup } from "../../shared/task-rollup.mjs";
import {
  NESTED_WORKSPACE_MAX_NODES,
  paginateWorkspaceItems,
  parseNestedWorkspaceQuery,
  workspaceItemFromRow,
  workspaceOverviewFromTask,
} from "../../shared/nested-workspace.mjs";

const JSON_BODY_LIMIT = 1024 * 1024;
const PROJECT_README_BODY_LIMIT = 3 * 1024 * 1024;
const ATTACHMENT_BODY_LIMIT = 25 * 1024 * 1024;
const DEFAULT_PROJECT_LABELS_JSON = JSON.stringify(DEFAULT_LABEL_NAMES);
const PROJECT_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const TASK_STATUSES = [
  "backlog",
  "todo",
  "in_progress",
  "in_review",
  "blocked",
  "done",
  "canceled",
];
const TASK_PRIORITIES = ["none", "urgent", "high", "medium", "low"];
const DEFAULT_STAGE_WORKFLOW = [
  ["todo", "To do", true], ["in_progress", "In progress", true],
  ["blocked", "Blocked", true], ["in_review", "In review", true],
  ["backlog", "Backlog", false], ["done", "Done", false], ["canceled", "Canceled", false],
];
const INLINE_ATTACHMENT_TYPES = new Set([
  "application/pdf",
  "image/avif",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
  "text/plain",
]);
const REALTIME_HUB_NAME = "global";
const SESSION_COOKIE_NAME = "__Host-taskboard_session";
const SESSION_MAX_AGE_SECONDS = 24 * 60 * 60;
const TASK_TREE_MAX_NODES = 1_000;

export class RealtimeHub extends DurableObject {
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/connect") {
      if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
        return json(426, {
          error: { code: "WEBSOCKET_REQUIRED", message: "A WebSocket upgrade is required" },
        }, { upgrade: "websocket" });
      }
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      this.ctx.acceptWebSocket(server);
      return new Response(null, { status: 101, webSocket: client });
    }

    if (url.pathname === "/broadcast" && request.method === "POST") {
      const payload = await request.json();
      if (!Number.isSafeInteger(payload?.revision) || payload.revision < 0) {
        return json(400, {
          error: { code: "INVALID_REVISION", message: "revision must be non-negative" },
        });
      }
      const message = JSON.stringify({ type: "revision", revision: payload.revision });
      for (const socket of this.ctx.getWebSockets()) {
        try {
          socket.send(message);
        } catch {
          // The runtime will deliver the close/error event for stale sockets.
        }
      }
      return empty(204);
    }

    return json(404, { error: { code: "NOT_FOUND", message: "Resource not found" } });
  }

  webSocketMessage(socket) {
    socket.close(1008, "Client messages are not supported");
  }
}

class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function json(status, value, headers = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
      ...headers,
    },
  });
}

function empty(status, headers = {}) {
  return new Response(null, {
    status,
    headers: { "cache-control": "no-store", ...headers },
  });
}

function methodNotAllowed(allowed) {
  throw new ApiError(405, "METHOD_NOT_ALLOWED", "Method not allowed", {
    allowed,
  });
}

function assertPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ApiError(400, "INVALID_BODY", "Request body must be a JSON object");
  }
}

function assertAllowedKeys(value, allowed) {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new ApiError(
      400,
      "UNKNOWN_FIELD",
      `Unknown field${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}`,
    );
  }
}

function stringField(value, name, {
  required = false,
  nullable = false,
  maxLength,
} = {}) {
  if (value === undefined) {
    if (required) {
      throw new ApiError(400, "INVALID_FIELD", `'${name}' is required`);
    }
    return undefined;
  }
  if (nullable && value === null) return null;
  if (typeof value !== "string") {
    throw new ApiError(
      400,
      "INVALID_FIELD",
      `'${name}' must be a string${nullable ? " or null" : ""}`,
    );
  }
  const normalized = value.trim();
  if (required && normalized.length === 0) {
    throw new ApiError(400, "INVALID_FIELD", `'${name}' cannot be empty`);
  }
  if (normalized.length > maxLength) {
    throw new ApiError(400, "INVALID_FIELD", `'${name}' cannot exceed ${maxLength} characters`);
  }
  return normalized;
}

function parseVersion(value, { allowZero = false } = {}) {
  if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1)) {
    throw new ApiError(
      400,
      "INVALID_FIELD",
      `'version' must be a ${allowZero ? "non-negative" : "positive"} integer`,
    );
  }
  return value;
}

function parseStatus(value, fallback) {
  const status = value ?? fallback;
  if (!TASK_STATUSES.includes(status)) {
    throw new ApiError(
      400,
      "INVALID_FIELD",
      `'status' must be one of: ${TASK_STATUSES.join(", ")}`,
    );
  }
  return status;
}

function parsePriority(value, fallback) {
  const priority = value ?? fallback;
  if (!TASK_PRIORITIES.includes(priority)) {
    throw new ApiError(
      400,
      "INVALID_FIELD",
      "'priority' must be none, urgent, high, medium, or low",
    );
  }
  return priority;
}

function parseLabels(value) {
  if (!Array.isArray(value) || value.length > 20) {
    throw new ApiError(400, "INVALID_FIELD", "'labels' must be an array with at most 20 entries");
  }
  const labels = value.map((label) => {
    if (typeof label !== "string") {
      throw new ApiError(400, "INVALID_FIELD", "Every label must be a string");
    }
    const normalized = label.trim();
    if (normalized.length === 0 || normalized.length > 64) {
      throw new ApiError(400, "INVALID_FIELD", "Labels must contain 1 to 64 characters");
    }
    return normalized;
  });
  if (new Set(labels).size !== labels.length) {
    throw new ApiError(400, "INVALID_FIELD", "Labels must be unique");
  }
  return labels;
}

function parseSortOrder(value) {
  if (
    typeof value !== "number"
    || !Number.isFinite(value)
    || Math.abs(value) > 1_000_000_000_000
  ) {
    throw new ApiError(
      400,
      "INVALID_FIELD",
      "'sortOrder' must be a finite number between -1000000000000 and 1000000000000",
    );
  }
  return value;
}

function parseDueDate(value, name = "dueDate") {
  const date = stringField(value, name, { nullable: true, maxLength: 10 });
  if (date !== null && date !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new ApiError(400, "INVALID_FIELD", `'${name}' must use YYYY-MM-DD`);
  }
  return date;
}

function parseRecurrence(value) {
  if (value === null) return null;
  assertPlainObject(value);
  assertAllowedKeys(value, new Set(["interval", "unit"]));
  if (!Number.isSafeInteger(value.interval) || value.interval < 1 || value.interval > 365) {
    throw new ApiError(
      400,
      "INVALID_FIELD",
      "'recurrence.interval' must be an integer from 1 to 365",
    );
  }
  if (!["day", "week", "month", "year"].includes(value.unit)) {
    throw new ApiError(
      400,
      "INVALID_FIELD",
      "'recurrence.unit' must be day, week, month, or year",
    );
  }
  return { interval: value.interval, unit: value.unit };
}

function parseDevelopmentContext(value) {
  if (value === null) return null;
  assertPlainObject(value);
  if (value.type === "branch") {
    assertAllowedKeys(value, new Set(["type", "branch"]));
    return {
      type: "branch",
      branch: stringField(value.branch, "developmentContext.branch", {
        required: true,
        maxLength: 512,
      }),
    };
  }
  if (value.type === "worktree") {
    assertAllowedKeys(value, new Set(["type", "path", "branch"]));
    const worktreePath = stringField(value.path, "developmentContext.path", {
      maxLength: 4096,
    });
    if (worktreePath?.includes("\0")) {
      throw new ApiError(
        400,
        "INVALID_FIELD",
        "'developmentContext.path' cannot contain null bytes",
      );
    }
    return {
      type: "worktree",
      path: null,
      branch: stringField(value.branch ?? null, "developmentContext.branch", {
        nullable: true,
        maxLength: 512,
      }),
    };
  }
  throw new ApiError(
    400,
    "INVALID_FIELD",
    "'developmentContext.type' must be branch or worktree",
  );
}

function parseThreadId(value) {
  if (value === undefined) return undefined;
  return stringField(value, "threadId", { required: true, maxLength: 256 });
}

function parseThreadBinding(value) {
  if (value === undefined || value === null) return value;
  assertPlainObject(value);
  assertAllowedKeys(value, new Set([
    "threadId",
    "codexProjectId",
    "codexProjectKind",
    "codexHostId",
    "workspacePath",
  ]));
  const threadId = stringField(value.threadId, "threadBinding.threadId", {
    required: true,
    maxLength: 256,
  });
  const identityFields = [
    value.codexProjectId,
    value.codexProjectKind,
    value.codexHostId,
    value.workspacePath,
  ];
  if (identityFields.every((field) => field === undefined)) return { threadId };
  if (identityFields.some((field) => field === undefined)) {
    throw new ApiError(400, "INVALID_FIELD", "Thread identity must include project, kind, host, and workspace");
  }
  const codexProjectId = stringField(value.codexProjectId, "threadBinding.codexProjectId", {
    required: true,
    maxLength: 256,
  });
  const codexProjectKind = value.codexProjectKind;
  const codexHostId = stringField(value.codexHostId, "threadBinding.codexHostId", {
    required: true,
    maxLength: 256,
  });
  const workspacePath = stringField(value.workspacePath, "threadBinding.workspacePath", {
    required: true,
    maxLength: 4096,
  });
  if (
    (codexProjectKind !== "local" && codexProjectKind !== "remote")
    || (codexProjectKind === "local" && codexHostId !== "local")
    || (codexProjectKind === "remote" && codexHostId === "local")
    || workspacePath.includes("\0")
  ) {
    throw new ApiError(400, "INVALID_FIELD", "Thread project identity is invalid");
  }
  return { threadId, codexProjectId, codexProjectKind, codexHostId, workspacePath };
}

function parseStageId(value) {
  if (value === undefined) return undefined;
  const stageId = stringField(value, "stageId", { maxLength: 36 });
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(stageId)) {
    throw new ApiError(400, "INVALID_FIELD", "'stageId' must be a UUID");
  }
  return stageId;
}

function parseAssigneeTarget(value) {
  if (value === undefined) return undefined;
  if (!["current-user", "codex-agent"].includes(value)) {
    throw new ApiError(
      400,
      "INVALID_FIELD",
      "'assigneeTarget' must be current-user or codex-agent",
    );
  }
  return value;
}

function slugify(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

function validateProjectId(value) {
  const id = stringField(value, "id", { required: true, maxLength: 64 });
  if (!PROJECT_ID_PATTERN.test(id)) {
    throw new ApiError(
      400,
      "INVALID_FIELD",
      "'id' must be a lowercase slug containing letters, numbers, or hyphens",
    );
  }
  return id;
}

function projectPrefix(project) {
  const idPrefix = project.id.toUpperCase().replace(/[^A-Z0-9]+/g, "").slice(0, 12) || "TASK";
  const existingPrefix = project.first_identifier?.replace(/-\d+$/, "");
  if (existingPrefix && existingPrefix !== idPrefix) return existingPrefix;
  if (idPrefix.length <= 5) return idPrefix;
  const namePrefix = [...project.name.toUpperCase().replace(/[^\p{L}\p{N}]+/gu, "")]
    .slice(0, 3)
    .join("");
  return namePrefix || idPrefix.slice(0, 3);
}

function now() {
  return new Date().toISOString();
}

function uuid() {
  return crypto.randomUUID();
}

function decodeBasicCredentials(header) {
  if (!header?.startsWith("Basic ")) return null;
  let bytes;
  try {
    const binary = atob(header.slice(6).trim());
    bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    return null;
  }
  let value;
  try {
    value = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
  const separator = value.indexOf(":");
  if (separator < 1) return null;
  return {
    username: value.slice(0, separator),
    password: value.slice(separator + 1),
  };
}

function encodeBase64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function decodeBase64Url(value) {
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function sessionSigningKey(sharedSecret, usage) {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(sharedSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    usage,
  );
}

async function createSessionCookie(username, sharedSecret) {
  const payload = new TextEncoder().encode(JSON.stringify({
    username,
    expiresAt: Date.now() + SESSION_MAX_AGE_SECONDS * 1_000,
  }));
  const encodedPayload = encodeBase64Url(payload);
  const key = await sessionSigningKey(sharedSecret, ["sign"]);
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(encodedPayload),
  );
  const token = `${encodedPayload}.${encodeBase64Url(new Uint8Array(signature))}`;
  return `${SESSION_COOKIE_NAME}=${token}; Path=/; Max-Age=${SESSION_MAX_AGE_SECONDS}; HttpOnly; Secure; SameSite=Strict`;
}

function readCookie(request, name) {
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const separator = part.indexOf("=");
    if (separator < 1 || part.slice(0, separator).trim() !== name) continue;
    return part.slice(separator + 1).trim();
  }
  return null;
}

async function decodeSessionUsername(request, sharedSecret) {
  const token = readCookie(request, SESSION_COOKIE_NAME);
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  try {
    const key = await sessionSigningKey(sharedSecret, ["verify"]);
    const valid = await crypto.subtle.verify(
      "HMAC",
      key,
      decodeBase64Url(parts[1]),
      new TextEncoder().encode(parts[0]),
    );
    if (!valid) return null;
    const payload = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(
      decodeBase64Url(parts[0]),
    ));
    if (!Number.isSafeInteger(payload?.expiresAt) || payload.expiresAt <= Date.now()) return null;
    return stringField(payload.username, "session username", { required: true, maxLength: 120 });
  } catch {
    return null;
  }
}

function unauthorized() {
  return json(
    401,
    { error: { code: "UNAUTHORIZED", message: "Valid Basic credentials are required" } },
    { "www-authenticate": 'Basic realm="Codex Taskboard", charset="UTF-8"' },
  );
}

async function authenticate(request, env) {
  if (typeof env.TASKBOARD_SHARED_SECRET !== "string" || env.TASKBOARD_SHARED_SECRET === "") {
    throw new ApiError(
      500,
      "SERVER_MISCONFIGURED",
      "TASKBOARD_SHARED_SECRET is not configured",
    );
  }
  const credentials = decodeBasicCredentials(request.headers.get("authorization"));
  let username;
  let sessionCookie = null;
  if (credentials) {
    const encoder = new TextEncoder();
    const [providedSecret, configuredSecret] = await Promise.all([
      crypto.subtle.digest("SHA-256", encoder.encode(credentials.password)),
      crypto.subtle.digest("SHA-256", encoder.encode(env.TASKBOARD_SHARED_SECRET)),
    ]);
    if (!crypto.subtle.timingSafeEqual(providedSecret, configuredSecret)) return null;
    username = stringField(credentials.username, "Basic username", {
      required: true,
      maxLength: 120,
    });
    sessionCookie = await createSessionCookie(username, env.TASKBOARD_SHARED_SECRET);
  } else {
    username = await decodeSessionUsername(request, env.TASKBOARD_SHARED_SECRET);
    if (!username) return null;
  }
  const userId = `basic:${encodeURIComponent(username.toLowerCase())}`;
  if (request.headers.get("x-taskboard-client") === "taskctl") {
    return {
      actor: {
        type: "agent",
        id: `${userId}:codex-agent`,
        name: `Codex Agent (${username})`,
        avatarUrl: null,
        username,
      },
      sessionCookie,
    };
  }
  return {
    actor: {
      type: "user",
      id: userId,
      name: username,
      avatarUrl: null,
      username,
    },
    sessionCookie,
  };
}

function resolveAssignee(target, actor) {
  if (target === undefined || target === "current-user") return actor;
  const userId = `basic:${encodeURIComponent(actor.username.toLowerCase())}`;
  return {
    type: "agent",
    id: `${userId}:codex-agent`,
    name: `Codex Agent (${actor.username})`,
    avatarUrl: null,
  };
}

async function readJson(
  request,
  limit = JSON_BODY_LIMIT,
  tooLargeMessage = "JSON body cannot exceed 1 MiB",
) {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith("application/json")) {
    throw new ApiError(
      415,
      "UNSUPPORTED_MEDIA_TYPE",
      "Content-Type must be application/json",
    );
  }
  const contentLength = Number(request.headers.get("content-length") ?? 0);
  if (contentLength > limit) {
    throw new ApiError(413, "BODY_TOO_LARGE", tooLargeMessage);
  }
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > limit) {
    throw new ApiError(413, "BODY_TOO_LARGE", tooLargeMessage);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new ApiError(400, "INVALID_JSON", "Request body is not valid JSON");
  }
}

async function readAttachment(request) {
  const contentLength = Number(request.headers.get("content-length") ?? 0);
  if (contentLength > ATTACHMENT_BODY_LIMIT) {
    throw new ApiError(413, "BODY_TOO_LARGE", "Attachment cannot exceed 25 MiB");
  }
  const body = await request.arrayBuffer();
  if (body.byteLength > ATTACHMENT_BODY_LIMIT) {
    throw new ApiError(413, "BODY_TOO_LARGE", "Attachment cannot exceed 25 MiB");
  }
  return body;
}

function parseAttachmentHeaders(request) {
  const encodedFilename = request.headers.get("x-taskboard-filename");
  if (encodedFilename === null) {
    throw new ApiError(400, "INVALID_FILENAME", "X-Taskboard-Filename is required");
  }
  let filename;
  try {
    filename = decodeURIComponent(encodedFilename).trim();
  } catch {
    throw new ApiError(
      400,
      "INVALID_FILENAME",
      "Attachment filename contains invalid encoding",
    );
  }
  if (
    filename.length === 0
    || filename.length > 240
    || filename === "."
    || filename === ".."
    || /[\u0000-\u001f\u007f/\\]/.test(filename)
  ) {
    throw new ApiError(400, "INVALID_FILENAME", "Attachment filename is invalid");
  }
  const rawContentType = request.headers.get("content-type");
  const contentType = rawContentType
    ? rawContentType.split(";", 1)[0].trim().toLowerCase()
    : "application/octet-stream";
  if (
    contentType.length === 0
    || contentType.length > 200
    || !/^[!#$%&'*+.^_`|~0-9a-z-]+\/[!#$%&'*+.^_`|~0-9a-z-]+$/.test(contentType)
  ) {
    throw new ApiError(
      415,
      "UNSUPPORTED_MEDIA_TYPE",
      "Attachment Content-Type is invalid",
    );
  }
  const kind = request.headers.get("x-taskboard-attachment-kind");
  if (kind !== "inline" && kind !== "attachment") {
    throw new ApiError(
      400,
      "INVALID_ATTACHMENT_KIND",
      "X-Taskboard-Attachment-Kind must be inline or attachment",
    );
  }
  return { filename, contentType, kind };
}

function projectFromRow(row) {
  return {
    id: row.id,
    name: row.name,
    workspacePath: null,
    labels: JSON.parse(row.labels),
    issueCount: Number(row.issue_count ?? 0),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function developmentContextFromRow(row) {
  if (row.development_context_type === "worktree") {
    return {
      type: "worktree",
      path: null,
      branch: row.development_branch,
    };
  }
  if (row.development_context_type === "branch") {
    return { type: "branch", branch: row.development_branch };
  }
  return null;
}

function commentConversationTitle(body) {
  const firstLine = String(body ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  if (!firstLine) return "评论";
  const compact = firstLine.replace(/\s+/g, " ");
  return compact.length > 80 ? `${compact.slice(0, 77)}…` : compact;
}

function threadBindingFromRow(row) {
  if (
    !row.thread_id
    || !row.thread_codex_project_id
    || !row.thread_codex_project_kind
    || !row.thread_codex_host_id
    || !row.thread_workspace_path
  ) return null;
  return {
    threadId: row.thread_id,
    codexProjectId: row.thread_codex_project_id,
    codexProjectKind: row.thread_codex_project_kind,
    codexHostId: row.thread_codex_host_id,
    workspacePath: row.thread_workspace_path,
  };
}

function legacyLocalThreadIdFromRow(row) {
  if (!row.thread_id) return null;
  return [
    row.thread_codex_project_id,
    row.thread_codex_project_kind,
    row.thread_codex_host_id,
    row.thread_workspace_path,
  ].every((value) => value == null)
    ? row.thread_id
    : null;
}

function storedThreadBinding(threadBinding, threadId) {
  if (threadBinding === undefined && (threadId === undefined || threadId === null)) return undefined;
  const binding = threadBinding === undefined ? { threadId } : threadBinding;
  return [
    binding?.threadId ?? null,
    binding?.codexProjectId ?? null,
    binding?.codexProjectKind ?? null,
    binding?.codexHostId ?? null,
    binding?.workspacePath ?? null,
  ];
}

function storedThreadBindingForExisting(current, threadBinding, threadId) {
  const currentBinding = threadBindingFromRow(current);
  if (
    threadBinding === undefined
    && currentBinding
    && currentBinding.threadId === threadId
  ) {
    return storedThreadBinding(currentBinding, threadId);
  }
  return storedThreadBinding(threadBinding, threadId);
}

function attachTaskActivity(task, comments, activities, previewImage = null) {
  const orderedComments = [...comments].sort((left, right) => left.id.localeCompare(right.id));
  const orderedActivities = [...activities].sort((left, right) => left.id.localeCompare(right.id));
  const participants = [];
  const participantIds = new Set();
  const addParticipant = (actor) => {
    const key = `${actor.type}:${actor.id}`;
    if (participantIds.has(key)) return;
    participantIds.add(key);
    participants.push(actor);
  };
  addParticipant({
    type: task.creatorType,
    id: task.creatorId,
    name: task.creatorName,
    avatarUrl: task.creatorAvatarUrl,
  });
  addParticipant(task.assignee);
  for (const comment of orderedComments) {
    addParticipant({
      type: comment.author_type,
      id: comment.author_id,
      name: comment.author_name,
      avatarUrl: comment.author_avatar_url,
    });
  }
  for (const activity of orderedActivities) {
    addParticipant({
      type: activity.actor_type,
      id: activity.actor_id,
      name: activity.actor_name,
      avatarUrl: activity.actor_avatar_url,
    });
  }
  const conversationRefs = [];
  if (task.threadBinding) {
    conversationRefs.push({
      ...task.threadBinding,
      source: "task",
      sourceId: task.id,
      title: task.title,
      updatedAt: task.updatedAt,
    });
  } else if (task.legacyLocalThreadId) {
    conversationRefs.push({
      threadId: task.legacyLocalThreadId,
      legacyLocal: true,
      source: "task",
      sourceId: task.id,
      title: task.title,
      updatedAt: task.updatedAt,
    });
  }
  for (const comment of orderedComments) {
    const threadBinding = threadBindingFromRow(comment);
    const legacyLocalThreadId = legacyLocalThreadIdFromRow(comment);
    if (threadBinding || legacyLocalThreadId) {
      conversationRefs.push({
        ...(threadBinding ?? { threadId: legacyLocalThreadId, legacyLocal: true }),
        source: "comment",
        sourceId: comment.id,
        title: commentConversationTitle(comment.body),
        updatedAt: comment.updated_at,
      });
    }
  }
  task.conversationRefs = conversationRefs;
  task.participants = participants;
  task.previewImage = previewImage;
  task.activityKey = JSON.stringify({
    version: 1,
    task: [task.id, task.version, task.updatedAt],
    comments: orderedComments.map((comment) => [comment.id, comment.version, comment.updated_at]),
    changes: orderedActivities.map((activity) => [activity.id, activity.created_at]),
  });
  task.activityUpdatedAt = [...orderedComments, ...orderedActivities].reduce(
    (latest, activity) => {
      const updatedAt = activity.updated_at ?? activity.created_at;
      return updatedAt > latest ? updatedAt : latest;
    },
    task.updatedAt,
  );
  return task;
}

function taskActivityFromRow(row) {
  return {
    id: row.id,
    taskId: row.task_id,
    actorType: row.actor_type,
    actorId: row.actor_id,
    actorName: row.actor_name,
    actorAvatarUrl: row.actor_avatar_url,
    changes: JSON.parse(row.changes),
    createdAt: row.created_at,
  };
}

function taskFieldChanges(task, changes) {
  return Object.entries(changes).flatMap(([field, after]) => {
    const before = task[field];
    return JSON.stringify(before) === JSON.stringify(after)
      ? []
      : [{ field, before, after }];
  });
}

function relationActivityValue(type, task, metadata) {
  return {
    type,
    identifier: task.identifier,
    title: task.title,
    ...(type === "parent" ? { metadata } : {}),
  };
}

function taskFromRow(row) {
  return {
    id: row.id,
    identifier: row.identifier,
    projectId: row.project_id,
    title: row.title,
    description: row.description,
    status: row.status,
    stageId: row.stage_id,
    priority: row.priority,
    labels: JSON.parse(row.labels),
    sortOrder: row.sort_order,
    threadId: row.thread_id,
    threadBinding: threadBindingFromRow(row),
    legacyLocalThreadId: legacyLocalThreadIdFromRow(row),
    creatorType: row.creator_type,
    creatorId: row.creator_id,
    creatorName: row.creator_name,
    creatorAvatarUrl: row.creator_avatar_url,
    assignee: {
      type: row.assignee_type,
      id: row.assignee_id,
      name: row.assignee_name,
      avatarUrl: row.assignee_avatar_url,
    },
    developmentContext: developmentContextFromRow(row),
    startDate: row.start_date,
    dueDate: row.due_date,
    recurrence: row.recurrence_interval && row.recurrence_unit
      ? { interval: row.recurrence_interval, unit: row.recurrence_unit }
      : null,
    archivedAt: row.archived_at,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function taskRelationSummaryFromRow(row) {
  return {
    id: row.id,
    identifier: row.identifier,
    projectId: row.project_id,
    title: row.title,
    status: row.status,
    priority: row.priority,
    assignee: {
      type: row.assignee_type,
      id: row.assignee_id,
      name: row.assignee_name,
      avatarUrl: row.assignee_avatar_url,
    },
    archivedAt: row.archived_at,
    ...(row.relation_metadata === undefined ? {} : {
      metadata: parentRelationMetadataFromStored(row.relation_metadata),
    }),
  };
}

function taskTreeNode(row, parentId, depth, path) {
  return {
    id: row.id,
    parentId,
    depth,
    path,
    summary: {
      identifier: row.identifier,
      title: row.title,
      status: row.status,
      priority: row.priority,
      archivedAt: row.archived_at,
    },
  };
}

function commentFromRow(row, attachments = []) {
  return {
    id: row.id,
    taskId: row.task_id,
    body: row.body,
    threadId: row.thread_id,
    threadBinding: threadBindingFromRow(row),
    legacyLocalThreadId: legacyLocalThreadIdFromRow(row),
    authorType: row.author_type,
    authorId: row.author_id,
    authorName: row.author_name,
    authorAvatarUrl: row.author_avatar_url,
    attachments,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function attachmentFromRow(row) {
  return {
    id: row.id,
    taskId: row.task_id,
    commentId: row.comment_id,
    kind: row.kind,
    filename: row.filename,
    contentType: row.content_type,
    size: row.size,
    createdAt: row.created_at,
  };
}

function projectReadmeAttachmentFromRow(row) {
  return {
    id: row.id,
    projectId: row.project_id,
    kind: "inline",
    filename: row.filename,
    contentType: row.content_type,
    size: row.size,
    createdAt: row.created_at,
  };
}

async function all(statement) {
  return (await statement.all()).results;
}

function changed(result) {
  if (typeof result?.meta?.changes !== "number") {
    throw new Error("D1 mutation did not return change metadata");
  }
  return result.meta.changes > 0;
}

function taskActivityStatement(env, taskId, actor, changes, timestamp, version) {
  return env.DB.prepare(`
    INSERT INTO task_activities (
      id, task_id, actor_type, actor_id, actor_name, actor_avatar_url, changes, created_at
    )
    SELECT ?, ?, ?, ?, ?, ?, ?, ?
    WHERE EXISTS (
      SELECT 1 FROM tasks WHERE id = ? AND version = ? AND updated_at = ?
    )
  `).bind(
    uuid(),
    taskId,
    actor.type,
    actor.id,
    actor.name,
    actor.avatarUrl,
    JSON.stringify(changes),
    timestamp,
    taskId,
    version,
    timestamp,
  );
}

async function requireProject(env, id) {
  const row = await env.DB.prepare("SELECT * FROM projects WHERE id = ?").bind(id).first();
  if (!row) {
    throw new ApiError(404, "PROJECT_NOT_FOUND", `Project '${id}' does not exist`);
  }
  return row;
}

async function taskRow(env, id) {
  return env.DB.prepare(
    "SELECT * FROM tasks WHERE id = ? OR identifier = ?",
  ).bind(id, id).first();
}

async function requireTaskRow(env, id) {
  const row = await taskRow(env, id);
  if (!row) throw new ApiError(404, "TASK_NOT_FOUND", `Task '${id}' does not exist`);
  return row;
}

function assertTaskVersion(row, expectedVersion) {
  if (row.version !== expectedVersion) {
    throw new ApiError(
      409,
      "VERSION_CONFLICT",
      "Task was changed by another client",
      { expectedVersion, actualVersion: row.version },
    );
  }
}

async function attachmentsForComment(env, commentId) {
  return (
    await all(
      env.DB.prepare(
        "SELECT * FROM attachments WHERE comment_id = ? ORDER BY created_at, id",
      ).bind(commentId),
    )
  ).map(attachmentFromRow);
}

async function hydrateComment(env, row) {
  return commentFromRow(row, await attachmentsForComment(env, row.id));
}

async function hydrateTask(env, row, activityComments = null, activityChanges = null) {
  const task = taskFromRow(row);
  const [parent, subIssues, blockedBy, blocks, related, previewImageRow] = await Promise.all([
    env.DB.prepare(`
      SELECT tasks.*, task_relations.metadata AS relation_metadata
      FROM task_relations
      JOIN tasks ON tasks.id = task_relations.source_task_id
      WHERE task_relations.relation_type = 'parent'
        AND task_relations.target_task_id = ?
    `).bind(task.id).first(),
    all(env.DB.prepare(`
      SELECT tasks.*, task_relations.metadata AS relation_metadata
      FROM task_relations
      JOIN tasks ON tasks.id = task_relations.target_task_id
      WHERE task_relations.relation_type = 'parent'
        AND task_relations.source_task_id = ?
      ORDER BY tasks.sort_order, tasks.created_at, tasks.id
    `).bind(task.id)),
    all(env.DB.prepare(`
      SELECT tasks.*
      FROM task_relations
      JOIN tasks ON tasks.id = task_relations.source_task_id
      WHERE task_relations.relation_type = 'blocks'
        AND task_relations.target_task_id = ?
      ORDER BY tasks.sort_order, tasks.created_at, tasks.id
    `).bind(task.id)),
    all(env.DB.prepare(`
      SELECT tasks.*
      FROM task_relations
      JOIN tasks ON tasks.id = task_relations.target_task_id
      WHERE task_relations.relation_type = 'blocks'
        AND task_relations.source_task_id = ?
      ORDER BY tasks.sort_order, tasks.created_at, tasks.id
    `).bind(task.id)),
    all(env.DB.prepare(`
      SELECT tasks.*
      FROM task_relations
      JOIN tasks ON tasks.id = CASE
        WHEN task_relations.source_task_id = ? THEN task_relations.target_task_id
        ELSE task_relations.source_task_id
      END
      WHERE task_relations.relation_type = 'related'
        AND (
          task_relations.source_task_id = ?
          OR task_relations.target_task_id = ?
        )
      ORDER BY tasks.sort_order, tasks.created_at, tasks.id
    `).bind(task.id, task.id, task.id)),
    env.DB.prepare(`
      SELECT attachments.*
      FROM attachments
      JOIN tasks ON tasks.id = attachments.task_id
      WHERE attachments.task_id = ?
        AND attachments.comment_id IS NULL
        AND attachments.content_type LIKE 'image/%'
        AND instr(tasks.description, 'api/attachments/' || attachments.id || '/content') > 0
      ORDER BY attachments.created_at, attachments.id
      LIMIT 1
    `).bind(task.id).first(),
  ]);
  task.relations = {
    parent: parent ? taskRelationSummaryFromRow(parent) : null,
    subIssues: subIssues.map(taskRelationSummaryFromRow),
    blockedBy: blockedBy.map(taskRelationSummaryFromRow),
    blocks: blocks.map(taskRelationSummaryFromRow),
    related: related.map(taskRelationSummaryFromRow),
  };
  const comments = activityComments ?? await all(env.DB.prepare(`
    SELECT
      id, task_id,
      CASE WHEN thread_id IS NULL THEN NULL ELSE substr(body, 1, 512) END AS body,
      thread_id, thread_codex_project_id, thread_codex_project_kind,
      thread_codex_host_id, thread_workspace_path,
      author_type, author_id, author_name,
      author_avatar_url, version, updated_at
    FROM comments
    WHERE task_id = ?
    ORDER BY id
  `).bind(task.id));
  const activities = activityChanges ?? await all(env.DB.prepare(`
    SELECT
      id, task_id, actor_type, actor_id, actor_name, actor_avatar_url, created_at
    FROM task_activities
    WHERE task_id = ?
    ORDER BY created_at, id
  `).bind(task.id));
  return attachTaskActivity(
    task,
    comments,
    activities,
    previewImageRow ? attachmentFromRow(previewImageRow) : null,
  );
}

async function getTask(env, id) {
  const row = await taskRow(env, id);
  return row ? hydrateTask(env, row) : null;
}

async function getTaskTree(env, id, direction, depth) {
  const root = await requireTaskRow(env, id);
  const nodes = [taskTreeNode(root, null, 0, [root.id])];
  const seen = new Set([root.id]);
  let frontier = [nodes[0]];
  const relationJoin = direction === "descendants"
    ? `
      FROM task_relations
      JOIN tasks ON tasks.id = task_relations.target_task_id
      WHERE task_relations.relation_type = 'parent'
        AND task_relations.source_task_id IN (%PLACEHOLDERS%)
    `
    : `
      FROM task_relations
      JOIN tasks ON tasks.id = task_relations.source_task_id
      WHERE task_relations.relation_type = 'parent'
        AND task_relations.target_task_id IN (%PLACEHOLDERS%)
    `;
  const parentColumn = direction === "descendants"
    ? "task_relations.source_task_id"
    : "task_relations.target_task_id";

  for (let level = 1; level <= depth && frontier.length > 0; level += 1) {
    const placeholders = frontier.map(() => "?").join(", ");
    const rows = await all(env.DB.prepare(`
      SELECT tasks.*, ${parentColumn} AS tree_parent_id
      ${relationJoin.replace("%PLACEHOLDERS%", placeholders)}
      ORDER BY tasks.sort_order, tasks.created_at, tasks.id
    `).bind(...frontier.map((node) => node.id)));
    const rowsByParent = new Map();
    for (const row of rows) {
      const siblings = rowsByParent.get(row.tree_parent_id) ?? [];
      siblings.push(row);
      rowsByParent.set(row.tree_parent_id, siblings);
    }
    const next = [];
    for (const parent of frontier) {
      for (const row of rowsByParent.get(parent.id) ?? []) {
        if (seen.has(row.id)) continue;
        if (nodes.length >= TASK_TREE_MAX_NODES) {
          throw new ApiError(413, "TREE_TOO_LARGE", `Task tree cannot exceed ${TASK_TREE_MAX_NODES} nodes`);
        }
        const node = taskTreeNode(row, parent.id, level, [...parent.path, row.id]);
        nodes.push(node);
        next.push(node);
        seen.add(row.id);
      }
    }
    frontier = next;
  }

  return {
    rootId: root.id,
    direction,
    depth,
    nodeCount: nodes.length,
    nodes,
  };
}

async function getTaskRollup(env, id) {
  const root = await requireTaskRow(env, id);
  const rows = await all(env.DB.prepare(`
    WITH RECURSIVE rolled_tasks(id, parent_id, relation_metadata) AS (
      SELECT ?, NULL, NULL
      UNION ALL
      SELECT relations.target_task_id, relations.source_task_id, relations.metadata
      FROM task_relations AS relations
      JOIN rolled_tasks ON rolled_tasks.id = relations.source_task_id
      WHERE relations.relation_type = 'parent'
        AND COALESCE(json_extract(relations.metadata, '$.rollup'), 1) = 1
    )
    SELECT tasks.*, rolled_tasks.parent_id AS rollup_parent_id,
      rolled_tasks.relation_metadata AS rollup_relation_metadata
    FROM rolled_tasks
    JOIN tasks ON tasks.id = rolled_tasks.id
    LIMIT ?
  `).bind(root.id, TASK_TREE_MAX_NODES + 1));
  if (rows.length > TASK_TREE_MAX_NODES) {
    throw new ApiError(413, "TREE_TOO_LARGE", `Task tree cannot exceed ${TASK_TREE_MAX_NODES} nodes`);
  }

  return calculateTaskRollup({
    root: taskFromRow(root),
    tasks: rows.map(taskFromRow),
    relations: rows.flatMap((row) => (
      row.rollup_parent_id === null ? [] : [{
        type: "parent",
        parentId: row.rollup_parent_id,
        childId: row.id,
        metadata: parentRelationMetadataFromStored(row.rollup_relation_metadata),
      }]
    )),
    maxNodes: TASK_TREE_MAX_NODES,
  });
}

async function getNestedWorkspace(env, id, options) {
  const root = await requireTaskRow(env, id);
  const error = (code, message) => new ApiError(409, code, message);
  const parentRow = async (taskId) => env.DB.prepare(`
    SELECT tasks.*
    FROM task_relations
    JOIN tasks ON tasks.id = task_relations.source_task_id
    WHERE task_relations.relation_type = 'parent'
      AND task_relations.target_task_id = ?
  `).bind(taskId).first();
  const childRows = async (parentId) => all(env.DB.prepare(`
    SELECT tasks.*
    FROM task_relations
    JOIN tasks ON tasks.id = task_relations.target_task_id
    WHERE task_relations.relation_type = 'parent'
      AND task_relations.source_task_id = ?
    ORDER BY tasks.sort_order, tasks.created_at, tasks.id
  `).bind(parentId));
  const ancestorRows = [root];
  const seenAncestors = new Set([root.id]);
  let current = root;
  while (true) {
    const parent = await parentRow(current.id);
    if (!parent) break;
    if (parent.project_id !== root.project_id) {
      throw error("CROSS_PROJECT_WORKSPACE", "Nested workspace items must stay within one project");
    }
    if (seenAncestors.has(parent.id)) {
      throw error("NESTED_WORKSPACE_CYCLE", "Nested workspace contains a parent cycle");
    }
    seenAncestors.add(parent.id);
    ancestorRows.unshift(parent);
    current = parent;
  }
  const breadcrumb = ancestorRows.map((row, depth) => workspaceItemFromRow(row, {
    depth,
    path: ancestorRows.slice(0, depth + 1).map((entry) => entry.id),
  }));
  const directChildren = (await childRows(root.id)).map((row) => {
    if (row.project_id !== root.project_id) {
      throw error("CROSS_PROJECT_WORKSPACE", "Nested workspace items must stay within one project");
    }
    return workspaceItemFromRow(row, { parentId: root.id, depth: 1, path: [root.id, row.id] });
  });
  const workspace = {
    overview: workspaceOverviewFromTask(await getTask(env, root.id)),
    breadcrumb,
    children: paginateWorkspaceItems(
      directChildren,
      options.childrenCursor,
      options.limit,
      "children",
      error,
    ),
  };
  if (!options.descendants) return workspace;

  const descendants = [];
  const seen = new Set([root.id]);
  let frontier = [{ id: root.id, path: [root.id] }];
  while (frontier.length > 0) {
    const next = [];
    for (const parent of frontier) {
      for (const row of await childRows(parent.id)) {
        if (row.project_id !== root.project_id) {
          throw error("CROSS_PROJECT_WORKSPACE", "Nested workspace items must stay within one project");
        }
        if (seen.has(row.id)) {
          throw error("NESTED_WORKSPACE_CYCLE", "Nested workspace contains a parent cycle");
        }
        if (descendants.length >= NESTED_WORKSPACE_MAX_NODES) {
          throw new ApiError(
            413,
            "NESTED_WORKSPACE_TOO_LARGE",
            `Nested workspace cannot exceed ${NESTED_WORKSPACE_MAX_NODES} descendants`,
          );
        }
        const node = workspaceItemFromRow(row, {
          parentId: parent.id,
          depth: parent.path.length,
          path: [...parent.path, row.id],
        });
        descendants.push(node);
        seen.add(row.id);
        next.push(node);
      }
    }
    frontier = next;
  }
  workspace.descendants = paginateWorkspaceItems(
    descendants,
    options.descendantsCursor,
    options.limit,
    "descendants",
    error,
  );
  return workspace;
}

async function taskActivityComments(env, taskIds) {
  const commentsByTask = new Map(taskIds.map((taskId) => [taskId, []]));
  const batches = [];
  for (let offset = 0; offset < taskIds.length; offset += 80) {
    const chunk = taskIds.slice(offset, offset + 80);
    if (chunk.length === 0) continue;
    const placeholders = chunk.map(() => "?").join(", ");
    batches.push(all(env.DB.prepare(`
      SELECT
        id, task_id,
        CASE WHEN thread_id IS NULL THEN NULL ELSE substr(body, 1, 512) END AS body,
        thread_id, thread_codex_project_id, thread_codex_project_kind,
        thread_codex_host_id, thread_workspace_path,
        author_type, author_id, author_name,
        author_avatar_url, version, updated_at
      FROM comments
      WHERE task_id IN (${placeholders})
      ORDER BY task_id, id
    `).bind(...chunk)));
  }
  for (const rows of await Promise.all(batches)) {
    for (const row of rows) commentsByTask.get(row.task_id)?.push(row);
  }
  return commentsByTask;
}

async function taskActivitiesForTasks(env, taskIds) {
  const activitiesByTask = new Map(taskIds.map((taskId) => [taskId, []]));
  const batches = [];
  for (let offset = 0; offset < taskIds.length; offset += 80) {
    const chunk = taskIds.slice(offset, offset + 80);
    if (chunk.length === 0) continue;
    const placeholders = chunk.map(() => "?").join(", ");
    batches.push(all(env.DB.prepare(`
      SELECT
        id, task_id, actor_type, actor_id, actor_name, actor_avatar_url, created_at
      FROM task_activities
      WHERE task_id IN (${placeholders})
      ORDER BY task_id, created_at, id
    `).bind(...chunk)));
  }
  for (const rows of await Promise.all(batches)) {
    for (const row of rows) activitiesByTask.get(row.task_id)?.push(row);
  }
  return activitiesByTask;
}

function parseProjectCreate(body) {
  assertPlainObject(body);
  assertAllowedKeys(body, new Set(["id", "name", "workspacePath"]));
  const name = stringField(body.name, "name", { required: true, maxLength: 120 });
  const id = validateProjectId(body.id ?? slugify(name));
  if (body.workspacePath !== undefined && body.workspacePath !== null) {
    const workspacePath = stringField(body.workspacePath, "workspacePath", {
      required: true,
      maxLength: 4096,
    });
    if (workspacePath.includes("\0")) {
      throw new ApiError(400, "INVALID_FIELD", "'workspacePath' cannot contain null bytes");
    }
  }
  return { id, name };
}

function parseProjectLabel(body) {
  assertPlainObject(body);
  assertAllowedKeys(body, new Set(["label"]));
  return stringField(body.label, "label", { required: true, maxLength: 64 });
}

function parseTaskCreate(body) {
  assertPlainObject(body);
  assertAllowedKeys(body, new Set([
    "projectId",
    "title",
    "description",
    "status",
    "stageId",
    "priority",
    "labels",
    "sortOrder",
    "threadId",
    "threadBinding",
    "assigneeTarget",
    "developmentContext",
    "startDate",
    "dueDate",
    "recurrence",
  ]));
  const input = {
    projectId: validateProjectId(body.projectId ?? "local"),
    title: stringField(body.title, "title", { required: true, maxLength: 240 }),
    description: stringField(body.description ?? "", "description", { maxLength: 100_000 }),
    status: parseStatus(body.status, "backlog"),
    stageId: parseStageId(body.stageId),
    priority: parsePriority(body.priority, "none"),
    labels: body.labels === undefined ? [] : parseLabels(body.labels),
    sortOrder: body.sortOrder === undefined ? undefined : parseSortOrder(body.sortOrder),
    threadId: parseThreadId(body.threadId),
    threadBinding: parseThreadBinding(body.threadBinding),
    assigneeTarget: parseAssigneeTarget(body.assigneeTarget),
    developmentContext: parseDevelopmentContext(body.developmentContext ?? null),
    startDate: parseDueDate(body.startDate ?? null, "startDate"),
    dueDate: parseDueDate(body.dueDate ?? null),
    recurrence: parseRecurrence(body.recurrence ?? null),
  };
  if (input.recurrence && !input.dueDate) {
    throw new ApiError(400, "INVALID_FIELD", "A recurring issue requires 'dueDate'");
  }
  return input;
}

function parseTaskPatch(body) {
  assertPlainObject(body);
  assertAllowedKeys(body, new Set([
    "version",
    "projectId",
    "title",
    "description",
    "status",
    "stageId",
    "priority",
    "labels",
    "threadId",
    "threadBinding",
    "assigneeTarget",
    "developmentContext",
    "startDate",
    "dueDate",
    "recurrence",
  ]));
  const changes = {};
  if (body.projectId !== undefined) changes.projectId = validateProjectId(body.projectId);
  if (body.title !== undefined) {
    changes.title = stringField(body.title, "title", { required: true, maxLength: 240 });
  }
  if (body.description !== undefined) {
    changes.description = stringField(body.description, "description", { maxLength: 100_000 });
  }
  if (body.status !== undefined) changes.status = parseStatus(body.status);
  if (body.stageId !== undefined) changes.stageId = parseStageId(body.stageId);
  if (body.priority !== undefined) changes.priority = parsePriority(body.priority);
  if (body.labels !== undefined) changes.labels = parseLabels(body.labels);
  if (body.developmentContext !== undefined) {
    changes.developmentContext = parseDevelopmentContext(body.developmentContext);
  }
  if (body.startDate !== undefined) changes.startDate = parseDueDate(body.startDate, "startDate");
  if (body.dueDate !== undefined) changes.dueDate = parseDueDate(body.dueDate);
  if (body.recurrence !== undefined) changes.recurrence = parseRecurrence(body.recurrence);
  const assigneeTarget = parseAssigneeTarget(body.assigneeTarget);
  if (Object.keys(changes).length === 0 && assigneeTarget === undefined) {
    throw new ApiError(400, "INVALID_BODY", "PATCH requires at least one task field");
  }
  return {
    version: parseVersion(body.version),
    changes,
    threadId: parseThreadId(body.threadId),
    threadBinding: parseThreadBinding(body.threadBinding),
    assigneeTarget,
  };
}

function parseMove(body) {
  assertPlainObject(body);
  assertAllowedKeys(body, new Set(["version", "status", "stageId", "sortOrder", "threadId", "threadBinding"]));
  return {
    version: parseVersion(body.version),
    status: body.status === undefined ? undefined : parseStatus(body.status),
    stageId: parseStageId(body.stageId),
    sortOrder: body.sortOrder === undefined ? undefined : parseSortOrder(body.sortOrder),
    threadId: parseThreadId(body.threadId),
    threadBinding: parseThreadBinding(body.threadBinding),
  };
}

function parseStageWorkflowSave(body) {
  assertPlainObject(body);
  assertAllowedKeys(body, new Set(["version", "definition", "removals"]));
  assertPlainObject(body.definition);
  assertAllowedKeys(body.definition, new Set(["schemaVersion", "stages"]));
  if (body.definition.schemaVersion !== 2 || !Array.isArray(body.definition.stages)) {
    throw new ApiError(400, "INVALID_FIELD", "'definition' must be stage workflow schema version 2");
  }
  const stages = body.definition.stages.map((raw, index) => {
    assertPlainObject(raw);
    assertAllowedKeys(raw, new Set([
      "stageId", "canonicalStatus", "name", "order", "boardVisible", "active",
      "isDefaultForStatus", "terminalKind",
    ]));
    const stageId = raw.stageId == null ? null : parseStageId(raw.stageId);
    const canonicalStatus = parseStatus(raw.canonicalStatus);
    const name = stringField(raw.name, `definition.stages[${index}].name`, { required: true, maxLength: 120 });
    if (!Number.isSafeInteger(raw.order) || raw.order < 0 || raw.order > 1_000_000) throw new ApiError(400, "INVALID_FIELD", "Stage order must be an integer from 0 to 1000000");
    if (typeof raw.boardVisible !== "boolean" || typeof raw.active !== "boolean" || typeof raw.isDefaultForStatus !== "boolean") {
      throw new ApiError(400, "INVALID_FIELD", "Stage visibility, active and default flags must be boolean");
    }
    const expectedTerminalKind = canonicalStatus === "done"
      ? "done"
      : canonicalStatus === "canceled"
        ? "canceled"
        : "none";
    if (raw.terminalKind !== expectedTerminalKind) {
      throw new ApiError(400, "INVALID_FIELD", `Stage terminalKind must be ${expectedTerminalKind} for ${canonicalStatus}`);
    }
    if (!raw.active && raw.isDefaultForStatus) {
      throw new ApiError(400, "INVALID_FIELD", "An inactive stage cannot be the default for its status");
    }
    return { stageId, canonicalStatus, name, order: raw.order, boardVisible: raw.boardVisible, active: raw.active, isDefaultForStatus: raw.isDefaultForStatus, terminalKind: raw.terminalKind };
  });
  if (new Set(stages.map((stage) => stage.order)).size !== stages.length || new Set(stages.map((stage) => stage.stageId).filter(Boolean)).size !== stages.filter((stage) => stage.stageId).length) {
    throw new ApiError(400, "INVALID_FIELD", "Stage ids and orders must be unique");
  }
  for (const status of TASK_STATUSES) {
    const defaults = stages.filter((stage) => stage.canonicalStatus === status && stage.isDefaultForStatus && stage.active);
    if (defaults.length !== 1) throw new ApiError(400, "INVALID_FIELD", `Each status requires exactly one active default stage (${status})`);
  }
  const removals = (body.removals ?? []).map((raw, index) => {
    assertPlainObject(raw);
    assertAllowedKeys(raw, new Set(["stageId", "destinationStageId"]));
    const stageId = parseStageId(raw.stageId);
    if (stageId === undefined) throw new ApiError(400, "INVALID_FIELD", `removals[${index}].stageId is required`);
    const destinationStageId = parseStageId(raw.destinationStageId);
    if (destinationStageId === undefined) throw new ApiError(400, "INVALID_FIELD", `removals[${index}].destinationStageId is required`);
    return { stageId, destinationStageId };
  });
  return { version: parseVersion(body.version, { allowZero: true }), definition: { schemaVersion: 2, stages }, removals };
}

function parseVersionMutation(body) {
  assertPlainObject(body);
  assertAllowedKeys(body, new Set(["version", "threadId", "threadBinding"]));
  return {
    version: parseVersion(body.version),
    threadId: parseThreadId(body.threadId),
    threadBinding: parseThreadBinding(body.threadBinding),
  };
}

function parseRelationOrigin(value) {
  if (value === undefined) return undefined;
  if (value !== "manual" && value !== "mention") {
    throw new ApiError(400, "INVALID_FIELD", "'origin' must be manual or mention");
  }
  return value;
}

function parseRelationMutation(body, type, method) {
  assertPlainObject(body);
  assertAllowedKeys(body, new Set(["version", "threadId", "threadBinding", "origin", "metadata"]));
  let metadata;
  if (type === "parent" && method !== "DELETE") {
    try {
      metadata = normalizeParentRelationMetadata(body.metadata, { required: method === "PATCH" });
    } catch (error) {
      throw new ApiError(400, "INVALID_FIELD", error.message);
    }
  }
  return {
    version: parseVersion(body.version),
    threadId: parseThreadId(body.threadId),
    threadBinding: parseThreadBinding(body.threadBinding),
    origin: parseRelationOrigin(body.origin),
    metadata,
  };
}

function parseCommentCreate(body) {
  assertPlainObject(body);
  assertAllowedKeys(body, new Set(["body", "threadId", "threadBinding"]));
  return {
    body: stringField(body.body ?? "", "body", { maxLength: 100_000 }),
    threadId: parseThreadId(body.threadId),
    threadBinding: parseThreadBinding(body.threadBinding),
  };
}

function parseCommentPatch(body) {
  assertPlainObject(body);
  assertAllowedKeys(body, new Set(["version", "body", "threadId", "threadBinding"]));
  if (body.body === undefined) {
    throw new ApiError(400, "INVALID_FIELD", "'body' is required");
  }
  return {
    version: parseVersion(body.version),
    body: stringField(body.body, "body", { maxLength: 100_000 }),
    threadId: parseThreadId(body.threadId),
    threadBinding: parseThreadBinding(body.threadBinding),
  };
}

function parseTaskFilters(searchParams) {
  const allowed = new Set(["projectId", "status", "archived"]);
  for (const key of searchParams.keys()) {
    if (!allowed.has(key)) {
      throw new ApiError(400, "UNKNOWN_QUERY_PARAMETER", `Unknown query parameter: ${key}`);
    }
    if (searchParams.getAll(key).length > 1) {
      throw new ApiError(400, "INVALID_QUERY_PARAMETER", `'${key}' cannot be repeated`);
    }
  }
  const projectId = searchParams.get("projectId");
  const status = searchParams.get("status");
  const archived = searchParams.get("archived") ?? "false";
  if (projectId !== null) validateProjectId(projectId);
  if (status !== null) parseStatus(status);
  if (!["false", "true", "all"].includes(archived)) {
    throw new ApiError(
      400,
      "INVALID_QUERY_PARAMETER",
      "'archived' must be false, true, or all",
    );
  }
  return { projectId, status, archived };
}

function parseTaskTreeQuery(searchParams) {
  const allowed = new Set(["direction", "depth"]);
  for (const key of searchParams.keys()) {
    if (!allowed.has(key)) {
      throw new ApiError(400, "UNKNOWN_QUERY_PARAMETER", `Unknown query parameter: ${key}`);
    }
    if (searchParams.getAll(key).length !== 1) {
      throw new ApiError(400, "INVALID_TREE_QUERY", `'${key}' cannot be repeated`);
    }
  }
  const direction = searchParams.get("direction");
  if (direction !== "descendants" && direction !== "ancestors") {
    throw new ApiError(400, "INVALID_TREE_QUERY", "'direction' must be descendants or ancestors");
  }
  const rawDepth = searchParams.get("depth");
  const depth = Number(rawDepth);
  if (!/^\d+$/.test(rawDepth ?? "") || !Number.isSafeInteger(depth) || depth < 1 || depth > 25) {
    throw new ApiError(400, "INVALID_TREE_QUERY", "'depth' must be an integer from 1 to 25");
  }
  return { direction, depth };
}

function parseAfterCursor(searchParams) {
  for (const key of searchParams.keys()) {
    if (key !== "after") {
      throw new ApiError(400, "UNKNOWN_QUERY_PARAMETER", `Unknown query parameter: ${key}`);
    }
  }
  const values = searchParams.getAll("after");
  if (values.length === 0) return null;
  if (values.length !== 1) {
    throw new ApiError(400, "INVALID_CURSOR", "'after' must be provided once");
  }
  const value = values[0];
  const revision = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(revision)) {
    throw new ApiError(400, "INVALID_CURSOR", "'after' must be a non-negative decimal integer");
  }
  return { value, revision };
}

function nextCursor(rows, after) {
  if (rows.length === 0) return after?.value ?? "0";
  let revision = rows[0].change_revision;
  for (const row of rows.slice(1)) {
    if (row.change_revision > revision) revision = row.change_revision;
  }
  return String(revision);
}

async function listProjects(env) {
  const rows = await all(env.DB.prepare(`
    SELECT
      projects.id,
      projects.name,
      projects.workspace_path,
      projects.labels,
      projects.created_at,
      projects.updated_at,
      COUNT(tasks.id) AS issue_count
    FROM projects
    LEFT JOIN tasks
      ON tasks.project_id = projects.id
      AND tasks.archived_at IS NULL
    GROUP BY
      projects.id,
      projects.name,
      projects.workspace_path,
      projects.labels,
      projects.created_at,
      projects.updated_at
    ORDER BY projects.created_at, projects.id
  `));
  return rows.map(projectFromRow);
}

async function getProject(env, id) {
  const row = await env.DB.prepare(`
    SELECT
      projects.id,
      projects.name,
      projects.workspace_path,
      projects.labels,
      projects.created_at,
      projects.updated_at,
      COUNT(tasks.id) AS issue_count
    FROM projects
    LEFT JOIN tasks
      ON tasks.project_id = projects.id
      AND tasks.archived_at IS NULL
    WHERE projects.id = ?
    GROUP BY
      projects.id,
      projects.name,
      projects.workspace_path,
      projects.labels,
      projects.created_at,
      projects.updated_at
  `).bind(id).first();
  return row ? projectFromRow(row) : null;
}

async function createProject(env, input) {
  const timestamp = now();
  try {
    const results = await env.DB.batch([
      env.DB.prepare(`
      INSERT INTO projects (
        id, name, workspace_path, labels, next_task_number, created_at, updated_at
      ) VALUES (?, ?, NULL, ?, 1, ?, ?)
    `).bind(input.id, input.name, DEFAULT_PROJECT_LABELS_JSON, timestamp, timestamp),
      env.DB.prepare("INSERT INTO project_stage_workflows (project_id, version, updated_at) VALUES (?, 1, ?)").bind(input.id, timestamp),
      ...DEFAULT_STAGE_WORKFLOW.map(([canonicalStatus, name, boardVisible], order) => env.DB.prepare(
        "INSERT INTO workflow_stages (id, project_id, canonical_status, name, sort_order, board_visible, active, is_default_for_status, terminal_kind, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 1, 1, ?, ?, ?)",
      ).bind(uuid(), input.id, canonicalStatus, name, order, boardVisible ? 1 : 0, canonicalStatus === "done" ? "done" : canonicalStatus === "canceled" ? "canceled" : "none", timestamp, timestamp)),
    ]);
    if (!changed(results[0])) throw new Error("Project creation did not report a mutation");
  } catch (error) {
    if (String(error.message).includes("UNIQUE constraint failed")) {
      throw new ApiError(409, "PROJECT_EXISTS", `Project '${input.id}' already exists`);
    }
    throw error;
  }
  return getProject(env, input.id);
}

async function addProjectLabel(env, projectId, label) {
  await requireProject(env, projectId);
  await env.DB.prepare(`
    UPDATE projects
    SET labels = json_insert(labels, '$[#]', ?), updated_at = ?
    WHERE id = ?
      AND NOT EXISTS (
        SELECT 1 FROM json_each(projects.labels) WHERE value = ?
      )
  `).bind(label, now(), projectId, label).run();
  return getProject(env, projectId);
}

async function deleteProjectLabel(env, projectId, label) {
  await requireProject(env, projectId);
  const timestamp = now();
  await env.DB.batch([
    env.DB.prepare(`
      UPDATE projects
      SET
        labels = (
          SELECT COALESCE(json_group_array(value), '[]')
          FROM json_each(projects.labels)
          WHERE value != ?
        ),
        updated_at = ?
      WHERE id = ?
        AND EXISTS (
          SELECT 1 FROM json_each(projects.labels) WHERE value = ?
        )
    `).bind(label, timestamp, projectId, label),
    env.DB.prepare(`
      UPDATE tasks
      SET
        labels = (
          SELECT COALESCE(json_group_array(value), '[]')
          FROM json_each(tasks.labels)
          WHERE value != ?
        ),
        version = version + 1,
        updated_at = ?
      WHERE project_id = ?
        AND EXISTS (
          SELECT 1 FROM json_each(tasks.labels) WHERE value = ?
        )
    `).bind(label, timestamp, projectId, label),
  ]);
  return getProject(env, projectId);
}

async function deleteProject(env, id) {
  const project = await getProject(env, id);
  if (!project) {
    throw new ApiError(404, "PROJECT_NOT_FOUND", `Project '${id}' does not exist`);
  }
  if (!id.startsWith("temp-")) {
    throw new ApiError(403, "PROJECT_DELETE_FORBIDDEN", "Only manually created projects can be deleted");
  }
  const result = await env.DB.prepare(`
    DELETE FROM projects
    WHERE id = ?
      AND NOT EXISTS (SELECT 1 FROM tasks WHERE project_id = ?)
  `).bind(id, id).run();
  if (!changed(result)) {
    const issueCount = Number(await env.DB.prepare(`
      SELECT COUNT(*) AS issue_count FROM tasks WHERE project_id = ?
    `).bind(id).first("issue_count"));
    throw new ApiError(409, "PROJECT_NOT_EMPTY", "Project still contains issues", { issueCount });
  }
  return project;
}

async function listTasks(env, filters) {
  const where = [];
  const values = [];
  if (filters.projectId) {
    where.push("project_id = ?");
    values.push(filters.projectId);
  }
  if (filters.status) {
    where.push("status = ?");
    values.push(filters.status);
  }
  if (filters.archived === "false") {
    where.push("archived_at IS NULL");
  } else if (filters.archived === "true") {
    where.push("archived_at IS NOT NULL");
  }
  const rows = await all(
    env.DB.prepare(`
      SELECT * FROM tasks
      ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY
        CASE status
          WHEN 'backlog' THEN 1
          WHEN 'todo' THEN 2
          WHEN 'in_progress' THEN 3
          WHEN 'in_review' THEN 4
          WHEN 'blocked' THEN 5
          WHEN 'done' THEN 6
          WHEN 'canceled' THEN 7
        END,
        sort_order,
        created_at,
        id
    `).bind(...values),
  );
  const taskIds = rows.map((row) => row.id);
  const [commentsByTask, activitiesByTask] = await Promise.all([
    taskActivityComments(env, taskIds),
    taskActivitiesForTasks(env, taskIds),
  ]);
  return Promise.all(rows.map((row) => hydrateTask(
    env,
    row,
    commentsByTask.get(row.id) ?? [],
    activitiesByTask.get(row.id) ?? [],
  )));
}

async function resolveStageForTask(env, projectId, { stageId, status }) {
  const row = stageId == null
    ? await env.DB.prepare("SELECT id, canonical_status FROM workflow_stages WHERE project_id = ? AND canonical_status = ? AND active = 1 AND is_default_for_status = 1").bind(projectId, status).first()
    : await env.DB.prepare("SELECT id, canonical_status FROM workflow_stages WHERE id = ? AND project_id = ? AND active = 1").bind(stageId, projectId).first();
  if (!row) throw new ApiError(400, "INVALID_STAGE", "Stage must be an active stage in the issue project");
  return { stageId: row.id, status: row.canonical_status };
}

const TRANSITION_IDENTIFIER = /^[a-z][a-z0-9_-]{0,63}$/;
const TRANSITION_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HUMAN_ACCEPTANCE_SIGNER_HEADER = "x-taskboard-human-acceptance";
const HUMAN_ACCEPTANCE_ASSERTION_VERSION = "v1";
const HUMAN_ACCEPTANCE_ASSERTION_TTL_MS = 5 * 60 * 1_000;
const HUMAN_ACCEPTANCE_ASSERTION_FUTURE_SKEW_MS = 30 * 1_000;
const HUMAN_ACCEPTANCE_ASSERTION_BASE64URL = /^[A-Za-z0-9_-]+$/;
const HUMAN_ACCEPTANCE_ASSERTION_SUBJECT = /^[a-z][a-z0-9_-]{2,63}$/;
const HUMAN_ACCEPTANCE_ASSERTION_NONCE = /^[A-Za-z0-9_-]{16,96}$/;
const LEDGER_RETRY_LIMIT = 3;

function transitionError(code, message, details) {
  const status = code === "ACTION_NOT_FOUND" || code === "INVALID_CONTRACT" ? 400 : 409;
  return new ApiError(status, code, message, details);
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

async function sha256(value) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function terminalKind(stage) {
  return stage.terminal_kind === "done" ? "completed" : stage.terminal_kind === "canceled" ? "canceled" : "none";
}

async function ensureProjectWorkflow(env, projectId) {
  const existing = await env.DB.prepare("SELECT * FROM workflow_definitions WHERE project_id = ?").bind(projectId).first();
  if (existing) return existing;
  const stages = await all(env.DB.prepare(`
    SELECT id, canonical_status, terminal_kind, sort_order
    FROM workflow_stages WHERE project_id = ? ORDER BY sort_order, id
  `).bind(projectId));
  if (stages.length === 0) throw transitionError("WORKFLOW_PIN_MISSING", "Project has no workflow stages");
  const timestamp = now();
  const workflowId = `workflow_${(await sha256(projectId)).slice(0, 24)}`;
  const revisionId = uuid();
  const profileRevisionId = uuid();
  const bindings = stages.map((stage, index) => ({
    taskStageId: stage.id, contractStageId: `stage_${index + 1}`,
    canonicalStatus: stage.canonical_status, terminalKind: terminalKind(stage), order: index + 1,
  }));
  const transitions = [];
  const rules = [];
  for (const from of bindings) for (const to of bindings) {
    if (from.taskStageId === to.taskStageId) continue;
    const actionKey = `legacy_move_${from.order}_${to.order}`;
    const requiresAcceptance = to.terminalKind === "completed";
    transitions.push({ transitionId: actionKey, fromStageId: from.contractStageId, toStageId: to.contractStageId,
      requiresAcceptance, irreversible: false, gateIds: requiresAcceptance ? ["human-acceptance"] : [], authorization: { required: false, action: null } });
    rules.push({ actionKey, transitionId: actionKey, fromTaskStageId: from.taskStageId, toTaskStageId: to.taskStageId,
      fromContractStageId: from.contractStageId, toContractStageId: to.contractStageId, toTerminalKind: to.terminalKind, legacy: 1 });
  }
  if (transitions.length === 0) transitions.push({ transitionId: "stay_stage_1", fromStageId: "stage_1", toStageId: "stage_1", requiresAcceptance: false, irreversible: false, gateIds: [], authorization: { required: false, action: null } });
  const definition = { schemaVersion: 1, workflowId, revisionId, revision: 1, createdAt: timestamp, immutable: true,
    agentProfileRevisions: [{ agentProfileId: "manual", agentProfileRevisionId: profileRevisionId, revision: 1, createdAt: timestamp, immutable: true, mode: "manual" }],
    stages: bindings.map((binding) => ({ stageId: binding.contractStageId, name: binding.contractStageId.replace("_", " "), terminalKind: binding.terminalKind, agentProfileRevisionId: profileRevisionId })),
    gates: [{ gateId: "human-acceptance", kind: "acceptance", requiredEvidenceTypes: ["human_acceptance"] }], transitions };
  const statements = [
    env.DB.prepare("INSERT INTO workflow_definitions (workflow_id, project_id, current_revision_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)").bind(workflowId, projectId, revisionId, timestamp, timestamp),
    env.DB.prepare("INSERT INTO workflow_revisions (revision_id, workflow_id, revision, definition_json, immutable, created_at) VALUES (?, ?, 1, ?, 1, ?)").bind(revisionId, workflowId, JSON.stringify(definition), timestamp),
    ...bindings.map((binding) => env.DB.prepare("INSERT INTO workflow_revision_stage_bindings (revision_id, contract_stage_id, task_stage_id, canonical_status, terminal_kind, stage_order) VALUES (?, ?, ?, ?, ?, ?)").bind(revisionId, binding.contractStageId, binding.taskStageId, binding.canonicalStatus, binding.terminalKind, binding.order)),
    ...rules.map((rule) => env.DB.prepare("INSERT INTO workflow_transition_rules (revision_id, action_key, transition_id, from_task_stage_id, to_task_stage_id, from_contract_stage_id, to_contract_stage_id, to_terminal_kind, legacy) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").bind(revisionId, rule.actionKey, rule.transitionId, rule.fromTaskStageId, rule.toTaskStageId, rule.fromContractStageId, rule.toContractStageId, rule.toTerminalKind, rule.legacy)),
  ];
  try {
    await env.DB.batch(statements);
  } catch (error) {
    const raced = await env.DB.prepare("SELECT * FROM workflow_definitions WHERE project_id = ?").bind(projectId).first();
    if (raced) return raced;
    throw error;
  }
  return { workflow_id: workflowId, project_id: projectId, current_revision_id: revisionId };
}

async function transitionContext(env, taskId) {
  const task = await requireTaskRow(env, taskId);
  const definition = await ensureProjectWorkflow(env, task.project_id);
  await env.DB.prepare(`INSERT OR IGNORE INTO workflow_task_pins (task_id, workflow_id, revision_id, pinned_at)
    VALUES (?, ?, ?, ?)`).bind(task.id, definition.workflow_id, definition.current_revision_id, task.created_at).run();
  const pin = await env.DB.prepare("SELECT * FROM workflow_task_pins WHERE task_id = ?").bind(task.id).first();
  const revision = pin && await env.DB.prepare("SELECT * FROM workflow_revisions WHERE revision_id = ?").bind(pin.revision_id).first();
  if (!pin || !revision) throw transitionError("WORKFLOW_PIN_MISSING", "Task has no pinned workflow revision");
  return { task, pin, revision, definition: JSON.parse(revision.definition_json) };
}

function parseIdempotencyKey(idempotencyKey) {
  if (idempotencyKey === null) throw new ApiError(400, "IDEMPOTENCY_KEY_REQUIRED", "Idempotency-Key header is required");
  const key = stringField(idempotencyKey, "Idempotency-Key", { required: true, maxLength: 64 });
  if (!TRANSITION_IDENTIFIER.test(key)) throw new ApiError(400, "INVALID_FIELD", "Idempotency-Key must be a stable identifier");
  return key;
}

function parseTransition(body, idempotencyKey) {
  assertPlainObject(body);
  assertAllowedKeys(body, new Set(["expectedStateVersion", "actionKey", "gateEvidence", "authorizationId"]));
  const key = parseIdempotencyKey(idempotencyKey);
  if (!Number.isSafeInteger(body.expectedStateVersion) || body.expectedStateVersion < 1) throw new ApiError(400, "INVALID_FIELD", "'expectedStateVersion' must be a positive integer");
  const actionKey = stringField(body.actionKey, "actionKey", { required: true, maxLength: 64 });
  if (!TRANSITION_IDENTIFIER.test(actionKey)) throw new ApiError(400, "INVALID_FIELD", "actionKey must be a stable identifier");
  if (body.gateEvidence !== undefined && !Array.isArray(body.gateEvidence)) throw new ApiError(400, "INVALID_FIELD", "'gateEvidence' must be an array");
  return { expectedStateVersion: body.expectedStateVersion, actionKey, gateEvidence: body.gateEvidence ?? [], authorizationId: body.authorizationId === undefined ? null : stringField(body.authorizationId, "authorizationId", { nullable: true, maxLength: 96 }), idempotencyKey: key };
}

function parseHumanEvidenceRegistration(body, idempotencyKey) {
  assertPlainObject(body);
  assertAllowedKeys(body, new Set(["expectedStateVersion", "actionKey", "gateId"]));
  if (!Number.isSafeInteger(body.expectedStateVersion) || body.expectedStateVersion < 1) throw new ApiError(400, "INVALID_FIELD", "'expectedStateVersion' must be a positive integer");
  const actionKey = stringField(body.actionKey, "actionKey", { required: true, maxLength: 64 });
  if (!TRANSITION_IDENTIFIER.test(actionKey)) throw new ApiError(400, "INVALID_FIELD", "actionKey must be a stable identifier");
  const gateId = body.gateId === undefined ? null : stringField(body.gateId, "gateId", { required: true, maxLength: 64 });
  if (gateId !== null && !TRANSITION_IDENTIFIER.test(gateId)) throw new ApiError(400, "INVALID_FIELD", "gateId must be a stable identifier");
  return { expectedStateVersion: body.expectedStateVersion, actionKey, gateId, idempotencyKey: parseIdempotencyKey(idempotencyKey) };
}

function parseHumanEvidenceRevocation(body, idempotencyKey) {
  assertPlainObject(body);
  assertAllowedKeys(body, new Set(["reason"]));
  const reason = stringField(body.reason, "reason", { required: true, maxLength: 64 });
  if (!TRANSITION_IDENTIFIER.test(reason)) throw new ApiError(400, "INVALID_FIELD", "reason must be a non-PII stable identifier");
  return { reason, idempotencyKey: parseIdempotencyKey(idempotencyKey) };
}

function humanAcceptanceSignerRequired() {
  return new ApiError(403, "HUMAN_ACCEPTANCE_SIGNER_REQUIRED", "A trusted human acceptance signer assertion is required");
}

function humanAcceptanceSigningKey(secret, usage) {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    usage,
  );
}

function parseHumanAcceptanceAssertion(header) {
  if (typeof header !== "string" || header.length === 0 || header.length > 4_096) {
    throw humanAcceptanceSignerRequired();
  }
  const parts = header.split(".");
  if (
    parts.length !== 3
    || parts[0] !== HUMAN_ACCEPTANCE_ASSERTION_VERSION
    || !HUMAN_ACCEPTANCE_ASSERTION_BASE64URL.test(parts[1])
    || !HUMAN_ACCEPTANCE_ASSERTION_BASE64URL.test(parts[2])
  ) {
    throw humanAcceptanceSignerRequired();
  }
  let signature;
  try {
    signature = decodeBase64Url(parts[2]);
  } catch {
    throw humanAcceptanceSignerRequired();
  }
  return { encodedPayload: parts[1], signature };
}

function parseSignedHumanAcceptancePayload(encodedPayload) {
  try {
    const payload = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(
      decodeBase64Url(encodedPayload),
    ));
    if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
      throw new Error("Human acceptance assertion payload is not an object");
    }
    return payload;
  } catch {
    throw humanAcceptanceSignerRequired();
  }
}

function assertHumanAcceptanceAssertionScope(payload, expected, requiredKeys) {
  const allowedKeys = new Set([
    "version", "subject", "issuedAt", "expiresAt", "nonce",
    ...Object.keys(expected), ...requiredKeys,
  ]);
  const keys = Object.keys(payload);
  if (
    keys.length !== allowedKeys.size
    || keys.some((key) => !allowedKeys.has(key))
    || payload.version !== 1
    || typeof payload.subject !== "string"
    || !HUMAN_ACCEPTANCE_ASSERTION_SUBJECT.test(payload.subject)
    || !Number.isSafeInteger(payload.issuedAt)
    || !Number.isSafeInteger(payload.expiresAt)
    || typeof payload.nonce !== "string"
    || !HUMAN_ACCEPTANCE_ASSERTION_NONCE.test(payload.nonce)
  ) {
    throw humanAcceptanceSignerRequired();
  }
  const timestamp = Date.now();
  if (
    payload.issuedAt > timestamp + HUMAN_ACCEPTANCE_ASSERTION_FUTURE_SKEW_MS
    || payload.expiresAt < timestamp
    || payload.expiresAt <= payload.issuedAt
    || payload.expiresAt - payload.issuedAt > HUMAN_ACCEPTANCE_ASSERTION_TTL_MS
  ) {
    throw humanAcceptanceSignerRequired();
  }
  for (const [key, value] of Object.entries(expected)) {
    if (payload[key] !== value) throw humanAcceptanceSignerRequired();
  }
  for (const key of requiredKeys) {
    if (!Object.hasOwn(payload, key)) throw humanAcceptanceSignerRequired();
  }
}

async function verifiedHumanAcceptanceActor(request, env, actor, expected, requiredKeys = []) {
  if (typeof env.TASKBOARD_HUMAN_ACCEPTANCE_SECRET !== "string" || env.TASKBOARD_HUMAN_ACCEPTANCE_SECRET === "") {
    throw new ApiError(500, "SERVER_MISCONFIGURED", "TASKBOARD_HUMAN_ACCEPTANCE_SECRET is not configured");
  }
  if (actor?.type !== "user") {
    throw new ApiError(403, "HUMAN_ACTOR_REQUIRED", "Only an authenticated human can record acceptance evidence");
  }
  const { encodedPayload, signature } = parseHumanAcceptanceAssertion(
    request.headers.get(HUMAN_ACCEPTANCE_SIGNER_HEADER),
  );
  const expectedSignature = new Uint8Array(await crypto.subtle.sign(
    "HMAC",
    await humanAcceptanceSigningKey(env.TASKBOARD_HUMAN_ACCEPTANCE_SECRET, ["sign"]),
    new TextEncoder().encode(`${HUMAN_ACCEPTANCE_ASSERTION_VERSION}.${encodedPayload}`),
  ));
  if (
    signature.byteLength !== expectedSignature.byteLength
    || !crypto.subtle.timingSafeEqual(signature, expectedSignature)
  ) {
    throw humanAcceptanceSignerRequired();
  }
  const assertion = parseSignedHumanAcceptancePayload(encodedPayload);
  assertHumanAcceptanceAssertionScope(assertion, expected, requiredKeys);
  const actorKey = `human_${(await sha256(assertion.subject)).slice(0, 24)}`;
  return {
    actorKey,
    actor: {
      type: "user",
      id: actorKey,
      name: "Trusted human acceptance operator",
      avatarUrl: null,
    },
    assertion,
  };
}

function evidenceResponse(row) {
  return {
    evidenceId: row.evidence_id,
    gateId: row.gate_id,
    type: row.evidence_type,
    capturedAt: row.captured_at,
    scope: {
      taskId: row.task_id,
      taskVersion: row.task_version,
      workflowId: row.workflow_id,
      revisionId: row.revision_id,
      transitionId: row.transition_id,
      actionKey: row.action_key,
      gateId: row.gate_id,
    },
    actor: { actorId: row.actor_key, kind: "human" },
    status: row.status,
    record: { evidenceEventId: row.evidence_event_id, eventHash: row.evidence_hash },
    revocation: row.status === "revoked" ? {
      revokedEventId: row.revoked_event_id,
      eventHash: row.revocation_hash,
      revokedAt: row.revoked_at,
      reason: row.revocation_reason,
    } : null,
  };
}

function isLedgerWriteConflict(error) {
  return /WORKFLOW_LEDGER_APPEND_ONLY|workflow_ledger_(events|head)|workflow_aggregate_projections.*last_sequence|workflow_outbox.*sequence|SQLITE_BUSY/i.test(String(error));
}

function matchingEvidencePayload(value, row) {
  return value
    && value.evidenceId === row.evidence_id
    && value.gateId === row.gate_id
    && value.type === row.evidence_type
    && value.capturedAt === row.captured_at
    && value.status === row.status
    && value.actor?.kind === "human"
    && value.actor?.actorId === row.actor_key
    && value.record?.evidenceEventId === row.evidence_event_id
    && value.record?.eventHash === row.evidence_hash
    && value.revocation === null;
}

async function resolveHumanAcceptanceEvidence(env, context, rule, command, gateId) {
  const candidates = command.gateEvidence.filter((item) => item?.gateId === gateId && item?.type === "human_acceptance");
  if (candidates.length !== 1 || !TRANSITION_UUID.test(candidates[0]?.evidenceId ?? "")) return null;
  const row = await env.DB.prepare(`
    SELECT evidence.*
    FROM workflow_human_evidence AS evidence
    LEFT JOIN workflow_transition_evidence_consumptions AS consumed ON consumed.evidence_id = evidence.evidence_id
    WHERE evidence.evidence_id = ?
      AND evidence.status = 'valid'
      AND evidence.task_id = ?
      AND evidence.task_version = ?
      AND evidence.workflow_id = ?
      AND evidence.revision_id = ?
      AND evidence.transition_id = ?
      AND evidence.gate_id = ?
      AND consumed.evidence_id IS NULL
  `).bind(
    candidates[0].evidenceId, context.task.id, command.expectedStateVersion,
    context.pin.workflow_id, context.pin.revision_id, rule.transition_id, gateId,
  ).first();
  return row && matchingEvidencePayload(candidates[0], row) ? row : null;
}

function assertTransitionPolicy(context, rule, command, authorization, descendants, occurredAt, acceptanceEvidenceByGate) {
  if (context.task.version !== command.expectedStateVersion) throw transitionError("EXPECTED_STATE_CONFLICT", "Task changed since the requested transition state", { expectedStateVersion: command.expectedStateVersion, actualStateVersion: context.task.version });
  if (context.task.archived_at !== null) throw transitionError("TASK_ARCHIVED", "Archived tasks cannot transition");
  if (!rule || rule.from_task_stage_id !== context.task.stage_id) throw transitionError("ACTION_NOT_FOUND", "actionKey is not available from the task's pinned workflow state");
  const transition = context.definition.transitions.find((item) => item.transitionId === rule.transition_id && item.fromStageId === rule.from_contract_stage_id && item.toStageId === rule.to_contract_stage_id);
  if (!transition) throw transitionError("ACTION_NOT_FOUND", "Transition is not defined by the pinned workflow");
  for (const gateId of transition.gateIds) {
    const gate = context.definition.gates.find((item) => item.gateId === gateId);
    if (gate?.kind === "acceptance") {
      if (!acceptanceEvidenceByGate?.get(gateId)) {
        throw transitionError("ACCEPTANCE_EVIDENCE_REQUIRED", "Transition requires persisted valid human acceptance evidence", { gateId });
      }
      continue;
    }
    throw transitionError("GATE_UNSATISFIED", `Gate ${gateId} requires persisted evidence that is not available in this phase`, { gateId });
  }
  if (transition.authorization?.required) {
    if (!authorization) throw transitionError("HUMAN_AUTH_REQUIRED", "This transition requires an exact human authorization");
    const scope = authorization.scope;
    if (authorization.status === "revoked") throw transitionError("AUTHORIZATION_REVOKED", "Human authorization has been revoked");
    if (authorization.action !== transition.authorization.action || scope?.workflowId !== context.pin.workflow_id || scope?.revisionId !== context.pin.revision_id || scope?.transitionId !== rule.transition_id || scope?.target?.type !== "task" || scope?.target?.id !== context.task.id) throw transitionError("HUMAN_AUTH_SCOPE_MISMATCH", "Human authorization does not exactly cover this action");
    if (authorization.expiresAt && Date.parse(occurredAt) > Date.parse(authorization.expiresAt)) throw transitionError("HUMAN_AUTH_REQUIRED", "Human authorization is expired for this action");
  }
  if (rule.to_terminal_kind === "completed") {
    const incomplete = descendants.filter((item) => item.required && item.status !== "done");
    if (incomplete.length) throw transitionError("REQUIRED_DESCENDANT_INCOMPLETE", "A completed task requires every required descendant to be done", { taskIds: incomplete.map((item) => item.task_id) });
  }
}

async function transitionTask(env, taskId, command, actor, { sortOrder, threadId, threadBinding, retryCount = 0 } = {}) {
  const fingerprint = canonicalJson({ taskId, expectedStateVersion: command.expectedStateVersion, actionKey: command.actionKey, gateEvidence: command.gateEvidence, authorizationId: command.authorizationId, sortOrder: sortOrder ?? null, threadId: threadId ?? null, threadBinding: threadBinding ?? null });
  const existing = await env.DB.prepare("SELECT * FROM workflow_transition_requests WHERE idempotency_key = ?").bind(command.idempotencyKey).first();
  if (existing) {
    if (existing.task_id !== taskId || existing.expected_state_version !== command.expectedStateVersion || existing.action_key !== command.actionKey || existing.request_fingerprint !== fingerprint) throw transitionError("IDEMPOTENCY_CONFLICT", "Idempotency-Key was already used for a different transition request");
    const event = await env.DB.prepare("SELECT envelope_json FROM workflow_ledger_events WHERE event_id = ?").bind(existing.event_id).first();
    if (!event) throw transitionError("LEDGER_HASH_INVALID", "Transition request points to a missing ledger event");
    return { task: await getTask(env, taskId), transition: requestFromRow(existing), event: JSON.parse(event.envelope_json), idempotent: true };
  }
  const existingLedgerKey = await env.DB.prepare("SELECT event_id FROM workflow_ledger_events WHERE idempotency_key = ?").bind(command.idempotencyKey).first();
  if (existingLedgerKey) throw transitionError("IDEMPOTENCY_CONFLICT", "Idempotency-Key was already used for a different workflow request");
  const context = await transitionContext(env, taskId);
  const rule = await env.DB.prepare("SELECT * FROM workflow_transition_rules WHERE revision_id = ? AND action_key = ?").bind(context.pin.revision_id, command.actionKey).first();
  let authorization = null;
  if (command.authorizationId) {
    const row = await env.DB.prepare("SELECT authorization_json FROM workflow_authorizations WHERE authorization_id = ?").bind(command.authorizationId).first();
    if (!row) throw transitionError("HUMAN_AUTH_REQUIRED", "Referenced human authorization was not found");
    try { authorization = JSON.parse(row.authorization_json); } catch { throw transitionError("INVALID_CONTRACT", "Stored human authorization is malformed"); }
  }
  const descendants = await all(env.DB.prepare(`WITH RECURSIVE descendants(task_id, required_path) AS (
    SELECT target_task_id, CASE WHEN json_extract(metadata, '$.required') = 1 THEN 1 ELSE 0 END FROM task_relations WHERE relation_type = 'parent' AND source_task_id = ?
    UNION ALL SELECT relations.target_task_id, CASE WHEN descendants.required_path = 1 AND json_extract(relations.metadata, '$.required') = 1 THEN 1 ELSE 0 END FROM task_relations AS relations JOIN descendants ON descendants.task_id = relations.source_task_id WHERE relations.relation_type = 'parent'
  ) SELECT descendants.task_id, descendants.required_path AS required, tasks.status FROM descendants JOIN tasks ON tasks.id = descendants.task_id`).bind(context.task.id));
  const timestamp = now();
  const transition = rule && context.definition.transitions.find((item) => item.transitionId === rule.transition_id && item.fromStageId === rule.from_contract_stage_id && item.toStageId === rule.to_contract_stage_id);
  const acceptanceEvidenceByGate = new Map();
  for (const gateId of transition?.gateIds ?? []) {
    const gate = context.definition.gates.find((item) => item.gateId === gateId);
    if (gate?.kind === "acceptance") {
      acceptanceEvidenceByGate.set(gateId, await resolveHumanAcceptanceEvidence(env, context, rule, command, gateId));
    }
  }
  assertTransitionPolicy(context, rule, command, authorization, descendants, timestamp, acceptanceEvidenceByGate);
  const destination = await env.DB.prepare("SELECT * FROM workflow_revision_stage_bindings WHERE revision_id = ? AND task_stage_id = ?").bind(context.pin.revision_id, rule.to_task_stage_id).first();
  if (!destination) throw transitionError("ACTION_NOT_FOUND", "Transition destination binding is unavailable");
  if (sortOrder === undefined) {
    const placement = await env.DB.prepare("SELECT MIN(sort_order) AS minimum FROM tasks WHERE project_id = ? AND stage_id = ? AND archived_at IS NULL AND id != ?").bind(context.task.project_id, destination.task_stage_id, context.task.id).first();
    sortOrder = placement?.minimum == null ? 1000 : placement.minimum - 1000;
  }
  const storedBinding = storedThreadBindingForExisting(context.task, threadBinding, threadId);
  const threadAssignment = storedBinding ? `thread_id = ?, thread_codex_project_id = ?, thread_codex_project_kind = ?, thread_codex_host_id = ?, thread_workspace_path = ?,` : "";
  const head = await env.DB.prepare("SELECT * FROM workflow_ledger_head WHERE singleton = 1").first();
  const sequence = (head?.last_sequence ?? 0) + 1;
  const event = { schemaVersion: 1, eventId: uuid(), eventType: "transition.requested", occurredAt: timestamp, workflowId: context.pin.workflow_id, revisionId: context.pin.revision_id, aggregateType: "task", aggregateId: context.task.id, correlationId: uuid(), causationId: null, idempotencyKey: command.idempotencyKey, prevHash: head?.last_event_hash ?? null, payload: { transitionId: rule.transition_id, fromStageId: rule.from_contract_stage_id, toStageId: rule.to_contract_stage_id, target: { type: "task", id: context.task.id } } };
  event.eventHash = await sha256(canonicalJson(event));
  const requestId = uuid();
  const state = { lastEventType: event.eventType, payload: event.payload, task: { id: context.task.id, stageId: destination.task_stage_id, status: destination.canonical_status, version: context.task.version + 1 } };
  const requestInsert = env.DB.prepare(`INSERT INTO workflow_transition_requests (request_id, task_id, idempotency_key, request_fingerprint, expected_state_version, action_key, workflow_id, revision_id, transition_id, from_stage_id, to_stage_id, event_id, event_hash, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(requestId, context.task.id, command.idempotencyKey, fingerprint, command.expectedStateVersion, rule.action_key, context.pin.workflow_id, context.pin.revision_id, rule.transition_id, rule.from_task_stage_id, rule.to_task_stage_id, event.eventId, event.eventHash, timestamp);
  const eventInsert = env.DB.prepare(`INSERT INTO workflow_ledger_events (sequence,event_id,event_type,workflow_id,revision_id,aggregate_type,aggregate_id,correlation_id,causation_id,idempotency_key,idempotency_fingerprint,prev_hash,event_hash,envelope_json,occurred_at,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .bind(sequence,event.eventId,event.eventType,event.workflowId,event.revisionId,event.aggregateType,event.aggregateId,event.correlationId,null,event.idempotencyKey,fingerprint,event.prevHash,event.eventHash,JSON.stringify(event),timestamp,timestamp);
  const statements = [eventInsert, requestInsert,
    ...[...acceptanceEvidenceByGate.values()].filter(Boolean).map((evidence) => env.DB.prepare(`
      INSERT INTO workflow_transition_evidence_consumptions (request_id, evidence_id, consumed_at)
      VALUES (?, ?, ?)
    `).bind(requestId, evidence.evidence_id, timestamp)),
    head ? env.DB.prepare("UPDATE workflow_ledger_head SET last_sequence = ?, last_event_hash = ?, updated_at = ? WHERE singleton = 1").bind(sequence, event.eventHash, timestamp) : env.DB.prepare("INSERT INTO workflow_ledger_head (singleton, last_sequence, last_event_hash, updated_at) VALUES (1, ?, ?, ?)").bind(sequence, event.eventHash, timestamp),
    env.DB.prepare(`UPDATE tasks SET status = ?, stage_id = ?, sort_order = ?, ${threadAssignment} version = version + 1, updated_at = ? WHERE id = ? AND version = ?`).bind(destination.canonical_status, destination.task_stage_id, sortOrder, ...(storedBinding ?? []), timestamp, context.task.id, context.task.version),
    taskActivityStatement(env, context.task.id, actor, taskFieldChanges(taskFromRow(context.task), { status: destination.canonical_status, stageId: destination.task_stage_id, ...(storedBinding && context.task.thread_id !== storedBinding[0] ? { threadId: storedBinding[0] } : {}) }), timestamp, context.task.version + 1),
    env.DB.prepare(`INSERT INTO workflow_aggregate_projections (aggregate_type,aggregate_id,workflow_id,revision_id,last_sequence,last_event_id,last_event_type,last_event_hash,state_json,created_at,updated_at) VALUES ('task',?,?,?,?,?,?,?,?,?,?) ON CONFLICT(aggregate_type,aggregate_id) DO UPDATE SET workflow_id=excluded.workflow_id,revision_id=excluded.revision_id,last_sequence=excluded.last_sequence,last_event_id=excluded.last_event_id,last_event_type=excluded.last_event_type,last_event_hash=excluded.last_event_hash,state_json=excluded.state_json,updated_at=excluded.updated_at`).bind(context.task.id,event.workflowId,event.revisionId,sequence,event.eventId,event.eventType,event.eventHash,JSON.stringify(state),timestamp,timestamp),
    env.DB.prepare(`INSERT INTO workflow_work_item_projections (work_item_id,project_id,status,stage_id,task_version,projection_kind,imported_at,source_updated_at,last_event_sequence,last_event_hash) VALUES (?, ?, ?, ?, ?, 'work_item.imported', ?, ?, ?, ?) ON CONFLICT(work_item_id) DO UPDATE SET status=excluded.status,stage_id=excluded.stage_id,task_version=excluded.task_version,source_updated_at=excluded.source_updated_at,last_event_sequence=excluded.last_event_sequence,last_event_hash=excluded.last_event_hash`).bind(context.task.id,context.task.project_id,destination.canonical_status,destination.task_stage_id,context.task.version + 1,context.task.created_at,timestamp,sequence,event.eventHash),
    env.DB.prepare("INSERT INTO workflow_outbox (event_id, sequence, topic, payload_json, created_at) VALUES (?, ?, 'workflow.transition.requested', ?, ?)").bind(event.eventId, sequence, JSON.stringify(event), timestamp),
  ];
  try { await env.DB.batch(statements); } catch (error) {
    const raced = await env.DB.prepare("SELECT * FROM workflow_transition_requests WHERE idempotency_key = ?").bind(command.idempotencyKey).first();
    if (raced && raced.request_fingerprint === fingerprint) return transitionTask(env, taskId, command, actor, { sortOrder, threadId, threadBinding, retryCount });
    if (String(error).includes("INVALID_HUMAN_ACCEPTANCE_EVIDENCE")) {
      throw transitionError("ACCEPTANCE_EVIDENCE_REQUIRED", "Human acceptance evidence is no longer valid for this transition");
    }
    if (String(error).includes("STALE_WORKFLOW_TRANSITION_REQUEST")) {
      throw transitionError("EXPECTED_STATE_CONFLICT", "Task changed during transition application", { expectedStateVersion: command.expectedStateVersion });
    }
    const ledgerCollision = await env.DB.prepare("SELECT event_id FROM workflow_ledger_events WHERE idempotency_key = ?").bind(command.idempotencyKey).first();
    if (ledgerCollision) throw transitionError("IDEMPOTENCY_CONFLICT", "Idempotency-Key was already used for a different workflow request");
    if (isLedgerWriteConflict(error)) {
      if (retryCount < LEDGER_RETRY_LIMIT) return transitionTask(env, taskId, command, actor, { sortOrder, threadId, threadBinding, retryCount: retryCount + 1 });
      throw transitionError("LEDGER_CONTENTION", "Workflow ledger was busy; retry the same idempotency key");
    }
    const latest = await requireTaskRow(env, taskId);
    if (latest.version !== command.expectedStateVersion) throw transitionError("EXPECTED_STATE_CONFLICT", "Task changed during transition application", { expectedStateVersion: command.expectedStateVersion, actualStateVersion: latest.version });
    throw error;
  }
  const request = await env.DB.prepare("SELECT * FROM workflow_transition_requests WHERE request_id = ?").bind(requestId).first();
  return { task: await getTask(env, taskId), transition: requestFromRow(request), event, idempotent: false };
}

function requestFromRow(row) {
  return { requestId: row.request_id, taskId: row.task_id, idempotencyKey: row.idempotency_key, expectedStateVersion: row.expected_state_version, actionKey: row.action_key, workflowId: row.workflow_id, revisionId: row.revision_id, transitionId: row.transition_id, fromStageId: row.from_stage_id, toStageId: row.to_stage_id, eventId: row.event_id, eventHash: row.event_hash, createdAt: row.created_at };
}

async function registerHumanAcceptanceEvidence(request, env, taskId, command, actor, { retryCount = 0 } = {}) {
  const attested = await verifiedHumanAcceptanceActor(request, env, actor, {
    purpose: "human_acceptance_evidence",
    route: "/api/tasks/:id/evidence",
    method: "POST",
    taskId,
    expectedStateVersion: command.expectedStateVersion,
    actionKey: command.actionKey,
    idempotencyKey: command.idempotencyKey,
  }, ["gateId"]);
  if (
    typeof attested.assertion.gateId !== "string"
    || !TRANSITION_IDENTIFIER.test(attested.assertion.gateId)
    || (command.gateId !== null && command.gateId !== attested.assertion.gateId)
  ) {
    throw humanAcceptanceSignerRequired();
  }
  const { actorKey, actor: humanActor } = attested;
  const attestedGateId = attested.assertion.gateId;
  const fingerprint = canonicalJson({ taskId, expectedStateVersion: command.expectedStateVersion, actionKey: command.actionKey, gateId: attestedGateId, actorKey, type: "human_acceptance" });
  const existing = await env.DB.prepare("SELECT * FROM workflow_human_evidence WHERE idempotency_key = ?").bind(command.idempotencyKey).first();
  if (existing) {
    if (existing.request_fingerprint !== fingerprint || existing.gate_id !== attestedGateId) throw transitionError("IDEMPOTENCY_CONFLICT", "Idempotency-Key was already used for a different acceptance evidence request");
    const event = await env.DB.prepare("SELECT envelope_json FROM workflow_ledger_events WHERE event_id = ?").bind(existing.ledger_event_id).first();
    if (!event) throw transitionError("LEDGER_HASH_INVALID", "Acceptance evidence points to a missing ledger event");
    return { evidence: evidenceResponse(existing), event: JSON.parse(event.envelope_json), idempotent: true };
  }
  const existingLedgerKey = await env.DB.prepare("SELECT event_id FROM workflow_ledger_events WHERE idempotency_key = ?").bind(command.idempotencyKey).first();
  if (existingLedgerKey) throw transitionError("IDEMPOTENCY_CONFLICT", "Idempotency-Key was already used for a different workflow request");
  const context = await transitionContext(env, taskId);
  if (context.task.version !== command.expectedStateVersion) {
    throw transitionError("EXPECTED_STATE_CONFLICT", "Task changed since the requested acceptance state", {
      expectedStateVersion: command.expectedStateVersion, actualStateVersion: context.task.version,
    });
  }
  if (context.task.archived_at !== null) throw transitionError("TASK_ARCHIVED", "Archived tasks cannot record acceptance evidence");
  const rule = await env.DB.prepare("SELECT * FROM workflow_transition_rules WHERE revision_id = ? AND action_key = ?").bind(context.pin.revision_id, command.actionKey).first();
  if (!rule || rule.from_task_stage_id !== context.task.stage_id) throw transitionError("ACTION_NOT_FOUND", "actionKey is not available from the task's pinned workflow state");
  const transition = context.definition.transitions.find((item) => item.transitionId === rule.transition_id && item.fromStageId === rule.from_contract_stage_id && item.toStageId === rule.to_contract_stage_id);
  const acceptanceGates = (transition?.gateIds ?? [])
    .map((gateId) => context.definition.gates.find((item) => item.gateId === gateId))
    .filter((gate) => gate?.kind === "acceptance");
  if (acceptanceGates.length === 0) throw transitionError("ACTION_NOT_FOUND", "This transition does not accept human acceptance evidence");
  if (acceptanceGates.length > 1 && command.gateId === null) {
    throw new ApiError(400, "GATE_ID_REQUIRED", "gateId is required when a transition has multiple human acceptance gates");
  }
  const gate = acceptanceGates.find((item) => item.gateId === (command.gateId ?? acceptanceGates[0].gateId));
  if (!gate) throw transitionError("ACTION_NOT_FOUND", "gateId is not an acceptance gate for this transition");
  if (gate.gateId !== attestedGateId) throw humanAcceptanceSignerRequired();
  const timestamp = now();
  const evidenceId = uuid();
  const evidenceEventId = uuid();
  const evidenceHash = await sha256(canonicalJson({
    schemaVersion: 1, evidenceId, evidenceEventId, taskId: context.task.id,
    taskVersion: context.task.version, workflowId: context.pin.workflow_id,
    revisionId: context.pin.revision_id, transitionId: rule.transition_id,
    gateId: gate.gateId, type: "human_acceptance", actorKey, capturedAt: timestamp,
  }));
  const head = await env.DB.prepare("SELECT * FROM workflow_ledger_head WHERE singleton = 1").first();
  const sequence = (head?.last_sequence ?? 0) + 1;
  const event = {
    schemaVersion: 1, eventId: uuid(), eventType: "gate.satisfied", occurredAt: timestamp,
    workflowId: context.pin.workflow_id, revisionId: context.pin.revision_id,
    aggregateType: "task", aggregateId: context.task.id, correlationId: uuid(), causationId: null,
    idempotencyKey: command.idempotencyKey, prevHash: head?.last_event_hash ?? null,
    payload: { gateId: gate.gateId, evidence: { evidenceId, evidenceEventId, eventHash: evidenceHash, actorKey } },
  };
  event.eventHash = await sha256(canonicalJson(event));
  const priorProjection = await env.DB.prepare("SELECT state_json, created_at FROM workflow_aggregate_projections WHERE aggregate_type = 'task' AND aggregate_id = ?").bind(context.task.id).first();
  let previousState = {};
  try { previousState = priorProjection ? JSON.parse(priorProjection.state_json) : {}; } catch { throw transitionError("LEDGER_HASH_INVALID", "Task aggregate projection is malformed"); }
  const state = {
    ...previousState,
    lastEventType: event.eventType,
    payload: event.payload,
    task: previousState.task ?? { id: context.task.id, stageId: context.task.stage_id, status: context.task.status, version: context.task.version },
  };
  const evidenceRow = {
    evidence_id: evidenceId, task_id: context.task.id, task_version: context.task.version,
    workflow_id: context.pin.workflow_id, revision_id: context.pin.revision_id,
    transition_id: rule.transition_id, action_key: command.actionKey, gate_id: gate.gateId,
    evidence_type: "human_acceptance", captured_at: timestamp,
    actor_key: actorKey, status: "valid", evidence_event_id: evidenceEventId, evidence_hash: evidenceHash, revoked_at: null,
    revoked_event_id: null, revocation_hash: null, revocation_reason: null, revocation_idempotency_key: null,
    revocation_request_fingerprint: null, revocation_ledger_event_id: null,
  };
  const statements = [
    env.DB.prepare(`INSERT INTO workflow_ledger_events (sequence,event_id,event_type,workflow_id,revision_id,aggregate_type,aggregate_id,correlation_id,causation_id,idempotency_key,idempotency_fingerprint,prev_hash,event_hash,envelope_json,occurred_at,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(sequence, event.eventId, event.eventType, event.workflowId, event.revisionId, event.aggregateType, event.aggregateId, event.correlationId, null, event.idempotencyKey, fingerprint, event.prevHash, event.eventHash, JSON.stringify(event), timestamp, timestamp),
    env.DB.prepare(`INSERT INTO workflow_human_evidence (evidence_id,idempotency_key,request_fingerprint,task_id,task_version,workflow_id,revision_id,transition_id,action_key,gate_id,evidence_type,actor_key,captured_at,evidence_event_id,evidence_hash,ledger_event_id,status,revoked_at,revoked_event_id,revocation_hash,revocation_reason,revocation_idempotency_key,revocation_request_fingerprint,revocation_ledger_event_id,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(evidenceId, command.idempotencyKey, fingerprint, context.task.id, context.task.version, context.pin.workflow_id, context.pin.revision_id, rule.transition_id, command.actionKey, gate.gateId, "human_acceptance", actorKey, timestamp, evidenceEventId, evidenceHash, event.eventId, "valid", null, null, null, null, null, null, null, timestamp),
    head ? env.DB.prepare("UPDATE workflow_ledger_head SET last_sequence = ?, last_event_hash = ?, updated_at = ? WHERE singleton = 1").bind(sequence, event.eventHash, timestamp) : env.DB.prepare("INSERT INTO workflow_ledger_head (singleton, last_sequence, last_event_hash, updated_at) VALUES (1, ?, ?, ?)").bind(sequence, event.eventHash, timestamp),
    env.DB.prepare(`INSERT INTO workflow_aggregate_projections (aggregate_type,aggregate_id,workflow_id,revision_id,last_sequence,last_event_id,last_event_type,last_event_hash,state_json,created_at,updated_at)
      VALUES ('task',?,?,?,?,?,?,?,?,?,?) ON CONFLICT(aggregate_type,aggregate_id) DO UPDATE SET workflow_id=excluded.workflow_id,revision_id=excluded.revision_id,last_sequence=excluded.last_sequence,last_event_id=excluded.last_event_id,last_event_type=excluded.last_event_type,last_event_hash=excluded.last_event_hash,state_json=excluded.state_json,updated_at=excluded.updated_at`).bind(context.task.id, event.workflowId, event.revisionId, sequence, event.eventId, event.eventType, event.eventHash, JSON.stringify(state), priorProjection?.created_at ?? timestamp, timestamp),
    env.DB.prepare("INSERT INTO workflow_outbox (event_id, sequence, topic, payload_json, created_at) VALUES (?, ?, 'workflow.gate.satisfied', ?, ?)").bind(event.eventId, sequence, JSON.stringify(event), timestamp),
    env.DB.prepare(`INSERT INTO task_activities (
      id, task_id, actor_type, actor_id, actor_name, actor_avatar_url, changes, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(uuid(), context.task.id, humanActor.type, humanActor.id, humanActor.name, humanActor.avatarUrl,
        JSON.stringify([{ field: "acceptanceEvidence", before: null, after: evidenceId }]), timestamp),
  ];
  try { await env.DB.batch(statements); } catch (error) {
    const raced = await env.DB.prepare("SELECT * FROM workflow_human_evidence WHERE idempotency_key = ?").bind(command.idempotencyKey).first();
    if (raced && raced.request_fingerprint === fingerprint) return registerHumanAcceptanceEvidence(request, env, taskId, command, actor, { retryCount });
    if (String(error).includes("STALE_HUMAN_ACCEPTANCE_EVIDENCE")) {
      throw transitionError("EXPECTED_STATE_CONFLICT", "Task changed while acceptance evidence was being recorded");
    }
    const ledgerCollision = await env.DB.prepare("SELECT event_id FROM workflow_ledger_events WHERE idempotency_key = ?").bind(command.idempotencyKey).first();
    if (ledgerCollision) throw transitionError("IDEMPOTENCY_CONFLICT", "Idempotency-Key was already used for a different workflow request");
    if (isLedgerWriteConflict(error)) {
      if (retryCount < LEDGER_RETRY_LIMIT) return registerHumanAcceptanceEvidence(request, env, taskId, command, actor, { retryCount: retryCount + 1 });
      throw transitionError("LEDGER_CONTENTION", "Workflow ledger was busy; retry the same idempotency key");
    }
    throw error;
  }
  return { evidence: evidenceResponse(evidenceRow), event, idempotent: false };
}

async function revokeHumanAcceptanceEvidence(request, env, taskId, evidenceId, command, actor, { retryCount = 0 } = {}) {
  const evidence = await env.DB.prepare("SELECT * FROM workflow_human_evidence WHERE evidence_id = ? AND task_id = ?").bind(evidenceId, taskId).first();
  if (!evidence) throw new ApiError(404, "EVIDENCE_NOT_FOUND", "Human acceptance evidence was not found for this task");
  const { actorKey, actor: humanActor } = await verifiedHumanAcceptanceActor(request, env, actor, {
    purpose: "human_acceptance_revocation",
    route: "/api/tasks/:id/evidence/:evidenceId/revoke",
    method: "POST",
    taskId,
    evidenceId,
    taskVersion: evidence.task_version,
    workflowId: evidence.workflow_id,
    revisionId: evidence.revision_id,
    transitionId: evidence.transition_id,
    actionKey: evidence.action_key,
    gateId: evidence.gate_id,
    reason: command.reason,
    idempotencyKey: command.idempotencyKey,
  });
  const fingerprint = canonicalJson({ taskId, evidenceId, reason: command.reason, actorKey, type: "human_acceptance_revocation" });
  if (evidence.actor_key !== actorKey) {
    throw new ApiError(403, "HUMAN_EVIDENCE_ACTOR_REQUIRED", "Only the recorded human can revoke this acceptance evidence");
  }
  if (evidence.status === "revoked") {
    if (evidence.revocation_idempotency_key !== command.idempotencyKey || evidence.revocation_request_fingerprint !== fingerprint) {
      throw transitionError("EVIDENCE_REVOKED", "Human acceptance evidence has already been revoked");
    }
    const replay = await env.DB.prepare("SELECT envelope_json FROM workflow_ledger_events WHERE event_id = ?").bind(evidence.revocation_ledger_event_id).first();
    if (!replay) throw transitionError("LEDGER_HASH_INVALID", "Acceptance evidence revocation points to a missing ledger event");
    return { evidence: evidenceResponse(evidence), event: JSON.parse(replay.envelope_json), idempotent: true };
  }
  const existingLedgerKey = await env.DB.prepare("SELECT event_id FROM workflow_ledger_events WHERE idempotency_key = ?").bind(command.idempotencyKey).first();
  if (existingLedgerKey) throw transitionError("IDEMPOTENCY_CONFLICT", "Idempotency-Key was already used for a different workflow request");
  const timestamp = now();
  const revokedEventId = uuid();
  const revocationHash = await sha256(canonicalJson({
    schemaVersion: 1, evidenceId: evidence.evidence_id, evidenceEventId: evidence.evidence_event_id,
    revokedEventId, taskId: evidence.task_id, taskVersion: evidence.task_version,
    workflowId: evidence.workflow_id, revisionId: evidence.revision_id,
    transitionId: evidence.transition_id, gateId: evidence.gate_id, actorKey,
    revokedAt: timestamp, reason: command.reason,
  }));
  const head = await env.DB.prepare("SELECT * FROM workflow_ledger_head WHERE singleton = 1").first();
  const sequence = (head?.last_sequence ?? 0) + 1;
  const event = {
    schemaVersion: 1, eventId: uuid(), eventType: "gate.revoked", occurredAt: timestamp,
    workflowId: evidence.workflow_id, revisionId: evidence.revision_id,
    aggregateType: "task", aggregateId: evidence.task_id, correlationId: uuid(), causationId: null,
    idempotencyKey: command.idempotencyKey, prevHash: head?.last_event_hash ?? null,
    payload: {
      gateId: evidence.gate_id,
      evidence: { evidenceId: evidence.evidence_id, evidenceEventId: evidence.evidence_event_id, eventHash: evidence.evidence_hash, actorKey },
      revocation: { revokedEventId, eventHash: revocationHash, revokedAt: timestamp, reason: command.reason, actorKey },
    },
  };
  event.eventHash = await sha256(canonicalJson(event));
  const priorProjection = await env.DB.prepare("SELECT state_json, created_at FROM workflow_aggregate_projections WHERE aggregate_type = 'task' AND aggregate_id = ?").bind(evidence.task_id).first();
  let previousState = {};
  try { previousState = priorProjection ? JSON.parse(priorProjection.state_json) : {}; } catch { throw transitionError("LEDGER_HASH_INVALID", "Task aggregate projection is malformed"); }
  const state = {
    ...previousState,
    lastEventType: event.eventType,
    payload: event.payload,
    task: previousState.task ?? { id: evidence.task_id, stageId: null, status: null, version: evidence.task_version },
  };
  const statements = [
    env.DB.prepare(`INSERT INTO workflow_ledger_events (sequence,event_id,event_type,workflow_id,revision_id,aggregate_type,aggregate_id,correlation_id,causation_id,idempotency_key,idempotency_fingerprint,prev_hash,event_hash,envelope_json,occurred_at,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(sequence, event.eventId, event.eventType, event.workflowId, event.revisionId, event.aggregateType, event.aggregateId, event.correlationId, null, event.idempotencyKey, fingerprint, event.prevHash, event.eventHash, JSON.stringify(event), timestamp, timestamp),
    env.DB.prepare(`UPDATE workflow_human_evidence
      SET status = 'revoked', revoked_at = ?, revoked_event_id = ?, revocation_hash = ?, revocation_reason = ?,
        revocation_idempotency_key = ?, revocation_request_fingerprint = ?, revocation_ledger_event_id = ?
      WHERE evidence_id = ?`).bind(timestamp, revokedEventId, revocationHash, command.reason, command.idempotencyKey, fingerprint, event.eventId, evidence.evidence_id),
    head ? env.DB.prepare("UPDATE workflow_ledger_head SET last_sequence = ?, last_event_hash = ?, updated_at = ? WHERE singleton = 1").bind(sequence, event.eventHash, timestamp) : env.DB.prepare("INSERT INTO workflow_ledger_head (singleton, last_sequence, last_event_hash, updated_at) VALUES (1, ?, ?, ?)").bind(sequence, event.eventHash, timestamp),
    env.DB.prepare(`INSERT INTO workflow_aggregate_projections (aggregate_type,aggregate_id,workflow_id,revision_id,last_sequence,last_event_id,last_event_type,last_event_hash,state_json,created_at,updated_at)
      VALUES ('task',?,?,?,?,?,?,?,?,?,?) ON CONFLICT(aggregate_type,aggregate_id) DO UPDATE SET workflow_id=excluded.workflow_id,revision_id=excluded.revision_id,last_sequence=excluded.last_sequence,last_event_id=excluded.last_event_id,last_event_type=excluded.last_event_type,last_event_hash=excluded.last_event_hash,state_json=excluded.state_json,updated_at=excluded.updated_at`).bind(evidence.task_id, event.workflowId, event.revisionId, sequence, event.eventId, event.eventType, event.eventHash, JSON.stringify(state), priorProjection?.created_at ?? timestamp, timestamp),
    env.DB.prepare("INSERT INTO workflow_outbox (event_id, sequence, topic, payload_json, created_at) VALUES (?, ?, 'workflow.gate.revoked', ?, ?)").bind(event.eventId, sequence, JSON.stringify(event), timestamp),
    env.DB.prepare(`INSERT INTO task_activities (
      id, task_id, actor_type, actor_id, actor_name, actor_avatar_url, changes, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(uuid(), evidence.task_id, humanActor.type, humanActor.id, humanActor.name, humanActor.avatarUrl,
        JSON.stringify([{ field: "acceptanceEvidence", before: evidence.evidence_id, after: "revoked" }]), timestamp),
  ];
  try { await env.DB.batch(statements); } catch (error) {
    const raced = await env.DB.prepare("SELECT * FROM workflow_human_evidence WHERE evidence_id = ? AND task_id = ?").bind(evidenceId, taskId).first();
    if (raced?.status === "revoked" && raced.revocation_idempotency_key === command.idempotencyKey && raced.revocation_request_fingerprint === fingerprint) {
      return revokeHumanAcceptanceEvidence(request, env, taskId, evidenceId, command, actor, { retryCount });
    }
    if (raced?.status === "revoked") throw transitionError("EVIDENCE_REVOKED", "Human acceptance evidence has already been revoked");
    const ledgerCollision = await env.DB.prepare("SELECT event_id FROM workflow_ledger_events WHERE idempotency_key = ?").bind(command.idempotencyKey).first();
    if (ledgerCollision) throw transitionError("IDEMPOTENCY_CONFLICT", "Idempotency-Key was already used for a different workflow request");
    if (isLedgerWriteConflict(error)) {
      if (retryCount < LEDGER_RETRY_LIMIT) return revokeHumanAcceptanceEvidence(request, env, taskId, evidenceId, command, actor, { retryCount: retryCount + 1 });
      throw transitionError("LEDGER_CONTENTION", "Workflow ledger was busy; retry the same idempotency key");
    }
    throw error;
  }
  const revoked = await env.DB.prepare("SELECT * FROM workflow_human_evidence WHERE evidence_id = ?").bind(evidenceId).first();
  return { evidence: evidenceResponse(revoked), event, idempotent: false };
}

async function createTask(env, input, actor) {
  const project = await env.DB.prepare(`
    SELECT
      projects.id,
      projects.name,
      (
        SELECT tasks.identifier
        FROM tasks
        WHERE tasks.project_id = projects.id
        ORDER BY tasks.created_at, tasks.id
        LIMIT 1
      ) AS first_identifier
    FROM projects
    WHERE projects.id = ?
  `).bind(input.projectId).first();
  if (!project) {
    throw new ApiError(404, "PROJECT_NOT_FOUND", `Project '${input.projectId}' does not exist`);
  }
  await ensureProjectWorkflow(env, input.projectId);
  const stage = await resolveStageForTask(env, input.projectId, input);
  input.status = stage.status;
  input.stageId = stage.stageId;
  const prefix = projectPrefix(project);
  const suffixStart = prefix.length + 2;
  let sortOrder = input.sortOrder;
  if (sortOrder === undefined) {
    const row = await env.DB.prepare(`
      SELECT COALESCE(MAX(sort_order), 0) AS maximum
      FROM tasks
      WHERE project_id = ? AND stage_id = ? AND archived_at IS NULL
    `).bind(input.projectId, input.stageId).first();
    sortOrder = row.maximum + 1000;
  }
  const id = uuid();
  const timestamp = now();
  const assignee = resolveAssignee(input.assigneeTarget, actor);
  const results = await env.DB.batch([
    env.DB.prepare(`
      INSERT INTO tasks (
        id, identifier, project_id, title, description, status, stage_id, priority, labels,
        sort_order, thread_id, thread_codex_project_id, thread_codex_project_kind,
        thread_codex_host_id, thread_workspace_path,
        creator_type, creator_id, creator_name, creator_avatar_url,
        assignee_type, assignee_id, assignee_name, assignee_avatar_url,
        development_context_type, development_branch,
        start_date, due_date, recurrence_interval, recurrence_unit,
        archived_at, version, created_at, updated_at
      )
      SELECT
        ?,
        ? || '-' || CAST(MAX(
          projects.next_task_number,
          COALESCE((
            SELECT MAX(CAST(substr(tasks.identifier, ?) AS INTEGER)) + 1
            FROM tasks
            WHERE tasks.identifier GLOB ?
          ), 1)
        ) AS TEXT),
        projects.id,
        ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?,
        ?, ?, ?, ?,
        NULL, 1, ?, ?
      FROM projects
      WHERE projects.id = ?
    `).bind(
      id,
      prefix,
      suffixStart,
      `${prefix}-[0-9]*`,
      input.title,
      input.description,
      input.status,
      input.stageId,
      input.priority,
      JSON.stringify(input.labels),
      sortOrder,
      ...(storedThreadBinding(input.threadBinding, input.threadId) ?? [null, null, null, null, null]),
      actor.type,
      actor.id,
      actor.name,
      actor.avatarUrl,
      assignee.type,
      assignee.id,
      assignee.name,
      assignee.avatarUrl,
      input.developmentContext?.type ?? null,
      input.developmentContext?.branch ?? null,
      input.startDate,
      input.dueDate,
      input.recurrence?.interval ?? null,
      input.recurrence?.unit ?? null,
      timestamp,
      timestamp,
      input.projectId,
    ),
    env.DB.prepare(`
      UPDATE projects
      SET
        next_task_number = (
          SELECT CAST(substr(identifier, ?) AS INTEGER) + 1
          FROM tasks
          WHERE id = ?
        ),
        labels = (
          SELECT json_group_array(value)
          FROM (
            SELECT value
            FROM (
              SELECT
                value,
                source_order,
                label_order,
                ROW_NUMBER() OVER (
                  PARTITION BY value
                  ORDER BY source_order, label_order
                ) AS occurrence_rank
              FROM (
                SELECT value, 0 AS source_order, key AS label_order
                FROM json_each(projects.labels)
                UNION ALL
                SELECT value, 1 AS source_order, key AS label_order
                FROM json_each(?)
              )
            )
            WHERE occurrence_rank = 1
            ORDER BY source_order, label_order
          )
        ),
        updated_at = ?
      WHERE id = ?
    `).bind(
      suffixStart,
      id,
      JSON.stringify(input.labels),
      timestamp,
      input.projectId,
    ),
  ]);
  if (!changed(results[0]) || !changed(results[1])) {
    throw new ApiError(
      404,
      "PROJECT_NOT_FOUND",
      `Project '${input.projectId}' does not exist`,
    );
  }
  return getTask(env, id);
}

async function legacyTransitionIdempotencyKey({ taskId, version, status, stageId, sortOrder }) {
  return `legacy_${(await sha256(canonicalJson({ taskId, version, status, stageId: stageId ?? null, sortOrder: sortOrder ?? null }))).slice(0, 56)}`;
}

async function updateTask(env, id, input, actor) {
  const current = await requireTaskRow(env, id);
  assertTaskVersion(current, input.version);
  const currentTask = taskFromRow(current);
  const targetProject = Object.hasOwn(input.changes, "projectId")
    ? await requireProject(env, input.changes.projectId)
    : null;
  const projectChanged = Boolean(targetProject && targetProject.id !== currentTask.projectId);
  const destinationProjectId = targetProject?.id ?? currentTask.projectId;
  const stageExplicit = Object.hasOwn(input.changes, "stageId");
  const statusExplicit = Object.hasOwn(input.changes, "status");
  if (Object.hasOwn(input.changes, "stageId") || projectChanged) {
    const stage = await resolveStageForTask(env, destinationProjectId, {
      stageId: input.changes.stageId,
      status: input.changes.status ?? currentTask.status,
    });
    input.changes.stageId = stage.stageId;
    input.changes.status = stage.status;
  } else if (Object.hasOwn(input.changes, "status")) {
    const stage = await resolveStageForTask(env, destinationProjectId, { status: input.changes.status });
    input.changes.stageId = stage.stageId;
    input.changes.status = stage.status;
  }
  const taskLabels = Object.hasOwn(input.changes, "labels")
    ? input.changes.labels
    : currentTask.labels;
  if (projectChanged) {
    const relation = await env.DB.prepare(`
      SELECT 1
      FROM task_relations
      WHERE source_task_id = ? OR target_task_id = ?
      LIMIT 1
    `).bind(current.id, current.id).first();
    if (relation) {
      throw new ApiError(
        409,
        "CROSS_PROJECT_RELATION",
        "Remove issue relations before moving the issue to another project",
      );
    }
  }
  const activityValues = { ...input.changes };
  if (projectChanged && !stageExplicit) delete activityValues.stageId;
  const dueDate = Object.hasOwn(input.changes, "dueDate")
    ? input.changes.dueDate
    : currentTask.dueDate;
  const recurrence = Object.hasOwn(input.changes, "recurrence")
    ? input.changes.recurrence
    : currentTask.recurrence;
  if (recurrence && !dueDate) {
    throw new ApiError(400, "INVALID_FIELD", "A recurring issue requires a due date");
  }

  const assignments = [];
  const values = [];
  const columns = {
    projectId: "project_id",
    title: "title",
    description: "description",
    status: "status",
    stageId: "stage_id",
    priority: "priority",
    labels: "labels",
    startDate: "start_date",
    dueDate: "due_date",
  };
  for (const [key, value] of Object.entries(input.changes)) {
    if (key === "developmentContext") {
      assignments.push("development_context_type = ?", "development_branch = ?");
      values.push(value?.type ?? null, value?.branch ?? null);
    } else if (key === "recurrence") {
      assignments.push("recurrence_interval = ?", "recurrence_unit = ?");
      values.push(value?.interval ?? null, value?.unit ?? null);
    } else {
      assignments.push(`${columns[key]} = ?`);
      values.push(key === "labels" ? JSON.stringify(value) : value);
    }
  }
  const stageChanged = (stageExplicit || statusExplicit)
    && Object.hasOwn(input.changes, "stageId")
    && input.changes.stageId !== currentTask.stageId;
  if (stageChanged) {
    const placementProjectId = projectChanged ? targetProject.id : currentTask.projectId;
    const row = await env.DB.prepare(`
      SELECT MIN(sort_order) AS minimum
      FROM tasks
      WHERE project_id = ? AND stage_id = ? AND archived_at IS NULL AND id != ?
    `).bind(placementProjectId, input.changes.stageId, current.id).first();
    assignments.push("sort_order = ?");
    values.push(row?.minimum == null ? 1000 : row.minimum - 1000);
  }
  if (input.assigneeTarget !== undefined) {
    const assignee = resolveAssignee(input.assigneeTarget, actor);
    activityValues.assignee = assignee;
    assignments.push(
      "assignee_type = ?",
      "assignee_id = ?",
      "assignee_name = ?",
      "assignee_avatar_url = ?",
    );
    values.push(assignee.type, assignee.id, assignee.name, assignee.avatarUrl);
  }
  const storedBinding = storedThreadBindingForExisting(current, input.threadBinding, input.threadId);
  if (storedBinding && !Object.hasOwn(input.changes, "projectId")) {
    assignments.push(
      "thread_id = ?",
      "thread_codex_project_id = ?",
      "thread_codex_project_kind = ?",
      "thread_codex_host_id = ?",
      "thread_workspace_path = ?",
    );
    values.push(...storedBinding);
  }
  assignments.push("version = version + 1", "updated_at = ?");
  const timestamp = now();
  values.push(timestamp, current.id, input.version);
  if (projectChanged) values.push(current.id, current.id);
  const relationGuard = projectChanged
    ? " AND NOT EXISTS (SELECT 1 FROM task_relations WHERE source_task_id = ? OR target_task_id = ?)"
    : "";
  const statements = [env.DB.prepare(`
    UPDATE tasks
    SET ${assignments.join(", ")}
    WHERE id = ? AND version = ?${relationGuard}
  `).bind(...values)];
  const activityChanges = taskFieldChanges(currentTask, activityValues);
  if (activityChanges.length > 0) {
    statements.push(taskActivityStatement(
      env,
      current.id,
      actor,
      activityChanges,
      timestamp,
      input.version + 1,
    ));
  }
  if (projectChanged) {
    statements.push(env.DB.prepare(`
      UPDATE projects
      SET updated_at = ?
      WHERE id IN (?, ?)
        AND EXISTS (
          SELECT 1 FROM tasks WHERE id = ? AND version = ? AND updated_at = ?
        )
    `).bind(
      timestamp,
      currentTask.projectId,
      targetProject.id,
      current.id,
      input.version + 1,
      timestamp,
    ));
  }
  if (taskLabels.length > 0) {
    statements.push(env.DB.prepare(`
      UPDATE projects
      SET
        labels = (
          SELECT json_group_array(value)
          FROM (
            SELECT value
            FROM (
              SELECT
                value,
                source_order,
                label_order,
                ROW_NUMBER() OVER (
                  PARTITION BY value
                  ORDER BY source_order, label_order
                ) AS occurrence_rank
              FROM (
                SELECT value, 0 AS source_order, key AS label_order
                FROM json_each(projects.labels)
                UNION ALL
                SELECT value, 1 AS source_order, key AS label_order
                FROM json_each(?)
              )
            )
            WHERE occurrence_rank = 1
            ORDER BY source_order, label_order
          )
        ),
        updated_at = ?
      WHERE id = ?
        AND EXISTS (
          SELECT 1 FROM tasks WHERE id = ? AND version = ? AND updated_at = ?
        )
        AND EXISTS (
          SELECT 1
          FROM json_each(?) AS task_labels
          WHERE NOT EXISTS (
            SELECT 1
            FROM json_each(projects.labels) AS project_labels
            WHERE project_labels.value = task_labels.value
          )
        )
    `).bind(
      JSON.stringify(taskLabels),
      timestamp,
      destinationProjectId,
      current.id,
      input.version + 1,
      timestamp,
      JSON.stringify(taskLabels),
    ));
  }
  const results = await env.DB.batch(statements);
  if (!changed(results[0])) {
    if (projectChanged) {
      const relation = await env.DB.prepare(`
        SELECT 1
        FROM task_relations
        WHERE source_task_id = ? OR target_task_id = ?
        LIMIT 1
      `).bind(current.id, current.id).first();
      if (relation) {
        throw new ApiError(
          409,
          "CROSS_PROJECT_RELATION",
          "Remove issue relations before moving the issue to another project",
        );
      }
    }
    const latest = await requireTaskRow(env, current.id);
    throw new ApiError(
      409,
      "VERSION_CONFLICT",
      "Task was changed by another client",
      { expectedVersion: input.version, actualVersion: latest.version },
    );
  }
  return getTask(env, current.id);
}

async function moveTask(env, id, input, actor) {
  const current = await requireTaskRow(env, id);
  assertTaskVersion(current, input.version);
  if (current.archived_at !== null) {
    throw new ApiError(409, "TASK_ARCHIVED", "Archived tasks cannot be moved");
  }
  if (input.stageId === undefined && input.status === undefined) {
    throw new ApiError(400, "INVALID_BODY", "Move requires stageId or status");
  }
  const stage = await resolveStageForTask(env, current.project_id, input);
  input.stageId = stage.stageId;
  input.status = stage.status;
  let sortOrder = input.sortOrder;
  if (input.stageId !== current.stage_id && sortOrder === undefined) {
    const row = await env.DB.prepare(`
      SELECT MIN(sort_order) AS minimum
      FROM tasks
      WHERE project_id = ? AND stage_id = ? AND archived_at IS NULL AND id != ?
    `).bind(current.project_id, input.stageId, current.id).first();
    sortOrder = row?.minimum == null ? 1000 : row.minimum - 1000;
  } else if (sortOrder === undefined) {
    const row = await env.DB.prepare(`
      SELECT COALESCE(MAX(sort_order), 0) AS maximum
      FROM tasks
      WHERE project_id = ? AND stage_id = ? AND archived_at IS NULL AND id != ?
    `).bind(current.project_id, input.stageId, current.id).first();
    sortOrder = row.maximum + 1000;
  }
  const timestamp = now();
  const storedBinding = storedThreadBindingForExisting(current, input.threadBinding, input.threadId);
  const threadAssignment = storedBinding
    ? `thread_id = ?, thread_codex_project_id = ?, thread_codex_project_kind = ?,
      thread_codex_host_id = ?, thread_workspace_path = ?,`
    : "";
  const statements = [env.DB.prepare(`
    UPDATE tasks
    SET
      status = ?,
      stage_id = ?,
      sort_order = ?,
      ${threadAssignment}
      version = version + 1,
      updated_at = ?
    WHERE id = ? AND version = ?
  `).bind(
    input.status,
    input.stageId,
    sortOrder,
    ...(storedBinding ?? []),
    timestamp,
    current.id,
    input.version,
  )];
  const activityChanges = taskFieldChanges(taskFromRow(current), { status: input.status, stageId: input.stageId });
  if (activityChanges.length > 0) {
    statements.push(taskActivityStatement(
      env,
      current.id,
      actor,
      activityChanges,
      timestamp,
      input.version + 1,
    ));
  }
  const results = await env.DB.batch(statements);
  if (!changed(results[0])) {
    const latest = await requireTaskRow(env, current.id);
    throw new ApiError(
      409,
      "VERSION_CONFLICT",
      "Task was changed by another client",
      { expectedVersion: input.version, actualVersion: latest.version },
    );
  }
  return getTask(env, current.id);
}

async function archiveTask(env, id, input, actor) {
  const current = await requireTaskRow(env, id);
  assertTaskVersion(current, input.version);
  const timestamp = now();
  const storedBinding = storedThreadBindingForExisting(current, input.threadBinding, input.threadId);
  const threadAssignment = storedBinding
    ? `thread_id = ?, thread_codex_project_id = ?, thread_codex_project_kind = ?,
      thread_codex_host_id = ?, thread_workspace_path = ?,`
    : "";
  const results = await env.DB.batch([env.DB.prepare(`
    UPDATE tasks
    SET
      archived_at = ?,
      ${threadAssignment}
      version = version + 1,
      updated_at = ?
    WHERE id = ? AND version = ?
  `).bind(timestamp, ...(storedBinding ?? []), timestamp, current.id, input.version),
  taskActivityStatement(
    env,
    current.id,
    actor,
    [{ field: "archivedAt", before: current.archived_at, after: timestamp }],
    timestamp,
    input.version + 1,
  )]);
  if (!changed(results[0])) {
    const latest = await requireTaskRow(env, current.id);
    throw new ApiError(
      409,
      "VERSION_CONFLICT",
      "Task was changed by another client",
      { expectedVersion: input.version, actualVersion: latest.version },
    );
  }
  return getTask(env, current.id);
}

async function restoreTask(env, id, input, actor) {
  const current = await requireTaskRow(env, id);
  assertTaskVersion(current, input.version);
  if (current.archived_at === null) {
    throw new ApiError(409, "TASK_NOT_ARCHIVED", "Only archived tasks can be restored");
  }
  const timestamp = now();
  const storedBinding = storedThreadBindingForExisting(current, input.threadBinding, input.threadId);
  const threadAssignment = storedBinding
    ? `thread_id = ?, thread_codex_project_id = ?, thread_codex_project_kind = ?,
      thread_codex_host_id = ?, thread_workspace_path = ?,`
    : "";
  const results = await env.DB.batch([env.DB.prepare(`
    UPDATE tasks
    SET
      archived_at = NULL,
      ${threadAssignment}
      version = version + 1,
      updated_at = ?
    WHERE id = ? AND version = ?
  `).bind(...(storedBinding ?? []), timestamp, current.id, input.version),
  taskActivityStatement(
    env,
    current.id,
    actor,
    [{ field: "archivedAt", before: current.archived_at, after: null }],
    timestamp,
    input.version + 1,
  )]);
  if (!changed(results[0])) {
    const latest = await requireTaskRow(env, current.id);
    throw new ApiError(
      409,
      "VERSION_CONFLICT",
      "Task was changed by another client",
      { expectedVersion: input.version, actualVersion: latest.version },
    );
  }
  return getTask(env, current.id);
}

async function deleteArchivedTask(env, id, expectedVersion) {
  const current = await requireTaskRow(env, id);
  assertTaskVersion(current, expectedVersion);
  if (current.archived_at === null) {
    throw new ApiError(409, "TASK_NOT_ARCHIVED", "Only archived tasks can be deleted");
  }
  const results = await env.DB.batch([
    env.DB.prepare("SELECT id FROM attachments WHERE task_id = ?").bind(current.id),
    env.DB.prepare(`
      DELETE FROM tasks
      WHERE id = ? AND version = ? AND archived_at IS NOT NULL
    `).bind(current.id, expectedVersion),
  ]);
  if (!changed(results[1])) {
    const latest = await requireTaskRow(env, current.id);
    assertTaskVersion(latest, expectedVersion);
    throw new ApiError(409, "TASK_NOT_ARCHIVED", "Only archived tasks can be deleted");
  }
  const attachmentIds = results[0].results.map((attachment) => attachment.id);
  await Promise.all(attachmentIds.map((attachmentId) => env.ATTACHMENTS.delete(attachmentId)));
}

function relationEndpoints(type, taskId, relatedTaskId) {
  if (type === "parent") {
    return {
      relationType: "parent",
      sourceTaskId: relatedTaskId,
      targetTaskId: taskId,
    };
  }
  if (type === "blocks") {
    return {
      relationType: "blocks",
      sourceTaskId: taskId,
      targetTaskId: relatedTaskId,
    };
  }
  if (type === "blocked_by") {
    return {
      relationType: "blocks",
      sourceTaskId: relatedTaskId,
      targetTaskId: taskId,
    };
  }
  if (type === "related") {
    const [sourceTaskId, targetTaskId] = [taskId, relatedTaskId].sort();
    return { relationType: "related", sourceTaskId, targetTaskId };
  }
  throw new ApiError(
    400,
    "INVALID_FIELD",
    "'relation type' must be parent, blocks, blocked_by, or related",
  );
}

async function assertRelationTasks(env, taskId, relatedTaskId, expectedVersion) {
  const task = await requireTaskRow(env, taskId);
  const relatedTask = await requireTaskRow(env, relatedTaskId);
  assertTaskVersion(task, expectedVersion);
  if (task.id === relatedTask.id) {
    throw new ApiError(400, "SELF_RELATION", "An issue cannot be related to itself");
  }
  if (task.project_id !== relatedTask.project_id) {
    // Cross-project composition remains intentionally unavailable pending an ownership policy.
    throw new ApiError(
      400,
      "CROSS_PROJECT_RELATION",
      "Issue relations must stay within one project",
    );
  }
  return { task, relatedTask };
}

async function addRelation(env, taskId, type, relatedTaskId, input, actor) {
  const { task, relatedTask } = await assertRelationTasks(
    env,
    taskId,
    relatedTaskId,
    input.version,
  );
  const endpoints = relationEndpoints(type, task.id, relatedTask.id);
  const metadataJson = endpoints.relationType === "parent"
    ? parentRelationMetadataJson(input.metadata)
    : DEFAULT_PARENT_RELATION_METADATA_JSON;
  const timestamp = now();
  const storedBinding = storedThreadBindingForExisting(task, input.threadBinding, input.threadId);
  const threadAssignment = storedBinding
    ? `thread_id = ?, thread_codex_project_id = ?, thread_codex_project_kind = ?,
      thread_codex_host_id = ?, thread_workspace_path = ?,`
    : "";
  let previousRelation = null;
  const statements = [];
  if (endpoints.relationType === "parent") {
    const cycle = await env.DB.prepare(`
      WITH RECURSIVE ancestors(id) AS (
        SELECT source_task_id
        FROM task_relations
        WHERE relation_type = 'parent' AND target_task_id = ?
        UNION
        SELECT task_relations.source_task_id
        FROM task_relations
        JOIN ancestors ON task_relations.target_task_id = ancestors.id
        WHERE task_relations.relation_type = 'parent'
      )
      SELECT 1 AS found FROM ancestors WHERE id = ?
    `).bind(relatedTask.id, task.id).first();
    if (cycle) {
      throw new ApiError(409, "RELATION_CYCLE", "This parent would create a cycle");
    }
    const existing = await env.DB.prepare(`
      SELECT source_task_id, metadata
      FROM task_relations
      WHERE relation_type = 'parent' AND target_task_id = ?
    `).bind(task.id).first();
    if (existing?.source_task_id === relatedTask.id) {
      if (existing.metadata === metadataJson) {
        return { task: await getTask(env, task.id), relatedTask: await getTask(env, relatedTask.id) };
      }
      return updateRelation(env, taskId, type, relatedTaskId, {
        ...input,
        metadata: parentRelationMetadataFromStored(metadataJson),
      }, actor);
    }
    if (existing) {
      const previousParent = await requireTaskRow(env, existing.source_task_id);
      previousRelation = relationActivityValue(
        type,
        taskFromRow(previousParent),
        parentRelationMetadataFromStored(existing.metadata),
      );
      statements.push(
        env.DB.prepare(`
          DELETE FROM task_relations
          WHERE relation_type = 'parent'
            AND target_task_id = ?
            AND EXISTS (
              SELECT 1 FROM tasks WHERE id = ? AND version = ?
            )
        `).bind(task.id, task.id, input.version),
      );
    }
  } else {
    const existing = await env.DB.prepare(`
      SELECT 1 AS found
      FROM task_relations
      WHERE relation_type = ? AND source_task_id = ? AND target_task_id = ?
    `).bind(
      endpoints.relationType,
      endpoints.sourceTaskId,
      endpoints.targetTaskId,
    ).first();
    if (existing) {
      throw new ApiError(409, "RELATION_EXISTS", "This issue relation already exists");
    }
  }
  statements.push(
    env.DB.prepare(`
      INSERT INTO task_relations (
        relation_type, source_task_id, target_task_id, origin, metadata, created_at
      )
      SELECT ?, ?, ?, ?, ?, ?
      WHERE EXISTS (
        SELECT 1 FROM tasks WHERE id = ? AND version = ?
      )
    `).bind(
      endpoints.relationType,
      endpoints.sourceTaskId,
      endpoints.targetTaskId,
      input.origin ?? "manual",
      metadataJson,
      timestamp,
      task.id,
      input.version,
    ),
    env.DB.prepare(`
      UPDATE tasks
      SET
        ${threadAssignment}
        version = version + 1,
        updated_at = ?
      WHERE id = ? AND version = ?
    `).bind(...(storedBinding ?? []), timestamp, task.id, input.version),
  );
  const taskUpdateIndex = statements.length - 1;
  statements.push(taskActivityStatement(
    env,
    task.id,
    actor,
    [{
      field: "relation",
      before: previousRelation,
      after: relationActivityValue(
        type,
        taskFromRow(relatedTask),
        endpoints.relationType === "parent" ? parentRelationMetadataFromStored(metadataJson) : undefined,
      ),
    }],
    timestamp,
    input.version + 1,
  ));
  let results;
  try {
    results = await env.DB.batch(statements);
  } catch (error) {
    const message = String(error.message);
    if (message.includes("CROSS_PROJECT_RELATION")) {
      throw new ApiError(
        400,
        "CROSS_PROJECT_RELATION",
        "Issue relations must stay within one project",
      );
    }
    if (message.includes("RELATION_CYCLE")) {
      throw new ApiError(409, "RELATION_CYCLE", "This parent would create a cycle");
    }
    if (
      message.includes("UNIQUE constraint failed")
      && message.includes("task_relations")
    ) {
      throw new ApiError(409, "RELATION_EXISTS", "This issue relation already exists");
    }
    throw error;
  }
  if (!changed(results[taskUpdateIndex])) {
    const latest = await requireTaskRow(env, task.id);
    throw new ApiError(
      409,
      "VERSION_CONFLICT",
      "Task was changed by another client",
      { expectedVersion: input.version, actualVersion: latest.version },
    );
  }
  return {
    task: await getTask(env, task.id),
    relatedTask: await getTask(env, relatedTask.id),
  };
}

async function updateRelation(env, taskId, type, relatedTaskId, input, actor) {
  if (type !== "parent") {
    throw new ApiError(400, "INVALID_FIELD", "Only parent relations have composition metadata");
  }
  const { task, relatedTask } = await assertRelationTasks(env, taskId, relatedTaskId, input.version);
  const endpoints = relationEndpoints(type, task.id, relatedTask.id);
  const relation = await env.DB.prepare(`
    SELECT metadata FROM task_relations
    WHERE relation_type = ? AND source_task_id = ? AND target_task_id = ?
  `).bind(endpoints.relationType, endpoints.sourceTaskId, endpoints.targetTaskId).first();
  if (!relation) throw new ApiError(404, "RELATION_NOT_FOUND", "This issue relation does not exist");
  const metadataJson = parentRelationMetadataJson(input.metadata, { required: true });
  if (relation.metadata === metadataJson) {
    return { task: await getTask(env, task.id), relatedTask: await getTask(env, relatedTask.id) };
  }
  const timestamp = now();
  const storedBinding = storedThreadBindingForExisting(task, input.threadBinding, input.threadId);
  const threadAssignment = storedBinding
    ? `thread_id = ?, thread_codex_project_id = ?, thread_codex_project_kind = ?,
      thread_codex_host_id = ?, thread_workspace_path = ?,`
    : "";
  const results = await env.DB.batch([
    env.DB.prepare(`
      UPDATE task_relations SET metadata = ?
      WHERE relation_type = ? AND source_task_id = ? AND target_task_id = ?
        AND EXISTS (SELECT 1 FROM tasks WHERE id = ? AND version = ?)
    `).bind(metadataJson, endpoints.relationType, endpoints.sourceTaskId, endpoints.targetTaskId, task.id, input.version),
    env.DB.prepare(`
      UPDATE tasks SET ${threadAssignment} version = version + 1, updated_at = ?
      WHERE id = ? AND version = ?
    `).bind(...(storedBinding ?? []), timestamp, task.id, input.version),
    taskActivityStatement(env, task.id, actor, [{
      field: "relation",
      before: relationActivityValue(type, taskFromRow(relatedTask), parentRelationMetadataFromStored(relation.metadata)),
      after: relationActivityValue(type, taskFromRow(relatedTask), parentRelationMetadataFromStored(metadataJson)),
    }], timestamp, input.version + 1),
  ]);
  if (!changed(results[1])) {
    const latest = await requireTaskRow(env, task.id);
    throw new ApiError(409, "VERSION_CONFLICT", "Task was changed by another client", {
      expectedVersion: input.version,
      actualVersion: latest.version,
    });
  }
  return { task: await getTask(env, task.id), relatedTask: await getTask(env, relatedTask.id) };
}

async function removeRelation(env, taskId, type, relatedTaskId, input, actor) {
  const { task, relatedTask } = await assertRelationTasks(
    env,
    taskId,
    relatedTaskId,
    input.version,
  );
  const endpoints = relationEndpoints(type, task.id, relatedTask.id);
  const relation = await env.DB.prepare(`
    SELECT origin, metadata
    FROM task_relations
    WHERE relation_type = ? AND source_task_id = ? AND target_task_id = ?
  `).bind(
    endpoints.relationType,
    endpoints.sourceTaskId,
    endpoints.targetTaskId,
  ).first();
  if (!relation) {
    throw new ApiError(404, "RELATION_NOT_FOUND", "This issue relation does not exist");
  }
  if (input.origin && relation.origin !== input.origin) {
    return {
      task: await getTask(env, task.id),
      relatedTask: await getTask(env, relatedTask.id),
    };
  }
  const timestamp = now();
  const storedBinding = storedThreadBindingForExisting(task, input.threadBinding, input.threadId);
  const threadAssignment = storedBinding
    ? `thread_id = ?, thread_codex_project_id = ?, thread_codex_project_kind = ?,
      thread_codex_host_id = ?, thread_workspace_path = ?,`
    : "";
  const mentionRemoval = input.origin === "mention"
    && endpoints.relationType === "related";
  const taskReference = `](?${new URLSearchParams({
    project: task.project_id,
    issue: relatedTask.identifier,
  })})`;
  const relatedTaskReference = `](?${new URLSearchParams({
    project: task.project_id,
    issue: task.identifier,
  })})`;
  const deleteStatement = mentionRemoval
    ? env.DB.prepare(`
      DELETE FROM task_relations
      WHERE relation_type = ?
        AND source_task_id = ?
        AND target_task_id = ?
        AND origin = 'mention'
        AND EXISTS (
          SELECT 1 FROM tasks WHERE id = ? AND version = ?
        )
        AND NOT EXISTS (
          SELECT 1
          FROM tasks
          WHERE (id = ? AND instr(description, ?) > 0)
            OR (id = ? AND instr(description, ?) > 0)
        )
        AND NOT EXISTS (
          SELECT 1
          FROM comments
          WHERE (task_id = ? AND instr(body, ?) > 0)
            OR (task_id = ? AND instr(body, ?) > 0)
        )
    `).bind(
      endpoints.relationType,
      endpoints.sourceTaskId,
      endpoints.targetTaskId,
      task.id,
      input.version,
      task.id,
      taskReference,
      relatedTask.id,
      relatedTaskReference,
      task.id,
      taskReference,
      relatedTask.id,
      relatedTaskReference,
    )
    : env.DB.prepare(`
      DELETE FROM task_relations
      WHERE relation_type = ?
        AND source_task_id = ?
        AND target_task_id = ?
        AND EXISTS (
          SELECT 1 FROM tasks WHERE id = ? AND version = ?
        )
    `).bind(
      endpoints.relationType,
      endpoints.sourceTaskId,
      endpoints.targetTaskId,
      task.id,
      input.version,
    );
  const results = await env.DB.batch([
    deleteStatement,
    env.DB.prepare(`
      UPDATE tasks
      SET
        ${threadAssignment}
        version = version + 1,
        updated_at = ?
      WHERE id = ? AND version = ?${mentionRemoval ? " AND changes() = 1" : ""}
    `).bind(...(storedBinding ?? []), timestamp, task.id, input.version),
    taskActivityStatement(
      env,
      task.id,
      actor,
      [{
        field: "relation",
        before: relationActivityValue(
          type,
          taskFromRow(relatedTask),
          endpoints.relationType === "parent" ? parentRelationMetadataFromStored(relation.metadata) : undefined,
        ),
        after: null,
      }],
      timestamp,
      input.version + 1,
    ),
  ]);
  if (!changed(results[1])) {
    const latest = await requireTaskRow(env, task.id);
    if (mentionRemoval && latest.version === input.version) {
      return {
        task: await getTask(env, task.id),
        relatedTask: await getTask(env, relatedTask.id),
      };
    }
    throw new ApiError(
      409,
      "VERSION_CONFLICT",
      "Task was changed by another client",
      { expectedVersion: input.version, actualVersion: latest.version },
    );
  }
  return {
    task: await getTask(env, task.id),
    relatedTask: await getTask(env, relatedTask.id),
  };
}

async function getProjectReadme(env, projectId) {
  const project = await getProject(env, projectId);
  if (!project) {
    throw new ApiError(404, "PROJECT_NOT_FOUND", `Project '${projectId}' does not exist`);
  }
  const row = await env.DB.prepare(`
    SELECT project_id, content, version, created_at, updated_at
    FROM project_readmes
    WHERE project_id = ?
  `).bind(projectId).first();
  return row
    ? {
      projectId: row.project_id,
      content: row.content,
      version: row.version,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }
    : { projectId, content: "", version: 0, createdAt: null, updatedAt: null };
}

async function saveProjectReadme(env, projectId, content, expectedVersion) {
  const project = await getProject(env, projectId);
  if (!project) {
    throw new ApiError(404, "PROJECT_NOT_FOUND", `Project '${projectId}' does not exist`);
  }
  const timestamp = now();
  if (expectedVersion === undefined) {
    await env.DB.prepare(`
      INSERT INTO project_readmes (project_id, content, version, created_at, updated_at)
      VALUES (?, ?, 1, ?, ?)
      ON CONFLICT(project_id) DO UPDATE SET
        content = excluded.content,
        version = project_readmes.version + 1,
        updated_at = excluded.updated_at
    `).bind(projectId, content, timestamp, timestamp).run();
    return getProjectReadme(env, projectId);
  }
  const current = await env.DB.prepare(`
    SELECT version FROM project_readmes WHERE project_id = ?
  `).bind(projectId).first();
  if (expectedVersion !== undefined) {
    const actualVersion = current?.version ?? 0;
    if (actualVersion !== expectedVersion) {
      throw new ApiError(409, "VERSION_CONFLICT", "Project README changed since it was last read", {
        expectedVersion,
        actualVersion,
      });
    }
  }
  if (current) {
    const versionCondition = expectedVersion !== undefined ? " AND version = ?" : "";
    const params = expectedVersion !== undefined
      ? [content, timestamp, projectId, expectedVersion]
      : [content, timestamp, projectId];
    const result = await env.DB.prepare(`
      UPDATE project_readmes
      SET content = ?, version = version + 1, updated_at = ?
      WHERE project_id = ?${versionCondition}
    `).bind(...params).run();
    if (!changed(result)) {
      const latest = await env.DB.prepare(`
        SELECT version FROM project_readmes WHERE project_id = ?
      `).bind(projectId).first();
      throw new ApiError(
        409,
        "VERSION_CONFLICT",
        "Project README changed since it was last read",
        { expectedVersion, actualVersion: latest?.version ?? 0 },
      );
    }
  } else {
    try {
      await env.DB.prepare(`
        INSERT INTO project_readmes (project_id, content, version, created_at, updated_at)
        VALUES (?, ?, 1, ?, ?)
      `).bind(projectId, content, timestamp, timestamp).run();
    } catch (error) {
      if (String(error.message).includes("UNIQUE constraint failed")) {
        const latest = await env.DB.prepare(`
          SELECT version FROM project_readmes WHERE project_id = ?
        `).bind(projectId).first();
        throw new ApiError(
          409,
          "VERSION_CONFLICT",
          "Project README changed since it was last read",
          { expectedVersion, actualVersion: latest?.version ?? 0 },
        );
      }
      throw error;
    }
  }
  return getProjectReadme(env, projectId);
}

function stageFromRow(row) {
  return {
    stageId: row.id,
    canonicalStatus: row.canonical_status,
    name: row.name,
    order: row.sort_order,
    boardVisible: Boolean(row.board_visible),
    active: Boolean(row.active),
    isDefaultForStatus: Boolean(row.is_default_for_status),
    terminalKind: row.terminal_kind,
  };
}

async function getStageWorkflow(env, projectId) {
  await requireProject(env, projectId);
  const [workflow, rows] = await Promise.all([
    env.DB.prepare("SELECT version, updated_at FROM project_stage_workflows WHERE project_id = ?").bind(projectId).first(),
    all(env.DB.prepare("SELECT * FROM workflow_stages WHERE project_id = ? ORDER BY sort_order, id").bind(projectId)),
  ]);
  return {
    projectId,
    definition: { schemaVersion: 2, stages: rows.map(stageFromRow) },
    version: workflow?.version ?? 0,
    updatedAt: workflow?.updated_at ?? null,
  };
}

async function saveStageWorkflow(env, projectId, input) {
  await requireProject(env, projectId);
  const current = await env.DB.prepare("SELECT version FROM project_stage_workflows WHERE project_id = ?").bind(projectId).first();
  const actualVersion = current?.version ?? 0;
  if (actualVersion !== input.version) throw new ApiError(409, "VERSION_CONFLICT", "Stage workflow was changed by another client", { expectedVersion: input.version, actualVersion });
  const existing = await all(env.DB.prepare("SELECT * FROM workflow_stages WHERE project_id = ?").bind(projectId));
  const existingIds = new Set(existing.map((stage) => stage.id));
  const nextStages = input.definition.stages.map((stage) => ({ ...stage, stageId: stage.stageId ?? uuid() }));
  const nextIds = new Set(nextStages.map((stage) => stage.stageId));
  const foreignStage = await env.DB.prepare(
    `SELECT id FROM workflow_stages WHERE id IN (${nextStages.map(() => "?").join(", ")}) AND project_id != ? LIMIT 1`,
  ).bind(...nextIds, projectId).first();
  if (foreignStage) {
    throw new ApiError(400, "INVALID_STAGE", "Stages must belong to the issue project");
  }
  if ([...nextIds].some((id) => !existingIds.has(id) && input.removals.some((removal) => removal.stageId === id))) {
    throw new ApiError(400, "INVALID_FIELD", "A removal cannot target a newly created stage");
  }
  const removed = [...existingIds].filter((id) => !nextIds.has(id));
  const removalByStage = new Map(input.removals.map((removal) => [removal.stageId, removal]));
  for (const stageId of removed) {
    const cards = await env.DB.prepare("SELECT COUNT(*) AS count FROM tasks WHERE project_id = ? AND stage_id = ?").bind(projectId, stageId).first();
    const removal = removalByStage.get(stageId);
    if (Number(cards?.count ?? 0) > 0 && !removal?.destinationStageId) {
      throw new ApiError(409, "STAGE_HAS_TASKS", "A destination stage is required before removing a stage with issues", { stageId, taskCount: Number(cards.count) });
    }
    const destination = nextStages.find((stage) => stage.stageId === removal?.destinationStageId);
    if (removal?.destinationStageId && !destination) {
      throw new ApiError(400, "INVALID_FIELD", "Removal destination must remain in this workflow");
    }
    if (Number(cards?.count ?? 0) > 0 && removal?.destinationStageId && !destination.active) {
      throw new ApiError(400, "INVALID_STAGE", "Removal destination must be an active stage in the new workflow");
    }
  }
  if (input.removals.some((removal) => !removed.includes(removal.stageId))) {
    throw new ApiError(400, "INVALID_FIELD", "A removal must name a stage removed from the definition");
  }
  const timestamp = now();
  const statements = [];
  for (const removal of input.removals) {
    statements.push(env.DB.prepare(
      "UPDATE tasks SET stage_id = ?, status = (SELECT canonical_status FROM workflow_stages WHERE id = ?), version = version + 1, updated_at = ? WHERE project_id = ? AND stage_id = ?",
    ).bind(removal.destinationStageId, removal.destinationStageId, timestamp, projectId, removal.stageId));
  }
  if (removed.length > 0) {
    statements.push(env.DB.prepare(`DELETE FROM workflow_stages WHERE project_id = ? AND id IN (${removed.map(() => "?").join(", ")})`).bind(projectId, ...removed));
  }
  statements.push(env.DB.prepare(
    "UPDATE workflow_stages SET sort_order = sort_order + 2000000, updated_at = ? WHERE project_id = ?",
  ).bind(timestamp, projectId));
  statements.push(env.DB.prepare(
    "UPDATE workflow_stages SET is_default_for_status = 0, updated_at = ? WHERE project_id = ?",
  ).bind(timestamp, projectId));
  for (const stage of nextStages) {
    statements.push(env.DB.prepare(`INSERT INTO workflow_stages (id, project_id, canonical_status, name, sort_order, board_visible, active, is_default_for_status, terminal_kind, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET canonical_status = excluded.canonical_status, name = excluded.name, sort_order = excluded.sort_order, board_visible = excluded.board_visible, active = excluded.active, is_default_for_status = excluded.is_default_for_status, terminal_kind = excluded.terminal_kind, updated_at = excluded.updated_at
      WHERE workflow_stages.project_id = excluded.project_id`).bind(stage.stageId, projectId, stage.canonicalStatus, stage.name, stage.order, stage.boardVisible ? 1 : 0, stage.active ? 1 : 0, stage.isDefaultForStatus ? 1 : 0, stage.terminalKind, timestamp, timestamp));
  }
  statements.push(current
    ? env.DB.prepare("UPDATE project_stage_workflows SET version = version + 1, updated_at = ? WHERE project_id = ? AND version = ?").bind(timestamp, projectId, input.version)
    : env.DB.prepare("INSERT INTO project_stage_workflows (project_id, version, updated_at) VALUES (?, 1, ?)").bind(projectId, timestamp));
  const results = await env.DB.batch(statements);
  if (!changed(results.at(-1))) throw new ApiError(409, "VERSION_CONFLICT", "Stage workflow was changed by another client", { expectedVersion: input.version, actualVersion: (await env.DB.prepare("SELECT version FROM project_stage_workflows WHERE project_id = ?").bind(projectId).first())?.version ?? 0 });
  return getStageWorkflow(env, projectId);
}

async function listTaskActivities(env, taskId) {
  const task = await requireTaskRow(env, taskId);
  const rows = await all(env.DB.prepare(`
    SELECT * FROM task_activities
    WHERE task_id = ?
    ORDER BY created_at, id
  `).bind(task.id));
  return rows.map(taskActivityFromRow);
}

async function listComments(env, taskId) {
  const task = await requireTaskRow(env, taskId);
  const rows = await all(env.DB.prepare(`
    SELECT * FROM comments
    WHERE task_id = ?
    ORDER BY created_at, id
  `).bind(task.id));
  return {
    comments: await Promise.all(rows.map((row) => hydrateComment(env, row))),
    nextCursor: nextCursor(rows, null),
  };
}

async function listCommentsAfter(env, taskId, after) {
  const task = await requireTaskRow(env, taskId);
  const rows = await all(env.DB.prepare(`
    SELECT * FROM comments
    WHERE task_id = ?
      AND change_revision > ?
    ORDER BY change_revision
  `).bind(task.id, after.revision));
  return {
    comments: await Promise.all(rows.map((row) => hydrateComment(env, row))),
    nextCursor: nextCursor(rows, after),
  };
}

async function createComment(env, taskId, input, actor) {
  const task = await requireTaskRow(env, taskId);
  const id = uuid();
  const timestamp = now();
  await env.DB.prepare(`
    INSERT INTO comments (
      id, task_id, body, thread_id, thread_codex_project_id, thread_codex_project_kind,
      thread_codex_host_id, thread_workspace_path, author_type, author_id, author_name,
      author_avatar_url, version, created_at, updated_at, change_revision
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?,
      (SELECT revision + 1 FROM global_revision WHERE singleton = 1))
  `).bind(
    id,
    task.id,
    input.body,
    ...(storedThreadBinding(input.threadBinding, input.threadId) ?? [null, null, null, null, null]),
    actor.type,
    actor.id,
    actor.name,
    actor.avatarUrl,
    timestamp,
    timestamp,
  ).run();
  const row = await env.DB.prepare("SELECT * FROM comments WHERE id = ?").bind(id).first();
  return hydrateComment(env, row);
}

async function requireCommentRow(env, id) {
  const row = await env.DB.prepare("SELECT * FROM comments WHERE id = ?").bind(id).first();
  if (!row) {
    throw new ApiError(404, "COMMENT_NOT_FOUND", `Comment '${id}' does not exist`);
  }
  return row;
}

function assertCommentVersion(row, expectedVersion) {
  if (row.version !== expectedVersion) {
    throw new ApiError(
      409,
      "VERSION_CONFLICT",
      "Comment was changed by another client",
      { expectedVersion, actualVersion: row.version },
    );
  }
}

async function updateComment(env, id, input) {
  const current = await requireCommentRow(env, id);
  assertCommentVersion(current, input.version);
  const storedBinding = storedThreadBinding(input.threadBinding, input.threadId);
  const threadAssignment = storedBinding
    ? `thread_id = ?, thread_codex_project_id = ?, thread_codex_project_kind = ?,
      thread_codex_host_id = ?, thread_workspace_path = ?,`
    : "";
  const result = await env.DB.prepare(`
    UPDATE comments
    SET
      body = ?,
      ${threadAssignment}
      version = version + 1,
      updated_at = ?,
      change_revision = (SELECT revision + 1 FROM global_revision WHERE singleton = 1)
    WHERE id = ? AND version = ?
  `).bind(
    input.body,
    ...(storedBinding ?? []),
    now(),
    current.id,
    input.version,
  ).run();
  if (!changed(result)) {
    const latest = await requireCommentRow(env, current.id);
    throw new ApiError(
      409,
      "VERSION_CONFLICT",
      "Comment was changed by another client",
      { expectedVersion: input.version, actualVersion: latest.version },
    );
  }
  const row = await requireCommentRow(env, current.id);
  return hydrateComment(env, row);
}

async function deleteComment(env, id, expectedVersion) {
  const current = await requireCommentRow(env, id);
  assertCommentVersion(current, expectedVersion);
  const attachments = await attachmentsForComment(env, current.id);
  const result = await env.DB.prepare(`
    DELETE FROM comments WHERE id = ? AND version = ?
  `).bind(current.id, expectedVersion).run();
  if (!changed(result)) {
    const latest = await requireCommentRow(env, current.id);
    throw new ApiError(
      409,
      "VERSION_CONFLICT",
      "Comment was changed by another client",
      { expectedVersion, actualVersion: latest.version },
    );
  }
  await Promise.all(attachments.map((attachment) => env.ATTACHMENTS.delete(attachment.id)));
}

async function listTaskAttachments(env, taskId, after) {
  const task = await requireTaskRow(env, taskId);
  const rows = after
    ? await all(env.DB.prepare(`
      SELECT * FROM attachments
      WHERE task_id = ? AND comment_id IS NULL
        AND change_revision > ?
      ORDER BY change_revision
    `).bind(task.id, after.revision))
    : await all(env.DB.prepare(`
      SELECT * FROM attachments
      WHERE task_id = ? AND comment_id IS NULL
      ORDER BY created_at, id
    `).bind(task.id));
  return {
    attachments: rows.map(attachmentFromRow),
    nextCursor: nextCursor(rows, after),
  };
}

async function listCommentAttachments(env, commentId, after) {
  await requireCommentRow(env, commentId);
  const rows = after
    ? await all(env.DB.prepare(`
      SELECT * FROM attachments
      WHERE comment_id = ?
        AND change_revision > ?
      ORDER BY change_revision
    `).bind(commentId, after.revision))
    : await all(env.DB.prepare(`
      SELECT * FROM attachments
      WHERE comment_id = ?
      ORDER BY created_at, id
    `).bind(commentId));
  return {
    attachments: rows.map(attachmentFromRow),
    nextCursor: nextCursor(rows, after),
  };
}

async function uploadAttachment(env, ownerType, ownerId, request) {
  let taskId;
  let commentId = null;
  if (ownerType === "task") {
    taskId = (await requireTaskRow(env, ownerId)).id;
  } else {
    const comment = await requireCommentRow(env, ownerId);
    taskId = comment.task_id;
    commentId = comment.id;
  }
  const metadata = parseAttachmentHeaders(request);
  const body = await readAttachment(request);
  const id = uuid();
  await env.ATTACHMENTS.put(id, body, {
    httpMetadata: { contentType: metadata.contentType },
  });
  try {
    await env.DB.prepare(`
      INSERT INTO attachments (
        id, task_id, comment_id, kind, filename, content_type, size, created_at, change_revision
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?,
        (SELECT revision + 1 FROM global_revision WHERE singleton = 1))
    `).bind(
      id,
      taskId,
      commentId,
      metadata.kind,
      metadata.filename,
      metadata.contentType,
      body.byteLength,
      now(),
    ).run();
  } catch (error) {
    await env.ATTACHMENTS.delete(id);
    throw error;
  }
  const row = await env.DB.prepare("SELECT * FROM attachments WHERE id = ?").bind(id).first();
  return attachmentFromRow(row);
}

async function uploadProjectReadmeAttachment(env, projectId, request) {
  await requireProject(env, projectId);
  const metadata = parseAttachmentHeaders(request);
  if (metadata.kind !== "inline") {
    throw new ApiError(
      400,
      "INVALID_ATTACHMENT_KIND",
      "Project README attachments must be inline",
    );
  }
  const body = await readAttachment(request);
  const id = uuid();
  await env.ATTACHMENTS.put(id, body, {
    httpMetadata: { contentType: metadata.contentType },
  });
  try {
    await env.DB.prepare(`
      INSERT INTO project_readme_attachments (
        id, project_id, filename, content_type, size, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).bind(
      id,
      projectId,
      metadata.filename,
      metadata.contentType,
      body.byteLength,
      now(),
    ).run();
  } catch (error) {
    await env.ATTACHMENTS.delete(id);
    throw error;
  }
  const row = await env.DB.prepare(
    "SELECT * FROM project_readme_attachments WHERE id = ?",
  ).bind(id).first();
  return projectReadmeAttachmentFromRow(row);
}

async function requireAttachment(env, id) {
  const row = await env.DB.prepare("SELECT * FROM attachments WHERE id = ?").bind(id).first();
  if (row) return attachmentFromRow(row);
  const projectReadmeRow = await env.DB.prepare(
    "SELECT * FROM project_readme_attachments WHERE id = ?",
  ).bind(id).first();
  if (projectReadmeRow) return projectReadmeAttachmentFromRow(projectReadmeRow);
  throw new ApiError(404, "ATTACHMENT_NOT_FOUND", `Attachment '${id}' does not exist`);
}

async function deleteAttachment(env, id) {
  const attachment = await requireAttachment(env, id);
  if (attachment.projectId) {
    await env.DB.prepare(
      "DELETE FROM project_readme_attachments WHERE id = ?",
    ).bind(attachment.id).run();
  } else {
    await env.DB.prepare("DELETE FROM attachments WHERE id = ?").bind(attachment.id).run();
  }
  await env.ATTACHMENTS.delete(attachment.id);
  return attachment;
}

function requireNoQuery(url, routeName) {
  if ([...url.searchParams.keys()].length > 0) {
    throw new ApiError(
      400,
      "UNKNOWN_QUERY_PARAMETER",
      `${routeName} does not accept query parameters`,
    );
  }
}

function decodePathPart(value, label) {
  let decoded;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    throw new ApiError(400, "INVALID_PATH", `${label} contains invalid encoding`);
  }
  if (decoded.length === 0 || decoded.length > 128) {
    throw new ApiError(400, "INVALID_PATH", `${label} is invalid`);
  }
  return decoded;
}

async function readGlobalRevision(env) {
  return env.DB.prepare(`
    SELECT revision FROM global_revision WHERE singleton = 1
  `).first("revision");
}

function realtimeHub(env) {
  return env.REALTIME_HUB.get(env.REALTIME_HUB.idFromName(REALTIME_HUB_NAME));
}

async function broadcastRevision(env, revision) {
  const response = await realtimeHub(env).fetch("https://realtime.internal/broadcast", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ revision }),
  });
  if (!response.ok) throw new Error(`Realtime broadcast failed (${response.status})`);
}

async function attachmentContent(env, id, request, download = false) {
  const attachment = await requireAttachment(env, id);
  const object = await env.ATTACHMENTS.get(attachment.id);
  if (!object) {
    throw new ApiError(
      404,
      "ATTACHMENT_NOT_FOUND",
      `Attachment '${id}' does not exist`,
    );
  }
  const encodedFilename = encodeURIComponent(attachment.filename).replace(
    /['()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  const canOpenInline = !download && INLINE_ATTACHMENT_TYPES.has(attachment.contentType);
  return new Response(request.method === "HEAD" ? null : object.body, {
    status: 200,
    headers: {
      "cache-control": "private, no-store",
      "content-disposition": `${
        canOpenInline ? "inline" : "attachment"
      }; filename*=UTF-8''${encodedFilename}`,
      "content-length": String(attachment.size),
      "content-security-policy": "sandbox; default-src 'none'",
      "content-type": canOpenInline
        ? attachment.contentType
        : "application/octet-stream",
    },
  });
}

async function routeApi(request, env, actor, url) {
  const { pathname } = url;

  if (pathname === "/api/meta") {
    if (request.method !== "GET") methodNotAllowed(["GET"]);
    requireNoQuery(url, "GET /api/meta");
    return json(200, {
      mode: "cloud",
      manageTaskboardSkillPath: null,
      realtime: {
        transport: "websocket",
        endpoint: "/api/events",
      },
      localCapabilities: { available: false },
    });
  }

  if (pathname === "/api/revisions") {
    if (request.method !== "GET") methodNotAllowed(["GET"]);
    const unknown = [...url.searchParams.keys()].filter((key) => key !== "since");
    if (unknown.length > 0) {
      throw new ApiError(
        400,
        "UNKNOWN_QUERY_PARAMETER",
        `Unknown query parameter: ${unknown[0]}`,
      );
    }
    if (url.searchParams.getAll("since").length !== 1) {
      throw new ApiError(
        400,
        "INVALID_QUERY_PARAMETER",
        "'since' must be provided once",
      );
    }
    const rawSince = url.searchParams.get("since");
    if (!/^\d+$/.test(rawSince ?? "")) {
      throw new ApiError(
        400,
        "INVALID_QUERY_PARAMETER",
        "'since' must be a non-negative integer",
      );
    }
    const since = Number(rawSince);
    if (!Number.isSafeInteger(since)) {
      throw new ApiError(
        400,
        "INVALID_QUERY_PARAMETER",
        "'since' must be a non-negative integer",
      );
    }
    const revision = await readGlobalRevision(env);
    return json(200, { changed: revision > since, revision });
  }

  if (
    pathname === "/api/device-workspaces"
    || /^\/api\/projects\/[^/]+\/development-contexts$/.test(pathname)
  ) {
    if (request.method !== "GET") methodNotAllowed(["GET"]);
    throw new ApiError(
      409,
      "LOCAL_COMPANION_REQUIRED",
      "This capability requires the local Codex companion",
    );
  }

  if (pathname === "/api/events") {
    if (request.method !== "GET") methodNotAllowed(["GET"]);
    requireNoQuery(url, "GET /api/events");
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      throw new ApiError(426, "WEBSOCKET_REQUIRED", "A WebSocket upgrade is required");
    }
    return realtimeHub(env).fetch(new Request("https://realtime.internal/connect", request));
  }

  if (pathname === "/api/projects") {
    if (request.method === "GET") {
      requireNoQuery(url, "GET /api/projects");
      return json(200, { projects: await listProjects(env) });
    }
    if (request.method === "POST") {
      return json(201, {
        project: await createProject(env, parseProjectCreate(await readJson(request))),
      });
    }
    methodNotAllowed(["GET", "POST"]);
  }

  const projectMatch = pathname.match(/^\/api\/projects\/([^/]+)$/);
  if (projectMatch) {
    requireNoQuery(url, "Project routes");
    const projectId = validateProjectId(decodePathPart(projectMatch[1], "Project id"));
    if (request.method !== "DELETE") methodNotAllowed(["DELETE"]);
    await deleteProject(env, projectId);
    return empty(204);
  }

  const projectLabelsMatch = pathname.match(/^\/api\/projects\/([^/]+)\/labels$/);
  if (projectLabelsMatch) {
    requireNoQuery(url, "Project label routes");
    const projectId = validateProjectId(
      decodePathPart(projectLabelsMatch[1], "Project id"),
    );
    if (request.method !== "POST" && request.method !== "DELETE") {
      methodNotAllowed(["POST", "DELETE"]);
    }
    const label = parseProjectLabel(await readJson(request));
    const project = request.method === "POST"
      ? await addProjectLabel(env, projectId, label)
      : await deleteProjectLabel(env, projectId, label);
    return json(200, { project });
  }

  const stageWorkflowMatch = pathname.match(
    /^\/api\/projects\/([^/]+)\/stage-workflow$/,
  );
  if (stageWorkflowMatch) {
    requireNoQuery(url, "Stage workflow routes");
    const projectId = validateProjectId(decodePathPart(stageWorkflowMatch[1], "Project id"));
    if (request.method === "GET") return json(200, { stageWorkflow: await getStageWorkflow(env, projectId) });
    if (request.method === "PUT") return json(200, {
      stageWorkflow: await saveStageWorkflow(env, projectId, parseStageWorkflowSave(await readJson(request))),
    });
    methodNotAllowed(["GET", "PUT"]);
  }

  const projectReadmeAttachmentsMatch = pathname.match(
    /^\/api\/projects\/([^/]+)\/readme\/attachments$/,
  );
  if (projectReadmeAttachmentsMatch) {
    requireNoQuery(url, "Project README attachment routes");
    const projectId = validateProjectId(
      decodePathPart(projectReadmeAttachmentsMatch[1], "Project id"),
    );
    if (request.method !== "POST") methodNotAllowed(["POST"]);
    return json(201, {
      attachment: await uploadProjectReadmeAttachment(env, projectId, request),
    });
  }

  const projectReadmeMatch = pathname.match(
    /^\/api\/projects\/([^/]+)\/readme$/,
  );
  if (projectReadmeMatch) {
    requireNoQuery(url, "Project README routes");
    const projectId = validateProjectId(
      decodePathPart(projectReadmeMatch[1], "Project id"),
    );
    if (request.method === "GET") {
      return json(200, { readme: await getProjectReadme(env, projectId) });
    }
    if (request.method === "PUT") {
      const body = await readJson(
        request,
        PROJECT_README_BODY_LIMIT,
        "Project README request cannot exceed 3 MiB",
      );
      assertPlainObject(body);
      assertAllowedKeys(body, new Set(["version", "content"]));
      const version = body.version === undefined
        ? undefined
        : parseVersion(body.version, { allowZero: true });
      const content = body.content ?? "";
      if (typeof content !== "string") {
        throw new ApiError(400, "INVALID_FIELD", "'content' must be a string");
      }
      if (content.length > 500_000) {
        throw new ApiError(400, "INVALID_FIELD", "'content' cannot exceed 500000 characters");
      }
      return json(200, {
        readme: await saveProjectReadme(env, projectId, content, version),
      });
    }
    methodNotAllowed(["GET", "PUT"]);
  }

  if (pathname === "/api/tasks") {
    if (request.method === "GET") {
      return json(200, {
        tasks: await listTasks(env, parseTaskFilters(url.searchParams)),
      });
    }
    if (request.method === "POST") {
      return json(201, {
        task: await createTask(env, parseTaskCreate(await readJson(request)), actor),
      });
    }
    methodNotAllowed(["GET", "POST"]);
  }

  const taskTreeMatch = pathname.match(/^\/api\/tasks\/([^/]+)\/tree$/);
  if (taskTreeMatch) {
    if (request.method !== "GET") methodNotAllowed(["GET"]);
    const taskId = decodePathPart(taskTreeMatch[1], "Task id");
    const { direction, depth } = parseTaskTreeQuery(url.searchParams);
    return json(200, { tree: await getTaskTree(env, taskId, direction, depth) });
  }

  const taskRollupMatch = pathname.match(/^\/api\/tasks\/([^/]+)\/rollup$/);
  if (taskRollupMatch) {
    if (request.method !== "GET") methodNotAllowed(["GET"]);
    requireNoQuery(url, "Task rollup routes");
    const taskId = decodePathPart(taskRollupMatch[1], "Task id");
    return json(200, { rollup: await getTaskRollup(env, taskId) });
  }

  const nestedWorkspaceMatch = pathname.match(/^\/api\/tasks\/([^/]+)\/workspace$/);
  if (nestedWorkspaceMatch) {
    if (request.method !== "GET") methodNotAllowed(["GET"]);
    const taskId = decodePathPart(nestedWorkspaceMatch[1], "Task id");
    const options = parseNestedWorkspaceQuery(
      url.searchParams,
      (code, message) => new ApiError(400, code, message),
    );
    return json(200, { workspace: await getNestedWorkspace(env, taskId, options) });
  }

  const taskTransitionMatch = pathname.match(/^\/api\/tasks\/([^/]+)\/transitions$/);
  if (taskTransitionMatch) {
    requireNoQuery(url, "Transition routes");
    if (request.method !== "POST") methodNotAllowed(["POST"]);
    const taskId = decodePathPart(taskTransitionMatch[1], "Task id");
    const command = parseTransition(
      await readJson(request),
      request.headers.get("idempotency-key"),
    );
    return json(200, await transitionTask(env, taskId, command, actor));
  }

  const taskEvidenceMatch = pathname.match(/^\/api\/tasks\/([^/]+)\/evidence$/);
  if (taskEvidenceMatch) {
    requireNoQuery(url, "Human evidence routes");
    if (request.method !== "POST") methodNotAllowed(["POST"]);
    const taskId = decodePathPart(taskEvidenceMatch[1], "Task id");
    const command = parseHumanEvidenceRegistration(
      await readJson(request),
      request.headers.get("idempotency-key"),
    );
    return json(201, await registerHumanAcceptanceEvidence(request, env, taskId, command, actor));
  }

  const taskEvidenceRevocationMatch = pathname.match(/^\/api\/tasks\/([^/]+)\/evidence\/([^/]+)\/revoke$/);
  if (taskEvidenceRevocationMatch) {
    requireNoQuery(url, "Human evidence revocation routes");
    if (request.method !== "POST") methodNotAllowed(["POST"]);
    const taskId = decodePathPart(taskEvidenceRevocationMatch[1], "Task id");
    const evidenceId = decodePathPart(taskEvidenceRevocationMatch[2], "Evidence id");
    if (!TRANSITION_UUID.test(evidenceId)) throw new ApiError(400, "INVALID_FIELD", "Evidence id must be a UUID");
    const command = parseHumanEvidenceRevocation(
      await readJson(request),
      request.headers.get("idempotency-key"),
    );
    return json(200, await revokeHumanAcceptanceEvidence(request, env, taskId, evidenceId, command, actor));
  }

  const relationMatch = pathname.match(
    /^\/api\/tasks\/([^/]+)\/relations\/([^/]+)\/([^/]+)$/,
  );
  if (relationMatch) {
    requireNoQuery(url, "Issue relation routes");
    const taskId = decodePathPart(relationMatch[1], "Task id");
    const type = decodePathPart(relationMatch[2], "Relation type");
    const relatedTaskId = decodePathPart(relationMatch[3], "Related task id");
    const input = parseRelationMutation(await readJson(request), type, request.method);
    if (request.method === "POST") {
      return json(200, await addRelation(env, taskId, type, relatedTaskId, input, actor));
    }
    if (request.method === "DELETE") {
      return json(200, await removeRelation(env, taskId, type, relatedTaskId, input, actor));
    }
    if (request.method === "PATCH") {
      return json(200, await updateRelation(env, taskId, type, relatedTaskId, input, actor));
    }
    methodNotAllowed(["POST", "PATCH", "DELETE"]);
  }

  const taskActivitiesMatch = pathname.match(/^\/api\/tasks\/([^/]+)\/activities$/);
  if (taskActivitiesMatch) {
    requireNoQuery(url, "Activity routes");
    const taskId = decodePathPart(taskActivitiesMatch[1], "Task id");
    if (request.method === "GET") {
      return json(200, { activities: await listTaskActivities(env, taskId) });
    }
    methodNotAllowed(["GET"]);
  }

  const taskCommentsMatch = pathname.match(/^\/api\/tasks\/([^/]+)\/comments$/);
  if (taskCommentsMatch) {
    const taskId = decodePathPart(taskCommentsMatch[1], "Task id");
    if (request.method === "GET") {
      const after = parseAfterCursor(url.searchParams);
      return json(200, after
        ? await listCommentsAfter(env, taskId, after)
        : await listComments(env, taskId));
    }
    requireNoQuery(url, "Comment routes");
    if (request.method === "POST") {
      return json(201, {
        comment: await createComment(
          env,
          taskId,
          parseCommentCreate(await readJson(request)),
          actor,
        ),
      });
    }
    methodNotAllowed(["GET", "POST"]);
  }

  const commentAttachmentsMatch = pathname.match(
    /^\/api\/comments\/([^/]+)\/attachments$/,
  );
  if (commentAttachmentsMatch) {
    const commentId = decodePathPart(commentAttachmentsMatch[1], "Comment id");
    if (request.method === "GET") {
      return json(
        200,
        await listCommentAttachments(env, commentId, parseAfterCursor(url.searchParams)),
      );
    }
    requireNoQuery(url, "Attachment routes");
    if (request.method === "POST") {
      return json(201, {
        attachment: await uploadAttachment(env, "comment", commentId, request),
      });
    }
    methodNotAllowed(["GET", "POST"]);
  }

  const commentMatch = pathname.match(/^\/api\/comments\/([^/]+)$/);
  if (commentMatch) {
    requireNoQuery(url, "Comment routes");
    const commentId = decodePathPart(commentMatch[1], "Comment id");
    if (request.method === "PATCH") {
      return json(200, {
        comment: await updateComment(
          env,
          commentId,
          parseCommentPatch(await readJson(request)),
        ),
      });
    }
    if (request.method === "DELETE") {
      const { version } = parseVersionMutation(await readJson(request));
      await deleteComment(env, commentId, version);
      return empty(204);
    }
    methodNotAllowed(["PATCH", "DELETE"]);
  }

  const taskAttachmentsMatch = pathname.match(
    /^\/api\/tasks\/([^/]+)\/attachments$/,
  );
  if (taskAttachmentsMatch) {
    const taskId = decodePathPart(taskAttachmentsMatch[1], "Task id");
    if (request.method === "GET") {
      return json(200, await listTaskAttachments(env, taskId, parseAfterCursor(url.searchParams)));
    }
    requireNoQuery(url, "Attachment routes");
    if (request.method === "POST") {
      return json(201, {
        attachment: await uploadAttachment(env, "task", taskId, request),
      });
    }
    methodNotAllowed(["GET", "POST"]);
  }

  const attachmentContentMatch = pathname.match(
    /^\/api\/attachments\/([^/]+)\/(content|download)$/,
  );
  if (attachmentContentMatch) {
    requireNoQuery(url, "Attachment routes");
    if (!["GET", "HEAD"].includes(request.method)) methodNotAllowed(["GET", "HEAD"]);
    return attachmentContent(
      env,
      decodePathPart(attachmentContentMatch[1], "Attachment id"),
      request,
      attachmentContentMatch[2] === "download",
    );
  }

  const attachmentMatch = pathname.match(/^\/api\/attachments\/([^/]+)$/);
  if (attachmentMatch) {
    requireNoQuery(url, "Attachment routes");
    if (request.method !== "DELETE") methodNotAllowed(["DELETE"]);
    await deleteAttachment(
      env,
      decodePathPart(attachmentMatch[1], "Attachment id"),
    );
    return empty(204);
  }

  const taskMatch = pathname.match(
    /^\/api\/tasks\/([^/]+)(?:\/(archive|restore|move))?$/,
  );
  if (taskMatch) {
    const taskId = decodePathPart(taskMatch[1], "Task id");
    const action = taskMatch[2];
    requireNoQuery(url, "Task routes");
    if (!action && request.method === "GET") {
      const task = await getTask(env, taskId);
      if (!task) {
        throw new ApiError(404, "TASK_NOT_FOUND", `Task '${taskId}' does not exist`);
      }
      return json(200, { task });
    }
    if (!action && request.method === "PATCH") {
      const input = parseTaskPatch(await readJson(request));
      const changesWorkflowState = Object.hasOwn(input.changes, "status") || Object.hasOwn(input.changes, "stageId");
      if (Object.hasOwn(input.changes, "projectId")) {
        const targetProject = await requireProject(env, input.changes.projectId);
        const current = await requireTaskRow(env, taskId);
        if (targetProject.id !== current.project_id) {
          if (changesWorkflowState) {
            throw new ApiError(409, "TRANSITION_REQUIRED", "Project moves cannot be combined with status or stage changes; record the transition separately");
          }
          throw new ApiError(409, "PROJECT_MOVE_UNAVAILABLE", "Cross-project moves are unavailable while a task is pinned to its project workflow");
        }
        if (changesWorkflowState) {
          throw new ApiError(409, "TRANSITION_REQUIRED", "Legacy status or stage changes must not be combined with project updates");
        }
      }
      if (changesWorkflowState) {
        const otherChanges = Object.keys(input.changes).filter((field) => field !== "status" && field !== "stageId");
        if (otherChanges.length || input.assigneeTarget !== undefined || input.threadId !== undefined || input.threadBinding !== undefined) {
          throw new ApiError(409, "TRANSITION_REQUIRED", "Legacy status or stage changes must be sent alone so TransitionService can record one atomic transition");
        }
        const current = await requireTaskRow(env, taskId);
        const target = await resolveStageForTask(env, current.project_id, {
          status: input.changes.status ?? taskFromRow(current).status,
          stageId: input.changes.stageId,
        });
        if (target.stageId === current.stage_id) throw transitionError("ACTION_NOT_FOUND", "Legacy transition must change the task stage");
        const idempotencyKey = await legacyTransitionIdempotencyKey({ taskId: current.id, version: input.version, status: target.status, stageId: target.stageId });
        const context = await transitionContext(env, current.id);
        const rule = await env.DB.prepare(`SELECT action_key FROM workflow_transition_rules
          WHERE revision_id = ? AND from_task_stage_id = ? AND to_task_stage_id = ? AND legacy = 1`).bind(context.pin.revision_id, current.stage_id, target.stageId).first();
        if (!rule) throw transitionError("ACTION_NOT_FOUND", "Legacy transition is not defined by the pinned workflow");
        const result = await transitionTask(env, current.id, { expectedStateVersion: input.version, actionKey: rule.action_key, gateEvidence: [], authorizationId: null, idempotencyKey }, actor);
        return json(200, { ...result, legacy: true });
      }
      return json(200, {
        task: await updateTask(env, taskId, input, actor),
      });
    }
    if (!action && request.method === "DELETE") {
      const { version } = parseVersionMutation(await readJson(request));
      await deleteArchivedTask(env, taskId, version);
      return empty(204);
    }
    if (action === "move" && request.method === "POST") {
      const input = parseMove(await readJson(request));
      const current = await requireTaskRow(env, taskId);
      const target = await resolveStageForTask(env, current.project_id, input);
      if (target.stageId === current.stage_id) throw transitionError("ACTION_NOT_FOUND", "Legacy transition must change the task stage");
      const idempotencyKey = await legacyTransitionIdempotencyKey({ taskId: current.id, version: input.version, status: target.status, stageId: target.stageId, sortOrder: input.sortOrder });
      const context = await transitionContext(env, current.id);
      const rule = await env.DB.prepare(`SELECT action_key FROM workflow_transition_rules
        WHERE revision_id = ? AND from_task_stage_id = ? AND to_task_stage_id = ? AND legacy = 1`).bind(context.pin.revision_id, current.stage_id, target.stageId).first();
      if (!rule) throw transitionError("ACTION_NOT_FOUND", "Legacy transition is not defined by the pinned workflow");
      const result = await transitionTask(env, current.id, { expectedStateVersion: input.version, actionKey: rule.action_key, gateEvidence: [], authorizationId: null, idempotencyKey }, actor, { sortOrder: input.sortOrder, threadId: input.threadId, threadBinding: input.threadBinding });
      return json(200, { ...result, legacy: true });
    }
    if (action === "archive" && request.method === "POST") {
      return json(200, {
        task: await archiveTask(
          env,
          taskId,
          parseVersionMutation(await readJson(request)),
          actor,
        ),
      });
    }
    if (action === "restore" && request.method === "POST") {
      return json(200, {
        task: await restoreTask(
          env,
          taskId,
          parseVersionMutation(await readJson(request)),
          actor,
        ),
      });
    }
    methodNotAllowed(action ? ["POST"] : ["GET", "PATCH", "DELETE"]);
  }

  throw new ApiError(404, "NOT_FOUND", "API route not found");
}

function withSecurityHeaders(response) {
  if (response.status === 101) return response;
  const secured = new Response(response.body, response);
  secured.headers.set("x-content-type-options", "nosniff");
  secured.headers.set("referrer-policy", "no-referrer");
  return secured;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    try {
      if (url.pathname === "/health") {
        if (request.method !== "GET") methodNotAllowed(["GET"]);
        return withSecurityHeaders(json(200, { status: "ok" }));
      }

      const authentication = await authenticate(request, env);
      if (!authentication) return withSecurityHeaders(unauthorized());

      let response = url.pathname.startsWith("/api/")
        ? await routeApi(request, env, authentication.actor, url)
        : env.ASSETS
          ? await env.ASSETS.fetch(request)
          : json(404, { error: { code: "NOT_FOUND", message: "Resource not found" } });
      if (authentication.sessionCookie && response.status !== 101) {
        response = new Response(response.body, response);
        response.headers.append("set-cookie", authentication.sessionCookie);
      }
      if (
        response.ok
        && env.REALTIME_HUB
        && url.pathname.startsWith("/api/")
        && !["GET", "HEAD", "OPTIONS"].includes(request.method)
      ) {
        const revision = await readGlobalRevision(env);
        ctx.waitUntil(broadcastRevision(env, revision).catch((error) => console.error(error)));
      }
      return withSecurityHeaders(response);
    } catch (error) {
      if (error instanceof ApiError) {
        const payload = {
          error: { code: error.code, message: error.message },
        };
        if (error.details !== undefined) payload.error.details = error.details;
        const headers = error.status === 405 && error.details?.allowed
          ? { allow: error.details.allowed.join(", ") }
          : {};
        return withSecurityHeaders(json(error.status, payload, headers));
      }
      console.error(error);
      return withSecurityHeaders(json(500, {
        error: { code: "INTERNAL_ERROR", message: "Internal server error" },
      }));
    }
  },
};
