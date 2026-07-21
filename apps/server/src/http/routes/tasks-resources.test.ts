/**
 * Phase 7.5: REST surface for bootstrap resources(前端读 + 失败 retry)。
 *
 * - GET /tasks/:id/resources 返回 per-task DB 的 bootstrap_resources 列表
 * - GET /tasks/:id/resources 返回 [] when task db 不存在 / 表不存在 (legacy)
 * - POST /tasks/:id/bootstrap/retry 触发 startBootstrap 回调,失败时 5xx,未知 task 404
 */

import express from 'express'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { createTasksRouter, type StartBootstrap } from './tasks.js'
import { _resetConfigForTest } from '../../config/index.js'
import { logger } from '../../util/logger.js'
import type { DbClient } from '../../db/client.js'
import type { TaskProcessLauncher } from '../../process/task-process-launcher.js'

const log = logger.child({ module: 'tasks-resources-test' })

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

const CHATROOM_MESSAGES_SCHEMA = `
CREATE TABLE IF NOT EXISTS chatroom_messages (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  channel TEXT NOT NULL,
  type TEXT NOT NULL,
  sender TEXT NOT NULL,
  content TEXT NOT NULL,
  mention TEXT NOT NULL DEFAULT '[]',
  refs TEXT NOT NULL DEFAULT '[]',
  reply_to TEXT,
  urgent_key TEXT,
  acknowledged_at TEXT,
  created_at TEXT NOT NULL
);
`

const SEATS_SCHEMA = `
CREATE TABLE IF NOT EXISTS seats (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  role TEXT NOT NULL,
  factory TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'init',
  current_agent_id TEXT,
  queue TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  model_override TEXT
);
`

const AGENTS_SCHEMA = `
CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  seat_id TEXT NOT NULL,
  factory TEXT NOT NULL,
  display_name TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'init',
  factory_version INTEGER NOT NULL,
  spawned_at TEXT NOT NULL,
  terminated_at TEXT,
  model_profile TEXT
);
`

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

