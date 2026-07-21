import { z } from 'zod'
import {
  AgentId,
  ArtifactId,
  MessageId,
  RelPath,
  SeatId,
  TaskId,
} from '../domain/common.js'
import { Artifact } from '../domain/artifact.js'
import { TaskBootstrapResource } from '../domain/bootstrap.js'
import { AgentModelProfile } from '../domain/factory.js'
import {
  ArtifactType,
  Channel,
  ContextAction,
  FactoryRole,
  MessageType,
  TaskState,
} from '../domain/enums.js'
import { Message } from '../domain/message.js'
import { Seat } from '../domain/seat.js'
import { StateTransition } from '../domain/task.js'

/**
 * chatroom-mcp 的 13 个工具契约（chatroom-protocol spec）。
 * MCP server 每 task 共享单实例（design.md D8），通过 transport 标识区分调用者。
 * 因 server 是 per-task，通信类工具的 taskId 由连接隐含；制品/岗位/状态机类显式带 taskId（与 spec 签名一致）。
 */

// 1. chatroom_send
export const ChatroomSendInput = z.object({
  channel: Channel,
  type: MessageType,
  content: z.string(),
  refs: z.array(ArtifactId).optional(),
  mention: z.array(SeatId).optional(),
  replyTo: MessageId.optional(),
})
export const ChatroomSendOutput = z.object({
  messageId: MessageId,
  /** 命中 offline/vacant 岗位、消息入队的 seatId 列表 */
  queuedSeats: z.array(SeatId).default([]),
})

// 2. chatroom_listen（长轮询）
export const ChatroomListenInput = z.object({
  channel: Channel,
  since: MessageId.optional(),
  timeoutMs: z.number().int().positive().default(30_000),
})
export const ChatroomListenOutput = z.object({ messages: z.array(Message) })

// 3. chatroom_recent
export const ChatroomRecentInput = z.object({
  channel: Channel,
  n: z.number().int().positive().default(20),
})
export const ChatroomRecentOutput = z.object({ messages: z.array(Message) })

// 4. artifact_register
export const ArtifactRegisterInput = z.object({
  taskId: TaskId,
  path: RelPath,
  type: ArtifactType,
  producer: AgentId,
  summary: z.string().default(''),
  refs: z.array(ArtifactId).optional(),
})
export const ArtifactRegisterOutput = z.object({ artifactId: ArtifactId })

// 5. artifact_list
export const ArtifactListInput = z.object({
  taskId: TaskId,
  type: ArtifactType.optional(),
  producer: AgentId.optional(),
})
export const ArtifactListOutput = z.object({ artifacts: z.array(Artifact) })

// 6. artifact_get
export const ArtifactGetInput = z.object({ artifactId: ArtifactId })
export const ArtifactGetOutput = z.object({ artifact: Artifact, content: z.string() })

// 7. seat_create
export const SeatCreateInput = z.object({
  taskId: TaskId,
  role: z.string().min(1),
  factory: FactoryRole,
  modelOverride: AgentModelProfile.optional(),
})
export const SeatCreateOutput = z.object({ seatId: SeatId })

// 8. seat_list
export const SeatListInput = z.object({ taskId: TaskId })
export const SeatListOutput = z.object({ seats: z.array(Seat) })

// 9. seat_status_get
export const SeatStatusGetInput = z.object({ seatId: SeatId })
export const SeatStatusGetOutput = z.object({ seat: Seat })

// 10. task_state_get
export const TaskStateGetInput = z.object({ taskId: TaskId })
export const TaskStateGetOutput = z.object({
  state: TaskState,
  history: z.array(StateTransition),
})

// 11. task_state_propose
export const ProposeEvidence = z.object({
  artifacts: z.array(ArtifactId).default([]),
  note: z.string().optional(),
})
export const TaskStateProposeInput = z.object({
  taskId: TaskId,
  targetState: TaskState,
  evidence: ProposeEvidence,
})
export const TaskStateProposeOutput = z.object({
  accepted: z.boolean(),
  newState: TaskState.optional(),
  reason: z.string().optional(),
})

// 12. task_write（受控文件写入：FIFO + 角色校验）
export const TaskWriteInput = z.object({
  taskId: TaskId,
  path: RelPath,
  content: z.string(),
  overwrite: z.boolean().default(false),
})
export const TaskWriteOutput = z.object({
  success: z.boolean(),
  bytesWritten: z.number().int().nonnegative().optional(),
  reason: z.string().optional(),
})

// 13. context_log（at-hook 内部调用）
export const ContextLogInput = z.object({
  taskId: TaskId,
  agentId: AgentId,
  action: ContextAction,
  ref: z.string(),
  ts: z.string(),
})
export const ContextLogOutput = z.object({ ok: z.boolean() })

// 14. task_resource_get — planner/engineer/qa/ci 查询 bootstrap resources（task-bootstrap-lifecycle 1.4）
export const TaskResourceGetInput = z.object({
  taskId: TaskId,
  /** 指定 resource id 时只返回该 resource；否则返回 task 全部 bootstrap resources */
  resourceId: z.string().min(1).optional(),
})
export const TaskResourceGetOutput = z.object({
  resources: z.array(TaskBootstrapResource),
})

/**
 * 工具名 → {input, output} 注册表。后端用它批量注册到 @modelcontextprotocol/sdk，
 * 前端/测试用它做静态校验。键即 MCP 工具名。
 */
export const McpTools = {
  chatroom_send: { input: ChatroomSendInput, output: ChatroomSendOutput },
  chatroom_listen: { input: ChatroomListenInput, output: ChatroomListenOutput },
  chatroom_recent: { input: ChatroomRecentInput, output: ChatroomRecentOutput },
  artifact_register: { input: ArtifactRegisterInput, output: ArtifactRegisterOutput },
  artifact_list: { input: ArtifactListInput, output: ArtifactListOutput },
  artifact_get: { input: ArtifactGetInput, output: ArtifactGetOutput },
  seat_create: { input: SeatCreateInput, output: SeatCreateOutput },
  seat_list: { input: SeatListInput, output: SeatListOutput },
  seat_status_get: { input: SeatStatusGetInput, output: SeatStatusGetOutput },
  task_state_get: { input: TaskStateGetInput, output: TaskStateGetOutput },
  task_state_propose: { input: TaskStateProposeInput, output: TaskStateProposeOutput },
  task_write: { input: TaskWriteInput, output: TaskWriteOutput },
  context_log: { input: ContextLogInput, output: ContextLogOutput },
  task_resource_get: { input: TaskResourceGetInput, output: TaskResourceGetOutput },
} as const

export type McpToolName = keyof typeof McpTools
export const MCP_TOOL_NAMES = Object.keys(McpTools) as McpToolName[]
