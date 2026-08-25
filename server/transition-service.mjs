import { randomUUID } from "node:crypto";

import {
  WORKFLOW_ERROR_CODES,
  WorkflowContractError,
  assertWorkflowRevisionPublication,
  canonicalJson,
  normalizeHumanAuthorization,
  normalizeWorkflowRevision,
} from "../shared/workflow-control.mjs";
import {
  TRANSITION_ERROR_CODES,
  TransitionServiceError,
  evaluatePinnedTransition,
  normalizeTransitionCommand,
} from "../shared/transition-service.mjs";
import { automationRunFromRow, createAutomationRunForTransition } from "./automation-run-service.mjs";
import { ApiError } from "./database.mjs";
import { WorkflowLedger } from "./workflow-ledger.mjs";
import { migrateLocalWorkflowTransitions } from "./workflow-transition-schema.mjs";

function now() {
  return new Date().toISOString();
}

function apiError(error) {
  if (error instanceof ApiError) return error;
  if (error instanceof TransitionServiceError) {
    const status = error.code === TRANSITION_ERROR_CODES.ACTION_NOT_FOUND ? 400 : 409;
    return new ApiError(status, error.code, error.message, error.details);
  }
  if (error instanceof WorkflowContractError) {
    const status = error.code === WORKFLOW_ERROR_CODES.INVALID_CONTRACT ? 400 : 409;
    return new ApiError(status, error.code, error.message, error.details);
  }
  return error;
}

function requestFromRow(row) {
  return {
    requestId: row.request_id,
    taskId: row.task_id,
    idempotencyKey: row.idempotency_key,
    expectedStateVersion: row.expected_state_version,
    actionKey: row.action_key,
    workflowId: row.workflow_id,
    revisionId: row.revision_id,
    transitionId: row.transition_id,
    fromStageId: row.from_stage_id,
    toStageId: row.to_stage_id,
    eventId: row.event_id,
    eventHash: row.event_hash,
    createdAt: row.created_at,
  };
}

function ruleFromRow(row) {
  return {
    actionKey: row.action_key,
    transitionId: row.transition_id,
    fromTaskStageId: row.from_task_stage_id,
    toTaskStageId: row.to_task_stage_id,
    fromContractStageId: row.from_contract_stage_id,
    toContractStageId: row.to_contract_stage_id,
    toTerminalKind: row.to_terminal_kind,
    legacy: row.legacy === 1,
  };
}

function normalizeSortOrder(sortOrder) {
  if (sortOrder === undefined) return undefined;
  if (typeof sortOrder !== "number" || !Number.isFinite(sortOrder) || Math.abs(sortOrder) > 1_000_000_000_000) {
    throw new ApiError(400, "INVALID_FIELD", "sortOrder must be a finite number between -1000000000000 and 1000000000000");
  }
  return sortOrder;
}

function normalizeThreadInput(threadId, threadBinding) {
  if (threadId !== undefined && (typeof threadId !== "string" || threadId.length === 0)) {
    throw new ApiError(400, "INVALID_FIELD", "threadId must be a non-empty string when supplied");
  }
  if (threadBinding !== undefined && threadBinding !== null) {
    if (!threadBinding || typeof threadBinding !== "object" || Array.isArray(threadBinding)) {
      throw new ApiError(400, "INVALID_FIELD", "threadBinding must be an object or null");
    }
    const fields = ["threadId", "codexProjectId", "codexProjectKind", "codexHostId", "workspacePath"];
    if (Object.keys(threadBinding).some((field) => !fields.includes(field)) || fields.some((field) => typeof threadBinding[field] !== "string" || threadBinding[field].length === 0)) {
      throw new ApiError(400, "INVALID_FIELD", "threadBinding is incomplete");
    }
  }
  return { threadId, threadBinding };
}

function transitionRequestFingerprint(taskId, command, sortOrder, threadInput) {
  return canonicalJson({
    taskId,
    expectedStateVersion: command.expectedStateVersion,
    actionKey: command.actionKey,
    gateEvidence: command.gateEvidence,
    authorizationId: command.authorizationId,
    sortOrder: sortOrder ?? null,
    thread: {
      hasThreadId: threadInput.threadId !== undefined,
      threadId: threadInput.threadId ?? null,
      hasThreadBinding: threadInput.threadBinding !== undefined,
      threadBinding: threadInput.threadBinding ?? null,
    },
  });
}

