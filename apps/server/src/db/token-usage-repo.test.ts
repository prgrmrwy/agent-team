import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDb, runMigrations, type DbClient } from './client.js'
import {
  aggregateGlobalUsage,
  aggregateProjectUsage,
  aggregateFactoryUsage,
  getTaskUsage,
  insertTokenUsageEvent,
} from './token-usage-repo.js'

const MIGRATIONS_TASK = path.join(import.meta.dirname ?? __dirname, './migrations-task')

let tmp: string
let db: DbClient

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'token-usage-repo-test-'))
  db = openDb(path.join(tmp, 'task.db'))
  runMigrations(db, MIGRATIONS_TASK)
})

afterEach(() => {
  db.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('token usage repo', () => {
  function insertAgent(factory = 'engineer') {
    const now = '2026-06-26T00:00:00.000Z'
    db.prepare(
      `INSERT INTO seats (id, task_id, role, factory, status, current_agent_id, queue, created_at)
       VALUES ('seat-1', 'task-1', 'Engineer #1', ?, 'working', 'agent-1', '[]', ?)`,
    ).run(factory, now)
    db.prepare(
      `INSERT INTO agents
        (id, task_id, seat_id, factory, display_name, state, factory_version, model_profile, spawned_at)
       VALUES ('agent-1', 'task-1', 'seat-1', ?, 'Ada', 'running', 1, ?, ?)`,
    ).run(factory, JSON.stringify({ model: 'claude-sonnet' }), now)
  }

  it('dedupes provider/source/external request id and aggregates task usage', () => {
    const base = {
      taskId: 'task-1',
      projectId: 'proj-1',
      agentId: 'agent-1',
      factory: 'engineer' as const,
      provider: 'claude-acp' as const,
      source: 'runtime' as const,
      externalRequestId: 'req-1',
      inputTokens: 10,
      outputTokens: 5,
      createdAt: '2026-06-26T00:00:00.000Z',
    }

    expect(insertTokenUsageEvent(db, { ...base, id: 'usage-1' })).toBe(true)
    expect(insertTokenUsageEvent(db, { ...base, id: 'usage-2', outputTokens: 99 })).toBe(false)

    const usage = getTaskUsage(db, 'task-1')
    expect(usage.totals.runtime.totalTokens).toBe(15)
    expect(usage.agents).toEqual([
      expect.objectContaining({ id: 'agent-1', totalTokens: 15 }),
    ])
  })

  it('returns factory usage sorted high-to-low and limited to top 10 tasks', () => {
    const taskDbs: Array<{ taskId: string; title: string; db: DbClient }> = []
    for (let i = 0; i < 11; i += 1) {
      const taskId = `task-${i}`
      insertTokenUsageEvent(db, {
        id: `usage-${i}`,
        taskId,
        factory: 'engineer',
        provider: 'codex-exec',
        source: 'runtime',
        totalTokens: i + 1,
      })
      taskDbs.push({ taskId, title: `Task ${i}`, db })
    }

    const usage = aggregateFactoryUsage('engineer', taskDbs)
    expect(usage.runtime.totalTokens).toBe(66)
    expect(usage.tasks).toHaveLength(10)
    expect(usage.tasks.map((item) => item.totalTokens)).toEqual([11, 10, 9, 8, 7, 6, 5, 4, 3, 2])
  })

  it('infers factory usage from the agent row when backfilled events do not include factory', () => {
    insertAgent('engineer')
    insertTokenUsageEvent(db, {
      id: 'usage-backfill-1',
      taskId: 'task-1',
      agentId: 'agent-1',
      provider: 'claude-acp',
      source: 'fallback-transcript',
      totalTokens: 123,
    })

    const factoryUsage = aggregateFactoryUsage('engineer', [{ taskId: 'task-1', title: 'Task One', db }])
    expect(factoryUsage.runtime.totalTokens).toBe(123)
    expect(factoryUsage.tasks).toEqual([
      expect.objectContaining({ id: 'task-1', label: 'Task One', totalTokens: 123 }),
    ])

    const projectUsage = aggregateProjectUsage('proj-1', [{ taskId: 'task-1', db }])
    expect(projectUsage.factories).toEqual([
      expect.objectContaining({ id: 'engineer', totalTokens: 123 }),
    ])
  })
})

describe('aggregateGlobalUsage', () => {
  // 用一组独立 task DB,不复用上面 beforeEach 的 db,避免相互污染
  const dbs: DbClient[] = []
  const tmps: string[] = []

  function makeTaskDb(taskId: string, factory = 'engineer'): DbClient {
    const t = fs.mkdtempSync(path.join(os.tmpdir(), `gu-test-${taskId}-`))
    tmps.push(t)
    const d = openDb(path.join(t, 'task.db'))
    runMigrations(d, MIGRATIONS_TASK)
    const now = '2026-06-26T00:00:00.000Z'
    d.prepare(
      `INSERT INTO seats (id, task_id, role, factory, status, current_agent_id, queue, created_at)
       VALUES ('seat-1', ?, 'Engineer #1', ?, 'working', 'agent-1', '[]', ?)`,
    ).run(taskId, factory, now)
    d.prepare(
      `INSERT INTO agents
        (id, task_id, seat_id, factory, display_name, state, factory_version, model_profile, spawned_at)
       VALUES ('agent-1', ?, 'seat-1', ?, 'A', 'running', 1, ?, ?)`,
    ).run(taskId, factory, JSON.stringify({ model: 'm' }), now)
    dbs.push(d)
    return d
  }

  afterEach(() => {
    for (const d of dbs) d.close()
    dbs.length = 0
    for (const t of tmps) fs.rmSync(t, { recursive: true, force: true })
    tmps.length = 0
  })

  it('空系统返回全 0 + 空 ranking', () => {
    const r = aggregateGlobalUsage([])
    expect(r.runtime.totalTokens).toBe(0)
    expect(r.tasks).toEqual([])
    expect(r.factories).toEqual([])
  })

  it('factory 跨 task 合并 + tasks ranking 按 total desc', () => {
    const dbA = makeTaskDb('task-A', 'engineer')
    insertTokenUsageEvent(dbA, {
      id: 'u-a',
      taskId: 'task-A',
      agentId: 'agent-1',
      factory: 'engineer',
      provider: 'claude-acp',
      source: 'runtime',
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 150,
    })
    const dbB = makeTaskDb('task-B', 'engineer')
    insertTokenUsageEvent(dbB, {
      id: 'u-b',
      taskId: 'task-B',
      agentId: 'agent-1',
      factory: 'engineer',
      provider: 'claude-acp',
      source: 'runtime',
      inputTokens: 200,
      outputTokens: 100,
      totalTokens: 300,
    })
    const r = aggregateGlobalUsage([
      { taskId: 'task-A', title: 'A title', db: dbA },
      { taskId: 'task-B', title: 'B title', db: dbB },
    ])
    expect(r.runtime.totalTokens).toBe(450)
    expect(r.factories).toEqual([expect.objectContaining({ id: 'engineer', totalTokens: 450 })])
    expect(r.tasks.map((t) => t.id)).toEqual(['task-B', 'task-A']) // desc
    expect(r.tasks[0]?.label).toBe('B title')
  })

  it('top 10 截断 + 0 token task 排除', () => {
    const inputs: DbClient[] = []
    for (let i = 0; i < 12; i++) {
      const d = makeTaskDb(`task-${i}`, 'engineer')
      inputs.push(d)
      insertTokenUsageEvent(d, {
        id: `u-${i}`,
        taskId: `task-${i}`,
        agentId: 'agent-1',
        factory: 'engineer',
        provider: 'claude-acp',
        source: 'runtime',
        inputTokens: i + 1,
        outputTokens: 0,
        totalTokens: i + 1,
      })
    }
    // 再加一个 0 token 的 task,应该不进 ranking
    makeTaskDb('task-empty', 'engineer')
    const r = aggregateGlobalUsage(
      inputs.map((d, i) => ({ taskId: `task-${i}`, db: d })).concat([
        { taskId: 'task-empty', db: dbs[12] as DbClient },
      ]),
    )
    expect(r.tasks).toHaveLength(10)
    expect(r.tasks.map((t) => t.totalTokens)).toEqual([12, 11, 10, 9, 8, 7, 6, 5, 4, 3])
    expect(r.tasks.find((t) => t.id === 'task-empty')).toBeUndefined()
  })

  it('老 task 无 token_usage 表静默跳过', () => {
    // 手动 drop token_usage_events 表模拟"老 task"
    const t = fs.mkdtempSync(path.join(os.tmpdir(), 'gu-old-'))
    tmps.push(t)
    const oldDb = openDb(path.join(t, 'task.db'))
    runMigrations(oldDb, MIGRATIONS_TASK)
    oldDb.exec('DROP TABLE token_usage_events')
    dbs.push(oldDb)

    const newDb = makeTaskDb('task-new', 'engineer')
    insertTokenUsageEvent(newDb, {
      id: 'u-new',
      taskId: 'task-new',
      agentId: 'agent-1',
      factory: 'engineer',
      provider: 'claude-acp',
      source: 'runtime',
      totalTokens: 77,
    })

    const r = aggregateGlobalUsage([
      { taskId: 'task-old', db: oldDb },
      { taskId: 'task-new', db: newDb },
    ])
    expect(r.runtime.totalTokens).toBe(77)
    expect(r.tasks.map((t) => t.id)).toEqual(['task-new'])
  })

  it('task label 回退到 taskId 当 title 缺失', () => {
    const d = makeTaskDb('task-no-title', 'qa')
    insertTokenUsageEvent(d, {
      id: 'u',
      taskId: 'task-no-title',
      agentId: 'agent-1',
      factory: 'qa',
      provider: 'claude-acp',
      source: 'runtime',
      totalTokens: 5,
    })
    const r = aggregateGlobalUsage([{ taskId: 'task-no-title', db: d }])
    expect(r.tasks[0]?.label).toBe('task-no-title')
  })
})
