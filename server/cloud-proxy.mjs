import path from "node:path";

import { DEFAULT_PROJECT_ID } from "../shared/domain.mjs";
import { normalizeCloudUrl } from "./cloud-config.mjs";

const LOCAL_COMPANION_ROUTES = new Set([
  "/health",
  "/api/meta",
  "/api/device-workspaces",
  "/api/local/cloud-session",
]);

const DEVICE_LOCAL_FIELD_NAMES = new Set([
  "workspacePath",
  "codexHostId",
  "workspace_path",
  "codex_host_id",
  "thread_workspace_path",
  "thread_codex_host_id",
  "workspace-path",
  "codex-host-id",
]);

export class CloudProxyError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.name = "CloudProxyError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function isLocalCompanionRoute(pathname) {
  return LOCAL_COMPANION_ROUTES.has(pathname)
    || pathname.startsWith("/api/local/")
    || /^\/api\/projects\/[^/]+\/development-contexts$/.test(pathname);
}

function basicAuthorization(actorName, sharedKey) {
  return `Basic ${Buffer.from(`${actorName}:${sharedKey}`, "utf8").toString("base64")}`;
}

function isCompleteLocalThreadBinding(value) {
  return value
    && typeof value === "object"
    && typeof value.threadId === "string"
    && typeof value.codexProjectId === "string"
    && (value.codexProjectKind === "local" || value.codexProjectKind === "remote")
    && typeof value.codexHostId === "string"
    && typeof value.workspacePath === "string";
}

function stripDeviceLocalFields(value) {
  if (Array.isArray(value)) return value.map(stripDeviceLocalFields);
  if (!value || typeof value !== "object") return value;
  const sanitized = {};
  for (const [key, child] of Object.entries(value)) {
    if (DEVICE_LOCAL_FIELD_NAMES.has(key)) continue;
    sanitized[key] = stripDeviceLocalFields(child);
  }
  return sanitized;
}

async function resolveLocalThreadBinding(threadId, config, resolveThreadBinding) {
  if (typeof threadId !== "string" || !threadId) return null;
  const stored = config?.threadBindings?.[threadId];
  if (isCompleteLocalThreadBinding(stored) && stored.threadId === threadId) return stored;
  if (typeof resolveThreadBinding !== "function") return null;
  const resolved = await resolveThreadBinding(threadId);
  return isCompleteLocalThreadBinding(resolved) && resolved.threadId === threadId
    ? resolved
    : null;
}

