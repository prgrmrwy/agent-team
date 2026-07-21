import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDb, runMigrations, type DbClient } from '../db/client.js'
import { getAgentUsage } from '../db/token-usage-repo.js'
import { persistRuntimeDoneUsage } from './runtime-usage.js'

const MIGRATIONS_TASK = path.join(import.meta.dirname ?? __dirname, '../db/migrations-task')

let tmp: string
let db: DbClient

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-usage-test-'))
  db = openDb(path.join(tmp, 'task.db'))
  runMigrations(db, MIGRATIONS_TASK)
  const now = '2026-06-26T00:00:00.000Z'
  db.prepare(
    `INSERT INTO seats (id, task_id, role, factory, status, current_agent_id, queue, created_at)
     VALUES ('seat-1', 'task-1', 'Engineer #1', 'engineer', 'working', 'agent-1', '[]', ?)`,
  ).run(now)
  db.prepare(
    `INSERT INTO agents
      (id, task_id, seat_id, factory, display_name, state, factory_version, model_profile, spawned_at)
     VALUES ('agent-1', 'task-1', 'seat-1', 'engineer', 'Ada', 'running', 1, ?, ?)`,
  ).run(JSON.stringify({ model: 'gpt-5.5' }), now)
})

afterEach(() => {
  db.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('persistRuntimeDoneUsage', () => {
  it('persists Codex done event usage with cached input, reasoning output, and total tokens', () => {
    const inserted = persistRuntimeDoneUsage({
      db,
      taskId: 'task-1',
      projectId: 'proj-1',
      agentId: 'agent-1',
      provider: 'codex-exec',
      event: {
        sessionId: 'session-1',
        stopReason: 'end_turn',
        usage: {
          input_tokens: 100,
          cached_input_tokens: 25,
          output_tokens: 40,
          reasoning_output_tokens: 10,
          total_tokens: 150,
        },
      },
    })

    expect(inserted).toBe(true)
    expect(getAgentUsage(db, 'task-1', 'agent-1').runtime).toMatchObject({
      inputTokens: 100,
      cacheReadTokens: 25,
      outputTokens: 40,
      reasoningTokens: 10,
      totalTokens: 150,
    })
    const row = db
      .prepare('SELECT provider, model, session_id FROM token_usage_events')
      .get() as { provider: string; model: string; session_id: string }
    expect(row).toEqual({ provider: 'codex-exec', model: 'gpt-5.5', session_id: 'session-1' })
  })
})