function existingThreadBinding(task) {
  if (
    !task.thread_id
    || !task.thread_codex_project_id
    || !task.thread_codex_project_kind
    || !task.thread_codex_host_id
    || !task.thread_workspace_path
  ) return null;
  return {
    threadId: task.thread_id,
    codexProjectId: task.thread_codex_project_id,
    codexProjectKind: task.thread_codex_project_kind,
    codexHostId: task.thread_codex_host_id,
    workspacePath: task.thread_workspace_path,
  };
}

function resolveThreadStorage(task, threadInput) {
  if (threadInput.threadId === undefined && threadInput.threadBinding === undefined) return null;
  const currentBinding = existingThreadBinding(task);
  const binding = threadInput.threadBinding === undefined
    ? (currentBinding && currentBinding.threadId === threadInput.threadId
      ? currentBinding
      : { threadId: threadInput.threadId })
    : threadInput.threadBinding;
  return [
    binding?.threadId ?? null,
    binding?.codexProjectId ?? null,
    binding?.codexProjectKind ?? null,
    binding?.codexHostId ?? null,
    binding?.workspacePath ?? null,
  ];
}

function requestMatchesEvent(row, event) {
  return (
    event.eventType === "transition.requested"
    && event.eventId === row.event_id
    && event.eventHash === row.event_hash
    && event.workflowId === row.workflow_id
    && event.revisionId === row.revision_id
    && event.aggregateType === "task"
    && event.aggregateId === row.task_id
    && event.idempotencyKey === row.idempotency_key
    && event.payload.transitionId === row.transition_id
    && event.payload.target.type === "task"
    && event.payload.target.id === row.task_id
  );
}

/**
 * Local-only coordinator. The callback passed to WorkflowLedger.append runs
 * inside the ledger's transaction, so the task write, request, projections,
 * event, and outbox commit or roll back together without nested BEGIN calls.
 */
export class TransitionService {
  constructor(taskboardDatabase, { clock = now } = {}) {
    this.taskboardDatabase = taskboardDatabase;
    this.database = taskboardDatabase.database;
    this.ledger = new WorkflowLedger(this.database, { now: clock });
    this.clock = clock;
  }

  listActions(taskId) {
    this.#ensureDefinitions();
    const context = this.#taskContext(taskId);
    return this.database.prepare(`
      SELECT * FROM workflow_transition_rules
      WHERE revision_id = ? AND from_task_stage_id = ?
      ORDER BY action_key
    `).all(context.pin.revision_id, context.task.stage_id).map(ruleFromRow);
  }

  getTaskWorkflow(taskId) {
    this.#ensureDefinitions();
    const context = this.#taskContext(taskId);
    return {
      workflowId: context.pin.workflow_id,
      revisionId: context.pin.revision_id,
      revision: context.revision.revision,
      definition: context.definition,
    };
  }

