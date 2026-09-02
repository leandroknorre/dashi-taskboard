import { randomUUID } from "node:crypto";

import {
  defaultStageWorkflowDefinition,
  normalizeStageWorkflowDefinition,
} from "../shared/board-workflow.mjs";
import { DEFAULT_PROJECT_ID, JIRA_PROJECT_ID } from "../shared/domain.mjs";
import { normalizeWorkflowRevision } from "../shared/workflow-control.mjs";
import { legacyActionKey } from "../shared/transition-service.mjs";
import { ApiError } from "./database.mjs";
import { workflowIdForProjectId } from "./workflow-transition-schema.mjs";

function now() {
  return new Date().toISOString();
}

function contractTerminalKind(terminalKind) {
  return terminalKind === "done" ? "completed" : terminalKind;
}

function physicalTerminalKind(terminalKind) {
  return terminalKind === "completed" ? "done" : terminalKind;
}

function contractStageId(taskStageId) {
  return `stage_${taskStageId.replaceAll("-", "")}`;
}

function nextTimestamp(current, candidate) {
  if (Date.parse(candidate) > Date.parse(current)) return candidate;
  return new Date(Date.parse(current) + 1).toISOString();
}

export class WorkflowAuthoringService {
  constructor(taskboardDatabase, transitionService, {
    clock = now,
    idFactory = randomUUID,
  } = {}) {
    this.taskboardDatabase = taskboardDatabase;
    this.database = taskboardDatabase.database;
    this.transitionService = transitionService;
    this.clock = clock;
    this.idFactory = idFactory;
  }

  get(projectId) {
    const project = this.#requireProject(projectId);
    const current = this.#currentRevision(projectId);
    const definition = this.#readAuthoringDefinition(projectId, current);
    return {
      projectId,
      workflowId: current?.definition.workflowId ?? workflowIdForProjectId(projectId),
      revisionId: current?.definition.revisionId ?? null,
      revision: current?.definition.revision ?? 0,
      definition,
      legacyOccupiedStages: this.#legacyOccupiedStages(projectId, current),
      projectUpdatedAt: project.updated_at,
    };
  }

  validate(projectId, { expectedRevisionId, definition }) {
    this.#assertProjectWritable(projectId);
    const plan = this.#plan(projectId, expectedRevisionId, definition);
    return {
      valid: true,
      projectId,
      expectedRevisionId,
      nextRevision: plan.revision.definition.revision,
      definition: plan.validatedDefinition,
      legacyOccupiedStages: plan.legacyOccupiedStages,
    };
  }

