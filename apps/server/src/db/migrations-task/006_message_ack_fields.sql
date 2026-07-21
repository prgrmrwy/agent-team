-- Store single-user urgent system-event acknowledgement with the message itself.
ALTER TABLE chatroom_messages ADD COLUMN urgent_key TEXT;
ALTER TABLE chatroom_messages ADD COLUMN acknowledged_at TEXT;

CREATE INDEX IF NOT EXISTS idx_messages_urgent_key ON chatroom_messages(task_id, urgent_key);
