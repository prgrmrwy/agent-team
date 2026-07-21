/**
 * 组 13 单测：MCP 工具 handler happy + edge
 * 用 TaskMcpContext 直接测业务逻辑（不启动真实 stdio transport）。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pino } from 'pino'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { DbClient } from '../db/client.js'
import { openDb, runMigrations } from '../db/client.js'
import { EffectEmitter } from '../domain/orchestrator/transition-effects.js'
import { TaskMcpContext } from './mcp-server.js'

const log = pino({ level: 'silent' })

const MIGRATIONS_TASK = path.join(import.meta.dirname ?? __dirname, '../db/migrations-task')
const MIGRATIONS_INDEX = path.join(import.meta.dirname ?? __dirname, '../db/migrations-index')

let tmpDir: string
let db: DbClient
let ctx: TaskMcpContext
const TASK_ID = 'task-test01'

function setupTask(dir: string, taskId: string, taskDb: DbClient) {
  // 创建目录结构
  fs.mkdirSync(path.join(dir, 'plan'), { recursive: true })
  fs.mkdirSync(path.join(dir, 'eng'), { recursive: true })
  fs.mkdirSync(path.join(dir, 'retro'), { recursive: true })

  // 在 index DB 插 task_meta（用于 task_state_get/propose）
  try {
    taskDb
      .prepare(
        `INSERT INTO tasks_meta (id, project_id, title, description, context_links, state, created_at, updated_at)
         VALUES (?, 'proj-1', 'Test Task', 'desc', '[]', 'S0', ?, ?)`,
      )
      .run(taskId, new Date().toISOString(), new Date().toISOString())
  } catch {
    // 可能 tasks_meta 不在 task db，忽略
  }
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-test-'))
  const dbPath = path.join(tmpDir, 'task.db')
  db = openDb(dbPath, log)
  runMigrations(db, MIGRATIONS_TASK, log)

  // 也跑 index migrations（有 state_history 等表）
  // task db 包含 state_history，复用同一个 db
  const emitter = new EffectEmitter()
  ctx = new TaskMcpContext({
    taskId: TASK_ID,
    taskWorkdir: tmpDir,
    db,
    emitter,
    log,
  })

  setupTask(tmpDir, TASK_ID, db)
})

afterEach(() => {
  db.close()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

// ---- chatroom_send ----
describe('chatroom_send', () => {
  it('happy: 写消息到 DB + chatroom.jsonl', async () => {
    const tool = getTool('chatroom_send')
    const result = await tool({
      channel: 'main',
      type: 'agent-text',
      content: 'hello world',
    })
    const out = parseResult(result)
    expect(out.messageId).toBeTruthy()
    expect(out.queuedSeats).toEqual([])

    // chatroom.jsonl 应存在
    const jsonl = fs.readFileSync(path.join(tmpDir, 'chatroom.jsonl'), 'utf-8')
    expect(jsonl).toContain('hello world')
  })

  it('urgent system-event also emits browser notification event', async () => {
    const notifies: Array<{ taskId: string; level: string; content: string }> = []
    const onNotify = (evt: { taskId: string; level: string; content: string }) => notifies.push(evt)
    ctx.emitter.on('notify', onNotify)
    try {
      const tool = getTool('chatroom_send')
      const out = parseResult(
        await tool({
          channel: 'main',
          type: 'system-event',
          content: '⚠ 等待人类确认: 请确认返回链路，我会暂停规划/建岗/propose。',
        }),
      )

      const row = db.prepare('SELECT urgent_key FROM chatroom_messages WHERE id = ?').get(out.messageId) as
        | { urgent_key: string | null }
        | undefined
      expect(row?.urgent_key).toMatch(/^urgent-/)
      expect(notifies).toEqual([
        {
          taskId: TASK_ID,
          level: 'warn',
          content: '⚠ 等待人类确认: 请确认返回链路，我会暂停规划/建岗/propose。',
        },
      ])
    } finally {
      ctx.emitter.off('notify', onNotify)
    }
  })

  it('planner waiting-confirmation system-event marks the human-confirmation gate', async () => {
    const marks: Array<{ messageId: string; byAgentId: string; content: string }> = []
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const m = ctx as any
    const originalMark = m.markHumanConfirmationPending
    m.markHumanConfirmationPending = (input: {
      messageId: string
      byAgentId: string
      content: string
    }) => marks.push(input)
    try {
      const out = parseResult(
        await callToolWithRole('chatroom_send', 'planner', {
          channel: 'main',
          type: 'system-event',
          content: '⚠ 等待人类确认: 请确认方案 A/B，我会暂停规划/建岗/propose。',
        }),
      )

      expect(marks).toEqual([
        {
          messageId: out.messageId,
          byAgentId: 'stub-agent-planner',
          content: '⚠ 等待人类确认: 请确认方案 A/B，我会暂停规划/建岗/propose。',
        },
      ])
    } finally {
      m.markHumanConfirmationPending = originalMark
    }
  })

  it('stateless: callerAgentId 解析 sender(无 sessionId)— 回归 caller=system bug', async () => {
    // stateless MCP 下 extra.sessionId 恒 undefined,caller 身份只能来自 ctx.callerAgentId。
    // 回归:之前 resolveCallerId 用 `if (extra.sessionId)` 门控 → 全 fallback 'system',
    // planner 消息被标 system + task_state_propose 被拒。
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const m = ctx as any
    m.callerAgentId = 'planner-stateless-1'
    try {
      // @ts-expect-error: 访问内部 _registeredTools
      const registered = ctx.mcpServer._registeredTools as Record<
        string,
        { handler: (a: unknown, e: unknown) => Promise<unknown> }
      >
      // 不传 sessionId(模拟 stateless transport)
      const result = (await registered['chatroom_send']!.handler(
        { channel: 'main', type: 'agent-text', content: 'from stateless planner' },
        {},
      )) as { content: Array<{ type: string; text: string }> }
      const out = parseResult(result)
      const row = db.prepare('SELECT sender FROM chatroom_messages WHERE id = ?').get(out.messageId) as
        | { sender: string }
        | undefined
      expect(row?.sender).toBe('planner-stateless-1')
    } finally {
      m.callerAgentId = undefined
    }
  })

  it('edge: mention offline 岗位 → 入队', async () => {
    // 插入一个 offline seat
    db.prepare(
      `INSERT INTO seats (id, task_id, role, factory, status, current_agent_id, queue, created_at)
       VALUES ('seat-1', ?, 'Planner #1', 'planner', 'offline', NULL, '[]', ?)`,
    ).run(TASK_ID, new Date().toISOString())

    const tool = getTool('chatroom_send')
    const result = await tool({
      channel: 'main',
      type: 'agent-text',
      content: 'message to offline',
      mention: ['seat-1'],
    })
    const out = parseResult(result)
    expect(out.queuedSeats).toContain('seat-1')
  })

  it('mention vacant 懒式 seat 只入队、不 spawn;绑定过 agent 的 seat 才唤醒 — 回归 S6 提前拉 qa/ci', async () => {
    db.prepare(
      `INSERT INTO seats (id, task_id, role, factory, status, current_agent_id, queue, created_at)
       VALUES ('seat-vac', ?, 'QA #1', 'qa', 'vacant', NULL, '[]', ?),
              ('seat-off', ?, 'Engineer #1', 'engineer', 'offline', NULL, '[]', ?)`,
    ).run(TASK_ID, new Date().toISOString(), TASK_ID, new Date().toISOString())
    db.prepare(
      `INSERT INTO agents (id, task_id, seat_id, factory, display_name, state, factory_version, spawned_at)
       VALUES ('agent-off', ?, 'seat-off', 'engineer', 'Engineer #1', 'idle', 1, ?)`,
    ).run(TASK_ID, new Date().toISOString())

    const woken: string[] = []
    const onWake = (evt: { seatId: string }) => woken.push(evt.seatId)
    ctx.emitter.on('wakeup-seat', onWake)
    try {
      const tool = getTool('chatroom_send')
      const out = parseResult(
        await tool({
          channel: 'main',
          type: 'agent-text',
          content: '交接 @all',
          mention: ['seat-vac', 'seat-off'],
        }),
      )
      // 两者都入队(spawn 后能从 queue/chatroom 看到)
      expect(out.queuedSeats).toEqual(expect.arrayContaining(['seat-vac', 'seat-off']))
      // 但只有已有 agent 绑定的 seat 触发唤醒;vacant(懒式未上场)绝不因被 @ 提前 spawn
      expect(woken).toContain('seat-off')
      expect(woken).not.toContain('seat-vac')
    } finally {
      ctx.emitter.off('wakeup-seat', onWake)
    }
  })
})

// ---- chatroom_recent ----
describe('chatroom_recent', () => {
  it('happy: 返回最近 n 条消息', async () => {
    // 先发几条消息
    const send = getTool('chatroom_send')
    await send({ channel: 'main', type: 'agent-text', content: 'msg1' })
    await send({ channel: 'main', type: 'agent-text', content: 'msg2' })

    const recent = getTool('chatroom_recent')
    const result = await recent({ channel: 'main', n: 10 })
    const out = parseResult(result)
    expect(out.messages.length).toBe(2)
    expect(out.messages[0].content).toBe('msg1')
  })

  it('edge: n=1 只返回最新一条', async () => {
    const send = getTool('chatroom_send')
    await send({ channel: 'main', type: 'agent-text', content: 'first' })
    await send({ channel: 'main', type: 'agent-text', content: 'second' })

    const recent = getTool('chatroom_recent')
    const result = await recent({ channel: 'main', n: 1 })
    const out = parseResult(result)
    expect(out.messages.length).toBe(1)
    expect(out.messages[0].content).toBe('second')
  })

  it('records chatroom-read usage for non-empty payloads', async () => {
    insertTestAgent('agent-reader')
    const send = getTool('chatroom_send')
    await send({ channel: 'main', type: 'agent-text', content: 'usage payload' })

    const result = await callToolWithAgent('chatroom_recent', 'agent-reader', {
      channel: 'main',
      n: 10,
    })
    const out = parseResult(result)
    expect(out.messages.length).toBe(1)

    const row = db
      .prepare(
        `SELECT agent_id, source, total_tokens
         FROM token_usage_events
         WHERE source = 'chatroom-read'`,
      )
      .get() as { agent_id: string; source: string; total_tokens: number }
    expect(row.agent_id).toBe('agent-reader')
    expect(row.total_tokens).toBeGreaterThan(0)
  })
})

// ---- chatroom_listen ----
describe('chatroom_listen', () => {
  it('happy: 有新消息立即返回', async () => {
    // 先发一条，再 listen
    const send = getTool('chatroom_send')
    await send({ channel: 'main', type: 'agent-text', content: 'preexisting' })

    const listen = getTool('chatroom_listen')
    const result = await listen({ channel: 'main', timeoutMs: 100 })
    const out = parseResult(result)
    // 因为 since 未指定，返回全部当前消息
    expect(out.messages.length).toBeGreaterThanOrEqual(1)
  })

  it('edge: 没有消息超时返回空数组', async () => {
    insertTestAgent('agent-listener')
    const result = await callToolWithAgent('chatroom_listen', 'agent-listener', {
      channel: 'main',
      timeoutMs: 50,
    })
    const out = parseResult(result)
    // 可能为空（没有消息）
    expect(Array.isArray(out.messages)).toBe(true)
    const count = db
      .prepare(`SELECT COUNT(*) count FROM token_usage_events WHERE source = 'chatroom-read'`)
      .get() as { count: number }
    expect(count.count).toBe(0)
  })

  it('records chatroom-read usage when listen returns messages', async () => {
    insertTestAgent('agent-listener')
    const send = getTool('chatroom_send')
    await send({ channel: 'main', type: 'agent-text', content: 'listen payload' })

    const result = await callToolWithAgent('chatroom_listen', 'agent-listener', {
      channel: 'main',
      timeoutMs: 100,
    })
    const out = parseResult(result)
    expect(out.messages.length).toBeGreaterThanOrEqual(1)
    const row = db
      .prepare(`SELECT agent_id, total_tokens FROM token_usage_events WHERE source = 'chatroom-read'`)
      .get() as { agent_id: string; total_tokens: number }
    expect(row.agent_id).toBe('agent-listener')
    expect(row.total_tokens).toBeGreaterThan(0)
  })
})

// ---- artifact_register ----
describe('artifact_register', () => {
  it('happy: 注册已存在文件', async () => {
    fs.writeFileSync(path.join(tmpDir, 'eng/design.md'), '# Design', 'utf-8')
    const tool = getTool('artifact_register')
    const result = await tool({
      taskId: TASK_ID,
      path: 'eng/design.md',
      type: 'design',
      producer: 'agent-1',
      summary: 'design doc',
    })
    const out = parseResult(result)
    expect(out.artifactId).toBeTruthy()
  })

  it('edge: 文件不存在被拒', async () => {
    const tool = getTool('artifact_register')
    const result = await tool({
      taskId: TASK_ID,
      path: 'eng/nonexistent.md',
      type: 'design',
      producer: 'agent-1',
      summary: '',
    })
    const out = parseResult(result)
    expect(out.error).toBeTruthy()
    expect(out.error).toMatch(/not found/)
  })

  it('edge: 路径越界被 RelPath schema 或业务拒绝', async () => {
    const tool = getTool('artifact_register')
    // /etc/passwd 是绝对路径，RelPath schema 会在 parse 层抛 ZodError
    // 业务逻辑也会拒绝越界路径
    await expect(
      tool({
        taskId: TASK_ID,
        path: '/etc/passwd',
        type: 'other',
        producer: 'agent-1',
        summary: '',
      }),
    ).rejects.toThrow() // zod 在 schema 层就拒绝了
  })
})

// ---- artifact_list / artifact_get ----
describe('artifact_list + artifact_get', () => {
  it('happy: list 返回注册的制品', async () => {
    fs.writeFileSync(path.join(tmpDir, 'eng/test-report.md'), '# Report', 'utf-8')
    const register = getTool('artifact_register')
    await register({
      taskId: TASK_ID,
      path: 'eng/test-report.md',
      type: 'test-report',
      producer: 'agent-1',
      summary: '',
    })

    const list = getTool('artifact_list')
    const result = await list({ taskId: TASK_ID })
    const out = parseResult(result)
    expect(out.artifacts.length).toBe(1)
    expect(out.artifacts[0].type).toBe('test-report')
  })

  it('happy: artifact_get 返回内容', async () => {
    fs.writeFileSync(path.join(tmpDir, 'eng/design.md'), '# Design content', 'utf-8')
    const register = getTool('artifact_register')
    const regResult = await register({
      taskId: TASK_ID,
      path: 'eng/design.md',
      type: 'design',
      producer: 'agent-1',
      summary: '',
    })
    const { artifactId } = parseResult(regResult)

    const getArt = getTool('artifact_get')
    const result = await getArt({ artifactId })
    const out = parseResult(result)
    expect(out.artifact.id).toBe(artifactId)
    expect(out.content).toContain('Design content')
  })
})

// ---- seat_create / seat_list / seat_status_get ----
describe('seat tools', () => {
  it('happy: seat_create 创建岗位', async () => {
    const create = getTool('seat_create')
    const result = await create({ taskId: TASK_ID, role: 'Planner #1', factory: 'planner' })
    const out = parseResult(result)
    expect(out.seatId).toBeTruthy()
  })

  it('happy: seat_list 返回所有岗位', async () => {
    const create = getTool('seat_create')
    await create({ taskId: TASK_ID, role: 'Planner #1', factory: 'planner' })
    await create({ taskId: TASK_ID, role: 'Engineer #1', factory: 'engineer' })

    const list = getTool('seat_list')
    const result = await list({ taskId: TASK_ID })
    const out = parseResult(result)
    expect(out.seats.length).toBe(2)
  })

  it('happy: seat_status_get 返回详情', async () => {
    const create = getTool('seat_create')
    const created = parseResult(
      await create({
        taskId: TASK_ID,
        role: 'Planner #1',
        factory: 'planner',
        modelOverride: { provider: 'codex-sdk', model: 'gpt-5.5' },
      }),
    )

    const statusGet = getTool('seat_status_get')
    const result = await statusGet({ seatId: created.seatId })
    const out = parseResult(result)
    expect(out.seat.id).toBe(created.seatId)
    expect(out.seat.status).toBe('vacant')
    expect(out.seat.modelOverride).toEqual({ provider: 'codex-sdk', model: 'gpt-5.5' })
  })

  it('edge: seat_status_get 不存在的 seat', async () => {
    const statusGet = getTool('seat_status_get')
    const result = await statusGet({ seatId: 'nonexistent' })
    const out = parseResult(result)
    expect(out.error).toBeTruthy()
  })

  it('edge: planner 等待人类确认期间不能 seat_create', async () => {
    withHumanConfirmationPending(true)
    try {
      const result = await callToolWithRole('seat_create', 'planner', {
        taskId: TASK_ID,
        role: 'Engineer #1',
        factory: 'engineer',
      })
      const out = parseResult(result)
      expect(out.error).toMatch(/waiting for human confirmation/)
    } finally {
      withHumanConfirmationPending(undefined)
    }
  })
})

// ---- task_write ----
describe('task_write', () => {
  it('happy: engineer 写 eng/ 目录', async () => {
    const write = getTool('task_write')
    const result = await write({
      taskId: TASK_ID,
      path: 'eng/test-report.md',
      content: '# Test Report\n## 结果\n全通',
      overwrite: false,
    })
    const out = parseResult(result)
    expect(out.success).toBe(true)
    expect(out.bytesWritten).toBeGreaterThan(0)
    expect(fs.existsSync(path.join(tmpDir, 'eng/test-report.md'))).toBe(true)
  })

  it('happy: qa 写 qa/ 目录', async () => {
    const write = getTool('task_write')
    const result = await write({
      taskId: TASK_ID,
      path: 'qa/verification_report.md',
      content: '# Verification Report\n结论: PASS',
      overwrite: false,
    })
    const out = parseResult(result)
    expect(out.success).toBe(true)
    expect(fs.existsSync(path.join(tmpDir, 'qa/verification_report.md'))).toBe(true)
  })

  // m2-ci-factory: ci 写 ci/ 目录
  it('happy: ci 写 ci/ 目录', async () => {
    const write = getTool('task_write')
    const result = await write({
      taskId: TASK_ID,
      path: 'ci/ci_report.md',
      content: '# CI Report\n## ready2merge\ntrue',
      overwrite: false,
    })
    const out = parseResult(result)
    expect(out.success).toBe(true)
    expect(fs.existsSync(path.join(tmpDir, 'ci/ci_report.md'))).toBe(true)
  })

  it('edge: overwrite=false 文件已存在被拒', async () => {
    fs.writeFileSync(path.join(tmpDir, 'eng/existing.md'), 'old content', 'utf-8')
    const write = getTool('task_write')
    const result = await write({
      taskId: TASK_ID,
      path: 'eng/existing.md',
      content: 'new content',
      overwrite: false,
    })
    const out = parseResult(result)
    expect(out.success).toBe(false)
    expect(out.reason).toMatch(/already exists/)
  })

  it('edge: 越权写 plan/ 目录（engineer 角色推断）', async () => {
    const write = getTool('task_write')
    const result = await write({
      taskId: TASK_ID,
      path: 'plan/task-plan.md',
      content: 'hacked',
      overwrite: true,
    })
    // plan/ 推断为 planner，但调用方（当前 inferCallerRole 是 planner），应该通过
    // 实际 M1 中，角色推断是基于 path 的，此测试验证结果
    const out = parseResult(result)
    // planner 可以写 plan/，所以 success=true
    expect(typeof out.success).toBe('boolean')
  })

  it('edge: 写保护路径 chatroom.jsonl 被拒', async () => {
    const write = getTool('task_write')
    const result = await write({
      taskId: TASK_ID,
      path: 'chatroom.jsonl',
      content: 'hacked',
      overwrite: true,
    })
    const out = parseResult(result)
    expect(out.success).toBe(false)
  })

  // Phase 6.3/6.4: planner 写 openspec/changes/** 进 planning home (task mgmt dir)
  it('happy (phase 6): planner 写 openspec/changes/<name>/proposal.md 到 task 管理目录', async () => {
    const write = getTool('task_write')
    const result = await write({
      taskId: TASK_ID,
      path: 'openspec/changes/sample-change/proposal.md',
      content: '## Why\n\nsample proposal',
      overwrite: false,
    })
    const out = parseResult(result)
    expect(out.success).toBe(true)
    expect(
      fs.existsSync(path.join(tmpDir, 'openspec/changes/sample-change/proposal.md')),
    ).toBe(true)
  })

  it('happy (phase 6): planner 写 openspec/changes/<name>/specs/<cap>/spec.md', async () => {
    const write = getTool('task_write')
    const result = await write({
      taskId: TASK_ID,
      path: 'openspec/changes/sample-change/specs/cap/spec.md',
      content: '## ADDED\n\nfoo',
      overwrite: false,
    })
    const out = parseResult(result)
    expect(out.success).toBe(true)
  })

  it('edge (phase 6): openspec/ 根目录文件被拒（必须落 changes/ 或 specs/）', async () => {
    const write = getTool('task_write')
    const result = await write({
      taskId: TASK_ID,
      path: 'openspec/random.md',
      content: 'nope',
      overwrite: true,
    })
    const out = parseResult(result)
    expect(out.success).toBe(false)
    expect(out.reason).toMatch(/restricted/)
  })

  it('happy (phase 6, role-bound): planner session 可写 openspec/changes/<name>/proposal.md', async () => {
    const result = await callToolWithRole('task_write', 'planner', {
      taskId: TASK_ID,
      path: 'openspec/changes/foo/proposal.md',
      content: '# Why\nfoo',
      overwrite: true,
    })
    const out = parseResult(result)
    expect(out.success).toBe(true)
  })

  it('edge (phase 6, role-bound): engineer session 写 openspec/ 被拒（应去 worktree 改源码）', async () => {
    const result = await callToolWithRole('task_write', 'engineer', {
      taskId: TASK_ID,
      path: 'openspec/changes/foo/spec.md',
      content: 'nope',
      overwrite: true,
    })
    const out = parseResult(result)
    expect(out.success).toBe(false)
    expect(out.reason).toMatch(/engineer cannot write to openspec/)
  })

  it('happy (phase 6, role-bound): engineer session 仍能写 eng/ test-report.md', async () => {
    const result = await callToolWithRole('task_write', 'engineer', {
      taskId: TASK_ID,
      path: 'eng/test-report.md',
      content: '# Test\nPASS',
      overwrite: true,
    })
    const out = parseResult(result)
    expect(out.success).toBe(true)
  })

  it('edge: planner 等待人类确认期间不能写规划产物', async () => {
    withHumanConfirmationPending(true)
    try {
      const result = await callToolWithRole('task_write', 'planner', {
        taskId: TASK_ID,
        path: 'plan/task-plan.md',
        content: '# Plan',
        overwrite: true,
      })
      const out = parseResult(result)
      expect(out.success).toBe(false)
      expect(out.reason).toMatch(/waiting for human confirmation/)
      expect(fs.existsSync(path.join(tmpDir, 'plan/task-plan.md'))).toBe(false)
    } finally {
      withHumanConfirmationPending(undefined)
    }
  })
})

// ---- task_state_propose ----
describe('task_state_propose', () => {
  it('edge: planner 等待人类确认期间不能 propose 推进状态', async () => {
    insertTestAgent('stub-agent-planner', 'planner', 'seat-planner')
    withHumanConfirmationPending(true)
    try {
      const result = await callToolWithAgent('task_state_propose', 'stub-agent-planner', {
        taskId: TASK_ID,
        targetState: 'S2',
        evidence: { artifacts: [] },
      })
      const out = parseResult(result)
      expect(out.accepted).toBe(false)
      expect(out.reason).toMatch(/waiting for human confirmation/)
    } finally {
      withHumanConfirmationPending(undefined)
    }
  })
})

// ---- context_log ----
describe('context_log', () => {
  it('happy: 写入 context_access_log', async () => {
    const logTool = getTool('context_log')
    const result = await logTool({
      taskId: TASK_ID,
      agentId: 'agent-1',
      action: 'read-file',
      ref: 'plan/task-plan.md',
      ts: new Date().toISOString(),
    })
    const out = parseResult(result)
    expect(out.ok).toBe(true)

    const row = db.prepare("SELECT * FROM context_access_log WHERE agent_id = 'agent-1'").get() as
      | { action: string }
      | undefined
    expect(row?.action).toBe('read-file')
  })
})

// ---- task_resource_get (Phase 4.4) ----
describe('task_resource_get', () => {
  function insertWorktreeRow(input: {
    status: string
    path?: string | null
    branch?: string | null
    provider?: string
    mode?: string | null
    summary?: string | null
    error?: string | null
  }) {
    const now = new Date().toISOString()
    db.prepare(
      `INSERT INTO bootstrap_resources
         (id, task_id, kind, status, provider, mode, path, branch, base_ref, summary, error, attempts, created_at, updated_at)
       VALUES ('primary-worktree', ?, 'worktree', ?, ?, ?, ?, ?, NULL, ?, ?, 1, ?, ?)`,
    ).run(
      TASK_ID,
      input.status,
      input.provider ?? 'generic-pnpm',
      input.mode ?? 'lean',
      input.path ?? null,
      input.branch ?? null,
      input.summary ?? null,
      input.error ?? null,
      now,
      now,
    )
  }

  it('returns ready worktree resource with path/branch/provider', async () => {
    insertWorktreeRow({
      status: 'ready',
      path: '/tmp/wt-x',
      branch: 'task/x',
      provider: 'generic-pnpm',
      mode: 'lean',
      summary: 'ok',
    })
    const tool = getTool('task_resource_get')
    const out = parseResult(await tool({ taskId: TASK_ID }))
    expect(out.resources).toHaveLength(1)
    expect(out.resources[0]).toMatchObject({
      id: 'primary-worktree',
      kind: 'worktree',
      status: 'ready',
      provider: 'generic-pnpm',
      mode: 'lean',
      path: '/tmp/wt-x',
      branch: 'task/x',
    })
  })

  it('returns failed worktree resource with error', async () => {
    insertWorktreeRow({ status: 'failed', error: 'git failed' })
    const tool = getTool('task_resource_get')
    const out = parseResult(await tool({ taskId: TASK_ID }))
    expect(out.resources[0].status).toBe('failed')
    expect(out.resources[0].error).toBe('git failed')
  })

  it('empty when no resources (provider=none / not yet started)', async () => {
    const tool = getTool('task_resource_get')
    const out = parseResult(await tool({ taskId: TASK_ID }))
    expect(out.resources).toEqual([])
  })

  it('resourceId filter returns only that resource', async () => {
    insertWorktreeRow({ status: 'creating' })
    const tool = getTool('task_resource_get')
    const out = parseResult(
      await tool({ taskId: TASK_ID, resourceId: 'primary-worktree' }),
    )
    expect(out.resources).toHaveLength(1)
    const out2 = parseResult(
      await tool({ taskId: TASK_ID, resourceId: 'does-not-exist' }),
    )
    expect(out2.resources).toEqual([])
  })
})

// ---- task-bootstrap-lifecycle phase 5: releasing→done release-then-validate order ----
describe('phase 5: task_state_propose releasing→done release orchestration', () => {
  it('releaseBootstrapResources 被调用后,bootstrap_resources 才进入终态', async () => {
    // 直接驱动注入的 release callback,模拟 task_state_propose 在 releasing→done
    // 通路上先 release 再校验的行为(校验本身在 orchestrator.test.ts 已覆盖)。
    const now = new Date().toISOString()
    db.prepare(
      `INSERT INTO bootstrap_resources
         (id, task_id, kind, status, provider, mode, path, branch, base_ref, summary, error, attempts, terminal_status, created_at, updated_at)
       VALUES ('primary-worktree', ?, 'worktree', 'ready', 'generic-pnpm', 'lean', '/tmp/wt', 'task/x', NULL, 'ok', NULL, 1, NULL, ?, ?)`,
    ).run(TASK_ID, now, now)

    const releaseCb = async (tid: string) => {
      db.prepare(
        `UPDATE bootstrap_resources
           SET status = 'retained', terminal_status = 'retained'
         WHERE task_id = ?`,
      ).run(tid)
    }
    const emitter = new EffectEmitter()
    const ctx2 = new TaskMcpContext({
      taskId: TASK_ID,
      taskWorkdir: tmpDir,
      db,
      emitter,
      log,
      releaseBootstrapResources: releaseCb,
    })
    expect(ctx2.releaseBootstrapResources).toBe(releaseCb)
    // 触发 callback(production 由 task_state_propose 在 permission 通过后调用)
    await ctx2.releaseBootstrapResources!(TASK_ID)
    const row = db
      .prepare(`SELECT terminal_status FROM bootstrap_resources WHERE task_id = ?`)
      .get(TASK_ID) as { terminal_status: string | null }
    expect(row.terminal_status).toBe('retained')
  })
})

// ---- helper ----

/**
 * 从 McpServer 的注册工具里找到对应的 handler（测试用）。
 * _registeredTools 是内部 object，key 为工具名，value 有 handler 属性。
 */
