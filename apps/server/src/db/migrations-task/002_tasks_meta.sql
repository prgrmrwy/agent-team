-- Per-task DB: tasks_meta 表（task 状态机当前状态 + 基本元数据）
-- 由 task-process-entry 启动时初始化（INSERT OR IGNORE）

CREATE TABLE IF NOT EXISTS tasks_meta (
  id          TEXT PRIMARY KEY,
  title       TEXT NOT NULL DEFAULT '',
  state       TEXT NOT NULL DEFAULT 'S1',  -- 进入 task-process 时已是 S1
  created_at  TEXT NOT NULL
);
