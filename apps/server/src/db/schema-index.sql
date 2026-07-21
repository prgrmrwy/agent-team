-- 全局索引 DB schema（~/.agent-team/index.db）
-- 主 server 拥有，存 projects / tasks_meta / factory_versions / factory_tuning_queue

CREATE TABLE IF NOT EXISTS projects (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  repo_path   TEXT,
  created_at  TEXT NOT NULL  -- ISO 8601
);

CREATE TABLE IF NOT EXISTS tasks_meta (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects(id),
  title       TEXT NOT NULL,
  description TEXT NOT NULL,
  context_links TEXT NOT NULL DEFAULT '[]',  -- JSON array
  state       TEXT NOT NULL DEFAULT 'S0',
  history     TEXT NOT NULL DEFAULT '[]',    -- JSON array of StateTransition
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tasks_meta_project ON tasks_meta(project_id);
CREATE INDEX IF NOT EXISTS idx_tasks_meta_state   ON tasks_meta(state);

CREATE TABLE IF NOT EXISTS factory_versions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,            -- FactoryRole
  version     INTEGER NOT NULL,
  yaml_snapshot TEXT NOT NULL,          -- 原始 YAML 字符串快照
  active      INTEGER NOT NULL DEFAULT 1, -- 0=archived
  created_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_factory_versions_name ON factory_versions(name, version);

CREATE TABLE IF NOT EXISTS factory_tuning_queue (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  factory_name TEXT NOT NULL,
  task_id      TEXT NOT NULL,
  suggestion   TEXT NOT NULL,           -- JSON
  status       TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','applied','dismissed')),
  created_at   TEXT NOT NULL
);
