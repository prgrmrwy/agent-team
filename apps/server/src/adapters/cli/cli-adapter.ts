/**
 * 组 14.1: CliAdapter interface
 * agent-runtime spec: ACP 驱动 + spawn/pause/resume/kill/events$
 *
 * domain 层只依赖此接口，具体实现（ACP）由 process 层注入。
 * 纪律：接口本身不 import 任何传输层，也不 import 实现文件。
 */

import type { EventEmitter } from 'node:events'
import type { AgentModelProfile, RuntimeProvider } from '@agent-team/protocol'

export type { AgentModelProfile, RuntimeProvider } from '@agent-team/protocol'

export type RuntimeErrorReason =
  | 'quota'
  | 'auth'
  | 'missing-binary'
  | 'session-not-found'
  | 'unsupported-provider'
  | 'runtime-failed'

export interface RuntimeTextEvent {
  sessionId: string
  text: string
  kind?: 'message' | 'thought'
}

export interface RuntimeToolEvent {
  sessionId: string
  title: string
  rawInput?: unknown
  toolCallId?: string
}

export interface RuntimeDoneEvent {
  sessionId: string
  stopReason: string
  usage?: unknown
}

export interface RuntimeErrorEvent {
  sessionId?: string
  provider: RuntimeProvider
  reason: RuntimeErrorReason
  message: string
  recoverable: boolean
  raw?: unknown
}

export interface RuntimeExitEvent {
  sessionId: string
  code: number | null
  signal: string | null
}

/**
 * CLI adapter 接口。
 * 一个 CliAdapter 实例对应一个 agent 生命周期（spawn → 多轮 prompt → kill）。
 * 事件通过 EventEmitter 发出，调用方 .on() 订阅。
 *
 * 约定事件名：
 * - update: provider 原始事件（诊断用）
 * - text: RuntimeTextEvent
 * - tool: RuntimeToolEvent
 * - done: RuntimeDoneEvent
 * - runtime-error: RuntimeErrorEvent
 * - exit: RuntimeExitEvent
 *
 * 不使用 EventEmitter 的特殊 'error' 事件，避免无 listener 时触发 ERR_UNHANDLED_ERROR。
 */
export interface CliAdapter extends EventEmitter {
  readonly provider: RuntimeProvider

  /**
   * 启动 bridge 进程，建立 ACP 连接，创建 session。
   * 返回 sessionId（ACP 会话标识）。
   */
  spawn(opts: SpawnOpts): Promise<string>

  /**
   * 向已有 session 发送 prompt。
   * 流式事件经 'chunk' / 'toolCall' / 'done' 抛出。
   */
  prompt(sessionId: string, text: string): Promise<void>

  /**
   * 暂停 agent（SIGSTOP bridge 进程）。
   * 恢复后 session 仍存活，无需重建。
   */
  pause(sessionId: string): void

  /**
   * 恢复暂停的 agent（SIGCONT）。
   */
  resume(sessionId: string): void

  /**
   * 人类打断当前 turn：停掉正在跑的这一轮,但**保留 session**(agent 转 idle,
   * 可被后续 prompt 续,无需重建)。用于"ESC ESC 停止所有 agent 工作"。
   * codex:abort 当前 prompt;acp:SIGSTOP 冻结 bridge 进程(best-effort)。
   */
  interrupt(sessionId: string): void

  /**
   * 终止 agent（SIGTERM → 5s 超时 → SIGKILL）。
   */
  kill(sessionId: string): Promise<void>

  /**
   * 判断 bridge 进程是否仍在运行。
   */
  isAlive(sessionId: string): boolean
}

/** spawn 选项 */
export interface SpawnOpts {
  /** agent workspace 绝对路径（ACP cwd + 权限锁定）*/
  workspace: string
  /** 额外可读目录，通常是 task worktree */
  additionalDirectories: string[]
  /** 注入的 MCP server 列表 */
  mcpServers: McpServerDecl[]
  /** 初始 prompt（第一轮对话）*/
  initialPrompt: string
  /** agent 环境变量（继承 process.env，可追加）*/
  env?: Record<string, string>
  /** spawn 时实际使用的 agent 模型配置 */
  runtime?: AgentModelProfile
}

/** MCP server 声明 — stdio 形态 */
export interface McpServerDeclStdio {
  type?: 'stdio'
  name: string
  command: string
  args: string[]
  env?: Record<string, string>
}

/** MCP server 声明 — HTTP 形态（ACP session/new mcpServers http 变体）*/
export interface McpServerDeclHttp {
  type: 'http'
  name: string
  url: string
  headers: Array<{ name: string; value: string }>
}

/** MCP server 声明 — SSE 形态 */
export interface McpServerDeclSse {
  type: 'sse'
  name: string
  url: string
  headers: Array<{ name: string; value: string }>
}

/** MCP server 声明（联合类型，与 protocol 对齐，此处独立定义避免循环依赖）*/
export type McpServerDecl = McpServerDeclStdio | McpServerDeclHttp | McpServerDeclSse

export function classifyRuntimeError(error: unknown): RuntimeErrorReason {
  const message = error instanceof Error ? error.message : String(error)
  const lower = message.toLowerCase()
  if (lower.includes('limit') || lower.includes('quota') || lower.includes('rate limit')) return 'quota'
  if (lower.includes('auth') || lower.includes('login') || lower.includes('unauthorized')) return 'auth'
  if (lower.includes('enoent') || lower.includes('not found') || lower.includes('unable to locate')) return 'missing-binary'
  if (lower.includes('session not found')) return 'session-not-found'
  return 'runtime-failed'
}

export function toRuntimeErrorEvent(
  provider: RuntimeProvider,
  error: unknown,
  opts: { sessionId?: string; recoverable?: boolean; reason?: RuntimeErrorReason } = {}
): RuntimeErrorEvent {
  const message = error instanceof Error ? error.message : String(error)
  return {
    sessionId: opts.sessionId,
    provider,
    reason: opts.reason ?? classifyRuntimeError(error),
    message,
    recoverable: opts.recoverable ?? true,
    raw: error,
  }
}
