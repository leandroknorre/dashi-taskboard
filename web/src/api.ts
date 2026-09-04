import type {
  ActorIdentity,
  AiChatCatalog,
  AiChatAttachmentInput,
  AiChatRun,
  AiChatSandbox,
  AiChatThread,
  AiChatThreadSnapshot,
  Attachment,
  Comment,
  ComposerCandidatesQuery,
  ComposerCandidatesResponse,
  ComposerRebindRequest,
  ComposerRebindResponse,
  ComposerTurnInput,
  CodexThreadBinding,
  DevelopmentScan,
  HostContext,
  IssueRelationOrigin,
  IssueRelationType,
  JiraConnection,
  Project,
  ProjectReadme,
  ProjectReadmeAttachment,
  ProjectSummary,
  Task,
  NestedWorkspace,
  TaskRollup,
  StageWorkflowDefinition,
  StageWorkflowRecord,
  WorkflowAuthoringDefinition,
  WorkflowAuthoringRecord,
  WorkflowAuthoringValidation,
  TaskChangeActivity,
  TaskboardMetadata,
  TaskDraft,
  TaskStatus,
} from "./types";

const DEFAULT_USER_ACTOR: ActorIdentity = {
  type: "user",
  id: "local-user",
  name: "本地用户",
  avatarUrl: null,
};

let currentUserActor = DEFAULT_USER_ACTOR;
let apiText = (_chinese: string, english: string) => english;

export function setCurrentUserActor(actor?: ActorIdentity) {
  currentUserActor = actor?.type === "user" ? actor : DEFAULT_USER_ACTOR;
}

export function setApiText(text: typeof apiText) {
  apiText = text;
}

interface ApiErrorBody {
  error?: {
    code?: string;
    message?: string;
    details?: unknown;
  };
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(status: number, body: ApiErrorBody) {
    super(body.error?.message ?? apiText(`请求失败（${status}）`, `Request failed (${status})`));
    this.name = "ApiError";
    this.status = status;
    this.code = body.error?.code ?? "REQUEST_FAILED";
    this.details = body.error?.details;
  }
}

