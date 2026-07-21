import { WebSocketServer } from 'ws'
import type { WebSocket } from 'ws'
import type { Server, IncomingMessage } from 'node:http'
import { URL } from 'node:url'
import { getConfig } from '../config/index.js'
import { dispatch } from './dispatcher.js'
import type { EnsureTaskProcess } from './handlers/human-message.js'
import type { DbClient } from '../db/client.js'
import type { ConnectionMap } from './broadcast.js'
import type { Logger } from '../util/logger.js'
import type { TaskProcessLauncher } from '../process/task-process-launcher.js'

export interface WsServerOptions {
  httpServer: Server
  log: Logger
  /**
   * Wave 2b: 返回 task-process launcher 的 getter。
   * 使用 getter 而非直接传值，支持 launcher 在 ws-server 初始化后创建（延迟绑定）。
   */
  getLauncher?: () => TaskProcessLauncher | undefined
  /**
   * M3 T10: 给 human-message handler 用 — task-process 死了时自动唤醒。
   * 由 main.ts 实现(它有 indexDb + config + factoriesDir 上下文)。
   */
  ensureTaskProcess?: EnsureTaskProcess
  /** Legacy injection kept for handler signature compatibility; lifecycle state is synced in main.ts. */
  indexDb?: DbClient
  /**
   * derive-presence:新订阅回放该 task 当前全 seat presence 快照。
   * 由 main.ts 实现(它持有 presence relay 缓存)。
   */
  getPresenceSnapshot?: (taskId: string) => {
    seatId: string
    presence: string
    agentId?: string | null
    displayName?: string | null
  }[]
}

/**
 * WS server（ws@8）。
 * - connection upgrade 阶段 token 鉴权（?token= 或 Sec-WebSocket-Protocol）
 * - 维护 taskId → Set<WebSocket> 连接 Map
 * - 所有入站消息通过 dispatcher 分发
 * - Wave 2b: getLauncher() 注入后转发 human-message/control 到 task-process IPC
 */
export function createWsServer(opts: WsServerOptions): { wss: WebSocketServer; connections: ConnectionMap } {
  const { httpServer, log, getLauncher, ensureTaskProcess, indexDb, getPresenceSnapshot } = opts
  const connections: ConnectionMap = new Map()

  const wss = new WebSocketServer({ noServer: true })

  // connection upgrade 鉴权
  httpServer.on('upgrade', (req: IncomingMessage, socket, head) => {
    const { token } = getConfig()

    // 解析 query string
    const reqUrl = req.url ?? '/'
    // 用 dummy base 解析相对 URL
    const parsed = new URL(reqUrl, 'http://localhost')
    const queryToken = parsed.searchParams.get('token')

    // 也支持 Sec-WebSocket-Protocol header（备选，前端通常用 query）
    const wsProtocol = req.headers['sec-websocket-protocol']

    const suppliedToken = queryToken ?? wsProtocol

    if (suppliedToken !== token) {
      log.warn({ url: reqUrl }, 'WS upgrade rejected: missing or invalid token')
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
      socket.destroy()
      return
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req)
    })
  })

  wss.on('connection', (ws: WebSocket) => {
    log.debug('WS client connected')

    ws.on('message', (data) => {
      const raw = data.toString()
      dispatch(ws, raw, connections, log, getLauncher?.(), ensureTaskProcess, indexDb, getPresenceSnapshot)
    })

    ws.on('close', () => {
      // 从所有 taskId 订阅中移除该连接
      for (const [taskId, subs] of connections) {
        subs.delete(ws)
        if (subs.size === 0) connections.delete(taskId)
      }
      log.debug('WS client disconnected')
    })

    ws.on('error', (err) => {
      log.error({ err }, 'WS error')
    })
  })

  return { wss, connections }
}
