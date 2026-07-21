/**
 * 组 16.3: ipc-protocol.ts
 * 主 server ↔ task-process IPC 消息 zod schema。
 *
 * 消息类型（agent-runtime spec）：
 *   task-event    task-process → server：消息/phase-change/artifact 事件，server 转 WS 推前端
 *   user-input    server → task-process：人类消息/@路由/控制指令
 *   heartbeat     双向：ping/pong
 *   lifecycle-control server → task-process：pause/resume/abort task
 */

import { z } from 'zod'
import { Presence } from '@agent-team/protocol'

// ---- task-event（task-process → server） ----

/**
 * 流式 delta — agent stream text 中间块。不落 DB,只 WS 推前端组装"草稿气泡"。
 * 一个 turn:多条 delta → 最后一条 chatroom-msg(final 完整内容)。
 * 前端用 (agentId, channel) 维护 partial state;final 到时清掉 partial 用 message 渲染。
 */
export const TaskEventChatroomMsgDelta = z.object({
  type: z.literal('task-event'),
  subtype: z.literal('chatroom-msg-delta'),
  taskId: z.string(),
  agentId: z.string(),
  channel: z.string(),
  /** 该 turn 内累积到目前的完整文本(非 incremental chunk),前端直接替换 */
  content: z.string(),
})

export const TaskEventChatroomMsg = z.object({
  type: z.literal('task-event'),
  subtype: z.literal('chatroom-msg'),
  taskId: z.string(),
  // 与实际 emit 的 protocol Message 形状对齐（之前用 seatId/agentId/messageType 字段导致
  // parseIpcMessage 校验失败 → chatroom-msg 被静默丢弃，前端永远收不到 agent 消息）。
  message: z.object({
    id: z.string(),
    taskId: z.string(),
    channel: z.string(),
    type: z.string(),
    sender: z.string(),
    content: z.string(),
    mention: z.array(z.string()).default([]),
    refs: z.array(z.string()).default([]),
    replyTo: z.string().nullable().default(null),
    createdAt: z.string(),
  }),
})

export const TaskEventPhaseChange = z.object({
  type: z.literal('task-event'),
  subtype: z.literal('phase-change'),
  taskId: z.string(),
  from: z.string(),
  to: z.string(),
  by: z.string(),
  at: z.string(),
})

export const TaskEventArtifact = z.object({
  type: z.literal('task-event'),
  subtype: z.literal('artifact'),
  taskId: z.string(),
  artifact: z.object({
    id: z.string(),
    type: z.string(),
    path: z.string(),
    registeredAt: z.string(),
  }),
})

export const TaskEventProposeRejected = z.object({
  type: z.literal('task-event'),
  subtype: z.literal('propose-rejected'),
  taskId: z.string(),
  reason: z.string(),
})

export const TaskEventSeatState = z.object({
  type: z.literal('task-event'),
  subtype: z.literal('seat-state'),
  taskId: z.string(),
  seatId: z.string(),
  presence: Presence,
  agentId: z.string().nullable(),
  displayName: z.string().nullable(),
})

export const TaskEventNotification = z.object({
  type: z.literal('task-event'),
  subtype: z.literal('notification'),
  taskId: z.string(),
  level: z.enum(['info', 'warn', 'error']),
  content: z.string(),
})

/** 防静默:task 卡住/恢复 → server 同步 index.db stalled 标志(phase-driven-orchestration)*/
export const TaskEventStalled = z.object({
  type: z.literal('task-event'),
  subtype: z.literal('stalled'),
  taskId: z.string(),
  stalled: z.boolean(),
  reason: z.string().optional(),
})

export const TaskEvent = z.discriminatedUnion('subtype', [
  TaskEventChatroomMsg,
  TaskEventChatroomMsgDelta,
  TaskEventPhaseChange,
  TaskEventArtifact,
  TaskEventProposeRejected,
  TaskEventSeatState,
  TaskEventNotification,
  TaskEventStalled,
])
export type TaskEvent = z.infer<typeof TaskEvent>

// ---- user-input（server → task-process） ----

export const UserInputMessage = z.object({
  type: z.literal('user-input'),
  subtype: z.literal('message'),
  taskId: z.string(),
  channel: z.string(),
  content: z.string(),
  mention: z.array(z.string()).default([]),
  refs: z.array(z.string()).default([]),
})

export const UserInputControl = z.object({
  type: z.literal('user-input'),
  subtype: z.literal('control'),
  taskId: z.string(),
  action: z.enum(['pause', 'resume', 'abort', 'complete', 'done']),
})

export const UserInput = z.discriminatedUnion('subtype', [
  UserInputMessage,
  UserInputControl,
])
export type UserInput = z.infer<typeof UserInput>

// ---- heartbeat（双向） ----

export const HeartbeatPing = z.object({
  type: z.literal('heartbeat'),
  direction: z.literal('ping'),
  at: z.string(),
})

export const HeartbeatPong = z.object({
  type: z.literal('heartbeat'),
  direction: z.literal('pong'),
  at: z.string(),
})

export const Heartbeat = z.union([HeartbeatPing, HeartbeatPong])
export type Heartbeat = z.infer<typeof Heartbeat>

// ---- lifecycle-control（server → task-process，task-process 初始化完成回报）----

export const LifecycleControl = z.object({
  type: z.literal('lifecycle-control'),
  action: z.enum(['shutdown', 'pause-all', 'resume-all']),
})
export type LifecycleControl = z.infer<typeof LifecycleControl>

export const LifecycleReady = z.object({
  type: z.literal('lifecycle-ready'),
  taskId: z.string(),
})
export type LifecycleReady = z.infer<typeof LifecycleReady>

// ---- 顶层 union ----

export const IpcMessage = z.union([
  TaskEvent,
  UserInput,
  Heartbeat,
  LifecycleControl,
  LifecycleReady,
])
export type IpcMessage = z.infer<typeof IpcMessage>

/** 便利函数：安全解析 IPC 消息（失败返回 null） */
export function parseIpcMessage(raw: unknown): IpcMessage | null {
  const result = IpcMessage.safeParse(raw)
  return result.success ? result.data : null
}
