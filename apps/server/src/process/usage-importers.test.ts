import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDb, runMigrations, type DbClient } from '../db/client.js'
import { getTaskUsage } from '../db/token-usage-repo.js'
import { importClaudeTranscriptUsage, parseAgentTeamCwd } from './usage-importers.js'

const MIGRATIONS_TASK = path.join(import.meta.dirname ?? __dirname, '../db/migrations-task')

let tmp: string
let db: DbClient

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-importers-test-'))
  db = openDb(path.join(tmp, 'task.db'))
  runMigrations(db, MIGRATIONS_TASK)
})

afterEach(() => {
  db.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('Claude transcript usage importer', () => {
  it('dedupes request ids, parses agent-team cwd, and skips unattributed lines', async () => {
    const root = path.join(tmp, 'claude-projects')
    fs.mkdirSync(root, { recursive: true })
    const attributedCwd = '/tmp/.agent-team/projects/proj-1/tasks/task-1/agents/agent-1'
    const lines = [
      {
        sessionId: 'session-1',
        requestId: 'req-1',
        cwd: attributedCwd,
        timestamp: '2026-06-26T00:00:00.000Z',
        message: {
          id: 'msg-1',
          model: 'claude-sonnet',
          usage: { input_tokens: 10, cache_read_input_tokens: 2, output_tokens: 3 },
        },
      },
      {
        sessionId: 'session-1',
        requestId: 'req-1',
        cwd: attributedCwd,
        timestamp: '2026-06-26T00:00:01.000Z',
        message: {
          id: 'msg-1-duplicate',
          usage: { input_tokens: 10, output_tokens: 3 },
        },
      },
      {
        sessionId: 'session-2',
        requestId: 'req-2',
        cwd: '/tmp/not-agent-team',
        message: { id: 'msg-2', usage: { input_tokens: 99, output_tokens: 99 } },
      },
    ]
    fs.writeFileSync(path.join(root, 'session.jsonl'), lines.map((line) => JSON.stringify(line)).join('\n'))

    expect(parseAgentTeamCwd(attributedCwd)).toEqual({
      projectId: 'proj-1',
      taskId: 'task-1',
      agentId: 'agent-1',
    })

    const result = await importClaudeTranscriptUsage({ db, taskId: 'task-1', roots: [root] })
    expect(result).toMatchObject({ scanned: 3, imported: 1, skipped: 2 })
    expect(getTaskUsage(db, 'task-1').totals.runtime.totalTokens).toBe(15)
    expect(getTaskUsage(db, 'task-1').agents[0]).toMatchObject({
      id: 'agent-1',
      totalTokens: 15,
    })
  })
})
