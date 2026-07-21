import express from 'express'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { createTasksRouter } from './tasks.js'
import { _resetConfigForTest } from '../../config/index.js'
import { logger } from '../../util/logger.js'
import type { DbClient } from '../../db/client.js'
import type { TaskProcessLauncher } from '../../process/task-process-launcher.js'

const TASKS_META_SCHEMA = `
CREATE TABLE IF NOT EXISTS tasks_meta (
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

const BOOTSTRAP_RESOURCES_SCHEMA = `
CREATE TABLE IF NOT EXISTS bootstrap_resources (
  id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  provider TEXT NOT NULL,
  mode TEXT,
  path TEXT,
  branch TEXT,
  base_ref TEXT,
  summary TEXT,
  error TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  terminal_status TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (task_id, id)
);
`

const log = logger.child({ module: 'tasks-file-viewer-e2e-test' })

let tmp: string
let indexDb: DbClient
let taskDb: DbClient
let server: http.Server
let baseUrl: string
let originalDataHome: string | undefined
let originalToken: string | undefined

function makeLauncher(): TaskProcessLauncher {
  return {
    launch: vi.fn(async () => true),
    hasActive: () => false,
  } as unknown as TaskProcessLauncher
}

async function startServer(): Promise<void> {
  const app = express()
  app.use(express.json())
  app.use(
    '/tasks',
    createTasksRouter(
      indexDb,
      log,
      () => makeLauncher(),
      () => taskDb,
    ),
  )
  server = http.createServer(app)
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  const addr = server.address() as AddressInfo
  baseUrl = `http://127.0.0.1:${addr.port}`
}

function seedTask(taskId = 'task-e2e', projectId = 'project-e2e'): string {
  indexDb
    .prepare(
      `INSERT INTO tasks_meta (id, project_id, title, description, created_at, updated_at)
       VALUES (?, ?, 'file viewer e2e', 'd', '2020-01-01T00:00:00Z', '2020-01-01T00:00:00Z')`,
    )
    .run(taskId, projectId)
  const taskDir = path.join(tmp, 'projects', projectId, 'tasks', taskId)
  fs.mkdirSync(path.join(taskDir, 'plan'), { recursive: true })
  fs.mkdirSync(path.join(taskDir, 'screenshots'), { recursive: true })
  return taskDir
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tasks-file-viewer-e2e-'))
  originalDataHome = process.env['DATA_HOME']
  originalToken = process.env['AGENT_TEAM_TOKEN']
  process.env['DATA_HOME'] = tmp
  process.env['AGENT_TEAM_TOKEN'] = 'test-token-file-viewer-e2e'
  _resetConfigForTest()

  indexDb = new Database(':memory:') as unknown as DbClient
  ;(indexDb as unknown as { exec: (s: string) => void }).exec(TASKS_META_SCHEMA)
  taskDb = new Database(':memory:') as unknown as DbClient
  ;(taskDb as unknown as { exec: (s: string) => void }).exec(BOOTSTRAP_RESOURCES_SCHEMA)
})

afterEach(async () => {
  if (server) await new Promise<void>((r) => server.close(() => r()))
  indexDb.close()
  taskDb.close()
  fs.rmSync(tmp, { recursive: true, force: true })
  if (originalDataHome === undefined) delete process.env['DATA_HOME']
  else process.env['DATA_HOME'] = originalDataHome
  if (originalToken === undefined) delete process.env['AGENT_TEAM_TOKEN']
  else process.env['AGENT_TEAM_TOKEN'] = originalToken
  _resetConfigForTest()
})

describe('file viewer HTTP e2e', () => {
  it('serves the workspace tree, markdown preview, and raw image bytes used by the UI', async () => {
    const taskDir = seedTask()
    fs.writeFileSync(path.join(taskDir, 'plan', 'task-plan.md'), '# E2E Plan\n\nOpen me.')
    fs.writeFileSync(path.join(taskDir, 'screenshots', 'home.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    fs.writeFileSync(path.join(taskDir, 'chatroom.jsonl'), 'hidden noise')
    await startServer()

    const root = await fetch(`${baseUrl}/tasks/task-e2e/workspace/ls`)
    expect(root.status).toBe(200)
    await expect(root.json()).resolves.toMatchObject({
      entries: [
        { name: 'plan', type: 'dir' },
        { name: 'screenshots', type: 'dir' },
      ],
    })

    const planDir = await fetch(`${baseUrl}/tasks/task-e2e/workspace/ls?path=plan`)
    expect(planDir.status).toBe(200)
    await expect(planDir.json()).resolves.toMatchObject({
      path: 'plan',
      entries: [{ name: 'task-plan.md', type: 'file' }],
    })

    const markdown = await fetch(`${baseUrl}/tasks/task-e2e/file?path=plan/task-plan.md`)
    expect(markdown.status).toBe(200)
    await expect(markdown.json()).resolves.toMatchObject({
      path: 'plan/task-plan.md',
      root: 'workspace',
      ext: 'md',
      content: '# E2E Plan\n\nOpen me.',
      binary: false,
    })

    const rawImage = await fetch(`${baseUrl}/tasks/task-e2e/file?path=screenshots/home.png&raw=1`)
    expect(rawImage.status).toBe(200)
    expect(rawImage.headers.get('content-type')).toContain('image/png')
    expect([...Buffer.from(await rawImage.arrayBuffer())]).toEqual([0x89, 0x50, 0x4e, 0x47])
  })

  it('falls back to the ready primary worktree after workspace misses', async () => {
    seedTask()
    const worktree = fs.mkdtempSync(path.join(os.tmpdir(), 'tasks-file-viewer-worktree-e2e-'))
    fs.mkdirSync(path.join(worktree, 'apps', 'web'), { recursive: true })
    fs.writeFileSync(path.join(worktree, 'apps', 'web', 'App.tsx'), 'export function App() {}')
    const now = new Date().toISOString()
    taskDb
      .prepare(
        `INSERT INTO bootstrap_resources (id, task_id, kind, status, provider, mode, path, attempts, created_at, updated_at)
         VALUES ('primary-worktree', 'task-e2e', 'worktree', 'ready', 'sw', 'lean', ?, 1, ?, ?)`,
      )
      .run(worktree, now, now)
    await startServer()

    const res = await fetch(`${baseUrl}/tasks/task-e2e/file?path=apps/web/App.tsx`)
    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toMatchObject({
      root: 'worktree',
      ext: 'tsx',
      content: 'export function App() {}',
    })

    fs.rmSync(worktree, { recursive: true, force: true })
  })
})