async function startServer(startBootstrap?: StartBootstrap): Promise<void> {
  const app = express()
  app.use(express.json())
  app.use(
    '/tasks',
    createTasksRouter(
      indexDb,
      log,
      () => makeLauncher(),
      () => taskDb,
      startBootstrap,
    ),
  )
  server = http.createServer(app)
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  const addr = server.address() as AddressInfo
  baseUrl = `http://127.0.0.1:${addr.port}`
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tasks-resources-test-'))
  originalDataHome = process.env['DATA_HOME']
  originalToken = process.env['AGENT_TEAM_TOKEN']
  process.env['DATA_HOME'] = tmp
  process.env['AGENT_TEAM_TOKEN'] = 'test-token-resources'
  _resetConfigForTest()

  indexDb = new Database(':memory:') as unknown as DbClient
  ;(indexDb as unknown as { exec: (s: string) => void }).exec(TASKS_META_SCHEMA)
  taskDb = new Database(':memory:') as unknown as DbClient
  ;(taskDb as unknown as { exec: (s: string) => void }).exec(BOOTSTRAP_RESOURCES_SCHEMA)
  ;(taskDb as unknown as { exec: (s: string) => void }).exec(CHATROOM_MESSAGES_SCHEMA)
  ;(taskDb as unknown as { exec: (s: string) => void }).exec(SEATS_SCHEMA)
  ;(taskDb as unknown as { exec: (s: string) => void }).exec(AGENTS_SCHEMA)
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

describe('GET /tasks/:id/resources', () => {
  it('returns bootstrap_resources rows mapped to TaskBootstrapResource shape', async () => {
    await startServer()
    const now = new Date().toISOString()
    taskDb
      .prepare(
        `INSERT INTO bootstrap_resources (id, task_id, kind, status, provider, mode, path, branch, attempts, created_at, updated_at)
         VALUES (?, ?, 'worktree', 'ready', 'generic-pnpm', 'lean', '/tmp/wt', 'feat/x', 1, ?, ?)`,
      )
      .run('primary-worktree', 't1', now, now)

    const res = await fetch(`${baseUrl}/tasks/t1/resources`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as Array<{ id: string; status: string; path: string; branch: string }>
    expect(body).toHaveLength(1)
    expect(body[0]?.id).toBe('primary-worktree')
    expect(body[0]?.status).toBe('ready')
    expect(body[0]?.path).toBe('/tmp/wt')
    expect(body[0]?.branch).toBe('feat/x')
  })

  it('returns [] when task db is missing or table absent', async () => {
    // build server with getTaskDb returning null
    const app = express()
    app.use(express.json())
    app.use(
      '/tasks',
      createTasksRouter(indexDb, log, () => makeLauncher(), () => null),
    )
    server = http.createServer(app)
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
    const addr = server.address() as AddressInfo
    baseUrl = `http://127.0.0.1:${addr.port}`

    const res = await fetch(`${baseUrl}/tasks/missing/resources`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual([])
  })
})

describe('GET /tasks/:id/messages', () => {
  function insertMessage(id: string, content: string, createdAt: string) {
    taskDb
      .prepare(
        `INSERT INTO chatroom_messages
         (id, task_id, channel, type, sender, content, mention, refs, created_at)
         VALUES (?, 't1', 'main', 'system-event', 'system', ?, '[]', '[]', ?)`,
      )
      .run(id, content, createdAt)
  }

  it('returns all messages in created_at order by default', async () => {
    insertMessage('m2', 'second', '2026-06-28T00:00:02.000Z')
    insertMessage('m1', 'first', '2026-06-28T00:00:01.000Z')
    await startServer()

    const res = await fetch(`${baseUrl}/tasks/t1/messages`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as Array<{ id: string; content: string }>
    expect(body.map((m) => m.id)).toEqual(['m1', 'm2'])
  })

  it('returns only messages newer than after for missed WS sync', async () => {
    insertMessage('m1', 'already cached', '2026-06-28T00:00:01.000Z')
    insertMessage('m2', 'missed while unsubscribed', '2026-06-28T00:00:02.000Z')
    await startServer()

    const res = await fetch(
      `${baseUrl}/tasks/t1/messages?after=${encodeURIComponent('2026-06-28T00:00:01.000Z')}`,
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as Array<{ id: string; content: string }>
    expect(body.map((m) => m.id)).toEqual(['m2'])
  })

  it('returns the newest limited message tail in chronological order', async () => {
    insertMessage('m1', 'old', '2026-06-28T00:00:01.000Z')
    insertMessage('m2', 'middle', '2026-06-28T00:00:02.000Z')
    insertMessage('m3', 'new', '2026-06-28T00:00:03.000Z')
    await startServer()

    const res = await fetch(`${baseUrl}/tasks/t1/messages?limit=2`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as Array<{ id: string; content: string }>
    expect(body.map((m) => m.id)).toEqual(['m2', 'm3'])
  })

  it('acks urgent system events by stable urgent key', async () => {
    taskDb
      .prepare(
        `INSERT INTO chatroom_messages
         (id, task_id, channel, type, sender, content, mention, refs, urgent_key, created_at)
         VALUES ('m1', 't1', 'main', 'system-event', 'system', '⚠️ 任务卡住:releasing 阶段超 10min 无任何进展。当前阶段无人推进,请人类介入。', '[]', '[]', 'urgent-test', '2026-06-28T00:00:01.000Z')`,
      )
      .run()
    await startServer()

    const ackRes = await fetch(`${baseUrl}/tasks/t1/messages/urgent-test/ack`, { method: 'POST' })
    expect(ackRes.status).toBe(200)
    expect(await ackRes.json()).toMatchObject({ ok: true, ids: ['m1', 'urgent-test'] })

    const msgRes = await fetch(`${baseUrl}/tasks/t1/messages`)
    const messages = (await msgRes.json()) as Array<{ id: string; acknowledgedAt: string | null }>
    expect(messages[0]).toMatchObject({ id: 'm1', acknowledgedAt: expect.any(String) })

    const ackListRes = await fetch(`${baseUrl}/tasks/t1/urgent-acks`)
    expect(await ackListRes.json()).toEqual(expect.arrayContaining(['m1', 'urgent-test']))
  })
})

describe('GET /tasks/:id/seats', () => {
  it('derives current agent and status from live agents for initial render', async () => {
    await startServer()
    const now = new Date().toISOString()
    taskDb
      .prepare(
        `INSERT INTO seats (id, task_id, role, factory, status, queue, created_at)
         VALUES ('seat-1', 'task-1', 'planner', 'planner', 'init', '[]', ?)`,
      )
      .run(now)
    taskDb
      .prepare(
        `INSERT INTO agents (id, task_id, seat_id, factory, display_name, state, factory_version, spawned_at)
         VALUES ('agent-1', 'task-1', 'seat-1', 'planner', '刘伯温', 'idle', 10, ?)`,
      )
      .run(now)
    taskDb
      .prepare(
        `INSERT INTO agents (id, task_id, seat_id, factory, display_name, state, factory_version, spawned_at)
         VALUES ('agent-old', 'task-1', 'seat-1', 'planner', '旧实例', 'terminated', 10, ?)`,
      )
      .run(new Date(Date.now() + 1_000).toISOString())

    const res = await fetch(`${baseUrl}/tasks/task-1/seats`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as Array<{ id: string; status: string; currentAgentId: string | null }>
    expect(body).toEqual([
      expect.objectContaining({
        id: 'seat-1',
        status: 'idle',
        currentAgentId: 'agent-1',
      }),
    ])
  })
})

describe('POST /tasks/:id/bootstrap/retry', () => {
  it('404 when task unknown', async () => {
    await startServer(vi.fn() as unknown as StartBootstrap)
    const res = await fetch(`${baseUrl}/tasks/nope/bootstrap/retry`, { method: 'POST' })
    expect(res.status).toBe(404)
  })

  it('503 when startBootstrap not wired', async () => {
    indexDb
      .prepare(
        `INSERT INTO tasks_meta (id, project_id, title, description, created_at, updated_at)
         VALUES ('t1', 'p1', 'x', 'd', '2020-01-01T00:00:00Z', '2020-01-01T00:00:00Z')`,
      )
      .run()
    await startServer()
    const res = await fetch(`${baseUrl}/tasks/t1/bootstrap/retry`, { method: 'POST' })
    expect(res.status).toBe(503)
  })

  it('invokes startBootstrap with task workdir and returns ok', async () => {
    indexDb
      .prepare(
        `INSERT INTO tasks_meta (id, project_id, title, description, created_at, updated_at)
         VALUES ('t1', 'p1', 'x', 'd', '2020-01-01T00:00:00Z', '2020-01-01T00:00:00Z')`,
      )
      .run()
    const startBootstrap = vi.fn(async () => null)
    await startServer(startBootstrap as unknown as StartBootstrap)
    const res = await fetch(`${baseUrl}/tasks/t1/bootstrap/retry`, { method: 'POST' })
    expect(res.status).toBe(200)
    expect(startBootstrap).toHaveBeenCalledTimes(1)
    const firstCall = (startBootstrap.mock.calls as unknown as Array<Array<{ taskId: string; projectId: string }>>)[0]
    expect(firstCall?.[0]?.taskId).toBe('t1')
    expect(firstCall?.[0]?.projectId).toBe('p1')
  })
})

describe('workspace file viewer routes', () => {
  function seedTask(taskId = 't1', projectId = 'p1') {
    indexDb
      .prepare(
        `INSERT INTO tasks_meta (id, project_id, title, description, created_at, updated_at)
         VALUES (?, ?, 'x', 'd', '2020-01-01T00:00:00Z', '2020-01-01T00:00:00Z')`,
      )
      .run(taskId, projectId)
    const taskDir = path.join(tmp, 'projects', projectId, 'tasks', taskId)
    fs.mkdirSync(path.join(taskDir, 'plan'), { recursive: true })
    return taskDir
  }

  it('returns workspace file content before checking worktree', async () => {
    const taskDir = seedTask()
    fs.writeFileSync(path.join(taskDir, 'plan', 'task-plan.md'), '# Plan')
    await startServer()

    const res = await fetch(`${baseUrl}/tasks/t1/file?path=plan/task-plan.md`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { content: string; root: string; ext: string }
    expect(body).toMatchObject({ content: '# Plan', root: 'workspace', ext: 'md' })
  })

  it('returns raw file bytes', async () => {
    const taskDir = seedTask()
    fs.mkdirSync(path.join(taskDir, 'screenshots'), { recursive: true })
    fs.writeFileSync(path.join(taskDir, 'screenshots', 'one.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    await startServer()

    const res = await fetch(`${baseUrl}/tasks/t1/file?path=screenshots/one.png&raw=1`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('image/png')
    const body = Buffer.from(await res.arrayBuffer())
    expect([...body]).toEqual([0x89, 0x50, 0x4e, 0x47])
  })

  it('returns worktree file content when workspace misses', async () => {
    seedTask()
    const worktree = fs.mkdtempSync(path.join(os.tmpdir(), 'tasks-file-viewer-wt-'))
    fs.mkdirSync(path.join(worktree, 'apps', 'web', 'src'), { recursive: true })
    fs.writeFileSync(path.join(worktree, 'apps', 'web', 'src', 'App.tsx'), 'export const App = 1')
    const now = new Date().toISOString()
    taskDb
      .prepare(
        `INSERT INTO bootstrap_resources (id, task_id, kind, status, provider, mode, path, attempts, created_at, updated_at)
         VALUES ('primary-worktree', 't1', 'worktree', 'ready', 'sw', 'lean', ?, 1, ?, ?)`,
      )
      .run(worktree, now, now)
    await startServer()

    const res = await fetch(`${baseUrl}/tasks/t1/file?path=apps/web/src/App.tsx`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { content: string; root: string; ext: string }
    expect(body).toMatchObject({
      content: 'export const App = 1',
      root: 'worktree',
      ext: 'tsx',
    })
    fs.rmSync(worktree, { recursive: true, force: true })
  })

  it('rejects path traversal', async () => {
    seedTask()
    await startServer()
    const res = await fetch(`${baseUrl}/tasks/t1/file?path=../../../../etc/passwd`)
    expect(res.status).toBe(403)
  })

  it('rejects raw path traversal before reading bytes', async () => {
    seedTask()
    await startServer()
    const res = await fetch(`${baseUrl}/tasks/t1/file?path=../../../../etc/passwd&raw=1`)
    expect(res.status).toBe(403)
  })

  it('returns 404 for missing file', async () => {
    seedTask()
    await startServer()
    const res = await fetch(`${baseUrl}/tasks/t1/file?path=missing.md`)
    expect(res.status).toBe(404)
  })

  it('marks binary non-image preview without returning text content', async () => {
    const taskDir = seedTask()
    fs.writeFileSync(path.join(taskDir, 'archive.bin'), Buffer.from([0x00, 0x01, 0x02, 0x03]))
    await startServer()

    const res = await fetch(`${baseUrl}/tasks/t1/file?path=archive.bin`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { binary: boolean; content: string; ext: string }
    expect(body).toMatchObject({ binary: true, content: '', ext: 'bin' })
  })

  it('truncates large text previews at 256KB', async () => {
    const taskDir = seedTask()
    fs.writeFileSync(path.join(taskDir, 'large.log'), 'a'.repeat(256 * 1024 + 3))
    await startServer()

    const res = await fetch(`${baseUrl}/tasks/t1/file?path=large.log`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { content: string; truncated: boolean }
    expect(body.truncated).toBe(true)
    expect(Buffer.byteLength(body.content)).toBe(256 * 1024)
  })

  it('lists one workspace directory layer', async () => {
    const taskDir = seedTask()
    fs.mkdirSync(path.join(taskDir, 'plan', 'nested'), { recursive: true })
    fs.writeFileSync(path.join(taskDir, 'plan', 'task-plan.md'), '# Plan')
    fs.writeFileSync(path.join(taskDir, 'task.db'), 'noise')
    await startServer()

    const res = await fetch(`${baseUrl}/tasks/t1/workspace/ls?path=plan`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { entries: Array<{ name: string; type: string }> }
    expect(body.entries).toEqual([
      { name: 'nested', type: 'dir' },
      { name: 'task-plan.md', type: 'file' },
    ])
  })

  it('rejects workspace listing path traversal', async () => {
    seedTask()
    await startServer()
    const res = await fetch(`${baseUrl}/tasks/t1/workspace/ls?path=../../../../etc`)
    expect(res.status).toBe(403)
  })
})
