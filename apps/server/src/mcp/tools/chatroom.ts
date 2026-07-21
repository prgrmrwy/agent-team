/**
 * 组 13: chatroom 工具（chatroom_send / chatroom_listen / chatroom_recent）
 * 使用 protocol McpTools 的 schema，不重定义。
 */

import fs from 'node:fs'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import type { Message } from '@agent-team/protocol'
import {
  ChatroomSendInput,
  ChatroomListenInput,
  ChatroomRecentInput,
  isUrgentSystemEvent,
  urgentKeyForContent,
} from '@agent-team/protocol'
import { newMessageId, newTokenUsageId } from '../../util/id.js'
import type { McpToolContext } from '../context.js'
import { insertTokenUsageEvent } from '../../db/token-usage-repo.js'
import { estimateTextTokens } from '../../util/token-usage.js'
import { isHumanConfirmationRequest } from './human-confirmation-gate.js'

/** 内存消息通知总线（每 task 一个实例，由 ctx.emitter 的 EventEmitter 复用）*/
const msgBus = new EventEmitter()
msgBus.setMaxListeners(100)

/** 把消息写入 DB + chatroom.jsonl，并通知 msgBus */
function persistMessage(ctx: McpToolContext, msg: Message): void {
  const db = ctx.db
  const urgentKey =
    msg.type === 'system-event' && isUrgentSystemEvent(msg.content)
      ? (msg.urgentKey ?? urgentKeyForContent(msg.content))
      : (msg.urgentKey ?? null)
  db.prepare(
    `INSERT INTO chatroom_messages
       (id, task_id, channel, type, sender, content, mention, refs, reply_to, urgent_key, acknowledged_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    msg.id,
    msg.taskId,
    msg.channel,
    msg.type,
    msg.sender,
    msg.content,
    JSON.stringify(msg.mention),
    JSON.stringify(msg.refs),
    msg.replyTo ?? null,
    urgentKey,
    msg.acknowledgedAt ?? null,
    msg.createdAt
  )
  msg.urgentKey = urgentKey
  msg.acknowledgedAt = msg.acknowledgedAt ?? null

  // append-only chatroom.jsonl
  const jsonlPath = path.join(ctx.taskWorkdir, 'chatroom.jsonl')
  fs.appendFileSync(jsonlPath, JSON.stringify(msg) + '\n', 'utf-8')

  // 通知长轮询等待者
  msgBus.emit(`msg:${ctx.taskId}:${msg.channel}`, msg)

  // 广播给 WS 前端（通过 EffectEmitter 上抛）
  ctx.emitter.emit('chatroom-msg', { taskId: ctx.taskId, message: msg })
  if (msg.type === 'system-event' && urgentKey) {
    ctx.emitter.emit('notify', {
      taskId: ctx.taskId,
      level: 'warn',
      content: msg.content,
    })
  }
  if (isHumanConfirmationRequest(ctx, msg)) {
    ctx.markHumanConfirmationPending?.({
      messageId: msg.id,
      byAgentId: msg.sender,
      content: msg.content,
    })
  }
}

/** 从 extra.sessionId 推断 caller agentId（HTTP transport 路径标识） */
function resolveCallerId(ctx: McpToolContext, extra: { sessionId?: string }): string {
  // stateless:优先 ctx.callerAgentId(URL 路径身份);回退旧 session 反查(单测/legacy)
  const agentId =
    ctx.callerAgentId ?? (extra.sessionId ? ctx.getAgentIdByMcpSession(extra.sessionId) : undefined)
  // fallback：系统消息或无法识别的 caller
  return agentId ?? 'system'
}

export function registerChatroomTools(ctx: McpToolContext): void {
  // 1. chatroom_send
  ctx.mcpServer.tool(
    'chatroom_send',
    'Send a message to a chatroom channel',
    ChatroomSendInput.shape,
    async (args, extra) => {
      const input = ChatroomSendInput.parse(args)
      const now = new Date().toISOString()
      const messageId = newMessageId()

      // 从 MCP session → agentId 解析 caller 身份
      const senderId = resolveCallerId(ctx, extra)

      // mention 唤醒(phase-driven-orchestration: chatroom-protocol "mention 唤醒 idle agent"):
      //   vacant  → **只入队,不唤醒**:从未上场的懒式 seat,等它自己的阶段到了正常 spawn
      //             时从 chatroom 看到这条 @。被 @ 就提前 spawn 会破坏懒式(在 S6 把 qa/ci 拉起)
      //   offline → 入队 + 唤醒:agent 曾在线后断连,re-spawn 是正当的
      //   idle    → 唤醒(promptSession 重激活,peer 催单闭环的前提)
      //   working → 不动(turn 结束自然可见新消息)
      const queuedSeats: string[] = []
      if (input.mention?.length) {
        for (const seatId of input.mention) {
          const seat = ctx.db.prepare('SELECT queue FROM seats WHERE id = ?').get(seatId) as
            | { queue: string }
            | undefined
          if (!seat) continue

          const queue: string[] = JSON.parse(seat.queue)
          queue.push(messageId)
          ctx.db.prepare('UPDATE seats SET queue = ? WHERE id = ?').run(JSON.stringify(queue), seatId)
          queuedSeats.push(seatId)

          const hadAgent = !!ctx.db
            .prepare("SELECT id FROM agents WHERE seat_id = ? AND state != 'terminated' LIMIT 1")
            .get(seatId)
          if (hadAgent) {
            // presence 由 task-process session map 决定:有 live session 就 prompt,无 live
            // session 则由 wake 重生。未上场的懒式 vacant seat 只入队,不提前 spawn。
            ctx.emitter.emit('wakeup-seat', { taskId: ctx.taskId, seatId })
          }
        }
      }

      const msg: Message = {
        id: messageId,
        taskId: ctx.taskId,
        channel: input.channel,
        type: input.type,
        sender: senderId,
        content: input.content,
        mention: input.mention ?? [],
        refs: input.refs ?? [],
        replyTo: input.replyTo ?? null,
        createdAt: now,
      }

      persistMessage(ctx, msg)

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ messageId, queuedSeats }),
          },
        ],
      }
    }
  )

  // 2. chatroom_listen（长轮询）
  ctx.mcpServer.tool(
    'chatroom_listen',
    'Long-poll for new messages in a chatroom channel',
    ChatroomListenInput.shape,
    async (args, extra) => {
      const input = ChatroomListenInput.parse(args)
      const { channel, since, timeoutMs } = input
      const callerId = resolveCallerId(ctx, extra)

      // 先查 DB 看有没有 since 之后的消息
      const recentRows = since
        ? (ctx.db
            .prepare(
              `SELECT * FROM chatroom_messages
               WHERE task_id = ? AND channel = ? AND created_at > (
                 SELECT created_at FROM chatroom_messages WHERE id = ?
               )
               ORDER BY created_at`
            )
            .all(ctx.taskId, channel, since) as Record<string, unknown>[])
        : (ctx.db
            .prepare(
              `SELECT * FROM chatroom_messages
               WHERE task_id = ? AND channel = ?
               ORDER BY created_at`
            )
            .all(ctx.taskId, channel) as Record<string, unknown>[])

      if (recentRows.length > 0) {
        const messages = recentRows.map(rowToMessage)
        const text = JSON.stringify({ messages })
        persistChatroomReadUsage(ctx, callerId, channel, text)
        return { content: [{ type: 'text' as const, text }] }
      }

      // 长轮询等待
      const messages = await new Promise<Message[]>((resolve) => {
        const timer = setTimeout(() => {
          cleanup()
          resolve([])
        }, timeoutMs)

        const handler = (msg: Message) => {
          cleanup()
          resolve([msg])
        }

        function cleanup() {
          clearTimeout(timer)
          msgBus.off(`msg:${ctx.taskId}:${channel}`, handler)
        }

        msgBus.once(`msg:${ctx.taskId}:${channel}`, handler)
      })

      const text = JSON.stringify({ messages })
      persistChatroomReadUsage(ctx, callerId, channel, text)
      return { content: [{ type: 'text' as const, text }] }
    }
  )

  // 3. chatroom_recent
  ctx.mcpServer.tool(
    'chatroom_recent',
    'Get recent messages from a chatroom channel',
    ChatroomRecentInput.shape,
    async (args, extra) => {
      const input = ChatroomRecentInput.parse(args)
      const callerId = resolveCallerId(ctx, extra)
      const rows = ctx.db
        .prepare(
          `SELECT * FROM chatroom_messages
           WHERE task_id = ? AND channel = ?
           ORDER BY created_at DESC LIMIT ?`
        )
        .all(ctx.taskId, input.channel, input.n) as Record<string, unknown>[]

      // 倒序加载后正序返回
      const messages = rows.reverse().map(rowToMessage)
      const text = JSON.stringify({ messages })
      persistChatroomReadUsage(ctx, callerId, input.channel, text)
      return { content: [{ type: 'text' as const, text }] }
    }
  )
}

function persistChatroomReadUsage(
  ctx: McpToolContext,
  agentId: string,
  channel: Message['channel'],
  payload: string,
): void {
  const tokens = estimateTextTokens(payload)
  if (tokens === 0 || payload === '{"messages":[]}') return
  const row = ctx.db
    .prepare('SELECT seat_id, factory FROM agents WHERE id = ?')
    .get(agentId) as { seat_id: string; factory: string } | undefined
  insertTokenUsageEvent(ctx.db, {
    id: newTokenUsageId(),
    taskId: ctx.taskId,
    projectId: process.env['TASK_PROJECT_ID'],
    agentId,
    seatId: row?.seat_id,
    factory: row?.factory,
    source: 'chatroom-read',
    channel,
    totalTokens: tokens,
    rawUsage: { bytes: payload.length },
  })
}

function rowToMessage(r: Record<string, unknown>): Message {
  return {
    id: r['id'] as string,
    taskId: r['task_id'] as string,
    channel: r['channel'] as Message['channel'],
    type: r['type'] as Message['type'],
    sender: r['sender'] as string,
    content: r['content'] as string,
    mention: JSON.parse((r['mention'] as string) ?? '[]') as string[],
    refs: JSON.parse((r['refs'] as string) ?? '[]') as string[],
    replyTo: (r['reply_to'] as string | null) ?? null,
    urgentKey: (r['urgent_key'] as string | null) ?? null,
    acknowledgedAt: (r['acknowledged_at'] as string | null) ?? null,
    createdAt: r['created_at'] as string,
  }
}
