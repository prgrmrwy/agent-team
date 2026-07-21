/**
 * 组 16.6 单测：ProcessPool + IPC protocol + heartbeat（用 fake child）
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ProcessPool } from './process-pool.js'
import { parseIpcMessage } from './ipc-protocol.js'
import { startHeartbeat } from './heartbeat.js'
import { EventEmitter } from 'node:events'

// -------- ProcessPool 单测 --------
describe('ProcessPool', () => {
  it('默认上限 2，活跃数正确（happy）', async () => {
    const pool = new ProcessPool()
    expect(pool.hasCapacity).toBe(true)

    let resolveFirst!: () => void
    let resolveSecond!: () => void

    const p1 = pool.submit('task-1', () => new Promise<void>((r) => (resolveFirst = r)))
    const p2 = pool.submit('task-2', () => new Promise<void>((r) => (resolveSecond = r)))

    // 等待两个 submit 进入 active
    await new Promise((r) => setTimeout(r, 0))
    expect(pool.activeCount).toBe(2)
    expect(pool.hasCapacity).toBe(false)

    resolveFirst()
    pool.release('task-1')

    await new Promise((r) => setTimeout(r, 0))
    expect(pool.activeCount).toBe(1)

    resolveSecond()
    pool.release('task-2')
    await p1
    await p2
  })

  it('超过上限时排队（happy）', async () => {
    const pool = new ProcessPool({ maxConcurrent: 1 })

    let resolveFirst!: () => void
    const startedTasks: string[] = []

    const p1 = pool.submit('task-1', async () => {
      startedTasks.push('task-1')
      await new Promise<void>((r) => (resolveFirst = r))
    })

    const p2 = pool.submit('task-2', async () => {
      startedTasks.push('task-2')
    })

    await new Promise((r) => setTimeout(r, 0))
    expect(startedTasks).toContain('task-1')
    expect(startedTasks).not.toContain('task-2') // 还在排队

    resolveFirst()
    pool.release('task-1')
    await p1

    // 等待 p2 被拉起
    await new Promise((r) => setTimeout(r, 0))
    pool.release('task-2')
    await p2
    expect(startedTasks).toContain('task-2')
  })

  it('重复 taskId 抛错（reject）', async () => {
    const pool = new ProcessPool()
    pool.submit('task-1', () => new Promise(() => {}))

    await new Promise((r) => setTimeout(r, 0))
    await expect(pool.submit('task-1', async () => {})).rejects.toThrow('already active')
  })

  it('cancelQueued 取消排队（happy）', async () => {
    const pool = new ProcessPool({ maxConcurrent: 1 })
    pool.submit('task-1', () => new Promise(() => {}))
    await new Promise((r) => setTimeout(r, 0))

    const p2 = pool.submit('task-2', async () => {})
    expect(pool.cancelQueued('task-2')).toBe(true)

    await expect(p2).rejects.toThrow('cancelled')
  })

  it('forceRemove 不触发队列（crash 场景）', async () => {
    const pool = new ProcessPool({ maxConcurrent: 1 })
    pool.submit('task-1', () => new Promise(() => {}))
    await new Promise((r) => setTimeout(r, 0))

    const started: string[] = []
    const p2 = pool.submit('task-2', async () => { started.push('task-2') })

    pool.forceRemove('task-1')
    await new Promise((r) => setTimeout(r, 0))
    // forceRemove 不触发队列，task-2 还在等
    expect(started).not.toContain('task-2')
  })
})

// -------- IPC protocol 单测 --------
describe('parseIpcMessage', () => {
  it('解析 heartbeat ping（happy）', () => {
    const msg = parseIpcMessage({ type: 'heartbeat', direction: 'ping', at: '2026-01-01T00:00:00Z' })
    expect(msg?.type).toBe('heartbeat')
  })

  it('解析 task-event phase-change（happy）', () => {
    const msg = parseIpcMessage({
      type: 'task-event',
      subtype: 'phase-change',
      taskId: 't1',
      from: 'S1',
      to: 'S2',
      by: 'planner',
      at: '2026-01-01T00:00:00Z',
    })
    expect(msg?.type).toBe('task-event')
  })

  it('解析 user-input message（happy）', () => {
    const msg = parseIpcMessage({
      type: 'user-input',
      subtype: 'message',
      taskId: 't1',
      channel: 'main',
      content: 'hello',
    })
    expect(msg?.type).toBe('user-input')
  })

  it('无效消息返回 null（reject）', () => {
    expect(parseIpcMessage({ type: 'unknown-type' })).toBeNull()
    expect(parseIpcMessage(null)).toBeNull()
    expect(parseIpcMessage('string')).toBeNull()
  })
})

// -------- heartbeat 单测（fake child process）--------
describe('startHeartbeat', () => {
  it('收到 pong 重置 missed count（happy）', async () => {
    const fakeProc = new EventEmitter() as EventEmitter & {
      send: ReturnType<typeof vi.fn>
      kill: ReturnType<typeof vi.fn>
    }
    fakeProc.send = vi.fn()
    fakeProc.kill = vi.fn()

    const onDead = vi.fn()
    const onAlive = vi.fn()

    const { stop } = startHeartbeat({
      taskId: 'task-1',
      process: fakeProc as unknown as import('node:child_process').ChildProcess,
      intervalMs: 50,
      maxMissed: 3,
      onAlive,
      onDead,
    })

    // 等一个心跳周期后模拟 pong
    await new Promise((r) => setTimeout(r, 60))
    fakeProc.emit('message', { type: 'heartbeat', direction: 'pong', at: new Date().toISOString() })

    await new Promise((r) => setTimeout(r, 10))
    expect(onAlive).toHaveBeenCalled()
    expect(onDead).not.toHaveBeenCalled()

    stop()
  })

  it('3 次未响应触发 onDead + SIGKILL（reject）', async () => {
    const fakeProc = new EventEmitter() as EventEmitter & {
      send: ReturnType<typeof vi.fn>
      kill: ReturnType<typeof vi.fn>
    }
    fakeProc.send = vi.fn()
    fakeProc.kill = vi.fn()

    const onDead = vi.fn()

    const { stop } = startHeartbeat({
      taskId: 'task-1',
      process: fakeProc as unknown as import('node:child_process').ChildProcess,
      intervalMs: 30,
      maxMissed: 3,
      onDead,
    })

    // 等 5 个周期（保证 3 次 miss），给 macOS 定时器留 50% 余量
    await new Promise((r) => setTimeout(r, 200))

    expect(onDead).toHaveBeenCalledWith('task-1')
    expect(fakeProc.kill).toHaveBeenCalledWith('SIGKILL')
    stop()
  })
})
