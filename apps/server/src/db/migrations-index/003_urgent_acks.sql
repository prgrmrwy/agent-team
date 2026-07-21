-- 003 urgent system-event 人类 ack 记录(per-message)
-- single-user 本地应用,无需 user 维度。表很小(只记被 ack 过的)。

CREATE TABLE IF NOT EXISTS urgent_acks (
  task_id    TEXT NOT NULL,
  message_id TEXT NOT NULL,
  acked_at   TEXT NOT NULL,
  PRIMARY KEY (task_id, message_id)
);

CREATE INDEX IF NOT EXISTS idx_urgent_acks_task ON urgent_acks(task_id);