  transition(taskId, input, {
    actor,
    sortOrder = undefined,
    threadId = undefined,
    threadBinding = undefined,
  } = {}) {
    this.#ensureDefinitions();
    let command;
    try {
      command = normalizeTransitionCommand(input);
    } catch (error) {
      throw apiError(error);
    }
    sortOrder = normalizeSortOrder(sortOrder);
    const threadInput = normalizeThreadInput(threadId, threadBinding);
    const requestFingerprint = transitionRequestFingerprint(taskId, command, sortOrder, threadInput);
    const existing = this.database.prepare(`
      SELECT * FROM workflow_transition_requests WHERE idempotency_key = ?
    `).get(command.idempotencyKey);
    if (existing) return this.#idempotentResult(existing, taskId, command, requestFingerprint);

    const context = this.#taskContext(taskId);
    const ruleRow = this.database.prepare(`
      SELECT * FROM workflow_transition_rules
      WHERE revision_id = ? AND action_key = ?
    `).get(context.pin.revision_id, command.actionKey);
    if (!ruleRow) {
      throw new ApiError(400, TRANSITION_ERROR_CODES.ACTION_NOT_FOUND, "actionKey is not defined by the task's pinned workflow");
    }
    const rule = ruleFromRow(ruleRow);
    const timestamp = this.clock();
    const eventInput = {
      schemaVersion: 1,
      eventType: "transition.requested",
      occurredAt: timestamp,
      workflowId: context.pin.workflow_id,
      revisionId: context.pin.revision_id,
      aggregateType: "task",
      aggregateId: taskId,
      correlationId: randomUUID(),
      causationId: null,
      idempotencyKey: command.idempotencyKey,
      payload: {
        transitionId: rule.transitionId,
        fromStageId: rule.fromContractStageId,
        toStageId: rule.toContractStageId,
        target: { type: "task", id: taskId },
      },
    };
    let applied = null;
    let ledgerResult;
    try {
      ledgerResult = this.ledger.append(eventInput, {
        project: (previous, event) => {
          applied = this.#applyInsideLedger({
            taskId,
            command,
            actor,
            sortOrder,
            threadInput,
            event,
            previousProjection: previous,
          });
          return {
            ...(previous ?? {}),
            lastEventType: event.eventType,
            payload: event.payload,
            task: {
              id: taskId,
              stageId: applied.stageId,
              status: applied.status,
              version: applied.version,
            },
          };
        },
      });
    } catch (error) {
      throw apiError(error);
    }
    if (ledgerResult.idempotent) {
      const request = this.database.prepare(`
        SELECT * FROM workflow_transition_requests WHERE idempotency_key = ?
      `).get(command.idempotencyKey);
      if (!request) {
        throw new ApiError(409, WORKFLOW_ERROR_CODES.IDEMPOTENCY_CONFLICT, "Ledger event exists without its transition request");
      }
      return this.#idempotentResult(request, taskId, command, requestFingerprint);
    }
    const request = this.database.prepare(`
      SELECT * FROM workflow_transition_requests WHERE idempotency_key = ?
    `).get(command.idempotencyKey);
    return {
      idempotent: false,
      task: this.taskboardDatabase.getTask(taskId),
      request: requestFromRow(request),
      event: ledgerResult.event,
      automationRun: applied.automationRun,
    };
  }

  transitionLegacy(taskId, {
    expectedStateVersion,
    status,
    stageId,
    idempotencyKey,
    actor,
    sortOrder = undefined,
    threadId = undefined,
    threadBinding = undefined,
  }) {
    this.#ensureDefinitions();
    const context = this.#taskContext(taskId);
    const target = stageId
      ? this.database.prepare(`
        SELECT bindings.* FROM workflow_revision_stage_bindings AS bindings
        WHERE bindings.revision_id = ? AND bindings.task_stage_id = ?
      `).get(context.pin.revision_id, stageId)
      : this.database.prepare(`
        SELECT bindings.*
        FROM workflow_revision_stage_bindings AS bindings
        JOIN workflow_stages AS stages ON stages.id = bindings.task_stage_id
        WHERE bindings.revision_id = ?
          AND bindings.canonical_status = ?
          AND stages.active = 1
          AND stages.is_default_for_status = 1
      `).get(context.pin.revision_id, status);
    if (!target || (status !== undefined && target.canonical_status !== status)) {
      throw new ApiError(400, TRANSITION_ERROR_CODES.ACTION_NOT_FOUND, "Legacy destination is not available in the pinned workflow");
    }
    if (target.task_stage_id === context.task.stage_id) {
      throw new ApiError(409, TRANSITION_ERROR_CODES.ACTION_NOT_FOUND, "Legacy transition must change the task stage");
    }
    const rule = this.database.prepare(`
      SELECT * FROM workflow_transition_rules
      WHERE revision_id = ? AND from_task_stage_id = ? AND to_task_stage_id = ? AND legacy = 1
    `).get(context.pin.revision_id, context.task.stage_id, target.task_stage_id);
    if (!rule) {
      throw new ApiError(409, TRANSITION_ERROR_CODES.ACTION_NOT_FOUND, "Legacy transition is not defined by the pinned workflow");
    }
    return this.transition(taskId, {
      expectedStateVersion,
      actionKey: rule.action_key,
      gateEvidence: [],
      authorizationId: null,
      idempotencyKey,
    }, { actor, sortOrder, threadId, threadBinding });
  }

  storeAuthorization(value) {
    let authorization;
    try {
      authorization = normalizeHumanAuthorization(value);
    } catch (error) {
      throw apiError(error);
    }
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.database.prepare(`
        SELECT authorization_json FROM workflow_authorizations WHERE authorization_id = ?
      `).get(authorization.authorizationId);
      const serialized = JSON.stringify(authorization);
      if (existing && existing.authorization_json !== serialized) {
        throw new ApiError(409, WORKFLOW_ERROR_CODES.IDEMPOTENCY_CONFLICT, "authorizationId already stores different authorization data");
      }
      if (!existing) {
        this.database.prepare(`
          INSERT INTO workflow_authorizations (
            authorization_id, workflow_id, revision_id, authorization_json, created_at
          ) VALUES (?, ?, ?, ?, ?)
        `).run(
          authorization.authorizationId, authorization.scope.workflowId,
          authorization.scope.revisionId, serialized, this.clock(),
        );
      }
      this.database.exec("COMMIT");
      return authorization;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw apiError(error);
    }
  }

  publishRevision({ projectId, definition, bindings, rules }) {
    let normalized;
    try {
      normalized = normalizeWorkflowRevision(definition);
    } catch (error) {
      throw apiError(error);
    }
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const workflow = this.database.prepare(`
        SELECT * FROM workflow_definitions WHERE project_id = ?
      `).get(projectId);
      if (!workflow || workflow.workflow_id !== normalized.workflowId) {
        throw new ApiError(404, "WORKFLOW_NOT_FOUND", "Workflow definition does not match the project");
      }
      const previous = this.database.prepare(`
        SELECT definition_json FROM workflow_revisions WHERE revision_id = ?
      `).get(workflow.current_revision_id);
      assertWorkflowRevisionPublication(JSON.parse(previous.definition_json), normalized);
      const transitionIds = new Set(normalized.transitions.map((transition) => transition.transitionId));
      const stageIds = new Set(normalized.stages.map((stage) => stage.stageId));
      if (!Array.isArray(bindings) || !Array.isArray(rules)) {
        throw new ApiError(400, "INVALID_FIELD", "bindings and rules must be arrays");
      }
      if (bindings.length !== normalized.stages.length || new Set(bindings.map((binding) => binding.contractStageId)).size !== bindings.length) {
        throw new ApiError(400, "INVALID_FIELD", "Every contract stage requires exactly one task stage binding");
      }
      if (bindings.some((binding) => !stageIds.has(binding.contractStageId))) {
        throw new ApiError(400, "INVALID_FIELD", "A binding references an unknown contract stage");
      }
      if (rules.some((rule) => !transitionIds.has(rule.transitionId) || !stageIds.has(rule.fromContractStageId) || !stageIds.has(rule.toContractStageId))) {
        throw new ApiError(400, "INVALID_FIELD", "A rule does not match the immutable revision definition");
      }
      const timestamp = this.clock();
      this.database.prepare(`
        INSERT INTO workflow_revisions (revision_id, workflow_id, revision, definition_json, immutable, created_at)
        VALUES (?, ?, ?, ?, 1, ?)
      `).run(normalized.revisionId, normalized.workflowId, normalized.revision, JSON.stringify(normalized), timestamp);
      const insertBinding = this.database.prepare(`
        INSERT INTO workflow_revision_stage_bindings (
          revision_id, contract_stage_id, task_stage_id, canonical_status, terminal_kind, stage_order
        ) VALUES (?, ?, ?, ?, ?, ?)
      `);
      for (const binding of bindings) {
        insertBinding.run(normalized.revisionId, binding.contractStageId, binding.taskStageId, binding.canonicalStatus, binding.terminalKind, binding.order);
      }
      const insertRule = this.database.prepare(`
        INSERT INTO workflow_transition_rules (
          revision_id, action_key, transition_id, from_task_stage_id, to_task_stage_id,
          from_contract_stage_id, to_contract_stage_id, to_terminal_kind, legacy
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const rule of rules) {
        insertRule.run(
          normalized.revisionId, rule.actionKey, rule.transitionId, rule.fromTaskStageId,
          rule.toTaskStageId, rule.fromContractStageId, rule.toContractStageId,
          rule.toTerminalKind, rule.legacy ? 1 : 0,
        );
      }
      this.database.prepare(`
        UPDATE workflow_definitions SET current_revision_id = ?, updated_at = ? WHERE workflow_id = ?
      `).run(normalized.revisionId, timestamp, normalized.workflowId);
      this.database.exec("COMMIT");
      return normalized;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw apiError(error);
    }
  }

  #ensureDefinitions() {
    migrateLocalWorkflowTransitions(this.database);
  }

  #taskContext(taskId) {
    const task = this.database.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId);
    if (!task) throw new ApiError(404, "TASK_NOT_FOUND", `Task '${taskId}' does not exist`);
    const pin = this.database.prepare("SELECT * FROM workflow_task_pins WHERE task_id = ?").get(taskId);
    if (!pin) throw new ApiError(409, TRANSITION_ERROR_CODES.WORKFLOW_PIN_MISSING, "Task has no pinned workflow revision");
    const revision = this.database.prepare("SELECT * FROM workflow_revisions WHERE revision_id = ?").get(pin.revision_id);
    if (!revision) throw new ApiError(409, TRANSITION_ERROR_CODES.WORKFLOW_PIN_MISSING, "Pinned workflow revision is unavailable");
    return { task, pin, revision, definition: normalizeWorkflowRevision(JSON.parse(revision.definition_json)) };
  }

  #idempotentResult(row, taskId, command, requestFingerprint) {
    if (
      row.task_id !== taskId
      || row.expected_state_version !== command.expectedStateVersion
      || row.action_key !== command.actionKey
      || row.request_fingerprint !== requestFingerprint
    ) {
      throw new ApiError(409, WORKFLOW_ERROR_CODES.IDEMPOTENCY_CONFLICT, "Idempotency-Key was already used for a different transition request");
    }
    try {
      this.ledger.audit();
    } catch (error) {
      throw apiError(error);
    }
    const eventRow = this.database.prepare(`
      SELECT envelope_json FROM workflow_ledger_events WHERE event_id = ?
    `).get(row.event_id);
    if (!eventRow) {
      throw new ApiError(409, WORKFLOW_ERROR_CODES.LEDGER_HASH_INVALID, "Transition request points to a missing ledger event");
    }
    const event = JSON.parse(eventRow.envelope_json);
    if (!requestMatchesEvent(row, event)) {
      throw new ApiError(409, WORKFLOW_ERROR_CODES.LEDGER_HASH_INVALID, "Transition request does not match its ledger event");
    }
    return {
      idempotent: true,
      task: this.taskboardDatabase.getTask(taskId),
      request: requestFromRow(row),
      event,
      automationRun: (() => {
        const run = this.database.prepare(`
          SELECT * FROM workflow_automation_runs WHERE transition_event_id = ?
        `).get(row.event_id);
        return run ? automationRunFromRow(run) : null;
      })(),
    };
  }

  #applyInsideLedger({ taskId, command, actor, sortOrder, threadInput, event, previousProjection }) {
    const context = this.#taskContext(taskId);
    const ruleRow = this.database.prepare(`
      SELECT * FROM workflow_transition_rules WHERE revision_id = ? AND action_key = ?
    `).get(context.pin.revision_id, command.actionKey);
    const rule = ruleRow ? ruleFromRow(ruleRow) : null;
    let authorization = null;
    if (command.authorizationId !== null) {
      const row = this.database.prepare(`
        SELECT authorization_json FROM workflow_authorizations WHERE authorization_id = ?
      `).get(command.authorizationId);
      if (!row) {
        throw new ApiError(409, WORKFLOW_ERROR_CODES.HUMAN_AUTH_REQUIRED, "Referenced human authorization was not found");
      }
      authorization = normalizeHumanAuthorization(JSON.parse(row.authorization_json));
    }
    const descendants = this.database.prepare(`
      WITH RECURSIVE descendants(task_id, required_path) AS (
        SELECT target_task_id,
          CASE WHEN json_extract(metadata, '$.required') = 1 THEN 1 ELSE 0 END
        FROM task_relations
        WHERE relation_type = 'parent' AND source_task_id = ?
        UNION ALL
        SELECT relations.target_task_id,
          CASE
            WHEN descendants.required_path = 1 AND json_extract(relations.metadata, '$.required') = 1
            THEN 1 ELSE 0
          END
        FROM task_relations AS relations
        JOIN descendants ON descendants.task_id = relations.source_task_id
        WHERE relations.relation_type = 'parent'
      )
      SELECT descendants.task_id, descendants.required_path, tasks.status
      FROM descendants JOIN tasks ON tasks.id = descendants.task_id
    `).all(taskId).map((row) => ({
      taskId: row.task_id,
      required: row.required_path === 1,
      status: row.status,
    }));
    let allowed;
    try {
      allowed = evaluatePinnedTransition({
        revision: context.definition,
        rule,
        task: { id: context.task.id, stageId: context.task.stage_id, version: context.task.version, archivedAt: context.task.archived_at },
        command: { ...command, occurredAt: event.occurredAt },
        authorization,
        descendants,
      });
    } catch (error) {
      throw apiError(error);
    }
    const destination = this.database.prepare(`
      SELECT * FROM workflow_revision_stage_bindings
      WHERE revision_id = ? AND task_stage_id = ?
    `).get(context.pin.revision_id, rule.toTaskStageId);
    if (!destination) throw new ApiError(409, TRANSITION_ERROR_CODES.ACTION_NOT_FOUND, "Transition destination binding is unavailable");
    const nextSortOrder = sortOrder ?? this.database.prepare(`
      SELECT MIN(sort_order) AS minimum FROM tasks
      WHERE project_id = ? AND stage_id = ? AND archived_at IS NULL AND id != ?
    `).get(context.task.project_id, destination.task_stage_id, taskId).minimum;
    const resolvedSortOrder = sortOrder ?? (nextSortOrder === null ? 1000 : nextSortOrder - 1000);
    const timestamp = this.clock();
    this.database.prepare(`
      INSERT INTO workflow_transition_requests (
        request_id, task_id, idempotency_key, request_fingerprint, expected_state_version, action_key,
        workflow_id, revision_id, transition_id, from_stage_id, to_stage_id,
        event_id, event_hash, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      randomUUID(), taskId, command.idempotencyKey,
      transitionRequestFingerprint(taskId, command, sortOrder, threadInput), command.expectedStateVersion,
      rule.actionKey, context.pin.workflow_id, context.pin.revision_id, rule.transitionId,
      rule.fromTaskStageId, rule.toTaskStageId, event.eventId, event.eventHash, timestamp,
    );
    const threadStorage = resolveThreadStorage(context.task, threadInput);
    const threadAssignments = threadStorage
      ? `thread_id = ?, thread_codex_project_id = ?, thread_codex_project_kind = ?,
        thread_codex_host_id = ?, thread_workspace_path = ?,`
      : "";
    const update = this.database.prepare(`
      UPDATE tasks
      SET status = ?, stage_id = ?, sort_order = ?, ${threadAssignments} version = version + 1, updated_at = ?
      WHERE id = ? AND version = ?
    `).run(
      destination.canonical_status, destination.task_stage_id, resolvedSortOrder,
      ...(threadStorage ?? []), timestamp, taskId, context.task.version,
    );
    if (update.changes !== 1) {
      throw new ApiError(409, TRANSITION_ERROR_CODES.EXPECTED_STATE_CONFLICT, "Task changed during transition application");
    }
    this.database.prepare(`
      INSERT INTO task_activities (
        id, task_id, actor_type, actor_id, actor_name, actor_avatar_url, changes, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      randomUUID(), taskId, actor?.type ?? "user", actor?.id ?? "local-user",
      actor?.name ?? "Local user", actor?.avatarUrl ?? null,
      JSON.stringify([
        { field: "status", before: context.task.status, after: destination.canonical_status },
        { field: "stageId", before: context.task.stage_id, after: destination.task_stage_id },
        ...(threadStorage && context.task.thread_id !== threadStorage[0]
          ? [{ field: "threadId", before: context.task.thread_id, after: threadStorage[0] }]
          : []),
      ]), timestamp,
    );
    const nextSequence = (this.database.prepare("SELECT last_sequence FROM workflow_ledger_head WHERE singleton = 1").get()?.last_sequence ?? 0) + 1;
    this.database.prepare(`
      INSERT INTO workflow_work_item_projections (
        work_item_id, project_id, status, stage_id, task_version, projection_kind,
        imported_at, source_updated_at, last_event_sequence, last_event_hash
      ) VALUES (?, ?, ?, ?, ?, 'work_item.imported', ?, ?, ?, ?)
      ON CONFLICT(work_item_id) DO UPDATE SET
        status = excluded.status,
        stage_id = excluded.stage_id,
        task_version = excluded.task_version,
        source_updated_at = excluded.source_updated_at,
        last_event_sequence = excluded.last_event_sequence,
        last_event_hash = excluded.last_event_hash
    `).run(
      taskId, context.task.project_id, destination.canonical_status, destination.task_stage_id,
      context.task.version + 1, context.task.created_at, timestamp, nextSequence, event.eventHash,
    );
    const automationRun = createAutomationRunForTransition(this.database, {
      taskId,
      workflowId: context.pin.workflow_id,
      revisionId: context.pin.revision_id,
      taskStageId: destination.task_stage_id,
      contractStageId: destination.contract_stage_id,
      definition: context.definition,
      transitionEvent: event,
      timestamp,
    });
    return {
      status: destination.canonical_status,
      stageId: destination.task_stage_id,
      version: context.task.version + 1,
      allowed,
      previousProjection,
      automationRun,
    };
  }
}
