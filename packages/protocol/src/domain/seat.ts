import { z } from 'zod'
import { AgentId, SeatId, TaskId, Timestamp } from './common.js'
import { FactoryRole, SeatStatus } from './enums.js'
import { AgentModelProfile } from './factory.js'

/**
 * 岗位：chatroom 中的一个位置（chatroom-protocol spec）。
 * planner 在 S1 出 seatPlan 时 seat_create 注册；crash 时 agent 换、岗位留。
 */
export const Seat = z.object({
  id: SeatId,
  taskId: TaskId,
  /** 展示名，如 "Engineer #1" */
  role: z.string().min(1),
  factory: FactoryRole,
  status: SeatStatus,
  /** 当前占据该岗位的 agent 实例（vacant 时为 null）*/
  currentAgentId: AgentId.nullable().default(null),
  /** offline/vacant 时积压的待回放消息 id */
  queue: z.array(z.string()).default([]),
  /** 该岗位的模型配置覆盖，spawn agent 时优先于 factory.preferredModelProfile。*/
  modelOverride: AgentModelProfile.optional(),
  createdAt: Timestamp,
})
export type Seat = z.infer<typeof Seat>
