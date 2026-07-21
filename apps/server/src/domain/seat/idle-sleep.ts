/**
 * 组 11: idle-sleep.ts
 * idle→SIGSTOP / 来消息 SIGCONT 的接口。
 * M1 只留可注入的 hook（interface + 默认 no-op），真正发信号在 Wave 2b 进程层。
 *
 * TODO(wave2b): 注入真实 SleepAdapter（接收 agentPid，发 SIGSTOP / SIGCONT）
 */

export interface SleepAdapter {
  /** 挂起 agent 进程（idle 超时后调）*/
  suspend(agentPid: number): Promise<void>
  /** 恢复 agent 进程（来消息时调）*/
  resume(agentPid: number): Promise<void>
}

/** 默认 no-op（Wave 2b 替换为真实信号发送）*/
export const noopSleepAdapter: SleepAdapter = {
  async suspend(_agentPid: number) {
    // TODO(wave2b): process.kill(agentPid, 'SIGSTOP')
  },
  async resume(_agentPid: number) {
    // TODO(wave2b): process.kill(agentPid, 'SIGCONT')
  },
}

/** idle 超时阈值（毫秒）*/
export const IDLE_TIMEOUT_MS = 5 * 60 * 1000 // 5 分钟

/**
 * IdleSleepManager：跟踪 seat 最后活跃时间，超时后通过 adapter 挂起。
 * Wave 2b 前：adapter 是 no-op，只记录"应该挂起"状态。
 */
export class IdleSleepManager {
  private timers = new Map<string, ReturnType<typeof setTimeout>>()
  private adapter: SleepAdapter

  constructor(adapter: SleepAdapter = noopSleepAdapter) {
    this.adapter = adapter
  }

  /** agent 有活动时重置超时 */
  touch(seatId: string, agentPid: number) {
    this.clearTimer(seatId)
    const timer = setTimeout(() => {
      this.adapter.suspend(agentPid).catch(() => {
        // 进程可能已退出，忽略错误
      })
    }, IDLE_TIMEOUT_MS)
    this.timers.set(seatId, timer)
  }

  /** 来消息时恢复（SIGCONT）*/
  async wakeup(seatId: string, agentPid: number) {
    this.clearTimer(seatId)
    await this.adapter.resume(agentPid)
    this.touch(seatId, agentPid)
  }

  /** seat 释放时清除定时器 */
  release(seatId: string) {
    this.clearTimer(seatId)
  }

  private clearTimer(seatId: string) {
    const t = this.timers.get(seatId)
    if (t) {
      clearTimeout(t)
      this.timers.delete(seatId)
    }
  }
}