  publish(projectId, { expectedRevisionId, definition }) {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.#assertProjectWritable(projectId);
      const plan = this.#plan(projectId, expectedRevisionId, definition);
      const timestamp = this.clock();

      for (const stage of plan.removedStages) {
        this.database.prepare(`
          UPDATE workflow_stages
          SET active = 0, is_default_for_status = 0, board_visible = 0
          WHERE id = ? AND project_id = ?
        `).run(stage.id, projectId);
      }
      for (const stage of plan.stages) {
        if (stage.existing) {
          this.database.prepare(`
            UPDATE workflow_stages
            SET canonical_status = ?, name = ?, stage_order = ?, board_visible = ?,
              active = ?, is_default_for_status = ?, terminal_kind = ?
            WHERE id = ? AND project_id = ?
          `).run(
            stage.canonicalStatus,
            stage.name,
            stage.order,
            Number(stage.boardVisible),
            Number(stage.active),
            Number(stage.isDefaultForStatus),
            stage.terminalKind,
            stage.stageId,
            projectId,
          );
        } else {
          this.database.prepare(`
            INSERT INTO workflow_stages (
              id, project_id, canonical_status, name, stage_order, board_visible,
              active, is_default_for_status, terminal_kind
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            stage.stageId,
            projectId,
            stage.canonicalStatus,
            stage.name,
            stage.order,
            Number(stage.boardVisible),
            Number(stage.active),
            Number(stage.isDefaultForStatus),
            stage.terminalKind,
          );
        }
      }

      const stageWorkflow = this.database.prepare(
        "SELECT version FROM project_stage_workflows WHERE project_id = ?",
      ).get(projectId);
      if (stageWorkflow) {
        this.database.prepare(`
          UPDATE project_stage_workflows
          SET version = version + 1, updated_at = ?
          WHERE project_id = ?
        `).run(timestamp, projectId);
      } else {
        this.database.prepare(`
          INSERT INTO project_stage_workflows (project_id, version, updated_at)
          VALUES (?, 1, ?)
        `).run(projectId, timestamp);
      }

      this.transitionService.publishRevision(plan.revision, { transaction: false });
      this.database.exec("COMMIT");
      return this.get(projectId);
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  renameProject(projectId, { name, expectedUpdatedAt }) {
    if (projectId === DEFAULT_PROJECT_ID) {
      throw new ApiError(409, "PROJECT_RENAME_UNAVAILABLE", "The global project cannot be renamed");
    }
    if (projectId === JIRA_PROJECT_ID) {
      throw new ApiError(409, "PROJECT_RENAME_UNAVAILABLE", "The Jira project name is controlled by synchronization");
    }
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const project = this.#assertProjectWritable(projectId);
      if (project.updated_at !== expectedUpdatedAt) {
        throw new ApiError(409, "PROJECT_UPDATED_AT_CONFLICT", "Project changed since it was loaded", {
          expectedUpdatedAt,
          actualUpdatedAt: project.updated_at,
        });
      }
      if (project.name === name) {
        this.database.exec("COMMIT");
        return this.taskboardDatabase.getProject(projectId);
      }
      const timestamp = nextTimestamp(project.updated_at, this.clock());
      const result = this.database.prepare(`
        UPDATE projects
        SET name = ?, version = version + 1, updated_at = ?
        WHERE id = ? AND updated_at = ? AND archived_at IS NULL
      `).run(name, timestamp, projectId, expectedUpdatedAt);
      if (result.changes !== 1) {
        const current = this.#requireProject(projectId);
        throw new ApiError(409, "PROJECT_UPDATED_AT_CONFLICT", "Project changed since it was loaded", {
          expectedUpdatedAt,
          actualUpdatedAt: current.updated_at,
        });
      }
      this.database.exec("COMMIT");
      return this.taskboardDatabase.getProject(projectId);
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  #plan(projectId, expectedRevisionId, inputDefinition) {
    const current = this.#currentRevision(projectId);
    const actualRevisionId = current?.definition.revisionId ?? null;
    if (actualRevisionId !== expectedRevisionId) {
      throw new ApiError(409, "WORKFLOW_REVISION_CONFLICT", "Workflow changed since it was loaded", {
        expectedRevisionId,
        actualRevisionId,
      });
    }
    const normalized = normalizeStageWorkflowDefinition(
      inputDefinition,
      (message) => new ApiError(400, "INVALID_FIELD", message),
    );
    const existingRows = this.database.prepare(`
      SELECT id, project_id, canonical_status, name, stage_order, board_visible,
        active, is_default_for_status, terminal_kind
      FROM workflow_stages WHERE project_id = ? ORDER BY stage_order, id
    `).all(projectId);
    const existingById = new Map(existingRows.map((stage) => [stage.id, stage]));
    const currentBindings = current
      ? this.database.prepare(`
          SELECT contract_stage_id, task_stage_id, canonical_status, terminal_kind, stage_order
          FROM workflow_revision_stage_bindings
          WHERE revision_id = ?
        `).all(current.definition.revisionId)
      : [];
    const bindingByTaskStageId = new Map(currentBindings.map((binding) => [binding.task_stage_id, binding]));
    const stages = normalized.stages.map((stage) => {
      const requested = stage.stageId ? existingById.get(stage.stageId) : null;
      if (stage.stageId && !requested) {
        throw new ApiError(400, "INVALID_STAGE", "A supplied stage does not belong to this project", {
          stageId: stage.stageId,
        });
      }
      const reusable = requested
        && requested.canonical_status === stage.canonicalStatus
        && requested.terminal_kind === stage.terminalKind;
      const stageId = reusable ? requested.id : this.idFactory();
      const previousBinding = reusable ? bindingByTaskStageId.get(stageId) : null;
      return {
        ...stage,
        stageId,
        existing: Boolean(reusable),
        contractStageId: previousBinding?.contract_stage_id ?? contractStageId(stageId),
      };
    });
    const retainedIds = new Set(stages.map((stage) => stage.stageId));
    const removedStages = existingRows.filter((stage) => !retainedIds.has(stage.id));
    const legacyOccupiedStages = removedStages.flatMap((stage) => {
      const taskCount = Number(this.database.prepare(`
        SELECT COUNT(*) AS count FROM tasks WHERE project_id = ? AND stage_id = ?
      `).get(projectId, stage.id).count);
      return taskCount > 0 ? [{
        stageId: stage.id,
        name: stage.name,
        canonicalStatus: stage.canonical_status,
        terminalKind: stage.terminal_kind,
        taskCount,
      }] : [];
    });
    const timestamp = this.clock();
    const workflowId = current?.definition.workflowId ?? workflowIdForProjectId(projectId);
    const profile = current?.definition.agentProfileRevisions ?? [{
      agentProfileId: "manual",
      agentProfileRevisionId: this.idFactory(),
      revision: 1,
      createdAt: timestamp,
      immutable: true,
      mode: "manual",
    }];
    const acceptanceGate = current?.definition.gates.find((gate) => gate.kind === "acceptance") ?? {
      gateId: "human-acceptance",
      kind: "acceptance",
      requiredEvidenceTypes: ["human_acceptance"],
    };
    const gates = current?.definition.gates.some((gate) => gate.kind === "acceptance")
      ? current.definition.gates
      : [...(current?.definition.gates ?? []), acceptanceGate];
    const active = stages.filter((stage) => stage.active);
    const transitions = [];
    const rules = [];
    for (const from of active) {
      for (const to of active) {
        if (from.stageId === to.stageId) continue;
        const actionKey = legacyActionKey(from.order, to.order);
        const requiresAcceptance = to.terminalKind === "done";
        transitions.push({
          transitionId: actionKey,
          fromStageId: from.contractStageId,
          toStageId: to.contractStageId,
          requiresAcceptance,
          irreversible: false,
          gateIds: requiresAcceptance ? [acceptanceGate.gateId] : [],
          authorization: { required: false, action: null },
        });
        rules.push({
          actionKey,
          transitionId: actionKey,
          fromTaskStageId: from.stageId,
          toTaskStageId: to.stageId,
          fromContractStageId: from.contractStageId,
          toContractStageId: to.contractStageId,
          toTerminalKind: contractTerminalKind(to.terminalKind),
          legacy: true,
        });
      }
    }
    const definition = normalizeWorkflowRevision({
      schemaVersion: 1,
      workflowId,
      revisionId: this.idFactory(),
      revision: (current?.definition.revision ?? 0) + 1,
      createdAt: timestamp,
      immutable: true,
      agentProfileRevisions: profile,
      stages: stages.map((stage) => ({
        stageId: stage.contractStageId,
        name: stage.name,
        terminalKind: contractTerminalKind(stage.terminalKind),
        agentProfileRevisionId: profile[0].agentProfileRevisionId,
      })),
      gates,
      transitions,
    });
    const bindings = stages.map((stage) => ({
      contractStageId: stage.contractStageId,
      taskStageId: stage.stageId,
      canonicalStatus: stage.canonicalStatus,
      terminalKind: contractTerminalKind(stage.terminalKind),
      order: stage.order,
    }));
    return {
      stages,
      removedStages,
      legacyOccupiedStages,
      validatedDefinition: normalized,
      authoringDefinition: {
        schemaVersion: 2,
        stages: stages.map(({ existing: _existing, contractStageId: _contractStageId, ...stage }) => stage),
      },
      revision: { projectId, definition, bindings, rules },
    };
  }

  #readAuthoringDefinition(projectId, current) {
    if (!current) {
      const rows = this.database.prepare(`
        SELECT id, canonical_status, name, stage_order, board_visible, active,
          is_default_for_status, terminal_kind
        FROM workflow_stages WHERE project_id = ? ORDER BY stage_order, id
      `).all(projectId);
      if (rows.length === 0) return defaultStageWorkflowDefinition();
      return { schemaVersion: 2, stages: rows.map((row) => this.#stageFromRow(row)) };
    }
    const rows = this.database.prepare(`
      SELECT stages.id, bindings.canonical_status, stages.name,
        bindings.stage_order, stages.board_visible, stages.active,
        stages.is_default_for_status, bindings.terminal_kind
      FROM workflow_revision_stage_bindings AS bindings
      JOIN workflow_stages AS stages ON stages.id = bindings.task_stage_id
      WHERE bindings.revision_id = ?
      ORDER BY bindings.stage_order, stages.id
    `).all(current.definition.revisionId);
    return { schemaVersion: 2, stages: rows.map((row) => this.#stageFromRow(row)) };
  }

  #stageFromRow(row) {
    return {
      stageId: row.id,
      canonicalStatus: row.canonical_status,
      name: row.name,
      order: row.stage_order,
      boardVisible: Boolean(row.board_visible),
      active: Boolean(row.active),
      isDefaultForStatus: Boolean(row.is_default_for_status),
      terminalKind: physicalTerminalKind(row.terminal_kind),
    };
  }

  #legacyOccupiedStages(projectId, current) {
    if (!current) return [];
    return this.database.prepare(`
      SELECT stages.id, stages.name, stages.canonical_status, stages.terminal_kind,
        COUNT(tasks.id) AS task_count
      FROM workflow_stages AS stages
      JOIN tasks ON tasks.project_id = stages.project_id AND tasks.stage_id = stages.id
      WHERE stages.project_id = ?
        AND NOT EXISTS (
          SELECT 1 FROM workflow_revision_stage_bindings AS bindings
          WHERE bindings.revision_id = ? AND bindings.task_stage_id = stages.id
        )
      GROUP BY stages.id, stages.name, stages.canonical_status, stages.terminal_kind
      ORDER BY stages.stage_order, stages.id
    `).all(projectId, current.definition.revisionId).map((row) => ({
      stageId: row.id,
      name: row.name,
      canonicalStatus: row.canonical_status,
      terminalKind: row.terminal_kind,
      taskCount: Number(row.task_count),
    }));
  }

  #currentRevision(projectId) {
    const row = this.database.prepare(`
      SELECT revisions.definition_json
      FROM workflow_definitions AS workflows
      JOIN workflow_revisions AS revisions
        ON revisions.revision_id = workflows.current_revision_id
      WHERE workflows.project_id = ?
    `).get(projectId);
    return row ? { definition: normalizeWorkflowRevision(JSON.parse(row.definition_json)) } : null;
  }

  #requireProject(projectId) {
    const project = this.database.prepare("SELECT * FROM projects WHERE id = ?").get(projectId);
    if (!project) throw new ApiError(404, "PROJECT_NOT_FOUND", `Project '${projectId}' does not exist`);
    return project;
  }

  #assertProjectWritable(projectId) {
    const project = this.#requireProject(projectId);
    if (project.archived_at !== null) {
      throw new ApiError(409, "PROJECT_ARCHIVED", "Archived projects are read-only until they are restored", {
        projectId,
        archivedAt: project.archived_at,
      });
    }
    return project;
  }
}
