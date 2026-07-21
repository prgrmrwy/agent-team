-- 004 phase-driven-orchestration: 防静默 stalled 标志
-- task 卡住(idle 空转超软推上限 / watchdog 超时无进展)→ 置 stalled,UI sidebar 高亮。
-- 不是新状态,只是 flag + reason + 时间戳;agent 后续有进展即清。

ALTER TABLE tasks_meta ADD COLUMN stalled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tasks_meta ADD COLUMN stalled_reason TEXT;
ALTER TABLE tasks_meta ADD COLUMN stalled_at TEXT;