async function prepareRequest(request, {
  assertTaskProjectMoveAllowed,
  clearThreadBinding,
  config,
  resolveThreadBinding,
  setThreadBinding,
} = {}) {
  const url = new URL(request.url);
  let projectWorkspace = null;
  let body = request.body;
  const isJson = request.headers.get("content-type")?.includes("application/json");
  const isProjectCreate = request.method === "POST" && url.pathname === "/api/projects";
  const taskPatchMatch = request.method === "PATCH"
    ? url.pathname.match(/^\/api\/tasks\/([^/]+)$/)
    : null;
  const isTaskMutation = (
    (request.method === "POST" && url.pathname === "/api/tasks")
    || Boolean(taskPatchMatch)
  );
  const isConversationMutation = request.method !== "GET"
    && (/^\/api\/tasks(?:\/|$)/.test(url.pathname) || /^\/api\/comments\//.test(url.pathname));
  const localThreadBindings = new Map();

  // Parse and scrub every JSON request before it can leave the companion. The
  // route-specific handling below adds local behavior, but the privacy
  // boundary must not depend on a route allowlist staying current.
  if (isJson) {
    let payload;
    try {
      payload = await request.clone().json();
    } catch {
      throw new CloudProxyError(400, "INVALID_JSON", "Request body must contain valid JSON");
    }
    const isObjectPayload = payload !== null && typeof payload === "object" && !Array.isArray(payload);
    if (
      (isProjectCreate || isTaskMutation || isConversationMutation)
      && !isObjectPayload
    ) {
      throw new CloudProxyError(400, "INVALID_BODY", "Request body must be a JSON object");
    }
    if (isObjectPayload) {
      if (
        taskPatchMatch
        && typeof payload.projectId === "string"
        && typeof assertTaskProjectMoveAllowed === "function"
      ) {
        let taskId;
        try {
          taskId = decodeURIComponent(taskPatchMatch[1]);
        } catch {
          throw new CloudProxyError(400, "INVALID_PATH", "Task id contains invalid encoding");
        }
        await assertTaskProjectMoveAllowed(taskId, payload.projectId);
      }
      if (isProjectCreate && Object.hasOwn(payload, "workspacePath")) {
        if (typeof payload.workspacePath === "string") {
          if (!path.isAbsolute(payload.workspacePath)) {
            throw new CloudProxyError(
              400,
              "INVALID_PROJECT_MAPPING",
              "Project workspacePath must be absolute",
            );
          }
          projectWorkspace = {
            projectId: typeof payload.id === "string" ? payload.id : null,
            workspacePath: payload.workspacePath,
          };
        }
        delete payload.workspacePath;
      }
      if (isTaskMutation && payload.developmentContext?.type === "worktree") {
        payload.developmentContext = {
          type: "worktree",
          ...(payload.developmentContext.branch === undefined
            ? {}
            : { branch: payload.developmentContext.branch }),
        };
      }
      if (isConversationMutation) {
        const explicitBinding = payload.threadBinding;
        let localBinding = null;
        if (isCompleteLocalThreadBinding(explicitBinding)) {
          localBinding = explicitBinding;
        } else if (
          !Object.hasOwn(payload, "threadBinding")
          && typeof payload.threadId === "string"
        ) {
          localBinding = await resolveLocalThreadBinding(
            payload.threadId,
            config,
            resolveThreadBinding,
          );
        }

        if (localBinding) {
          if (typeof setThreadBinding !== "function") {
            throw new CloudProxyError(
              500,
              "LOCAL_THREAD_BINDING_UNAVAILABLE",
              "Local thread binding storage is unavailable",
            );
          }
          await setThreadBinding(localBinding);
          localThreadBindings.set(localBinding.threadId, localBinding);
          // The Cloud contract retains only the opaque thread identifier. The
          // complete identity remains in the local companion configuration.
          payload.threadId = localBinding.threadId;
          delete payload.threadBinding;
        } else if (explicitBinding === null) {
          if (typeof payload.threadId === "string" && typeof clearThreadBinding === "function") {
            await clearThreadBinding(payload.threadId);
          }
        } else if (Object.hasOwn(payload, "threadBinding")) {
          const threadId = explicitBinding?.threadId;
          if (typeof threadId === "string") payload.threadId = threadId;
          delete payload.threadBinding;
        }
      }
    }
    body = JSON.stringify(stripDeviceLocalFields(payload));
  }

  return { body, projectWorkspace, localThreadBindings };
}

async function localizeThreadReference(reference, resolveThreadBinding) {
  if (!reference || typeof reference !== "object") return reference;
  const {
    codexProjectId,
    codexProjectKind,
    codexHostId,
    workspacePath,
    threadBinding,
    legacyLocal,
    ...safeReference
  } = reference;
  void codexProjectId;
  void codexProjectKind;
  void codexHostId;
  void workspacePath;
  void threadBinding;
  void legacyLocal;
  const threadId = typeof safeReference.threadId === "string"
    ? safeReference.threadId
    : null;
  const localBinding = await resolveThreadBinding(threadId);
  if (localBinding) return { ...safeReference, ...localBinding };
  return threadId
    ? { ...safeReference, threadId, legacyLocal: true }
    : safeReference;
}

async function localizeThreadBoundEntity(entity, resolveThreadBinding) {
  if (!entity || typeof entity !== "object") return entity;
  const hasThreadReference = Object.hasOwn(entity, "threadId")
    || Object.hasOwn(entity, "threadBinding")
    || Object.hasOwn(entity, "legacyLocalThreadId")
    || Array.isArray(entity.conversationRefs);
  if (!hasThreadReference) return entity;
  const {
    threadBinding,
    legacyLocalThreadId,
    conversationRefs,
    ...safeEntity
  } = entity;
  void threadBinding;
  void legacyLocalThreadId;
  const threadId = typeof safeEntity.threadId === "string" ? safeEntity.threadId : null;
  const localBinding = await resolveThreadBinding(threadId);
  const localized = {
    ...safeEntity,
    threadBinding: localBinding,
    legacyLocalThreadId: localBinding ? null : threadId,
  };
  if (Array.isArray(conversationRefs)) {
    localized.conversationRefs = await Promise.all(
      conversationRefs.map((reference) => localizeThreadReference(reference, resolveThreadBinding)),
    );
  }
  return localized;
}

async function localizeTask(task, resolveDevelopmentContext, resolveThreadBinding) {
  if (!task || typeof task !== "object") return task;
  let localized = task;
  if (task.developmentContext?.type === "worktree") {
    const cloudContext = {
      type: "worktree",
      ...(task.developmentContext.branch === undefined
        ? {}
        : { branch: task.developmentContext.branch }),
    };
    const localContext = resolveDevelopmentContext
      ? await resolveDevelopmentContext(task.projectId, cloudContext)
      : null;
    localized = {
      ...task,
      developmentContext: localContext ?? { ...cloudContext, path: null },
    };
  }
  return localizeThreadBoundEntity(localized, resolveThreadBinding);
}

async function localizeResponse(
  response,
  {
    readConfig,
    requestThreadBindings,
    resolveDevelopmentContext,
    resolveThreadBinding,
    setProjectWorkspace,
    projectWorkspace,
  },
) {
  if (response.status === 401) return response;
  if (!response.headers.get("content-type")?.includes("application/json")) return response;
  const payload = stripDeviceLocalFields(await response.json());

  if (response.ok && projectWorkspace) {
    const projectId = projectWorkspace.projectId ?? payload.project?.id;
    if (projectId) {
      await setProjectWorkspace(projectId, projectWorkspace.workspacePath);
    }
  }

  const config = await readConfig();
  const resolveLocalBinding = async (threadId) => {
    if (typeof threadId !== "string" || !threadId) return null;
    const requestBinding = requestThreadBindings?.get(threadId);
    if (isCompleteLocalThreadBinding(requestBinding)) return requestBinding;
    return resolveLocalThreadBinding(threadId, config, resolveThreadBinding);
  };
  if (Array.isArray(payload.projects)) {
    payload.projects = payload.projects.map((project) => ({
      ...project,
      workspacePath: project.id === DEFAULT_PROJECT_ID
        ? null
        : config.projectMappings[project.id] ?? null,
    }));
  }
  if (payload.project && typeof payload.project === "object") {
    payload.project = {
      ...payload.project,
      workspacePath: payload.project.id === DEFAULT_PROJECT_ID
        ? null
        : config.projectMappings[payload.project.id] ?? null,
    };
  }
  if (payload.task) {
    payload.task = await localizeTask(
      payload.task,
      resolveDevelopmentContext,
      resolveLocalBinding,
    );
  }
  if (Array.isArray(payload.tasks)) {
    const contexts = new Map();
    const resolveOnce = resolveDevelopmentContext
      ? (projectId, context) => {
        const key = `${projectId ?? ""}\0${context.branch ?? ""}`;
        if (!contexts.has(key)) {
          contexts.set(key, resolveDevelopmentContext(projectId, context));
        }
        return contexts.get(key);
      }
      : null;
    payload.tasks = await Promise.all(
      payload.tasks.map((task) => localizeTask(task, resolveOnce, resolveLocalBinding)),
    );
  }
  if (payload.comment) {
    payload.comment = await localizeThreadBoundEntity(payload.comment, resolveLocalBinding);
  }
  if (Array.isArray(payload.comments)) {
    payload.comments = await Promise.all(
      payload.comments.map((comment) => localizeThreadBoundEntity(comment, resolveLocalBinding)),
    );
  }

  const headers = new Headers(response.headers);
  headers.delete("content-length");
  headers.delete("content-encoding");
  return new Response(JSON.stringify(payload), {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export function createCloudProxy({
  configStore,
  getConfig,
  fetch: fetchImplementation = globalThis.fetch,
  resolveDevelopmentContext,
  assertTaskProjectMoveAllowed,
  resolveThreadBinding,
}) {
  const readConfig = getConfig ?? (() => configStore.read());
  const clearThreadBinding = configStore?.clearThreadBinding?.bind(configStore);
  const setProjectWorkspace = configStore?.setProjectWorkspace?.bind(configStore);
  const setThreadBinding = configStore?.setThreadBinding?.bind(configStore);

  return {
    async webSocketTarget(pathname = "/api/events") {
      const config = await readConfig();
      if (!config?.remoteUrl || !config.actorName || !config.sharedKey) {
        throw new CloudProxyError(
          409,
          "CLOUD_NOT_CONFIGURED",
          "Cloud collaboration is not configured",
        );
      }
      let remoteUrl;
      try {
        remoteUrl = normalizeCloudUrl(config.remoteUrl);
      } catch (error) {
        throw new CloudProxyError(
          500,
          "INVALID_CLOUD_CONFIG",
          error instanceof Error ? error.message : String(error),
        );
      }
      const url = new URL(pathname, `${remoteUrl}/`);
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      return {
        url: url.href,
        headers: { authorization: basicAuthorization(config.actorName, config.sharedKey) },
      };
    },
    async forward(request) {
      const config = await readConfig();
      if (!config?.remoteUrl || !config.actorName || !config.sharedKey) {
        throw new CloudProxyError(
          409,
          "CLOUD_NOT_CONFIGURED",
          "Cloud collaboration is not configured",
        );
      }
      let remoteUrl;
      try {
        remoteUrl = normalizeCloudUrl(config.remoteUrl);
      } catch (error) {
        throw new CloudProxyError(
          500,
          "INVALID_CLOUD_CONFIG",
          error instanceof Error ? error.message : String(error),
        );
      }

      const sourceUrl = new URL(request.url);
      const upstreamUrl = new URL(
        `${sourceUrl.pathname}${sourceUrl.search}`,
        `${remoteUrl}/`,
      );
      const headers = new Headers(request.headers);
      headers.delete("authorization");
      headers.delete("host");
      headers.delete("connection");
      headers.delete("transfer-encoding");
      headers.delete("accept-encoding");
      for (const name of [...headers.keys()]) {
        if (name.toLowerCase().startsWith("x-taskboard-user-")) headers.delete(name);
      }
      headers.set("authorization", basicAuthorization(config.actorName, config.sharedKey));

      const prepared = await prepareRequest(request, {
        assertTaskProjectMoveAllowed,
        clearThreadBinding,
        config,
        resolveThreadBinding,
        setThreadBinding,
      });
      if (prepared.projectWorkspace && !setProjectWorkspace) {
        throw new CloudProxyError(
          500,
          "PROJECT_MAPPING_UNAVAILABLE",
          "Local project mapping storage is unavailable",
        );
      }
      if (typeof prepared.body === "string") headers.delete("content-length");
      const init = {
        method: request.method,
        headers,
        redirect: "manual",
      };
      if (request.method !== "GET" && request.method !== "HEAD" && prepared.body !== null) {
        init.body = prepared.body;
        if (typeof prepared.body !== "string") init.duplex = "half";
      }

      let response;
      try {
        response = await fetchImplementation(upstreamUrl, init);
      } catch (error) {
        throw new CloudProxyError(
          502,
          "REMOTE_UNAVAILABLE",
          `Cannot reach cloud taskboard at ${remoteUrl}`,
          error instanceof Error ? error.message : String(error),
        );
      }
      return localizeResponse(response, {
        readConfig,
        projectWorkspace: prepared.projectWorkspace,
        requestThreadBindings: prepared.localThreadBindings,
        resolveDevelopmentContext,
        resolveThreadBinding,
        setProjectWorkspace,
      });
    },
  };
}
