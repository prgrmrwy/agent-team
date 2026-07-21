import { z } from 'zod'
import { TaskBootstrapConfig } from './bootstrap.js'
import { ProjectId, TaskId, Timestamp } from './common.js'
import { TaskState } from './enums.js'

/** 上下文链接（S0 表单要求至少 1 条）*/
export const ContextLink = z.object({
  url: z.string().url(),
  label: z.string().optional(),
})
export type ContextLink = z.infer<typeof ContextLink>

/** 状态机历史的一条记录 */
export const StateTransition = z.object({
  from: TaskState,
  to: TaskState,
  at: Timestamp,
  /** 触发事件（design.md D14 transition table 的 event 名）*/
  event: z.string(),
  /** 触发者：agentId 或 'human' 或 'system' */
  by: z.string(),
})
export type StateTransition = z.infer<typeof StateTransition>

export const Task = z.object({
  id: TaskId,
  projectId: ProjectId,
  title: z.string().min(1),
  description: z.string().min(1),
  /** 上下文链接(M3 起改为可选,planner 多轮交互里自取;旧 API 仍可传)*/
  contextLinks: z.array(ContextLink).default([]),
  state: TaskState,
  history: z.array(StateTransition).default([]),
  /** 防静默:任务卡住标志(phase-driven-orchestration)。sidebar 高亮用。*/
  stalled: z.boolean().default(false),
  stalledReason: z.string().optional(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
})
export type Task = z.infer<typeof Task>

/**
 * 创建任务的输入(S0 表单提交,server 生成 id/state/时间戳)。
 *
 * M3 调整:**只要求 description 非空**,其他都可选:
 * - title:不传时 server 从 description 推断(前 60 字符)
 * - projectId:不传时默认 `default`
 * - contextLinks:不强制(planner 多轮交互里再问)
 *
 * Codex 风的"想到啥写啥就发"流程要求最低门槛。
 */
export const CreateTaskInput = z.object({
  projectId: ProjectId.optional(),
  title: z.string().min(1).optional(),
  description: z.string().min(1, '描述不能为空'),
  contextLinks: z.array(ContextLink).default([]),
  /** 显式覆盖项目默认 bootstrap 配置（未传时 server 从项目本地 yaml 解析）*/
  bootstrap: TaskBootstrapConfig.optional(),
})
export type CreateTaskInput = z.infer<typeof CreateTaskInput>
