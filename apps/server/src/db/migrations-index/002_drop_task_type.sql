CREATE TABLE tasks_meta_next (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects(id),
  title       TEXT NOT NULL,
  description TEXT NOT NULL,
  context_links TEXT NOT NULL DEFAULT '[]',
  state       TEXT NOT NULL DEFAULT 'S0',
  history     TEXT NOT NULL DEFAULT '[]',
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

INSERT INTO tasks_meta_next
  (id, project_id, title, description, context_links, state, history, created_at, updated_at)
SELECT
  id, project_id, title, description, context_links, state, history, created_at, updated_at
FROM tasks_meta;

DROP TABLE tasks_meta;
ALTER TABLE tasks_meta_next RENAME TO tasks_meta;

CREATE INDEX IF NOT EXISTS idx_tasks_meta_project ON tasks_meta(project_id);
CREATE INDEX IF NOT EXISTS idx_tasks_meta_state   ON tasks_meta(state);
