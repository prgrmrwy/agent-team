/**
 * 组 11 单测：seat entity 状态机 + seat-repo + seat-queue + idle-sleep
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { pino } from 'pino'
import { transitionSeat, assertTransition } from './seat.js'
import { createSeatRepo } from './seat-repo.js'
import { createSeatQueueService } from './seat-queue.js'
import { IdleSleepManager, noopSleepAdapter } from './idle-sleep.js'
import { openDb, runMigrations } from '../../db/client.js'
import type { Seat } from '@agent-team/protocol'

const log = pino({ level: 'silent' })

const MIGRATIONS_TASK = path.join(
  import.meta.dirname ?? __dirname,
  '../../db/migrations-task'
)

function makeSeat(overrides: Partial<Seat> = {}): Seat {
  return {
    id: 'seat-test01',
    taskId: 'task-test01',
    role: 'Engineer #1',
    factory: 'engineer',
    status: 'init',
    currentAgentId: null,
    queue: [],
    createdAt: new Date().toISOString(),
    ...overrides,
  }
}

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'seat-test-'))
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

// ---- 状态机 ----
describe('seat entity state machine', () => {
  it('init → idle (happy)', () => {
    const s = makeSeat({ status: 'init' })
    const ns = transitionSeat(s, 'idle')
    expect(ns.status).toBe('idle')
  })

  it('idle → working (happy)', () => {
    const s = makeSeat({ status: 'idle' })
    const ns = transitionSeat(s, 'working')
    expect(ns.status).toBe('working')
  })

  it('working → switching → idle (happy: model fallback)', () => {
    const s = makeSeat({ status: 'working' })
    const switching = transitionSeat(s, 'switching')
    expect(switching.status).toBe('switching')
    const idle = transitionSeat(switching, 'idle')
    expect(idle.status).toBe('idle')
  })

  it('idle → offline (happy)', () => {
    const s = makeSeat({ status: 'idle' })
    const ns = transitionSeat(s, 'offline')
    expect(ns.status).toBe('offline')
  })

  it('offline → idle (happy: SIGCONT 恢复)', () => {
    const s = makeSeat({ status: 'offline' })
    const ns = transitionSeat(s, 'idle')
    expect(ns.status).toBe('idle')
  })

  it('working → vacant (happy: crash)', () => {
    const s = makeSeat({ status: 'working' })
    const ns = transitionSeat(s, 'vacant')
    expect(ns.status).toBe('vacant')
  })

  it('vacant → init (happy: 重 spawn)', () => {
    const s = makeSeat({ status: 'vacant' })
    const ns = transitionSeat(s, 'init')
    expect(ns.status).toBe('init')
  })

  it('idle → init (reject: 非法转移)', () => {
    const s = makeSeat({ status: 'idle' })
    expect(() => transitionSeat(s, 'init')).toThrow('invalid seat transition')
  })

  it('working → offline (reject)', () => {
    const s = makeSeat({ status: 'working' })
    expect(() => assertTransition('working', 'offline')).toThrow('invalid seat transition')
  })
})

// ---- seat-repo ----
describe('seat-repo', () => {
  function makeDb() {
    const dbPath = path.join(tmpDir, 'task.db')
    const db = openDb(dbPath, log)
    runMigrations(db, MIGRATIONS_TASK, log)
    return db
  }

  it('insert + findById (happy)', () => {
    const db = makeDb()
    const repo = createSeatRepo(db)
    const seat = makeSeat()
    repo.insert(seat)
    const found = repo.findById(seat.id)
    expect(found).toBeDefined()
    expect(found?.id).toBe(seat.id)
  })

  it('findByTask 返回该 task 所有岗位', () => {
    const db = makeDb()
    const repo = createSeatRepo(db)
    repo.insert(makeSeat({ id: 'seat-1', taskId: 'task-a' }))
    repo.insert(makeSeat({ id: 'seat-2', taskId: 'task-a' }))
    repo.insert(makeSeat({ id: 'seat-3', taskId: 'task-b' }))
    expect(repo.findByTask('task-a').length).toBe(2)
    expect(repo.findByTask('task-b').length).toBe(1)
  })

})

// ---- seat-queue ----
describe('seat-queue', () => {
  function makeDbAndRepo() {
    const dbPath = path.join(tmpDir, 'task.db')
    const db = openDb(dbPath, log)
    runMigrations(db, MIGRATIONS_TASK, log)
    const repo = createSeatRepo(db)
    return { db, repo }
  }

  it('enqueue + drainQueue 回放清空 (happy)', () => {
    const { repo } = makeDbAndRepo()
    repo.insert(makeSeat({ status: 'offline' }))
    const qs = createSeatQueueService(repo)
    qs.enqueue('seat-test01', 'msg-001')
    qs.enqueue('seat-test01', 'msg-002')
    const drained = qs.drainQueue('seat-test01')
    expect(drained).toEqual(['msg-001', 'msg-002'])
    // drain 后队列为空
    expect(qs.peekQueue('seat-test01')).toEqual([])
  })

  it('enqueue 不存在的 seat 抛错 (edge)', () => {
    const { repo } = makeDbAndRepo()
    const qs = createSeatQueueService(repo)
    expect(() => qs.enqueue('nonexistent', 'msg-001')).toThrow('seat not found')
  })
})

// ---- idle-sleep ----
describe('IdleSleepManager', () => {
  it('touch + wakeup 调 adapter (happy)', async () => {
    const suspend = vi.fn().mockResolvedValue(undefined)
    const resume = vi.fn().mockResolvedValue(undefined)
    const mgr = new IdleSleepManager({ suspend, resume })
    mgr.touch('seat-1', 1234)
    await mgr.wakeup('seat-1', 1234)
    expect(resume).toHaveBeenCalledWith(1234)
  })

  it('release 清除 timer 不报错 (edge)', () => {
    const mgr = new IdleSleepManager(noopSleepAdapter)
    mgr.touch('seat-1', 9999)
    expect(() => mgr.release('seat-1')).not.toThrow()
  })
})
