import { z } from 'zod'
import { ArtifactId, SeatId, TaskId } from '../domain/common.js'
import { Artifact } from '../domain/artifact.js'
import {
  BootstrapMode,
  BootstrapProvider,
  BootstrapResourceKind,
  BootstrapResourceStatus,
} from '../domain/bootstrap.js'
import { Channel, Presence, TaskState } from '../domain/enums.js'
import { Message } from '../domain/message.js'

/**
 * 前后端 WebSocket 协议（design.md D15）。
 * 前端只通过 WS 收事件，发控制/消息；不直接调 MCP。
 */

// ---- Server → Client ----
export const ServerToClient = z.discriminatedUnion('type', [
  z.object({ type: z.literal('chatroom-msg'), taskId: TaskId, message: Message }),
  // 流式 delta:agent stream 中间块,前端组装"草稿气泡",final chatroom-msg 到时替换
  z.object({
    type: z.literal('chatroom-msg-delta'),
    taskId: TaskId,
    agentId: z.string().min(1),
    channel: z.string().min(1),
    content: z.string(),
  }),
  z.object({ type: z.literal('phase-change'), taskId: TaskId, from: TaskState, to: TaskState }),
  // 进程在线信号(derive-presence D3):task-process 活/死。alive=false 时前端把该 task
  // 所有 seat 渲染为 offline,绝不沿用陈旧 presence(消灭僵尸"假活")。
  // 订阅 task 时 server 立即回一条当前值;进程起/死时推送变化。
  z.object({ type: z.literal('task-process-state'), taskId: TaskId, alive: z.boolean() }),
  // seat presence(derive-presence):活进程派生后广播。主 server 内存 relay 缓存最新值,
  // 新订阅时回放(快照),进程死时清。presence 不落库。
  z.object({
    type: z.literal('seat-state'),
    taskId: TaskId,
    seatId: SeatId,
    presence: Presence,
    agentId: z.string().nullable().optional(),
    displayName: z.string().nullable().optional(),
  }),
  z.object({ type: z.literal('artifact-event'), taskId: TaskId, artifact: Artifact }),
  z.object({ type: z.literal('propose-rejected'), taskId: TaskId, reason: z.string() }),
  z.object({
    type: z.literal('bootstrap-resource'),
    taskId: TaskId,
    resourceId: z.string().min(1),
    kind: BootstrapResourceKind,
    status: BootstrapResourceStatus,
    provider: BootstrapProvider,
    mode: BootstrapMode.optional(),
    summary: z.string().optional(),
    error: z.string().optional(),
  }),
  z.object({
    type: z.literal('notification'),
    level: z.enum(['info', 'warn', 'error']),
    content: z.string(),
  }),
])
export type ServerToClient = z.infer<typeof ServerToClient>

// ---- Client → Server ----
export const ClientToServer = z.discriminatedUnion('type', [
  z.object({ type: z.literal('subscribe-task'), taskId: TaskId }),
  z.object({ type: z.literal('unsubscribe-task'), taskId: TaskId }),
  z.object({
    type: z.literal('human-message'),
    taskId: TaskId,
    channel: Channel,
    content: z.string().min(1),
    mention: z.array(SeatId).default([]),
    refs: z.array(ArtifactId).default([]),
  }),
  z.object({
    type: z.literal('control'),
    taskId: TaskId,
    // M3 T12:统一 done(替代旧 UI 上的 pause/resume/complete/abort 三联按钮)。
    // 旧 action 保留协议,前端不再暴露;done = 立刻置 state=done(乐观)+
    // 后台 planner 异步判断是否需要 archive,有问题 chatroom 问用户回 archive/skip
    action: z.enum(['pause', 'resume', 'abort', 'complete', 'done']),
  }),
])
export type ClientToServer = z.infer<typeof ClientToServer>
