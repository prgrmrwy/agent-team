import type WebSocket from 'ws'
import type { ServerToClient } from '@agent-team/protocol'

/**
 * 连接 Map：taskId → 订阅该 task 的 WebSocket 集合。
 * 全局单例，由 ws-server.ts 持有。
 */
export type ConnectionMap = Map<string, Set<WebSocket>>

/** 按 taskId 广播事件给所有已订阅的前端连接 */
export function broadcast(
  connections: ConnectionMap,
  taskId: string,
  event: ServerToClient
): void {
  const subs = connections.get(taskId)
  if (!subs?.size) return

  const payload = JSON.stringify(event)
  for (const ws of subs) {
    if (ws.readyState === 1 /* OPEN */) {
      ws.send(payload)
    }
  }
}

/** 广播给所有连接（不分 task，如全局 notification）*/
export function broadcastAll(connections: ConnectionMap, event: ServerToClient): void {
  const payload = JSON.stringify(event)
  for (const subs of connections.values()) {
    for (const ws of subs) {
      if (ws.readyState === 1) {
        ws.send(payload)
      }
    }
  }
}
