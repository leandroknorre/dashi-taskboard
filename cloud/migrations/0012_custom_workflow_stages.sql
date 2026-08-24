CREATE TABLE project_stage_workflows (
  project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_at TEXT NOT NULL
);

CREATE TABLE workflow_stages (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  canonical_status TEXT NOT NULL CHECK (canonical_status IN ('backlog', 'todo', 'in_progress', 'in_review', 'blocked', 'done', 'canceled')),
  name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 120),
  sort_order INTEGER NOT NULL CHECK (sort_order >= 0),
  board_visible INTEGER NOT NULL DEFAULT 1 CHECK (board_visible IN (0, 1)),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  is_default_for_status INTEGER NOT NULL DEFAULT 0 CHECK (is_default_for_status IN (0, 1)),
  terminal_kind TEXT NOT NULL DEFAULT 'none' CHECK (terminal_kind IN ('none', 'done', 'canceled')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (project_id, sort_order)
);
CREATE INDEX workflow_stages_project_sort ON workflow_stages(project_id, sort_order, id);
CREATE UNIQUE INDEX workflow_stages_default_category
  ON workflow_stages(project_id, canonical_status) WHERE is_default_for_status = 1;
CREATE TRIGGER workflow_stages_default_must_be_active_insert
BEFORE INSERT ON workflow_stages
WHEN NEW.is_default_for_status = 1 AND NEW.active = 0
BEGIN SELECT RAISE(ABORT, 'INACTIVE_DEFAULT_STAGE'); END;
CREATE TRIGGER workflow_stages_default_must_be_active_update
BEFORE UPDATE OF active, is_default_for_status ON workflow_stages
WHEN NEW.is_default_for_status = 1 AND NEW.active = 0
BEGIN SELECT RAISE(ABORT, 'INACTIVE_DEFAULT_STAGE'); END;

ALTER TABLE tasks ADD COLUMN stage_id TEXT REFERENCES workflow_stages(id);
CREATE INDEX tasks_project_stage_sort ON tasks(project_id, archived_at, stage_id, sort_order, created_at);

INSERT INTO project_stage_workflows (project_id, version, updated_at)
SELECT id, 1, updated_at FROM projects;

INSERT INTO workflow_stages (
  id, project_id, canonical_status, name, sort_order, board_visible, active,
  is_default_for_status, terminal_kind, created_at, updated_at
)
SELECT
  lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) || '-' ||
    substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6))),
  p.id,
  json_extract(defaults_json.value, '$.status'),
  json_extract(defaults_json.value, '$.name'),
  json_extract(defaults_json.value, '$.sortOrder'),
  json_extract(defaults_json.value, '$.boardVisible'),
  1,
  1,
  CASE json_extract(defaults_json.value, '$.status') WHEN 'done' THEN 'done' WHEN 'canceled' THEN 'canceled' ELSE 'none' END,
  p.created_at,
  p.updated_at
FROM projects AS p
CROSS JOIN json_each('[
  {"status":"todo","name":"To do","sortOrder":0,"boardVisible":1},
  {"status":"in_progress","name":"In progress","sortOrder":1,"boardVisible":1},
  {"status":"blocked","name":"Blocked","sortOrder":2,"boardVisible":1},
  {"status":"in_review","name":"In review","sortOrder":3,"boardVisible":1},
  {"status":"backlog","name":"Backlog","sortOrder":4,"boardVisible":0},
  {"status":"done","name":"Done","sortOrder":5,"boardVisible":0},
  {"status":"canceled","name":"Canceled","sortOrder":6,"boardVisible":0}
]') AS defaults_json;

UPDATE tasks
SET stage_id = (
  SELECT id FROM workflow_stages
  WHERE workflow_stages.project_id = tasks.project_id
    AND workflow_stages.canonical_status = tasks.status
    AND workflow_stages.is_default_for_status = 1
);

CREATE TRIGGER tasks_stage_project_insert
BEFORE INSERT ON tasks
WHEN NEW.stage_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'STAGE_PROJECT_MISMATCH')
  WHERE NOT EXISTS (
    SELECT 1 FROM workflow_stages
    WHERE id = NEW.stage_id AND project_id = NEW.project_id
  );
END;

CREATE TRIGGER tasks_stage_project_update
BEFORE UPDATE OF project_id, stage_id ON tasks
WHEN NEW.stage_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'STAGE_PROJECT_MISMATCH')
  WHERE NOT EXISTS (
    SELECT 1 FROM workflow_stages
    WHERE id = NEW.stage_id AND project_id = NEW.project_id
  );
END;

CREATE TRIGGER project_stage_workflows_revision_insert
AFTER INSERT ON project_stage_workflows
BEGIN UPDATE global_revision SET revision = revision + 1 WHERE singleton = 1; END;
CREATE TRIGGER project_stage_workflows_revision_update
AFTER UPDATE ON project_stage_workflows
BEGIN UPDATE global_revision SET revision = revision + 1 WHERE singleton = 1; END;
CREATE TRIGGER project_stage_workflows_revision_delete
AFTER DELETE ON project_stage_workflows
BEGIN UPDATE global_revision SET revision = revision + 1 WHERE singleton = 1; END;
CREATE TRIGGER workflow_stages_revision_insert
AFTER INSERT ON workflow_stages
BEGIN UPDATE global_revision SET revision = revision + 1 WHERE singleton = 1; END;
CREATE TRIGGER workflow_stages_revision_update
AFTER UPDATE ON workflow_stages
BEGIN UPDATE global_revision SET revision = revision + 1 WHERE singleton = 1; END;
CREATE TRIGGER workflow_stages_revision_delete
AFTER DELETE ON workflow_stages
BEGIN UPDATE global_revision SET revision = revision + 1 WHERE singleton = 1; END;