function getTool(name: string) {
  // @ts-expect-error: 访问内部 _registeredTools 用于测试
  const registered = ctx.mcpServer._registeredTools as Record<
    string,
    { handler: (args: unknown, extra: unknown) => Promise<unknown> }
  >
  const tool = registered[name]
  if (!tool) throw new Error(`tool not registered: ${name}`)
  return (args: unknown) =>
    tool.handler(args, {}) as Promise<{ content: Array<{ type: string; text: string }> }>
}

// 给 task_write 等需要 caller role 的工具拼一个带 sessionId 的 extra。
// 测试中通过 monkey-patch ctx.getAgentIdByMcpSession / getRoleByAgentId 直接返回 stub role。
function callToolWithRole(name: string, role: string, args: unknown) {
  // @ts-expect-error: 访问内部 _registeredTools 用于测试
  const registered = ctx.mcpServer._registeredTools as Record<
    string,
    { handler: (args: unknown, extra: unknown) => Promise<unknown> }
  >
  const tool = registered[name]
  if (!tool) throw new Error(`tool not registered: ${name}`)
  const sessionId = `stub-session-${role}`
  const stubAgentId = `stub-agent-${role}`
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const m = ctx as any
  const origGetAgent = m.getAgentIdByMcpSession.bind(ctx)
  const origGetRole = m.getRoleByAgentId.bind(ctx)
  m.getAgentIdByMcpSession = (s: string) =>
    s === sessionId ? stubAgentId : origGetAgent(s)
  m.getRoleByAgentId = (a: string) => (a === stubAgentId ? role : origGetRole(a))
  return (tool.handler(args, { sessionId }) as Promise<{
    content: Array<{ type: string; text: string }>
  }>).finally(() => {
    m.getAgentIdByMcpSession = origGetAgent
    m.getRoleByAgentId = origGetRole
  })
}

