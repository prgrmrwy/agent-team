import type WebSocket from 'ws'
import type { Presence, ServerToClient } from '@agent-team/protocol'
import type { ConnectionMap } from '../broadcast.js'
import type { Logger } from '../../util/logger.js'
import type { TaskProcessLauncher } from '../../process/task-process-launcher.js'

export function handleSubscribeTask(
  ws: WebSocket,
  taskId: string,
  connections: ConnectionMap,
  log: Logger,
  launcher?: TaskProcessLauncher,
  getPresenceSnapshot?: (taskId: string) => {
    seatId: string
    presence: string
    agentId?: string | null
    displayName?: string | null
  }[],
): void {
  if (!connections.has(taskId)) {
    connections.set(taskId, new Set())
  }
  connections.get(taskId)!.add(ws)
  log.debug({ taskId }, 'client subscribed to task')

  // derive-presence D3:订阅即告知该 task 的进程在线状态。前端据此决定
  // 显示真实 presence(在线)还是 offline(离线)。launcher 缺省(测试)时跳过。
  const alive = launcher ? launcher.hasActive(taskId) : false
  if (launcher) {
    const event: ServerToClient = { type: 'task-process-state', taskId, alive }
    ws.send(JSON.stringify(event))
  }

  // derive-presence D2:回放当前 presence 快照(进程在线且有缓存时)。
  // presence 不落库,只从内存 relay 缓存回放给新订阅者。
  if (alive && getPresenceSnapshot) {
    for (const { seatId, presence, agentId, displayName } of getPresenceSnapshot(taskId)) {
      const ev: ServerToClient = {
        type: 'seat-state',
        taskId,
        seatId,
        presence: presence as Presence,
        agentId,
        displayName,
      }
      ws.send(JSON.stringify(ev))
    }
  }
}

export function handleUnsubscribeTask(
  ws: WebSocket,
  taskId: string,
  connections: ConnectionMap,
  log: Logger
): void {
  const subs = connections.get(taskId)
  if (subs) {
    subs.delete(ws)
    if (subs.size === 0) connections.delete(taskId)
  }
  log.debug({ taskId }, 'client unsubscribed from task')
}
