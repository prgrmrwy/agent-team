import { describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { handleControl } from './control.js'
import { logger } from '../../util/logger.js'
import type { DbClient } from '../../db/client.js'
import type { TaskProcessLauncher } from '../../process/task-process-launcher.js'

const TASKS_META_SCHEMA = `
CREATE TABLE tasks_meta (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  context_links TEXT NOT NULL DEFAULT '[]',
  state TEXT NOT NULL DEFAULT 'S0',
  history TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`

function indexDbWithTask(state: string): DbClient {
  const db = new Database(':memory:') as unknown as DbClient
  ;(db as unknown as { exec: (s: string) => void }).exec(TASKS_META_SCHEMA)
  db.prepare(
    `INSERT INTO tasks_meta (id, project_id, title, description, state, created_at, updated_at)
     VALUES ('task-1', 'p1', 't', 'd', ?, '2026-06-28T00:00:00.000Z', '2026-06-28T00:00:00.000Z')`,
  ).run(state)
  return db
}

function launcher(active = false): TaskProcessLauncher {
  return {
    hasActive: vi.fn(() => active),
    send: vi.fn(() => true),
  } as unknown as TaskProcessLauncher
}

describe('handleControl', () => {
  it('does not relaunch or forward done controls for terminal tasks', async () => {
    const db = indexDbWithTask('aborted')
    const l = launcher(false)
    const ensureTaskProcess = vi.fn(async () => 'launched' as const)

    await handleControl(
      {} as never,
      { type: 'control', taskId: 'task-1', action: 'done' },
      logger.child({ module: 'control-test' }),
      l,
      db,
      ensureTaskProcess,
    )

    expect(ensureTaskProcess).not.toHaveBeenCalled()
    expect(l.send).not.toHaveBeenCalled()
    db.close()
  })

  it('relaunches a non-terminal inactive task before forwarding done', async () => {
    const db = indexDbWithTask('S7')
    const l = launcher(false)
    const ensureTaskProcess = vi.fn(async () => 'launched' as const)

    await handleControl(
      {} as never,
      { type: 'control', taskId: 'task-1', action: 'done' },
      logger.child({ module: 'control-test' }),
      l,
      db,
      ensureTaskProcess,
    )

    expect(ensureTaskProcess).toHaveBeenCalledWith('task-1')
    expect(l.send).toHaveBeenCalledTimes(1)
    db.close()
  })
})
