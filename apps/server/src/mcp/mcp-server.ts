/**
 * 组 13: mcp-server.ts
 * @modelcontextprotocol/sdk 共享单 McpServer 实例，通过 StreamableHTTPServerTransport
 * 在 127.0.0.1:<动态端口> 暴露。
 *
 * 架构决策（1A，对齐 design.md D8 演进；后改为 stateless transport）：
 *   - 每个 agentId 独占路径 /mcp/<agentId>，URL 路径即 caller 身份
 *   - **stateless 模式**：每个 HTTP 请求新建 McpServer + transport(sessionIdGenerator: undefined)
 *     连接后 handleRequest,res close 时销毁。不维护跨请求 session。
 *     —— 因为 codex-sdk 的 MCP client 短连接复用 + 不稳定重连,任何"跨请求 session 复用"
 *     方案都会在它 init 后主动 close → 后续请求落到陌生 transport 被拒,导致 agent 中途丢工具
 *     退化到裸 curl 乱来。stateless 把 session 这个失败点彻底消除(MCP SDK 官方 stateless 范式)。
 *   - ACP session/new 传入 { type:'http', name:'chatroom', url: getMcpUrl(agentId) }
 *
 * 每次 HTTP 请求到达 /mcp/:agentId 时：
 *   1. 从路径中提取 agentId(= caller 身份)
 *   2. 查 agents 注册表 → role（或从 DB agents 表延迟查找）
 *   3. 新建 server+transport,registerAllTools 时 ctx.getAgentIdByMcpSession 恒返回该 agentId
 */

import http from 'node:http'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import type { DbClient } from '../db/client.js'
import type { EffectEmitter } from '../domain/orchestrator/transition-effects.js'
import type { Logger } from '../util/logger.js'
import type { McpToolContext } from './context.js'
import { registerAllTools } from './tools/index.js'
import { insertTokenUsageEvent } from '../db/token-usage-repo.js'
import { newTokenUsageId } from '../util/id.js'
import { normalizeClaudeTelemetryPayload } from '../process/token-usage-normalizer.js'

/** 每个已注册 agent 的元数据(只存身份/角色;stateless 模式下 transport/server 每请求新建)*/
export interface AgentEntry {
  agentId: string
  role: string
}

/**
 * 每个 task 共享一个 TaskMcpContext 实例。
 * 通过 HTTP server 暴露，每个 agent 用独立 URL 路径区分身份。
 */
export class TaskMcpContext implements McpToolContext {
  readonly taskId: string
  readonly taskWorkdir: string
  readonly mcpServer: McpServer
  readonly db: DbClient
  readonly emitter: EffectEmitter
  readonly log: Logger
  readonly releaseBootstrapResources?: (taskId: string) => Promise<void>
  readonly isHumanConfirmationPending?: () => boolean
  readonly markHumanConfirmationPending?: (input: {
    messageId: string
    byAgentId: string
    content: string
  }) => void
  readonly clearHumanConfirmationPending?: (reason: string) => void

  /** HTTP server 监听端口（动态分配）*/
  private httpPort = 0
  private httpServer: http.Server | null = null

  /** agentId → AgentEntry（只存角色元数据;路由按 URL 路径 /mcp/<agentId>）*/
  private agents = new Map<string, AgentEntry>()

  constructor(opts: {
    taskId: string
    taskWorkdir: string
    db: DbClient
    emitter: EffectEmitter
    log: Logger
    releaseBootstrapResources?: (taskId: string) => Promise<void>
    isHumanConfirmationPending?: () => boolean
    markHumanConfirmationPending?: (input: {
      messageId: string
      byAgentId: string
      content: string
    }) => void
    clearHumanConfirmationPending?: (reason: string) => void
  }) {
    this.taskId = opts.taskId
    this.taskWorkdir = opts.taskWorkdir
    this.db = opts.db
    this.emitter = opts.emitter
    this.log = opts.log
    if (opts.releaseBootstrapResources) {
      this.releaseBootstrapResources = opts.releaseBootstrapResources
    }
    if (opts.isHumanConfirmationPending) {
      this.isHumanConfirmationPending = opts.isHumanConfirmationPending
    }
    if (opts.markHumanConfirmationPending) {
      this.markHumanConfirmationPending = opts.markHumanConfirmationPending
    }
    if (opts.clearHumanConfirmationPending) {
      this.clearHumanConfirmationPending = opts.clearHumanConfirmationPending
    }

    this.mcpServer = new McpServer(
      { name: 'chatroom-mcp', version: '1.0.0' },
      { capabilities: { tools: {} } }
    )

    // 在共享实例上注册工具（供单测 + 接口占位用）；此 server 不连任何 transport。
    // 真正连接 agent 的是 registerAgent 中按 agent 新建的独立 McpServer 实例
    // （MCP SDK 一个 McpServer 只能连一个 transport，故 per-agent 各一个）。
    registerAllTools(this)
  }

