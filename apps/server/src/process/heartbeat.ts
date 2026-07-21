/**
 * 组 16.4: heartbeat.ts
 * 30s 心跳；3 次失败 SIGKILL + 告警。
 *
 * agent-runtime spec "进程池容量与心跳"：
 *   主 server MUST 每 30s 对每个 task-process 心跳；
 *   3 次未响应视为僵死，强杀该 task-process 并告警。
 */

import type { ChildProcess } from 'node:child_process'

export interface HeartbeatOpts {
  taskId: string
  process: ChildProcess
  intervalMs?: number
  maxMissed?: number
  onAlive?: (taskId: string) => void
  onDead?: (taskId: string) => void
}

/**
 * 启动心跳监测。
 * 每 intervalMs（默认 30s）发送 ping，等待 pong；
 * 连续 maxMissed（默认 3）次无响应则强杀并调用 onDead。
 *
 * 返回 stopHeartbeat 函数，task-process 正常退出时调用。
 */
export function startHeartbeat(opts: HeartbeatOpts): { stop: () => void } {
  const {
    taskId,
    process: proc,
    intervalMs = 30_000,
    maxMissed = 3,
    onAlive,
    onDead,
  } = opts

  let missedCount = 0
  let waitingPong = false
  let stopped = false

  // 监听 pong
  const onMessage = (msg: unknown) => {
    if (
      typeof msg === 'object' &&
      msg !== null &&
      'type' in msg &&
      (msg as Record<string, unknown>)['type'] === 'heartbeat' &&
      (msg as Record<string, unknown>)['direction'] === 'pong'
    ) {
      missedCount = 0
      waitingPong = false
      onAlive?.(taskId)
    }
  }

  proc.on('message', onMessage)

  const interval = setInterval(() => {
    if (stopped) return

    if (waitingPong) {
      // 上一个 ping 还没收到 pong
      missedCount += 1
    }

    if (missedCount >= maxMissed) {
      stopped = true
      clearInterval(interval)
      proc.off('message', onMessage)

      // 强杀
      try {
        proc.kill('SIGKILL')
      } catch {
        // ignore if already dead
      }

      onDead?.(taskId)
      return
    }

    // 发 ping
    waitingPong = true
    try {
      proc.send({ type: 'heartbeat', direction: 'ping', at: new Date().toISOString() })
    } catch {
      // process might have exited
      missedCount += 1
    }
  }, intervalMs)

  return {
    stop: () => {
      stopped = true
      clearInterval(interval)
      proc.off('message', onMessage)
    },
  }
}
