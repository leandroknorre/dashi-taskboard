ALTER TABLE task_relations
ADD COLUMN metadata TEXT NOT NULL DEFAULT '{"required":true,"rollup":true}';
