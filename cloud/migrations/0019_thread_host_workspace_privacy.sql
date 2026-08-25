UPDATE tasks
SET
  thread_workspace_path = NULL,
  thread_codex_host_id = NULL
WHERE thread_workspace_path IS NOT NULL
   OR thread_codex_host_id IS NOT NULL;

UPDATE comments
SET
  thread_workspace_path = NULL,
  thread_codex_host_id = NULL
WHERE thread_workspace_path IS NOT NULL
   OR thread_codex_host_id IS NOT NULL;

CREATE TRIGGER IF NOT EXISTS tasks_reject_thread_host_workspace_insert
BEFORE INSERT ON tasks
WHEN NEW.thread_workspace_path IS NOT NULL
  OR NEW.thread_codex_host_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'THREAD_HOST_OR_WORKSPACE_FORBIDDEN');
END;

CREATE TRIGGER IF NOT EXISTS tasks_reject_thread_host_workspace_update
BEFORE UPDATE OF thread_workspace_path, thread_codex_host_id ON tasks
WHEN NEW.thread_workspace_path IS NOT NULL
  OR NEW.thread_codex_host_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'THREAD_HOST_OR_WORKSPACE_FORBIDDEN');
END;

CREATE TRIGGER IF NOT EXISTS comments_reject_thread_host_workspace_insert
BEFORE INSERT ON comments
WHEN NEW.thread_workspace_path IS NOT NULL
  OR NEW.thread_codex_host_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'THREAD_HOST_OR_WORKSPACE_FORBIDDEN');
END;

CREATE TRIGGER IF NOT EXISTS comments_reject_thread_host_workspace_update
BEFORE UPDATE OF thread_workspace_path, thread_codex_host_id ON comments
WHEN NEW.thread_workspace_path IS NOT NULL
  OR NEW.thread_codex_host_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'THREAD_HOST_OR_WORKSPACE_FORBIDDEN');
END;