export function resolveTaskboardUrl(path: string): string {
  return new URL(path.replace(/^\//, ""), document.baseURI).href;
}

export function resolveTaskboardWebSocketUrl(path: string): string {
  const url = new URL(resolveTaskboardUrl(path));
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.href;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  const method = (init?.method ?? "GET").toUpperCase();
  if (method !== "GET" && method !== "HEAD") {
    headers.set("X-Taskboard-User-Id", currentUserActor.id);
    headers.set("X-Taskboard-User-Name", encodeURIComponent(currentUserActor.name));
    if (currentUserActor.avatarUrl) {
      headers.set("X-Taskboard-User-Avatar", currentUserActor.avatarUrl);
    }
  }

  const readRequest = method === "GET" || method === "HEAD";
  let response: Response;
  for (let attempt = 0; ; attempt += 1) {
    try {
      response = await fetch(resolveTaskboardUrl(path), { ...init, headers, redirect: "manual" });
      break;
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") throw error;
      if (readRequest && attempt < 2) {
        await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
        continue;
      }
      const failure = error instanceof Error && error.name === "TimeoutError"
        ? "timeout"
        : error instanceof TypeError
          ? "browser-network"
          : "network";
      throw new ApiError(0, {
        error: {
          code: readRequest ? "READ_FAILED" : "SERVICE_UNAVAILABLE",
          message: readRequest
            ? apiText(
                "暂时无法读取 Taskboard 数据。面板会自动重试，请稍后再试。",
                "Taskboard data is temporarily unavailable. The panel will retry automatically.",
              )
            : apiText(
                "暂时无法连接 Taskboard 服务，请稍后重试。",
                "The Taskboard service is temporarily unavailable. Try again later.",
              ),
          details: { method, failure },
        },
      });
    }
  }
  if (
    response.type === "opaqueredirect"
    || response.status === 301
    || response.status === 302
    || response.status === 303
    || response.status === 307
    || response.status === 308
  ) {
    throw new ApiError(401, {
      error: {
        code: "ACCESS_AUTHENTICATION_REQUIRED",
        message: apiText(
          "Taskboard 登录已过期，请重新登录。",
          "Your Taskboard sign-in expired. Sign in again.",
        ),
      },
    });
  }
  let body: T & ApiErrorBody;
  try {
    body = (await response.json()) as T & ApiErrorBody;
  } catch (error) {
    if ((error as Error).name === "AbortError") throw error;
    body = {} as T & ApiErrorBody;
  }

  if (!response.ok) throw new ApiError(response.status, body);
  return body;
}

export async function listProjects(signal?: AbortSignal): Promise<Project[]> {
  const data = await request<{ projects: Project[] }>("/api/projects", { signal });
  return data.projects;
}

export async function getJiraConnection(signal?: AbortSignal): Promise<JiraConnection> {
  try {
    const data = await request<{ connection: JiraConnection }>("/api/local/jira-connection", { signal });
    return data.connection;
  } catch (error) {
    if (
      error instanceof ApiError
      && (error.code === "LOCAL_COMPANION_REQUIRED" || error.status === 404)
    ) {
      return {
        configured: false,
        baseUrl: null,
        username: null,
        displayName: null,
        projects: [],
        projectId: "jira-my-tasks",
        lastSyncedAt: null,
        insecureHttp: false,
      };
    }
    throw error;
  }
}

export async function configureJiraConnection(input: {
  baseUrl: string;
  username: string;
  password: string;
  projects: string[];
}): Promise<JiraConnection> {
  const data = await request<{ connection: JiraConnection }>("/api/local/jira-connection", {
    method: "PUT",
    body: JSON.stringify(input),
  });
  return data.connection;
}

export async function syncJiraConnection(): Promise<JiraConnection> {
  const data = await request<{ connection: JiraConnection }>("/api/local/jira-connection/sync", {
    method: "POST",
  });
  return data.connection;
}

export async function getProjectSummary(
  projectId: string,
  signal?: AbortSignal,
): Promise<ProjectSummary> {
  return request<ProjectSummary>(
    `/api/local/projects/${encodeURIComponent(projectId)}/summary`,
    { signal },
  );
}

export async function getTaskboardMetadata(signal?: AbortSignal): Promise<TaskboardMetadata> {
  return request<TaskboardMetadata>("/api/meta", { signal });
}

export async function getTaskboardRevision(
  since: number,
  signal?: AbortSignal,
): Promise<{ changed: boolean; revision: number }> {
  const query = new URLSearchParams({ since: String(since) });
  return request<{ changed: boolean; revision: number }>(`/api/revisions?${query}`, { signal });
}

export async function getHostRuntime(signal?: AbortSignal): Promise<HostContext | null> {
  const data = await request<{
    runtime: (Pick<HostContext, "threadId" | "threadRunning" | "threadTodoProgress"> & {
      codexProjectId: string | null;
      codexProjectKind: "local" | "remote" | null;
      codexHostId: string | null;
      workspacePath: string | null;
      updatedAt: number;
    }) | null;
  }>("/api/local/host-runtime", { signal });
  if (!data.runtime) return null;
  const { codexProjectId, codexProjectKind, codexHostId, workspacePath } = data.runtime;
  return {
    threadId: data.runtime.threadId,
    threadRunning: data.runtime.threadRunning,
    threadTodoProgress: data.runtime.threadTodoProgress,
    ...(codexProjectId && codexProjectKind && codexHostId && workspacePath
      ? {
          projectId: codexProjectId,
          workspacePath,
          projects: [{
            id: codexProjectId,
            name: codexProjectId,
            projectKind: codexProjectKind,
            workspacePath,
            hostId: codexHostId,
          }],
        }
      : {}),
  };
}

export async function getLocalWhoami(signal?: AbortSignal): Promise<ActorIdentity> {
  const data = await request<{ user: ActorIdentity }>("/api/local/whoami", { signal });
  return data.user;
}

/**
 * The non-human assignee targets this server is configured with (besides
 * Codex), fetched from the server rather than hardcoded in the client so a
 * deployment's own session/pillar names never need to live in this repo.
 */
export async function getLocalSessionAgents(
  signal?: AbortSignal,
): Promise<ReadonlyArray<{ id: string; name: string }>> {
  const data = await request<{ sessionAgents: ReadonlyArray<{ id: string; name: string }> }>(
    "/api/local/whoami",
    { signal },
  );
  return data.sessionAgents;
}

export async function getCodexThreadProgress(
  threadIds: string[],
  signal?: AbortSignal,
): Promise<Record<string, { completed: number | null; total: number | null; running: boolean } | null>> {
  const query = new URLSearchParams();
  for (const threadId of threadIds) query.append("threadId", threadId);
  const data = await request<{
    progress: Record<string, {
      completed: number | null;
      total: number | null;
      running: boolean;
    } | null>;
  }>(`/api/local/codex-thread-progress?${query}`, { signal });
  return data.progress;
}

export async function publishHostRuntime(context: HostContext): Promise<void> {
  if (!context.threadId || context.threadRunning === undefined) return;
  const project = context.projects?.find((candidate) => candidate.id === context.projectId);
  await request("/api/local/host-runtime", {
    method: "PUT",
    body: JSON.stringify({
      threadId: context.threadId,
      threadRunning: context.threadRunning,
      threadTodoProgress: context.threadTodoProgress ?? null,
      codexProjectId: project?.id ?? null,
      codexProjectKind: project?.projectKind ?? null,
      codexHostId: project?.hostId ?? null,
      workspacePath: project?.workspacePath ?? null,
    }),
  });
}

export async function getAiChatCatalog(
  projectId: string,
  signal?: AbortSignal,
): Promise<AiChatCatalog> {
  return request<AiChatCatalog>(
    `/api/local/ai/catalog?projectId=${encodeURIComponent(projectId)}`,
    { signal },
  );
}

export async function getAiChatComposerCandidates(
  input: ComposerCandidatesQuery,
  signal?: AbortSignal,
): Promise<ComposerCandidatesResponse> {
  const query = new URLSearchParams({
    trigger: input.trigger,
    query: input.query,
  });
  if (input.projectId) query.set("projectId", input.projectId);
  if (input.threadId) query.set("threadId", input.threadId);
  if (input.surface) query.set("surface", input.surface);
  return request<ComposerCandidatesResponse>(`/api/local/ai/composer/candidates?${query}`, { signal });
}

export async function rebindAiChatComposerReferences(
  input: ComposerRebindRequest,
): Promise<ComposerRebindResponse> {
  return request<ComposerRebindResponse>("/api/local/ai/composer/rebind", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function listAiChatThreads(signal?: AbortSignal): Promise<AiChatThread[]> {
  const data = await request<{ threads: AiChatThread[] }>("/api/local/ai/threads", { signal });
  return data.threads;
}

export async function createAiChatThread(input: {
  projectId: string;
  issueId?: string;
  title?: string;
  model?: string;
  reasoningEffort?: string;
  sandbox?: AiChatSandbox;
}): Promise<AiChatThread> {
  const data = await request<{ thread: AiChatThread }>("/api/local/ai/threads", {
    method: "POST",
    body: JSON.stringify(input),
  });
  return data.thread;
}

export async function getAiChatThread(
  threadId: string,
  signal?: AbortSignal,
): Promise<AiChatThreadSnapshot> {
  return request<AiChatThreadSnapshot>(
    `/api/local/ai/threads/${encodeURIComponent(threadId)}`,
    { signal },
  );
}

export async function updateAiChatThread(
  threadId: string,
  input: {
    title?: string;
    model?: string;
    reasoningEffort?: string;
    sandbox?: AiChatSandbox;
  },
): Promise<AiChatThread> {
  const data = await request<{ thread: AiChatThread }>(
    `/api/local/ai/threads/${encodeURIComponent(threadId)}`,
    {
      method: "PATCH",
      body: JSON.stringify(input),
    },
  );
  return data.thread;
}

export async function deleteAiChatThread(threadId: string): Promise<void> {
  await request<void>(
    `/api/local/ai/threads/${encodeURIComponent(threadId)}`,
    { method: "DELETE" },
  );
}

export async function startAiChatTurn(
  threadId: string,
  input: {
    message: string;
    skillIds?: string[];
    attachments?: AiChatAttachmentInput[];
    dangerFullAccessConfirmed?: boolean;
  },
): Promise<AiChatRun> {
  const data = await request<{ run: AiChatRun }>(
    `/api/local/ai/threads/${encodeURIComponent(threadId)}/turns`,
    {
      method: "POST",
      body: JSON.stringify(input),
    },
  );
  return data.run;
}

export async function startAiChatComposerTurn(
  threadId: string,
  input: ComposerTurnInput,
): Promise<AiChatRun> {
  const data = await request<{ run: AiChatRun }>(
    `/api/local/ai/threads/${encodeURIComponent(threadId)}/turns`,
    {
      method: "POST",
      body: JSON.stringify(input),
    },
  );
  return data.run;
}

export async function interruptAiChatRun(runId: string): Promise<AiChatRun> {
  const data = await request<{ run: AiChatRun }>(
    `/api/local/ai/runs/${encodeURIComponent(runId)}/interrupt`,
    { method: "POST" },
  );
  return data.run;
}

export async function compactAiChatThread(threadId: string): Promise<AiChatThread> {
  const data = await request<{ thread: AiChatThread }>(
    `/api/local/ai/threads/${encodeURIComponent(threadId)}/compact`,
    { method: "POST" },
  );
  return data.thread;
}

export function subscribeAiChatThread(
  threadId: string,
  onHint: (type: "ai.event" | "ai.run") => void,
  onError?: () => void,
): () => void {
  const source = new EventSource(
    resolveTaskboardUrl(`/api/local/ai/threads/${encodeURIComponent(threadId)}/events`),
  );
  source.addEventListener("ai.event", () => onHint("ai.event"));
  source.addEventListener("ai.run", () => onHint("ai.run"));
  if (onError) source.addEventListener("error", onError);
  return () => source.close();
}

export async function listDeviceWorkspaces(signal?: AbortSignal): Promise<Record<string, string>> {
  try {
    const data = await request<{ workspaces: Record<string, string> }>("/api/device-workspaces", { signal });
    return data.workspaces;
  } catch (error) {
    if (error instanceof ApiError && error.code === "LOCAL_COMPANION_REQUIRED") return {};
    throw error;
  }
}

export async function getProjectReadme(
  projectId: string,
  signal?: AbortSignal,
): Promise<ProjectReadme> {
  const data = await request<{ readme: ProjectReadme }>(
    `/api/projects/${encodeURIComponent(projectId)}/readme`,
    { signal },
  );
  return data.readme;
}

export async function saveProjectReadme(
  projectId: string,
  content: string,
  version?: number,
): Promise<ProjectReadme> {
  const data = await request<{ readme: ProjectReadme }>(
    `/api/projects/${encodeURIComponent(projectId)}/readme`,
    {
      method: "PUT",
      body: JSON.stringify({ content, ...(version !== undefined ? { version } : {}) }),
    },
  );
  return data.readme;
}

export async function uploadProjectReadmeAttachment(
  projectId: string,
  file: File,
): Promise<ProjectReadmeAttachment> {
  const data = await request<{ attachment: ProjectReadmeAttachment }>(
    `/api/projects/${encodeURIComponent(projectId)}/readme/attachments`,
    {
      method: "POST",
      headers: {
        "Content-Type": file.type || "application/octet-stream",
        "X-Taskboard-Filename": encodeURIComponent(file.name),
        "X-Taskboard-Attachment-Kind": "inline",
      },
      body: file,
    },
  );
  return data.attachment;
}

export async function createProject(input: {
  id: string;
  name: string;
  workspacePath: string | null;
}): Promise<Project> {
  const data = await request<{ project: Project }>("/api/projects", {
    method: "POST",
    body: JSON.stringify(input),
  });
  return data.project;
}

export async function createProjectLabel(projectId: string, label: string): Promise<Project> {
  const data = await request<{ project: Project }>(
    `/api/projects/${encodeURIComponent(projectId)}/labels`,
    {
      method: "POST",
      body: JSON.stringify({ label }),
    },
  );
  return data.project;
}

export async function deleteProjectLabel(projectId: string, label: string): Promise<Project> {
  const data = await request<{ project: Project }>(
    `/api/projects/${encodeURIComponent(projectId)}/labels`,
    {
      method: "DELETE",
      body: JSON.stringify({ label }),
    },
  );
  return data.project;
}

export async function deleteProject(projectId: string): Promise<void> {
  await request(`/api/projects/${encodeURIComponent(projectId)}`, {
    method: "DELETE",
  });
}

export async function listDevelopmentContexts(
  projectId: string,
  codexProjectId?: string,
  codexThreadId?: string,
  signal?: AbortSignal,
  workspacePath?: string,
): Promise<DevelopmentScan> {
  const query = new URLSearchParams();
  if (codexProjectId) query.set("codexProjectId", codexProjectId);
  if (codexThreadId) query.set("codexThreadId", codexThreadId);
  if (workspacePath) query.set("workspacePath", workspacePath);
  const suffix = query.size > 0 ? `?${query}` : "";
  return request<DevelopmentScan>(
    `/api/projects/${encodeURIComponent(projectId)}/development-contexts${suffix}`,
    { signal },
  );
}

async function listTasksByArchive(
  projectId: string | undefined,
  archived: "true" | "false",
  signal?: AbortSignal,
): Promise<Task[]> {
  const params = new URLSearchParams({ archived });
  if (projectId) params.set("projectId", projectId);
  const data = await request<{ tasks: Task[] }>(`/api/tasks?${params}`, { signal });
  return data.tasks;
}

export function listTasks(projectId?: string, signal?: AbortSignal): Promise<Task[]> {
  return listTasksByArchive(projectId, "false", signal);
}

export async function getTask(taskId: string, signal?: AbortSignal): Promise<Task> {
  const data = await request<{ task: Task }>(
    `/api/tasks/${encodeURIComponent(taskId)}`,
    { signal },
  );
  return data.task;
}

export function getNestedWorkspace(
  taskId: string,
  options: {
    descendants?: boolean;
    limit?: number;
    childrenCursor?: string | null;
    descendantsCursor?: string | null;
  } = {},
  signal?: AbortSignal,
): Promise<NestedWorkspace> {
  const params = new URLSearchParams();
  if (options.descendants) params.set("descendants", "true");
  if (options.limit) params.set("limit", String(options.limit));
  if (options.childrenCursor) params.set("childrenCursor", options.childrenCursor);
  if (options.descendantsCursor) params.set("descendantsCursor", options.descendantsCursor);
  const suffix = params.size ? `?${params}` : "";
  return request<{ workspace: NestedWorkspace }>(
    `/api/tasks/${encodeURIComponent(taskId)}/workspace${suffix}`,
    { signal },
  ).then((data) => data.workspace);
}

export function getTaskRollup(taskId: string, signal?: AbortSignal): Promise<TaskRollup> {
  return request<{ rollup: TaskRollup }>(
    `/api/tasks/${encodeURIComponent(taskId)}/rollup`,
    { signal },
  ).then((data) => data.rollup);
}

export function listArchivedTasks(projectId?: string, signal?: AbortSignal): Promise<Task[]> {
  return listTasksByArchive(projectId, "true", signal);
}

export async function createTask(projectId: string, draft: TaskDraft, threadId?: string): Promise<Task> {
  const data = await request<{ task: Task }>("/api/tasks", {
    method: "POST",
    body: JSON.stringify({ projectId, ...draft, ...(threadId ? { threadId } : {}) }),
  });
  return data.task;
}

export function getStageWorkflow(projectId: string, signal?: AbortSignal): Promise<StageWorkflowRecord> {
  return request<StageWorkflowRecord>(
    `/api/projects/${encodeURIComponent(projectId)}/stage-workflow`,
    { signal },
  );
}

export function saveStageWorkflow(
  projectId: string,
  definition: StageWorkflowDefinition,
  version: number,
  removals: Array<{ stageId: string; destinationStageId: string }> = [],
): Promise<StageWorkflowRecord> {
  return request<StageWorkflowRecord>(
    `/api/projects/${encodeURIComponent(projectId)}/stage-workflow`,
    { method: "PUT", body: JSON.stringify({ definition, version, removals }) },
  );
}

export function getWorkflowAuthoring(
  projectId: string,
  signal?: AbortSignal,
): Promise<WorkflowAuthoringRecord> {
  return request<{ workflow: WorkflowAuthoringRecord }>(
    `/api/projects/${encodeURIComponent(projectId)}/workflow-authoring`,
    { signal },
  ).then((data) => data.workflow);
}

export function validateWorkflowAuthoring(
  projectId: string,
  expectedRevisionId: string | null,
  definition: WorkflowAuthoringDefinition,
): Promise<WorkflowAuthoringValidation> {
  return request<{ validation: WorkflowAuthoringValidation }>(
    `/api/projects/${encodeURIComponent(projectId)}/workflow-authoring/validate`,
    {
      method: "POST",
      body: JSON.stringify({ expectedRevisionId, definition }),
    },
  ).then((data) => data.validation);
}

export function publishWorkflowAuthoring(
  projectId: string,
  expectedRevisionId: string | null,
  definition: WorkflowAuthoringDefinition,
): Promise<WorkflowAuthoringRecord> {
  return request<{ workflow: WorkflowAuthoringRecord }>(
    `/api/projects/${encodeURIComponent(projectId)}/workflow-authoring/publish`,
    {
      method: "POST",
      body: JSON.stringify({ expectedRevisionId, definition }),
    },
  ).then((data) => data.workflow);
}

export async function renameProject(
  project: Project,
  name: string,
): Promise<Project> {
  const data = await request<{ project: Project }>(
    `/api/projects/${encodeURIComponent(project.id)}`,
    {
      method: "PATCH",
      body: JSON.stringify({ name, expectedUpdatedAt: project.updatedAt }),
    },
  );
  return data.project;
}

export async function updateTask(task: Task, draft: Partial<TaskDraft>, threadId?: string): Promise<Task> {
  const data = await request<{ task: Task }>(`/api/tasks/${encodeURIComponent(task.id)}`, {
    method: "PATCH",
    body: JSON.stringify({ version: task.version, ...draft, ...(threadId ? { threadId } : {}) }),
  });
  return data.task;
}

function taskDraftValueMatches(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function restoreTaskDraftChanges(snapshot: Task, changed: Task): Partial<TaskDraft> {
  const changes: Partial<TaskDraft> = {};
  if (snapshot.title !== changed.title) changes.title = snapshot.title;
  if (snapshot.description !== changed.description) changes.description = snapshot.description;
  if (snapshot.status !== changed.status) changes.status = snapshot.status;
  if (snapshot.stageId !== changed.stageId && snapshot.stageId != null) changes.stageId = snapshot.stageId;
  if (snapshot.priority !== changed.priority) changes.priority = snapshot.priority;
  if (!taskDraftValueMatches(snapshot.labels, changed.labels)) changes.labels = snapshot.labels;
  if (!taskDraftValueMatches(snapshot.developmentContext, changed.developmentContext)) {
    changes.developmentContext = snapshot.developmentContext;
  }
  if (snapshot.startDate !== changed.startDate) changes.startDate = snapshot.startDate;
  if (snapshot.dueDate !== changed.dueDate) changes.dueDate = snapshot.dueDate;
  if (!taskDraftValueMatches(snapshot.recurrence, changed.recurrence)) changes.recurrence = snapshot.recurrence;
  return changes;
}

export async function moveTask(
  task: Task,
  status: TaskStatus,
  sortOrder?: number,
  stageId?: string,
): Promise<Task> {
  const sameStage = stageId !== undefined
    ? task.stageId === stageId
    : task.status === status;
  if (sameStage) {
    const data = await request<{ task: Task }>(
      `/api/tasks/${encodeURIComponent(task.id)}/move`,
      {
        method: "POST",
        body: JSON.stringify({
          version: task.version,
          status,
          ...(stageId ? { stageId } : {}),
          ...(sortOrder === undefined ? {} : { sortOrder }),
        }),
      },
    );
    return data.task;
  }

  const { actions } = await request<{ actions: TaskTransitionAction[] }>(
    `/api/tasks/${encodeURIComponent(task.id)}/transitions`,
  );
  const candidates = actions.filter((action) => (
    stageId !== undefined ? action.toStageId === stageId : action.toStatus === status
  ));
  if (candidates.length !== 1) {
    throw new ApiError(409, {
      error: {
        code: candidates.length === 0 ? "ACTION_NOT_FOUND" : "AMBIGUOUS_TRANSITION",
        message: candidates.length === 0
          ? apiText(
              "当前流程不允许移动到所选阶段。",
              "The current workflow does not allow moving to the selected stage.",
            )
          : apiText(
              "多个流程动作指向所选状态，请选择具体阶段。",
              "More than one workflow action reaches that status. Choose a specific stage.",
            ),
      },
    });
  }
  const action = candidates[0]!;
  const operationId = crypto.randomUUID();
  let gateEvidence: unknown[] = [];
  if (action.requiresAcceptance) {
    const evidence = await retryIdempotentRequest(() => request<{ evidence: unknown }>(
      `/api/tasks/${encodeURIComponent(task.id)}/evidence`,
      {
        method: "POST",
        headers: { "Idempotency-Key": `task-evidence-${operationId}` },
        body: JSON.stringify({
          expectedStateVersion: task.version,
          actionKey: action.actionKey,
        }),
      },
    ));
    gateEvidence = [evidence.evidence];
  }
  const data = await retryIdempotentRequest(() => request<{ task: Task }>(
    `/api/tasks/${encodeURIComponent(task.id)}/transitions`,
    {
      method: "POST",
      headers: { "Idempotency-Key": `task-transition-${operationId}` },
      body: JSON.stringify({
        expectedStateVersion: task.version,
        actionKey: action.actionKey,
        gateEvidence,
        ...(sortOrder === undefined ? {} : { sortOrder }),
      }),
    },
  ));
  return data.task;
}

export interface TaskTransitionAction {
  actionKey: string;
  transitionId: string;
  toStageId: string;
  toStatus: TaskStatus;
  toTerminalKind: "none" | "completed" | "canceled";
  requiresAcceptance: boolean;
}

export type TaskMutationFailure =
  | { kind: "blocker"; taskIds: string[] }
  | { kind: "authentication" }
  | { kind: "conflict" }
  | { kind: "unavailable" }
  | { kind: "other" };

export function classifyTaskMutationFailure(error: unknown): TaskMutationFailure {
  if (!(error instanceof ApiError)) return { kind: "other" };
  if (error.code === "REQUIRED_DESCENDANT_INCOMPLETE") {
    const taskIds = error.details && typeof error.details === "object" && "taskIds" in error.details
      && Array.isArray(error.details.taskIds)
      ? error.details.taskIds.filter((value): value is string => typeof value === "string")
      : [];
    return { kind: "blocker", taskIds };
  }
  if (
    error.code === "ACCESS_AUTHENTICATION_REQUIRED"
    || error.status === 401
    || error.status === 403
  ) return { kind: "authentication" };
  if (
    error.code === "VERSION_CONFLICT"
    || error.code === "EXPECTED_STATE_CONFLICT"
  ) return { kind: "conflict" };
  if (
    error.code === "SERVICE_UNAVAILABLE"
    || error.status === 0
    || error.status >= 500
  ) return { kind: "unavailable" };
  return { kind: "other" };
}

async function retryIdempotentRequest<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    const failure = classifyTaskMutationFailure(error);
    if (failure.kind !== "unavailable") throw error;
    return operation();
  }
}

export async function archiveTask(task: Task, threadId?: string): Promise<Task> {
  const data = await request<{ task: Task }>(
    `/api/tasks/${encodeURIComponent(task.id)}/archive`,
    {
      method: "POST",
      body: JSON.stringify({ version: task.version, ...(threadId ? { threadId } : {}) }),
    },
  );
  return data.task;
}

export async function restoreTask(task: Task, threadId?: string): Promise<Task> {
  const data = await request<{ task: Task }>(
    `/api/tasks/${encodeURIComponent(task.id)}/restore`,
    {
      method: "POST",
      body: JSON.stringify({ version: task.version, ...(threadId ? { threadId } : {}) }),
    },
  );
  return data.task;
}

export type SourceRecordAction = "adopt" | "merge" | "discard" | "restore";

export interface SourceRecordMutationResult {
  sourceRecord: Task;
  workCard?: Task;
  targetTaskId: string | null;
  disposition: "adopted" | "merged" | "discarded" | "pending";
  version: number;
  idempotent: boolean;
}

export async function mutateSourceRecord(
  task: Task,
  action: SourceRecordAction,
  target?: { targetProjectId?: string; targetTaskId?: string },
): Promise<SourceRecordMutationResult> {
  const idempotencyKey = `source-record-${action}-${crypto.randomUUID()}`;
  return retryIdempotentRequest(() => request<SourceRecordMutationResult>(
    `/api/source-records/${encodeURIComponent(task.id)}/${action}`,
    {
      method: "POST",
      headers: { "Idempotency-Key": idempotencyKey },
      body: JSON.stringify({
        version: task.version,
        ...(action === "adopt" ? { targetProjectId: target?.targetProjectId } : {}),
        ...(action === "merge" ? { targetTaskId: target?.targetTaskId } : {}),
      }),
    },
  ));
}

export async function deleteArchivedTask(task: Task): Promise<void> {
  await request(`/api/tasks/${encodeURIComponent(task.id)}`, {
    method: "DELETE",
    body: JSON.stringify({ version: task.version }),
  });
}

export async function addTaskRelation(
  task: Task,
  type: IssueRelationType,
  relatedTaskId: string,
  threadId?: string,
  origin?: IssueRelationOrigin,
): Promise<{ task: Task; relatedTask: Task }> {
  return request<{ task: Task; relatedTask: Task }>(
    `/api/tasks/${encodeURIComponent(task.id)}/relations/${type}/${encodeURIComponent(relatedTaskId)}`,
    {
      method: "POST",
      body: JSON.stringify({
        version: task.version,
        ...(origin ? { origin } : {}),
        ...(threadId ? { threadId } : {}),
      }),
    },
  );
}

export async function removeTaskRelation(
  task: Task,
  type: IssueRelationType,
  relatedTaskId: string,
  threadId?: string,
  origin?: IssueRelationOrigin,
): Promise<{ task: Task; relatedTask: Task }> {
  return request<{ task: Task; relatedTask: Task }>(
    `/api/tasks/${encodeURIComponent(task.id)}/relations/${type}/${encodeURIComponent(relatedTaskId)}`,
    {
      method: "DELETE",
      body: JSON.stringify({
        version: task.version,
        ...(origin ? { origin } : {}),
        ...(threadId ? { threadId } : {}),
      }),
    },
  );
}

export async function listComments(taskId: string, signal?: AbortSignal): Promise<Comment[]> {
  const data = await request<{ comments: Comment[] }>(
    `/api/tasks/${encodeURIComponent(taskId)}/comments`,
    { signal },
  );
  return data.comments;
}

export async function listTaskActivities(
  taskId: string,
  signal?: AbortSignal,
): Promise<TaskChangeActivity[]> {
  const data = await request<{ activities: TaskChangeActivity[] }>(
    `/api/tasks/${encodeURIComponent(taskId)}/activities`,
    { signal },
  );
  return data.activities;
}

export async function createComment(
  taskId: string,
  body: string,
  threadId?: string,
  threadBinding?: CodexThreadBinding | null,
): Promise<Comment> {
  const data = await request<{ comment: Comment }>(
    `/api/tasks/${encodeURIComponent(taskId)}/comments`,
    {
      method: "POST",
      body: JSON.stringify({
        body,
        ...(threadId ? { threadId } : {}),
        ...(threadBinding === undefined ? {} : { threadBinding }),
      }),
    },
  );
  return data.comment;
}

export async function updateComment(comment: Comment, body: string, threadId?: string): Promise<Comment> {
  const data = await request<{ comment: Comment }>(
    `/api/comments/${encodeURIComponent(comment.id)}`,
    {
      method: "PATCH",
      body: JSON.stringify({ version: comment.version, body, ...(threadId ? { threadId } : {}) }),
    },
  );
  return data.comment;
}

export async function deleteComment(comment: Comment, threadId?: string): Promise<void> {
  await request(`/api/comments/${encodeURIComponent(comment.id)}`, {
    method: "DELETE",
    body: JSON.stringify({ version: comment.version, ...(threadId ? { threadId } : {}) }),
  });
}

export async function listAttachments(taskId: string, signal?: AbortSignal): Promise<Attachment[]> {
  const data = await request<{ attachments: Attachment[] }>(
    `/api/tasks/${encodeURIComponent(taskId)}/attachments`,
    { signal },
  );
  return data.attachments;
}

export async function uploadAttachment(
  taskId: string,
  file: File,
  kind: Attachment["kind"],
): Promise<Attachment> {
  const data = await request<{ attachment: Attachment }>(
    `/api/tasks/${encodeURIComponent(taskId)}/attachments`,
    {
      method: "POST",
      headers: {
        "Content-Type": file.type || "application/octet-stream",
        "X-Taskboard-Filename": encodeURIComponent(file.name),
        "X-Taskboard-Attachment-Kind": kind,
      },
      body: file,
    },
  );
  return data.attachment;
}

export async function uploadCommentAttachment(
  commentId: string,
  file: File,
  kind: Attachment["kind"],
): Promise<Attachment> {
  const data = await request<{ attachment: Attachment }>(
    `/api/comments/${encodeURIComponent(commentId)}/attachments`,
    {
      method: "POST",
      headers: {
        "Content-Type": file.type || "application/octet-stream",
        "X-Taskboard-Filename": encodeURIComponent(file.name),
        "X-Taskboard-Attachment-Kind": kind,
      },
      body: file,
    },
  );
  return data.attachment;
}

export async function deleteAttachment(attachment: Attachment): Promise<void> {
  await request(`/api/attachments/${encodeURIComponent(attachment.id)}`, {
    method: "DELETE",
  });
}

export function attachmentContentUrl(attachment: { id: string }): string {
  return `api/attachments/${encodeURIComponent(attachment.id)}/content`;
}

export function attachmentDownloadUrl(attachment: Attachment): string {
  return `api/attachments/${encodeURIComponent(attachment.id)}/download`;
}

export function resolvePersistedAttachmentUrl(value: string): string {
  if (/^\/?api\/attachments\/[^/?#]+\/content$/.test(value)) {
    return resolveTaskboardUrl(value);
  }
  try {
    const url = new URL(value);
    const match = url.pathname.match(/\/api\/attachments\/([^/]+)\/content$/);
    if (url.protocol === "http:" && url.hostname === "127.0.0.1" && match) {
      return resolveTaskboardUrl(`/api/attachments/${match[1]}/content`);
    }
  } catch {
    return value;
  }
  return value;
}
