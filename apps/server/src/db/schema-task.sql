-- Per-task DB schema（<task-workdir>/task.db）
-- task-process 拥有，存 chatroom_messages / seats / agents / artifacts / context_access_log / state_history

CREATE TABLE IF NOT EXISTS chatroom_messages (
  id          TEXT PRIMARY KEY,
  task_id     TEXT NOT NULL,
  channel     TEXT NOT NULL CHECK(channel IN ('main','eng-internal','tool-traces','mentions')),
  type        TEXT NOT NULL,
  sender      TEXT NOT NULL,
  content     TEXT NOT NULL,
  mention     TEXT NOT NULL DEFAULT '[]',  -- JSON array of SeatId
  refs        TEXT NOT NULL DEFAULT '[]',  -- JSON array of ArtifactId
  reply_to    TEXT,
  urgent_key  TEXT,
  acknowledged_at TEXT,
  created_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_messages_task_channel ON chatroom_messages(task_id, channel, created_at);
CREATE INDEX IF NOT EXISTS idx_messages_created_at   ON chatroom_messages(created_at);
CREATE INDEX IF NOT EXISTS idx_messages_urgent_key   ON chatroom_messages(task_id, urgent_key);

CREATE TABLE IF NOT EXISTS seats (
  id              TEXT PRIMARY KEY,
  task_id         TEXT NOT NULL,
  role            TEXT NOT NULL,
  factory         TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'init' CHECK(status IN ('init','idle','working','offline','vacant')),
  current_agent_id TEXT,
  queue           TEXT NOT NULL DEFAULT '[]',  -- JSON array of MessageId
  model_override  TEXT,
  created_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_seats_task ON seats(task_id);

CREATE TABLE IF NOT EXISTS agents (
  id              TEXT PRIMARY KEY,
  task_id         TEXT NOT NULL,
  seat_id         TEXT NOT NULL REFERENCES seats(id),
  factory         TEXT NOT NULL,
  display_name    TEXT NOT NULL,
  state           TEXT NOT NULL DEFAULT 'init',
  factory_version INTEGER NOT NULL,
  model_profile   TEXT,
  spawned_at      TEXT NOT NULL,
  terminated_at   TEXT
);

CREATE INDEX IF NOT EXISTS idx_agents_task   ON agents(task_id);
CREATE INDEX IF NOT EXISTS idx_agents_seat   ON agents(seat_id);

CREATE TABLE IF NOT EXISTS artifacts (
  id          TEXT PRIMARY KEY,
  task_id     TEXT NOT NULL,
  path        TEXT NOT NULL,
  type        TEXT NOT NULL,
  producer    TEXT NOT NULL,  -- AgentId
  summary     TEXT NOT NULL DEFAULT '',
  refs        TEXT NOT NULL DEFAULT '[]',  -- JSON array of ArtifactId
  created_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_artifacts_task ON artifacts(task_id);

CREATE TABLE IF NOT EXISTS context_access_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id     TEXT NOT NULL,
  agent_id    TEXT NOT NULL,
  action      TEXT NOT NULL CHECK(action IN ('read-file','websearch','webfetch','run-cmd','mcp-call','skill-load')),
  ref         TEXT NOT NULL,
  ts          TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_context_log_task ON context_access_log(task_id, ts);

CREATE TABLE IF NOT EXISTS state_history (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id     TEXT NOT NULL,
  from_state  TEXT NOT NULL,
  to_state    TEXT NOT NULL,
  event       TEXT NOT NULL,
  by          TEXT NOT NULL,  -- agentId or 'human' or 'system'
  version     INTEGER NOT NULL DEFAULT 1,  -- 乐观锁
  at          TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_state_history_task ON state_history(task_id, at);

CREATE TABLE IF NOT EXISTS token_usage_events (
  id                       TEXT PRIMARY KEY,
  task_id                  TEXT NOT NULL,
  project_id               TEXT,
  agent_id                 TEXT,
  seat_id                  TEXT,
  factory                  TEXT,
  provider                 TEXT,
  model                    TEXT,
  session_id               TEXT,
  external_request_id      TEXT,
  source                   TEXT NOT NULL CHECK(source IN ('runtime','fallback-transcript','chatroom-read','chatroom-corpus')),
  channel                  TEXT,
  input_tokens             INTEGER NOT NULL DEFAULT 0,
  cache_creation_tokens    INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens        INTEGER NOT NULL DEFAULT 0,
  output_tokens            INTEGER NOT NULL DEFAULT 0,
  reasoning_tokens         INTEGER NOT NULL DEFAULT 0,
  total_tokens             INTEGER NOT NULL DEFAULT 0,
  raw_usage_json           TEXT,
  created_at               TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_token_usage_external
  ON token_usage_events(provider, source, external_request_id)
  WHERE external_request_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_token_usage_task_source ON token_usage_events(task_id, source);
CREATE INDEX IF NOT EXISTS idx_token_usage_agent ON token_usage_events(task_id, agent_id, source);
CREATE INDEX IF NOT EXISTS idx_token_usage_factory ON token_usage_events(factory, task_id, source);
CREATE INDEX IF NOT EXISTS idx_token_usage_created_at ON token_usage_events(created_at);
