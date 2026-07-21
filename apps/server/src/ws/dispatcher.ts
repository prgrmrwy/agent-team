import type WebSocket from 'ws'
import { ClientToServer } from '@agent-team/protocol'
import { handleSubscribeTask, handleUnsubscribeTask } from './handlers/subscribe-task.js'
import { handleHumanMessage, type EnsureTaskProcess } from './handlers/human-message.js'
import { handleControl } from './handlers/control.js'
import type { ConnectionMap } from './broadcast.js'
import type { Logger } from '../util/logger.js'
import type { TaskProcessLauncher } from '../process/task-process-launcher.js'
import type { DbClient } from '../db/client.js'

/**
 * 解析并分发客户端 WS 消息。
 * Zod 校验失败时发回 error 帧，不关闭连接。
 * Wave 2b: launcher 注入后，human-message / control 转发到 task-process IPC。
 * M3 T10: ensureTaskProcess 注入后,human-message 命中已死 task-process 时自动唤醒。
 */
export function dispatch(
  ws: WebSocket,
  raw: string,
  connections: ConnectionMap,
  log: Logger,
  launcher?: TaskProcessLauncher,
  ensureTaskProcess?: EnsureTaskProcess,
  indexDb?: DbClient,
  getPresenceSnapshot?: (taskId: string) => {
    seatId: string
    presence: string
    agentId?: string | null
    displayName?: string | null
  }[],
): void {
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch {
    ws.send(JSON.stringify({ type: 'error', error: 'invalid JSON' }))
    return
  }

  const parsed = ClientToServer.safeParse(json)
  if (!parsed.success) {
    ws.send(JSON.stringify({ type: 'error', error: 'unknown or invalid message', details: parsed.error.flatten() }))
    return
  }

  const msg = parsed.data

  switch (msg.type) {
    case 'subscribe-task':
      handleSubscribeTask(ws, msg.taskId, connections, log, launcher, getPresenceSnapshot)
      break
    case 'unsubscribe-task':
      handleUnsubscribeTask(ws, msg.taskId, connections, log)
      break
    case 'human-message':
      handleHumanMessage(ws, msg, log, launcher, ensureTaskProcess).catch((err) => {
        log.error({ err, taskId: msg.taskId }, 'handleHumanMessage threw')
      })
      break
    case 'control':
      handleControl(ws, msg, log, launcher, indexDb, ensureTaskProcess).catch((err) => {
        log.error({ err, taskId: msg.taskId }, 'handleControl threw')
      })
      break
  }
}
