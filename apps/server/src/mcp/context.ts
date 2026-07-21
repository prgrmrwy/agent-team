/**
 * 工具 handler 依赖的最小上下文接口。
 * 抽出为独立接口，打破 tools ↔ mcp-server 的循环依赖：
 * 工具只依赖本接口（context.ts），不再 import 具体的 TaskMcpContext（mcp-server.ts）。
 * TaskMcpContext implements 本接口。
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { DbClient } from '../db/client.js'
import type { EffectEmitter } from '../domain/orchestrator/transition-effects.js'
import type { Logger } from '../util/logger.js'

export interface McpToolContext {
  readonly taskId: string
  readonly taskWorkdir: string
  readonly mcpServer: McpServer
  readonly db: DbClient
  readonly emitter: EffectEmitter
  readonly log: Logger
  /**
   * 根据 agentId 查询角色（用于工具 handler caller 标识）。
   * agentId 来自 HTTP URL 路径 /mcp/<agentId>，
   * 工具 handler 通过 extra.sessionId → getAgentIdByMcpSession(sessionId) 获得 agentId。
   */
  getRoleByAgentId(agentId: string): string | undefined
  /**
   * 本请求的 caller agentId。stateless MCP 下由 HTTP URL 路径 /mcp/<agentId> 决定,
   * mcp-server 为每个请求构造 ctx 时注入。工具 handler 应**优先**用它解析 caller 身份。
   * (class 级共享 ctx / 单测里为 undefined → 工具走 fallback。)
   */
  readonly callerAgentId?: string
  /**
   * 【stateless 后恒返回 undefined】旧 stateful 模式按 MCP session 反查 agentId。
   * 保留仅为接口兼容;新代码用 callerAgentId。
   */
  getAgentIdByMcpSession(mcpSessionId: string): string | undefined
  /**
   * 返回供 ACP session/new 使用的 chatroom-mcp HTTP URL。
   * 格式：http://127.0.0.1:<port>/mcp/<agentId>
   */
  getMcpUrl(agentId: string): string
  /** 返回 Claude Code OTel HTTP ingest URL。 */
  getOtelUrl(agentId: string): string
  /**
   * task-bootstrap-lifecycle phase 5.3: orchestrator hook 给 task_state_propose
   * 在 releasing→done 通路中调用,把所有 non-terminal bootstrap resource 推到
   * 终态(retained/removed/archived/needs-review)。
   * 缺省(测试/legacy)时跳过 release;校验仍可通过资源不存在的场景。
   */
  releaseBootstrapResources?(taskId: string): Promise<void>
  /**
   * Planner 对齐/收尾时可通过置顶 system-event 显式等待人类确认。
   * 等待期间 process 层持有门禁状态，MCP 工具层按此拒绝 planner 的推进类动作。
   */
  isHumanConfirmationPending?(): boolean
  markHumanConfirmationPending?(input: {
    messageId: string
    byAgentId: string
    content: string
  }): void
  clearHumanConfirmationPending?(reason: string): void
}
