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
