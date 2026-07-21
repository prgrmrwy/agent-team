import { z } from 'zod'
import { AgentId, SeatId, TaskId, Timestamp } from './common.js'
import { AgentRunState, FactoryRole } from './enums.js'
import { AgentModelProfile, McpServerDecl } from './factory.js'

/**
 * task-plan 里 planner 声明的岗位计划项（factory-system spec：task-level 注入）。
 */
export const SeatSpec = z.object({
  role: z.string().min(1),
  factory: FactoryRole,
  count: z.number().int().positive().default(1),
  /** 该岗位的按需 MCP 注入（如 internal-cli），会 merge 进 coreMcps + recommendedMcps */
  mcpInjections: z.array(McpServerDecl).default([]),
  /** worktree 写分工（planner 预编排，防代码竞态）；如 "src/auth/**" */
  fileScope: z.array(z.string()).default([]),
  /** 任务级模型配置覆盖；优先级高于 factory.preferredModelProfile。*/
  modelOverride: AgentModelProfile.optional(),
  /** 该岗位 agent 运行在哪个 computer（执行基底 id）；优先级高于 factory.preferredComputer。默认 'local'。*/
  computer: z.string().min(1).optional(),
})
export type SeatSpec = z.infer<typeof SeatSpec>

/**
 * agent 实例（agent-runtime spec）。
 * id 形如 `<factory>-<task-short>-<n>`；displayName 从工厂 namePool 抽签的历史人物名。
 */
export const Agent = z.object({
  id: AgentId,
  taskId: TaskId,
  seatId: SeatId,
  factory: FactoryRole,
  displayName: z.string().min(1),
  state: AgentRunState,
  /** spawn 时锁定的工厂版本（快照写 factory.lock.yaml）*/
  factoryVersion: z.number().int().positive(),
  /** spawn 时实际使用的模型配置快照。*/
  modelProfile: AgentModelProfile.optional(),
  spawnedAt: Timestamp,
  terminatedAt: Timestamp.nullable().default(null),
})
export type Agent = z.infer<typeof Agent>