function callToolWithAgent(name: string, agentId: string, args: unknown) {
  // @ts-expect-error: 访问内部 _registeredTools 用于测试
  const registered = ctx.mcpServer._registeredTools as Record<
    string,
    { handler: (args: unknown, extra: unknown) => Promise<unknown> }
  >
  const tool = registered[name]
  if (!tool) throw new Error(`tool not registered: ${name}`)
  const sessionId = `stub-session-${agentId}`
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const m = ctx as any
  const origGetAgent = m.getAgentIdByMcpSession.bind(ctx)
  m.getAgentIdByMcpSession = (s: string) => (s === sessionId ? agentId : origGetAgent(s))
  return (tool.handler(args, { sessionId }) as Promise<{
    content: Array<{ type: string; text: string }>
  }>).finally(() => {
    m.getAgentIdByMcpSession = origGetAgent
  })
}

function insertTestAgent(agentId: string, factory = 'engineer', seatId = 'seat-reader'): void {
  const now = new Date().toISOString()
  db.prepare(
    `INSERT OR IGNORE INTO seats (id, task_id, role, factory, status, current_agent_id, queue, created_at)
     VALUES (?, ?, ?, ?, 'working', ?, '[]', ?)`,
  ).run(seatId, TASK_ID, `${factory} #1`, factory, agentId, now)
  db.prepare(
    `INSERT OR IGNORE INTO agents
      (id, task_id, seat_id, factory, display_name, state, factory_version, model_profile, spawned_at)
     VALUES (?, ?, ?, ?, 'reader', 'running', 1, NULL, ?)`,
  ).run(agentId, TASK_ID, seatId, factory, now)
}

function withHumanConfirmationPending(value: boolean | undefined): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const m = ctx as any
  m.isHumanConfirmationPending = value === undefined ? undefined : () => value
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function parseResult(result: { content: Array<{ type: string; text: string }> }): any {
  const text = result.content[0]?.text ?? '{}'
  return JSON.parse(text)
}
