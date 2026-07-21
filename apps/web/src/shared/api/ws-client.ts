import { ServerToClient, type ClientToServer } from '@agent-team/protocol'
import { env } from '../config/env.js'
import { useStore } from '../lib/store.js'

type MessageHandler = (msg: ServerToClient) => void

const INITIAL_RECONNECT_DELAY = 1_000
const MAX_RECONNECT_DELAY = 30_000
const RECONNECT_MULTIPLIER = 2

class WsClient {
  private ws: WebSocket | null = null
  private reconnectDelay = INITIAL_RECONNECT_DELAY
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private handlers: Set<MessageHandler> = new Set()
  private destroyed = false
  private subscribedTaskIds: Set<string> = new Set()

  connect() {
    // 单例 + React StrictMode：mount→connect / unmount→destroy / mount→connect。
    // connect 表示"现在要连"，重置 destroyed，否则第二次 connect 会被旧的 destroyed 永久挡掉。
    this.destroyed = false
    if (this.ws?.readyState === WebSocket.OPEN || this.ws?.readyState === WebSocket.CONNECTING) return

    const token = env.token
    const url = `${env.wsBase}/ws${token ? `?token=${encodeURIComponent(token)}` : ''}`
    const ws = new WebSocket(url)

    this.ws = ws

    ws.addEventListener('open', () => {
      if (ws !== this.ws || this.destroyed) return
      console.log('[ws] connected')
      this.reconnectDelay = INITIAL_RECONNECT_DELAY
      // re-subscribe previously subscribed tasks after reconnect
      for (const taskId of this.subscribedTaskIds) {
        this.send({ type: 'subscribe-task', taskId })
      }
    })

    ws.addEventListener('message', (event: MessageEvent<string>) => {
      if (ws !== this.ws || this.destroyed) return
      let raw: unknown
      try {
        raw = JSON.parse(event.data)
      } catch {
        console.warn('[ws] non-JSON message', event.data)
        return
      }

      const result = ServerToClient.safeParse(raw)
      if (!result.success) {
        console.warn('[ws] unknown message shape', result.error.format())
        return
      }

      const msg = result.data
      // Dispatch to zustand store for cross-cutting state
      this.dispatchToStore(msg)
      // Notify all feature-level handlers
      for (const handler of this.handlers) {
        handler(msg)
      }
    })

    ws.addEventListener('close', () => {
      if (ws !== this.ws || this.destroyed) return
      console.log('[ws] disconnected, scheduling reconnect in', this.reconnectDelay, 'ms')
      this.ws = null
      this.scheduleReconnect()
    })

    ws.addEventListener('error', () => {
      if (ws !== this.ws || this.destroyed) return
      console.warn('[ws] connection error, will retry if the socket closes')
    })
  }

  private dispatchToStore(msg: ServerToClient) {
    const store = useStore.getState()
    if (msg.type === 'phase-change') {
      // If this is the current task, update its state
      const current = store.currentTask
      if (current && current.id === msg.taskId) {
        store.setCurrentTask({ ...current, state: msg.to })
      }
    }
  }

  private scheduleReconnect() {
    if (this.destroyed) return
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = setTimeout(() => {
      this.reconnectDelay = Math.min(this.reconnectDelay * RECONNECT_MULTIPLIER, MAX_RECONNECT_DELAY)
      this.connect()
    }, this.reconnectDelay)
  }

  send(msg: ClientToServer) {
    if (this.ws?.readyState !== WebSocket.OPEN) {
      console.warn('[ws] cannot send, not connected', msg.type)
      return
    }
    this.ws.send(JSON.stringify(msg))
  }

  subscribeTask(taskId: string) {
    this.subscribedTaskIds.add(taskId)
    this.send({ type: 'subscribe-task', taskId })
  }

  unsubscribeTask(taskId: string) {
    this.subscribedTaskIds.delete(taskId)
    this.send({ type: 'unsubscribe-task', taskId })
  }

  addHandler(handler: MessageHandler): () => void {
    this.handlers.add(handler)
    return () => this.handlers.delete(handler)
  }

  isConnected() {
    return this.ws?.readyState === WebSocket.OPEN
  }

  destroy() {
    this.destroyed = true
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
    this.ws?.close()
    this.ws = null
  }
}

/** Singleton WS client — import and use anywhere in the app. */
export const wsClient = new WsClient()
