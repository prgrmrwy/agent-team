/**
 * Phase 3.5: POST /tasks 在 task-process 与 bootstrap runner 之间执行的并行编排。
 *
 * 验证点：
 *  - startBootstrap 在 launcher.launch 之前/同期被调用，不等待其 resolve
 *  - bootstrap 失败（startBootstrap reject）不阻塞 launcher.launch 也不让 201 退化为 5xx
 *  - 任务目录骨架不再 mkdir worktree/
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

const log = logger.child({ module: 'tasks-bootstrap-test' })

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

let tmp: string
let indexDb: DbClient
let server: http.Server
let baseUrl: string
let originalDataHome: string | undefined
let originalToken: string | undefined

function makeLauncher(launchImpl: () => Promise<boolean>): TaskProcessLauncher {
  return {
    launch: vi.fn(launchImpl),
    hasActive: () => false,
  } as unknown as TaskProcessLauncher
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tasks-bootstrap-test-'))
  originalDataHome = process.env['DATA_HOME']
  originalToken = process.env['AGENT_TEAM_TOKEN']
  process.env['DATA_HOME'] = tmp
  process.env['AGENT_TEAM_TOKEN'] = 'test-token-bootstrap'
  _resetConfigForTest()

  indexDb = new Database(':memory:') as unknown as DbClient
  ;(indexDb as unknown as { exec: (s: string) => void }).exec(TASKS_META_SCHEMA)
})

afterEach(async () => {
  if (server) await new Promise<void>((r) => server.close(() => r()))
  indexDb.close()
  fs.rmSync(tmp, { recursive: true, force: true })
  if (originalDataHome === undefined) delete process.env['DATA_HOME']
  else process.env['DATA_HOME'] = originalDataHome
  if (originalToken === undefined) delete process.env['AGENT_TEAM_TOKEN']
  else process.env['AGENT_TEAM_TOKEN'] = originalToken
  _resetConfigForTest()
})

async function startServer(startBootstrap: StartBootstrap, launcher: TaskProcessLauncher): Promise<void> {
  const app = express()
  app.use(express.json())
  app.use(
    '/tasks',
    createTasksRouter(indexDb, log, () => launcher, () => null, startBootstrap),
  )
  server = http.createServer(app)
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  const addr = server.address() as AddressInfo
  baseUrl = `http://127.0.0.1:${addr.port}`
}

describe('POST /tasks bootstrap parallelism (Phase 3.1/3.2/3.5)', () => {
  it('triggers startBootstrap and launcher in parallel; bootstrap pending does not delay launcher', async () => {
    let bootstrapResolved = false
    let launcherCalledAt = 0
    let bootstrapCalledAt = 0

    const startBootstrap: StartBootstrap = vi.fn(async () => {
      bootstrapCalledAt = Date.now()
      // 模拟 bootstrap 比 launcher 慢
      await new Promise((r) => setTimeout(r, 200))
      bootstrapResolved = true
      return null
    })

    const launcher = makeLauncher(async () => {
      launcherCalledAt = Date.now()
      return true
    })

    await startServer(startBootstrap, launcher)

    const t0 = Date.now()
    const res = await fetch(`${baseUrl}/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ description: 'hello bootstrap parallel', contextLinks: [] }),
    })
    const elapsed = Date.now() - t0
    expect(res.status).toBe(201)

    expect(startBootstrap).toHaveBeenCalledTimes(1)
    expect(launcher.launch).toHaveBeenCalledTimes(1)
    // launcher 不应该等 bootstrap 完成
    expect(bootstrapResolved).toBe(false)
    expect(launcherCalledAt).toBeGreaterThan(0)
    expect(bootstrapCalledAt).toBeGreaterThan(0)
    // 整个请求应明显早于 bootstrap 完成；阈值留出 CI/并发调度抖动。
    expect(elapsed).toBeLessThan(180)
  })

  it('bootstrap rejection does not block 201 / launcher', async () => {
    const startBootstrap: StartBootstrap = vi.fn(async () => {
      throw new Error('bootstrap failed')
    })
    const launcher = makeLauncher(async () => true)

    await startServer(startBootstrap, launcher)

    const res = await fetch(`${baseUrl}/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ description: 'bootstrap rejects', contextLinks: [] }),
    })
    expect(res.status).toBe(201)
    expect(launcher.launch).toHaveBeenCalledTimes(1)
  })

  it('does NOT mkdir worktree/ subdir (Phase 3.2)', async () => {
    const startBootstrap: StartBootstrap = vi.fn(async () => null)
    const launcher = makeLauncher(async () => true)

    await startServer(startBootstrap, launcher)

    const res = await fetch(`${baseUrl}/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ description: 'no worktree dir', contextLinks: [] }),
    })
    expect(res.status).toBe(201)
    const body = (await res.json()) as { id: string; projectId: string }

    const taskDir = path.join(tmp, 'projects', body.projectId, 'tasks', body.id)
    expect(fs.existsSync(path.join(taskDir, 'plan'))).toBe(true)
    expect(fs.existsSync(path.join(taskDir, 'agents'))).toBe(true)
    expect(fs.existsSync(path.join(taskDir, 'worktree'))).toBe(false)
  })
})
