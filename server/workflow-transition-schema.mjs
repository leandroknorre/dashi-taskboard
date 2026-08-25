import { createHash, randomUUID } from "node:crypto";

import { normalizeWorkflowRevision } from "../shared/workflow-control.mjs";
import { legacyActionKey } from "../shared/transition-service.mjs";

function now() {
  return new Date().toISOString();
}

function workflowIdForProject(projectId) {
  return `workflow_${createHash("sha256").update(projectId).digest("hex").slice(0, 24)}`;
}

function contractTerminalKind(stage) {
  return stage.terminal_kind === "done"
    ? "completed"
    : stage.terminal_kind === "canceled"
      ? "canceled"
      : "none";
}

function workflowSnapshot(workflowId, stages, timestamp) {
  const revisionId = randomUUID();
  const agentProfileRevisionId = randomUUID();
  const bindings = stages.map((stage, index) => ({
    taskStageId: stage.id,
    contractStageId: `stage_${index + 1}`,
    canonicalStatus: stage.canonical_status,
    terminalKind: contractTerminalKind(stage),
    order: index + 1,
  }));
  const transitions = [];
  const rules = [];
  for (const from of bindings) {
    for (const to of bindings) {
      if (from.taskStageId === to.taskStageId) continue;
      const actionKey = legacyActionKey(from.order, to.order);
      const requiresAcceptance = to.terminalKind === "completed";
      transitions.push({
        transitionId: actionKey,
        fromStageId: from.contractStageId,
        toStageId: to.contractStageId,
        requiresAcceptance,
        irreversible: false,
        gateIds: requiresAcceptance ? ["human-acceptance"] : [],
        authorization: { required: false, action: null },
      });
      rules.push({
        actionKey,
        transitionId: actionKey,
        fromTaskStageId: from.taskStageId,
        toTaskStageId: to.taskStageId,
        fromContractStageId: from.contractStageId,
        toContractStageId: to.contractStageId,
        toTerminalKind: to.terminalKind,
        legacy: true,
      });
    }
  }
  // The contract requires at least one declared transition even for a one-stage workflow.
  if (transitions.length === 0 && bindings.length === 1) {
    transitions.push({
      transitionId: "stay_stage_1",
      fromStageId: bindings[0].contractStageId,
      toStageId: bindings[0].contractStageId,
      requiresAcceptance: false,
      irreversible: false,
      gateIds: [],
      authorization: { required: false, action: null },
    });
  }
  const definition = normalizeWorkflowRevision({
    schemaVersion: 1,
    workflowId,
    revisionId,
    revision: 1,
    createdAt: timestamp,
    immutable: true,
    agentProfileRevisions: [{
      agentProfileId: "manual",
      agentProfileRevisionId,
      revision: 1,
      createdAt: timestamp,
      immutable: true,
      mode: "manual",
    }],
    stages: bindings.map((binding) => ({
      stageId: binding.contractStageId,
      name: binding.contractStageId.replace("_", " "),
      terminalKind: binding.terminalKind,
      agentProfileRevisionId,
    })),
    gates: [{
      gateId: "human-acceptance",
      kind: "acceptance",
      requiredEvidenceTypes: ["human_acceptance"],
    }],
    transitions,
  });
  return { definition, bindings, rules };
}

