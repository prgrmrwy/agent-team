import { z } from 'zod'
import { ArtifactId, MessageId, SeatId, TaskId, Timestamp } from './common.js'
import { Channel, MessageType } from './enums.js'

/**
 * chatroom 一条消息（chatroom-protocol spec）。
 * 原文 append-only 落 chatroom.jsonl，元数据索引进 SQLite。
 */
export const Message = z.object({
  id: MessageId,
  taskId: TaskId,
  channel: Channel,
  type: MessageType,
  /** 发送者：seatId / 'human' / 'system' */
  sender: z.string().min(1),
  content: z.string(),
  /** @ 路由目标岗位 */
  mention: z.array(SeatId).default([]),
  /** 引用的 artifact（消息卡片可点击）*/
  refs: z.array(ArtifactId).default([]),
  /** 回复某条消息 */
  replyTo: MessageId.nullable().default(null),
  /** 需要人类确认的系统消息稳定键；普通消息为 null/undefined */
  urgentKey: z.string().nullable().optional(),
  /** 单用户本地确认时间；未确认为 null/undefined */
  acknowledgedAt: Timestamp.nullable().optional(),
  createdAt: Timestamp,
})
export type Message = z.infer<typeof Message>

/**
 * 系统事件是否属"需要人类介入 / 异常状态"类。
 * 前后端共享同一口径，避免 ack 与醒目渲染判断漂移。
 */
export function isUrgentSystemEvent(content: string): boolean {
  if (/[⚠❌🚨⛔🛑]/.test(content)) return true
  if (/(人类介入|人工介入|请人类|请人工|需要人类)/.test(content)) return true
  return false
}

export function urgentKeyForContent(content: string): string {
  let hash = 5381
  for (let i = 0; i < content.length; i++) {
    hash = (hash * 33) ^ content.charCodeAt(i)
  }
  return `urgent-${(hash >>> 0).toString(36)}`
}
