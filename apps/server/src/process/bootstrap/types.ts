import type { BootstrapReleasePolicy } from '@agent-team/protocol'
import type {
  BootstrapMode,
  BootstrapResourceTerminalStatus,
  TaskBootstrapConfig,
  TaskBootstrapResource,
} from '@agent-team/protocol'

/**
 * Bootstrap provider 程序入口 (design.md D1)。
 * 每个 provider MUST 暴露 prepare/status/release 三类动作并返回结构化结果。
 * Runner 负责把这些结果写到 task DB 的 bootstrap_resources。
 */
export interface BootstrapProviderContext {
  taskId: string
  taskWorkdir: string
  /** 仓库根 — 默认服务器进程的 cwd,sw provider 据此寻找 Nexus checkout */
  repoRoot: string
  mode: BootstrapMode | undefined
  /** release 策略 — provider 在 release() 内读这个决定 worktree 终态 */
  releasePolicy: BootstrapReleasePolicy
  /** provider 特有的额外参数 (来自 TaskBootstrapConfig.options) */
  options: Record<string, unknown>
}

export interface PrepareSuccess {
  ok: true
  path: string
  branch?: string
  baseRef?: string
  summary?: string
}

export interface PrepareFailure {
  ok: false
  error: string
  summary?: string
}

export type PrepareResult = PrepareSuccess | PrepareFailure

export interface StatusResult {
  /** provider 当前认为的状态 — Runner 会与 DB 状态对账 */
  status: 'creating' | 'ready' | 'failed'
  path?: string
  branch?: string
  summary?: string
  error?: string
}

export interface ReleaseResult {
  terminalStatus: BootstrapResourceTerminalStatus
  summary?: string
  error?: string
}

export interface BootstrapProvider {
  readonly id: 'generic-pnpm' | 'sw' | 'generic'
  prepare(ctx: BootstrapProviderContext): Promise<PrepareResult>
  status(ctx: BootstrapProviderContext, resource: TaskBootstrapResource): Promise<StatusResult>
  release(ctx: BootstrapProviderContext, resource: TaskBootstrapResource): Promise<ReleaseResult>
}

export interface RunnerEmit {
  /** chatroom main 频道写一条 system-event,Runner 同时落 chatroom_messages 表 */
  systemEvent(taskId: string, content: string): void
  /** WS 推 bootstrap-resource 事件 (Phase 3 接入 server-side bus) */
  resourceEvent?: (taskId: string, resource: TaskBootstrapResource) => void
}

export interface RunnerOptions {
  /** 任务 DB 路径(per-task SQLite);若 db 已传则忽略 */
  taskDbPath?: string
  /** 已打开的 task DB 复用(避免重复 open + migrate);传入时 Runner 不接管 close 生命周期 */
  db?: import('../../db/client.js').DbClient
  taskWorkdir: string
  repoRoot?: string
  emit?: RunnerEmit
  providers?: Partial<Record<BootstrapProvider['id'], BootstrapProvider>>
}

export type ResolvedBootstrapConfig = TaskBootstrapConfig