export const WORKFLOW_TRANSITION_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS workflow_definitions (
    workflow_id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL UNIQUE REFERENCES projects(id) ON DELETE CASCADE,
    current_revision_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS workflow_revisions (
    revision_id TEXT PRIMARY KEY,
    workflow_id TEXT NOT NULL REFERENCES workflow_definitions(workflow_id) ON DELETE CASCADE,
    revision INTEGER NOT NULL CHECK (revision > 0),
    definition_json TEXT NOT NULL,
    immutable INTEGER NOT NULL CHECK (immutable = 1),
    created_at TEXT NOT NULL,
    UNIQUE (workflow_id, revision)
  );
  CREATE TRIGGER IF NOT EXISTS workflow_revisions_prevent_replace_collision
  BEFORE INSERT ON workflow_revisions
  WHEN EXISTS (
    SELECT 1 FROM workflow_revisions
    WHERE revision_id = NEW.revision_id
      OR (workflow_id = NEW.workflow_id AND revision = NEW.revision)
  )
  BEGIN SELECT RAISE(ABORT, 'WORKFLOW_REVISION_IMMUTABLE'); END;
  CREATE TRIGGER IF NOT EXISTS workflow_revisions_immutable_update
  BEFORE UPDATE ON workflow_revisions
  BEGIN SELECT RAISE(ABORT, 'WORKFLOW_REVISION_IMMUTABLE'); END;
  CREATE TRIGGER IF NOT EXISTS workflow_revisions_immutable_delete
  BEFORE DELETE ON workflow_revisions
  WHEN EXISTS (
    SELECT 1 FROM workflow_definitions WHERE workflow_id = OLD.workflow_id
  )
  BEGIN SELECT RAISE(ABORT, 'WORKFLOW_REVISION_IMMUTABLE'); END;

  CREATE TABLE IF NOT EXISTS workflow_revision_stage_bindings (
    revision_id TEXT NOT NULL REFERENCES workflow_revisions(revision_id) ON DELETE CASCADE,
    contract_stage_id TEXT NOT NULL,
    task_stage_id TEXT NOT NULL REFERENCES workflow_stages(id),
    canonical_status TEXT NOT NULL,
    terminal_kind TEXT NOT NULL CHECK (terminal_kind IN ('none', 'completed', 'canceled')),
    stage_order INTEGER NOT NULL,
    PRIMARY KEY (revision_id, contract_stage_id),
    UNIQUE (revision_id, task_stage_id)
  );
  CREATE TRIGGER IF NOT EXISTS workflow_revision_stage_bindings_prevent_replace_collision
  BEFORE INSERT ON workflow_revision_stage_bindings
  WHEN EXISTS (
    SELECT 1 FROM workflow_revision_stage_bindings
    WHERE (revision_id = NEW.revision_id AND contract_stage_id = NEW.contract_stage_id)
      OR (revision_id = NEW.revision_id AND task_stage_id = NEW.task_stage_id)
  )
  BEGIN SELECT RAISE(ABORT, 'WORKFLOW_REVISION_IMMUTABLE'); END;
  CREATE TRIGGER IF NOT EXISTS workflow_revision_stage_bindings_immutable_update
  BEFORE UPDATE ON workflow_revision_stage_bindings
  BEGIN SELECT RAISE(ABORT, 'WORKFLOW_REVISION_IMMUTABLE'); END;
  CREATE TRIGGER IF NOT EXISTS workflow_revision_stage_bindings_immutable_delete
  BEFORE DELETE ON workflow_revision_stage_bindings
  WHEN EXISTS (
    SELECT 1 FROM workflow_revisions WHERE revision_id = OLD.revision_id
  )
  BEGIN SELECT RAISE(ABORT, 'WORKFLOW_REVISION_IMMUTABLE'); END;
  CREATE TABLE IF NOT EXISTS workflow_transition_rules (
    revision_id TEXT NOT NULL REFERENCES workflow_revisions(revision_id) ON DELETE CASCADE,
    action_key TEXT NOT NULL,
    transition_id TEXT NOT NULL,
    from_task_stage_id TEXT NOT NULL REFERENCES workflow_stages(id),
    to_task_stage_id TEXT NOT NULL REFERENCES workflow_stages(id),
    from_contract_stage_id TEXT NOT NULL,
    to_contract_stage_id TEXT NOT NULL,
    to_terminal_kind TEXT NOT NULL CHECK (to_terminal_kind IN ('none', 'completed', 'canceled')),
    legacy INTEGER NOT NULL DEFAULT 0 CHECK (legacy IN (0, 1)),
    PRIMARY KEY (revision_id, action_key),
    UNIQUE (revision_id, transition_id)
  );
  CREATE TRIGGER IF NOT EXISTS workflow_transition_rules_prevent_replace_collision
  BEFORE INSERT ON workflow_transition_rules
  WHEN EXISTS (
    SELECT 1 FROM workflow_transition_rules
    WHERE (revision_id = NEW.revision_id AND action_key = NEW.action_key)
      OR (revision_id = NEW.revision_id AND transition_id = NEW.transition_id)
  )
  BEGIN SELECT RAISE(ABORT, 'WORKFLOW_REVISION_IMMUTABLE'); END;
  CREATE TRIGGER IF NOT EXISTS workflow_transition_rules_immutable_update
  BEFORE UPDATE ON workflow_transition_rules
  BEGIN SELECT RAISE(ABORT, 'WORKFLOW_REVISION_IMMUTABLE'); END;
  CREATE TRIGGER IF NOT EXISTS workflow_transition_rules_immutable_delete
  BEFORE DELETE ON workflow_transition_rules
  WHEN EXISTS (
    SELECT 1 FROM workflow_revisions WHERE revision_id = OLD.revision_id
  )
  BEGIN SELECT RAISE(ABORT, 'WORKFLOW_REVISION_IMMUTABLE'); END;

  CREATE TABLE IF NOT EXISTS workflow_task_pins (
    task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
    workflow_id TEXT NOT NULL REFERENCES workflow_definitions(workflow_id),
    revision_id TEXT NOT NULL REFERENCES workflow_revisions(revision_id),
    pinned_at TEXT NOT NULL
  );
  CREATE TRIGGER IF NOT EXISTS workflow_task_pins_prevent_replace_collision
  BEFORE INSERT ON workflow_task_pins
  WHEN EXISTS (SELECT 1 FROM workflow_task_pins WHERE task_id = NEW.task_id)
  BEGIN SELECT RAISE(ABORT, 'WORKFLOW_PIN_IMMUTABLE'); END;
  CREATE TRIGGER IF NOT EXISTS workflow_task_pins_immutable_update
  BEFORE UPDATE ON workflow_task_pins
  BEGIN SELECT RAISE(ABORT, 'WORKFLOW_PIN_IMMUTABLE'); END;
  CREATE TRIGGER IF NOT EXISTS workflow_task_pins_immutable_delete
  BEFORE DELETE ON workflow_task_pins
  WHEN EXISTS (
    SELECT 1 FROM tasks WHERE id = OLD.task_id
  )
  BEGIN SELECT RAISE(ABORT, 'WORKFLOW_PIN_IMMUTABLE'); END;

  CREATE TABLE IF NOT EXISTS workflow_transition_requests (
    request_id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    idempotency_key TEXT NOT NULL UNIQUE,
    request_fingerprint TEXT NOT NULL,
    expected_state_version INTEGER NOT NULL,
    action_key TEXT NOT NULL,
    workflow_id TEXT NOT NULL,
    revision_id TEXT NOT NULL,
    transition_id TEXT NOT NULL,
    from_stage_id TEXT NOT NULL,
    to_stage_id TEXT NOT NULL,
    event_id TEXT NOT NULL UNIQUE REFERENCES workflow_ledger_events(event_id) DEFERRABLE INITIALLY DEFERRED,
    event_hash TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE (task_id, expected_state_version)
  );
  CREATE TRIGGER IF NOT EXISTS workflow_transition_requests_prevent_replace_collision
  BEFORE INSERT ON workflow_transition_requests
  WHEN EXISTS (
    SELECT 1 FROM workflow_transition_requests
    WHERE request_id = NEW.request_id
      OR idempotency_key = NEW.idempotency_key
      OR event_id = NEW.event_id
      OR (task_id = NEW.task_id AND expected_state_version = NEW.expected_state_version)
  )
  BEGIN SELECT RAISE(ABORT, 'WORKFLOW_TRANSITION_REQUEST_IMMUTABLE'); END;
  CREATE TRIGGER IF NOT EXISTS workflow_transition_requests_immutable_update
  BEFORE UPDATE ON workflow_transition_requests
  BEGIN SELECT RAISE(ABORT, 'WORKFLOW_TRANSITION_REQUEST_IMMUTABLE'); END;
  CREATE TRIGGER IF NOT EXISTS workflow_transition_requests_immutable_delete
  BEFORE DELETE ON workflow_transition_requests
  WHEN EXISTS (
    SELECT 1 FROM tasks WHERE id = OLD.task_id
  )
  BEGIN SELECT RAISE(ABORT, 'WORKFLOW_TRANSITION_REQUEST_IMMUTABLE'); END;

  CREATE TABLE IF NOT EXISTS workflow_authorizations (
    authorization_id TEXT PRIMARY KEY,
    workflow_id TEXT NOT NULL,
    revision_id TEXT NOT NULL,
    authorization_json TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TRIGGER IF NOT EXISTS workflow_authorizations_prevent_replace_collision
  BEFORE INSERT ON workflow_authorizations
  WHEN EXISTS (SELECT 1 FROM workflow_authorizations WHERE authorization_id = NEW.authorization_id)
  BEGIN SELECT RAISE(ABORT, 'WORKFLOW_AUTHORIZATION_IMMUTABLE'); END;
  CREATE INDEX IF NOT EXISTS workflow_authorizations_scope
    ON workflow_authorizations(workflow_id, revision_id, authorization_id);
  CREATE TRIGGER IF NOT EXISTS workflow_authorizations_immutable_update
  BEFORE UPDATE ON workflow_authorizations
  BEGIN SELECT RAISE(ABORT, 'WORKFLOW_AUTHORIZATION_IMMUTABLE'); END;
`;

function insertSnapshot(database, { projectId, workflowId, definition, bindings, rules, timestamp }) {
  database.prepare(`
    INSERT INTO workflow_definitions (workflow_id, project_id, current_revision_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(workflowId, projectId, definition.revisionId, timestamp, timestamp);
  database.prepare(`
    INSERT INTO workflow_revisions (revision_id, workflow_id, revision, definition_json, immutable, created_at)
    VALUES (?, ?, ?, ?, 1, ?)
  `).run(definition.revisionId, workflowId, definition.revision, JSON.stringify(definition), timestamp);
  const insertBinding = database.prepare(`
    INSERT INTO workflow_revision_stage_bindings (
      revision_id, contract_stage_id, task_stage_id, canonical_status, terminal_kind, stage_order
    ) VALUES (?, ?, ?, ?, ?, ?)
  `);
  for (const binding of bindings) {
    insertBinding.run(
      definition.revisionId, binding.contractStageId, binding.taskStageId,
      binding.canonicalStatus, binding.terminalKind, binding.order,
    );
  }
  const insertRule = database.prepare(`
    INSERT INTO workflow_transition_rules (
      revision_id, action_key, transition_id, from_task_stage_id, to_task_stage_id,
      from_contract_stage_id, to_contract_stage_id, to_terminal_kind, legacy
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const rule of rules) {
    insertRule.run(
      definition.revisionId, rule.actionKey, rule.transitionId, rule.fromTaskStageId,
      rule.toTaskStageId, rule.fromContractStageId, rule.toContractStageId,
      rule.toTerminalKind, rule.legacy ? 1 : 0,
    );
  }
}

/** Local-only migration. It snapshots existing stage workflows without creating ledger history. */
export function migrateLocalWorkflowTransitions(database) {
  database.exec("PRAGMA recursive_triggers = ON");
  database.exec("BEGIN IMMEDIATE");
  try {
    database.exec(WORKFLOW_TRANSITION_SCHEMA_SQL);
    const timestamp = now();
    for (const project of database.prepare("SELECT id FROM projects ORDER BY id").all()) {
      const existing = database.prepare("SELECT workflow_id FROM workflow_definitions WHERE project_id = ?").get(project.id);
      if (existing) continue;
      const stages = database.prepare(`
        SELECT id, canonical_status, terminal_kind
        FROM workflow_stages WHERE project_id = ? ORDER BY stage_order, id
      `).all(project.id);
      if (stages.length === 0) continue;
      const workflowId = workflowIdForProject(project.id);
      const snapshot = workflowSnapshot(workflowId, stages, timestamp);
      insertSnapshot(database, { projectId: project.id, workflowId, ...snapshot, timestamp });
    }
    database.prepare(`
      INSERT INTO workflow_task_pins (task_id, workflow_id, revision_id, pinned_at)
      SELECT tasks.id, definitions.workflow_id, definitions.current_revision_id, ?
      FROM tasks
      JOIN workflow_definitions AS definitions ON definitions.project_id = tasks.project_id
      WHERE NOT EXISTS (
        SELECT 1 FROM workflow_task_pins AS pins WHERE pins.task_id = tasks.id
      )
    `).run(timestamp);
    database.exec(`
      CREATE TRIGGER IF NOT EXISTS workflow_task_pins_on_task_insert
      AFTER INSERT ON tasks
      BEGIN
        INSERT INTO workflow_task_pins (task_id, workflow_id, revision_id, pinned_at)
        SELECT NEW.id, workflow_id, current_revision_id, NEW.created_at
        FROM workflow_definitions
        WHERE project_id = NEW.project_id
          AND NOT EXISTS (
            SELECT 1 FROM workflow_task_pins AS pins WHERE pins.task_id = NEW.id
          );
      END;
    `);
    database.exec(`
      CREATE TRIGGER IF NOT EXISTS workflow_work_item_projections_on_task_insert
      AFTER INSERT ON tasks
      BEGIN
        INSERT INTO workflow_work_item_projections (
          work_item_id, project_id, status, stage_id, task_version, projection_kind,
          imported_at, source_updated_at, last_event_sequence, last_event_hash
        ) VALUES (
          NEW.id, NEW.project_id, NEW.status, NEW.stage_id, NEW.version, 'work_item.imported',
          NEW.created_at, NEW.updated_at, NULL, NULL
        ) ON CONFLICT(work_item_id) DO NOTHING;
      END;
    `);
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

export function workflowIdForProjectId(projectId) {
  return workflowIdForProject(projectId);
}