  /**
   * 启动 HTTP MCP server（幂等：已启动则直接返回端口）。
   * task-process-entry 在 spawn 任何 agent 之前先调此方法。
   */
  async startHttpServer(): Promise<number> {
    if (this.httpServer) return this.httpPort

    this.httpServer = http.createServer((req, res) => {
      this._handleRequest(req, res).catch((err: unknown) => {
        this.log.error({ err }, 'chatroom-mcp HTTP handler uncaught error')
        if (!res.headersSent) res.writeHead(500).end('Internal error')
      })
    })

    await new Promise<void>((resolve, reject) => {
      this.httpServer!.listen(0, '127.0.0.1', () => {
        const addr = this.httpServer!.address()
        this.httpPort = typeof addr === 'object' && addr !== null ? addr.port : 0
        this.log.info(
          { taskId: this.taskId, port: this.httpPort },
          'chatroom-mcp HTTP server started'
        )
        resolve()
      })
      this.httpServer!.once('error', reject)
    })

    return this.httpPort
  }

  /** 停止 HTTP server（task 结束时调用）*/
  async stopHttpServer(): Promise<void> {
    if (!this.httpServer) return
    // stateless:无跨请求 transport 需关闭,清角色表即可
    this.agents.clear()
    await new Promise<void>((resolve) => this.httpServer!.close(() => resolve()))
    this.httpServer = null
    this.log.info({ taskId: this.taskId }, 'chatroom-mcp HTTP server stopped')
  }

  /**
   * 返回供 ACP session/new mcpServers[].url 使用的 chatroom-mcp HTTP URL。
   * 格式：http://127.0.0.1:<port>/mcp/<agentId>
   */
  getMcpUrl(agentId: string): string {
    if (!this.httpServer) {
      throw new Error('HTTP server not started; call startHttpServer() first')
    }
    return `http://127.0.0.1:${this.httpPort}/mcp/${agentId}`
  }

  getOtelUrl(agentId: string): string {
    if (!this.httpServer) {
      throw new Error('HTTP server not started; call startHttpServer() first')
    }
    return `http://127.0.0.1:${this.httpPort}/otel/${agentId}`
  }

  /**
   * 注册 agent 角色元数据。在 spawn 流程中调用,供工具 handler 查 role。
   * stateless 模式下不再预建 transport —— transport 每请求新建(见 _handleRequest)。
   */
  registerAgent(agentId: string, role: string): void {
    this.agents.set(agentId, { agentId, role })
    this.log.info({ agentId, role, taskId: this.taskId }, 'agent registered for HTTP MCP')
  }

  /** 注销 agent（agent 释放时调用）*/
  async unregisterAgent(agentId: string): Promise<void> {
    if (!this.agents.delete(agentId)) return
    this.log.info({ agentId, taskId: this.taskId }, 'agent unregistered from HTTP MCP')
  }

  /** 获取 agent 角色（工具 handler 用）：先查注册表,再 fallback DB agents 表 */
  getRoleByAgentId(agentId: string): string | undefined {
    const cached = this.agents.get(agentId)?.role
    if (cached) return cached
    const row = this.db.prepare('SELECT factory FROM agents WHERE id = ?').get(agentId) as
      | { factory: string }
      | undefined
    return row?.factory
  }

  /**
   * stateless 模式:caller 身份由 URL 路径 /mcp/<agentId> 决定,与 MCP session 无关。
   * 每请求构造的 ctx 把此方法绑定为恒返回该 agentId(见 buildAgentContext),
   * 故此处 class 级实现仅为接口兼容,实际不被路由用到。
   */
  getAgentIdByMcpSession(_mcpSessionId: string): string | undefined {
    return undefined
  }

  /** 为单个 HTTP 请求构造 ctx：caller 恒为 URL 路径里的 agentId */
  private buildAgentContext(agentId: string, server: McpServer): McpToolContext {
    return {
      taskId: this.taskId,
      taskWorkdir: this.taskWorkdir,
      mcpServer: server,
      db: this.db,
      emitter: this.emitter,
      log: this.log,
      // stateless:caller 恒为本 URL 路径的 agentId(工具优先用此解析身份)
      callerAgentId: agentId,
      getRoleByAgentId: (a) => this.getRoleByAgentId(a),
      getAgentIdByMcpSession: () => agentId,
      getMcpUrl: (a) => this.getMcpUrl(a),
      getOtelUrl: (a) => this.getOtelUrl(a),
      ...(this.releaseBootstrapResources
        ? { releaseBootstrapResources: this.releaseBootstrapResources }
        : {}),
      ...(this.isHumanConfirmationPending
        ? { isHumanConfirmationPending: this.isHumanConfirmationPending }
        : {}),
      ...(this.markHumanConfirmationPending
        ? { markHumanConfirmationPending: this.markHumanConfirmationPending }
        : {}),
      ...(this.clearHumanConfirmationPending
        ? { clearHumanConfirmationPending: this.clearHumanConfirmationPending }
        : {}),
    }
  }

