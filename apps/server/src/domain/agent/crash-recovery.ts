/**
 * 组 15.5: crash-recovery.ts
 * agent crash 自动重 spawn + 重新抽签 displayName。
 *
 * 分层纪律：
 *   - 不 import mcp/adapters/http/ws
 *   - 具体 spawn 操作通过 RecoveryDeps 注入
 *   - 通过 EventEmitter 上抛 recovery 事件给上层订阅
 */

import { EventEmitter } from 'node:events'
import type { Factory } from '@agent-team/protocol'
import type { SpawnResult, MiniMcpServer } from './spawn-agent.js'

/** 恢复依赖接口 */
export interface RecoveryDeps {
  /** spawn 新 agent 替代 crash 的 */
  spawnAgent(opts: {
    taskWorkdir: string
    factory: Factory
    usedNames: Set<string>
    taskWorktree: string
    extraMcps?: MiniMcpServer[]
    initialPrompt: string
  }): Promise<SpawnResult>
}

/** crash 事件载荷 */
export interface AgentCrashEvent {
  taskId: string
  oldAgentId: string
  oldDisplayName: string
  factory: Factory
  exitCode: number | null
  exitSignal: string | null
}

/** 恢复成功事件载荷 */
export interface AgentRecoveredEvent {
  taskId: string
  oldAgentId: string
  newAgentId: string
  newDisplayName: string
  sessionId: string
}

/**
 * CrashRecovery：监听 agent exit 事件，自动重 spawn。
 * 发出 'recovered' 事件，上层（task-process-entry）订阅后更新 DB + 通知 WS。
 *
 * 重 spawn 时重新抽签（spec："crash 重 spawn 时重新抽签，不复用旧名"）。
 */
export class CrashRecovery extends EventEmitter {
  private taskId: string
  private taskWorkdir: string
  private taskWorktree: string
  private usedNames: Set<string>
  private deps: RecoveryDeps
  private maxRetries: number

  /** agentId → 已重试次数 */
  private retries = new Map<string, number>()

  constructor(opts: {
    taskId: string
    taskWorkdir: string
    taskWorktree: string
    usedNames: Set<string>
    deps: RecoveryDeps
    maxRetries?: number
  }) {
    super()
    this.taskId = opts.taskId
    this.taskWorkdir = opts.taskWorkdir
    this.taskWorktree = opts.taskWorktree
    this.usedNames = opts.usedNames
    this.deps = opts.deps
    this.maxRetries = opts.maxRetries ?? 3
  }

  /**
   * 处理 agent crash 事件。
   * 若未超过重试次数，自动重 spawn 并发出 'recovered'。
   * 超出重试次数则发出 'give-up'。
   */
  async handleCrash(evt: AgentCrashEvent): Promise<void> {
    const retries = (this.retries.get(evt.oldAgentId) ?? 0) + 1
    this.retries.set(evt.oldAgentId, retries)

    if (retries > this.maxRetries) {
      this.emit('give-up', evt)
      return
    }

    try {
      // 重新抽签（spec：crash 重 spawn 不复用旧名）
      // usedNames 中移除旧名（因为旧 agent 已 terminated）
      this.usedNames.delete(evt.oldDisplayName)

      const result = await this.deps.spawnAgent({
        taskWorkdir: this.taskWorkdir,
        factory: evt.factory,
        usedNames: this.usedNames,
        taskWorktree: this.taskWorktree,
        initialPrompt: `你是新接替${evt.oldDisplayName}岗位的 agent。请先从 chatroom recent 了解上下文，然后继续工作。`,
      })

      const recoveredEvt: AgentRecoveredEvent = {
        taskId: this.taskId,
        oldAgentId: evt.oldAgentId,
        newAgentId: result.agentId,
        newDisplayName: result.displayName,
        sessionId: result.sessionId,
      }
      this.emit('recovered', recoveredEvt)
    } catch (err) {
      this.emit('recovery-failed', { ...evt, error: err })
    }
  }
}
