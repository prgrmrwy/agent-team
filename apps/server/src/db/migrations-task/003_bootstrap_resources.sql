-- Per-task DB: bootstrap config + bootstrap resources（task-bootstrap-lifecycle phase 1.6）
-- bootstrap_config 每 task 单行;bootstrap_resources 记录 worktree 等副作用与终态。

CREATE TABLE IF NOT EXISTS bootstrap_config (
  task_id     TEXT PRIMARY KEY,
  provider    TEXT NOT NULL CHECK(provider IN ('none','generic-pnpm','sw','generic')),
  mode        TEXT CHECK(mode IS NULL OR mode IN ('lean','full')),
  options     TEXT NOT NULL DEFAULT '{}',
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS bootstrap_resources (
  id          TEXT NOT NULL,
  task_id     TEXT NOT NULL,
  kind        TEXT NOT NULL CHECK(kind IN ('worktree')),
  status      TEXT NOT NULL CHECK(status IN ('creating','ready','failed','retained','removed','archived','needs-review')),
  provider    TEXT NOT NULL CHECK(provider IN ('none','generic-pnpm','sw','generic')),
  mode        TEXT CHECK(mode IS NULL OR mode IN ('lean','full')),
  path        TEXT,
  branch      TEXT,
  base_ref    TEXT,
  summary     TEXT,
  error       TEXT,
  attempts    INTEGER NOT NULL DEFAULT 0,
  terminal_status TEXT CHECK(terminal_status IS NULL OR terminal_status IN ('retained','removed','archived','needs-review')),
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  PRIMARY KEY (task_id, id)
);

CREATE INDEX IF NOT EXISTS idx_bootstrap_resources_task ON bootstrap_resources(task_id);
CREATE INDEX IF NOT EXISTS idx_bootstrap_resources_status ON bootstrap_resources(status);