  /** 列出当前已注册 agents */
  listRegisteredAgents(): { agentId: string; role: string }[] {
    return Array.from(this.agents.values()).map((e) => ({
      agentId: e.agentId,
      role: e.role,
    }))
  }

  /**
   * 处理 HTTP 请求。
   * 路径格式：/mcp/<agentId>（GET 建立 SSE / POST 发送消息 / DELETE 关闭 session）
   */
  private async _handleRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse
  ): Promise<void> {
    const url = req.url ?? ''
    const otelMatch = url.match(/^\/otel\/([^/?]+)/)
    if (otelMatch) {
      await this._handleOtelRequest(otelMatch[1]!, req, res)
      return
    }
    const match = url.match(/^\/mcp\/([^/?]+)/)
    if (!match) {
      res.writeHead(404).end('Not found')
      return
    }

    const agentId = match[1]!
    // 延迟注册角色：ACP bridge 可能比 registerAgent 先到
    if (!this.agents.has(agentId)) {
      const agentRow = this.db
        .prepare('SELECT factory FROM agents WHERE id = ?')
        .get(agentId) as { factory: string } | undefined
      this.registerAgent(agentId, agentRow?.factory ?? 'unknown')
    }

    const body = await readRequestBody(req)
    const parsedBody = body ? (JSON.parse(body) as unknown) : undefined

    // stateless:每请求新建 server + transport(sessionIdGenerator: undefined),
    // res close 时销毁。彻底消除跨请求 session 复用这个失败点(codex 短连接重连不再炸)。
    const server = new McpServer(
      { name: 'chatroom-mcp', version: '1.0.0' },
      { capabilities: { tools: {} } }
    )
    registerAllTools(this.buildAgentContext(agentId, server))
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
    res.on('close', () => {
      transport.close().catch(() => {})
      server.close().catch(() => {})
    })
    await server.connect(transport)
    await transport.handleRequest(req, res, parsedBody)
  }

  private async _handleOtelRequest(
    agentId: string,
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    if (req.method !== 'POST') {
      res.writeHead(405).end('method not allowed')
      return
    }
    const body = await readRequestBody(req)
    let parsed: unknown
    try {
      parsed = body ? JSON.parse(body) : {}
    } catch {
      res.writeHead(400).end('invalid json')
      return
    }
    const usage = normalizeClaudeTelemetryPayload(parsed)
    if (!usage) {
      res.writeHead(202).end('ignored')
      return
    }
    const agentRow = this.db
      .prepare('SELECT seat_id, factory, model_profile FROM agents WHERE id = ?')
      .get(agentId) as { seat_id: string; factory: string; model_profile: string | null } | undefined
    let model = usage.model
    if (!model && agentRow?.model_profile) {
      try {
        const profile = JSON.parse(agentRow.model_profile) as { model?: string }
        model = profile.model
      } catch {
        // ignore
      }
    }
    insertTokenUsageEvent(this.db, {
      id: newTokenUsageId(),
      taskId: this.taskId,
      projectId: process.env['TASK_PROJECT_ID'],
      agentId,
      seatId: agentRow?.seat_id,
      factory: agentRow?.factory,
      provider: 'claude-acp',
      model,
      externalRequestId: usage.externalRequestId,
      source: 'runtime',
      inputTokens: usage.inputTokens,
      cacheCreationTokens: usage.cacheCreationTokens,
      cacheReadTokens: usage.cacheReadTokens,
      outputTokens: usage.outputTokens,
      reasoningTokens: usage.reasoningTokens,
      totalTokens: usage.totalTokens,
      rawUsage: usage.rawUsage ?? parsed,
    })
    res.writeHead(202).end('ok')
  }
}

/** 读取 HTTP 请求 body（POST 时需要）*/
function readRequestBody(req: http.IncomingMessage): Promise<string | null> {
  return new Promise((resolve, reject) => {
    if (req.method === 'GET' || req.method === 'DELETE') {
      resolve(null)
      return
    }
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8') || null))
    req.on('error', reject)
  })
}
