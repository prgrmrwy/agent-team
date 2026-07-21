import express from 'express'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { openDb, runMigrations, type DbClient } from '../../db/client.js'
import { insertTokenUsageEvent } from '../../db/token-usage-repo.js'
import { logger } from '../../util/logger.js'
import type { TaskProcessLauncher } from '../../process/task-process-launcher.js'
import { createFactoriesRouter } from './factories.js'
import { createProjectsRouter } from './projects.js'
import { createTasksRouter } from './tasks.js'

const MIGRATIONS_TASK = path.join(import.meta.dirname ?? __dirname, '../../db/migrations-task')
const log = logger.child({ module: 'usage-routes-test' })

let tmp: string
let indexDb: DbClient
let taskDb: DbClient
let server: http.Server
let baseUrl: string

function makeLauncher(): TaskProcessLauncher {
  return {
    launch: vi.fn(async () => true),
    hasActive: () => false,
  } as unknown as TaskProcessLauncher
}

async function startServer(): Promise<void> {
  const app = express()
  app.use(express.json())
  const getTaskDb = (taskId: string) => (taskId === 'task-1' ? taskDb : null)
  app.use('/tasks', createTasksRouter(indexDb, log, () => makeLauncher(), getTaskDb))
  app.use('/projects', createProjectsRouter(indexDb, log, getTaskDb))
  app.use('/factories', createFactoriesRouter(indexDb, getTaskDb))
  server = http.createServer(app)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const addr = server.address() as AddressInfo
  baseUrl = `http://127.0.0.1:${addr.port}`
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-routes-test-'))
  indexDb = openDb(path.join(tmp, 'index.db'))
  indexDb.exec(`
    CREATE TABLE projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      repo_path TEXT,
      created_at TEXT NOT NULL
    );
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
  `)
  const now = '2026-06-26T00:00:00.000Z'
  indexDb
    .prepare('INSERT INTO projects (id, name, repo_path, created_at) VALUES (?, ?, NULL, ?)')
    .run('proj-1', 'Project 1', now)
  indexDb
    .prepare(
      `INSERT INTO tasks_meta (id, project_id, title, description, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run('task-1', 'proj-1', 'Task One', 'desc', now, now)

  taskDb = openDb(path.join(tmp, 'task.db'))
  runMigrations(taskDb, MIGRATIONS_TASK)
  insertTokenUsageEvent(taskDb, {
    id: 'usage-runtime-1',
    taskId: 'task-1',
    projectId: 'proj-1',
    agentId: 'agent-1',
    factory: 'engineer',
    provider: 'codex-exec',
    source: 'runtime',
    inputTokens: 100,
    outputTokens: 25,
    totalTokens: 125,
    createdAt: now,
  })
  insertTokenUsageEvent(taskDb, {
    id: 'usage-chatroom-1',
    taskId: 'task-1',
    projectId: 'proj-1',
    agentId: 'agent-1',
    factory: 'engineer',
    source: 'chatroom-read',
    totalTokens: 12,
    createdAt: now,
  })
})

afterEach(async () => {
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()))
  indexDb.close()
  taskDb.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('usage REST routes', () => {
  it('returns task, agent, factory, and project token usage without cost fields', async () => {
    await startServer()

    const taskUsage = await getJson('/tasks/task-1/usage')
    expect(taskUsage.totals.runtime.totalTokens).toBe(125)
    expect(taskUsage.totals.chatroomRead.totalTokens).toBe(12)
    expect(taskUsage.agents[0]).toMatchObject({ id: 'agent-1', totalTokens: 137 })

    const agentUsage = await getJson('/tasks/task-1/agents/agent-1/usage')
    expect(agentUsage.runtime.totalTokens).toBe(125)

    const factoryUsage = await getJson('/factories/engineer/usage')
    expect(factoryUsage.runtime.totalTokens).toBe(125)
    expect(factoryUsage.tasks[0]).toMatchObject({ id: 'task-1', label: 'Task One', totalTokens: 125 })

    const projectUsage = await getJson('/projects/proj-1/usage')
    expect(projectUsage.runtime.totalTokens).toBe(125)
    expect(JSON.stringify({ taskUsage, agentUsage, factoryUsage, projectUsage })).not.toContain('cost')
  })
})

async function getJson(pathname: string): Promise<any> {
  const res = await fetch(`${baseUrl}${pathname}`)
  expect(res.status).toBe(200)
  return res.json()
}
