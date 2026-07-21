import { z } from 'zod'
import { TaskId, Timestamp } from './common.js'

/**
 * Task bootstrap 协议 — orchestrator 启动 task 时准备 worktree / 依赖 / 隔离分支。
 * 详见 openspec/changes/task-bootstrap-lifecycle/specs/task-bootstrap/spec.md。
 */

export const BootstrapProvider = z.enum(['none', 'generic-pnpm', 'sw', 'generic'])
export type BootstrapProvider = z.infer<typeof BootstrapProvider>

export const BootstrapMode = z.enum(['lean', 'full'])
export type BootstrapMode = z.infer<typeof BootstrapMode>

export const BootstrapResourceKind = z.enum(['worktree'])
export type BootstrapResourceKind = z.infer<typeof BootstrapResourceKind>

/**
 * resource 状态枚举:
 * - creating/ready/failed = 启动期生命周期
 * - retained/removed/archived/needs-review = release 终态
 */
export const BootstrapResourceStatus = z.enum([
  'creating',
  'ready',
  'failed',
  'retained',
  'removed',
  'archived',
  'needs-review',
])
export type BootstrapResourceStatus = z.infer<typeof BootstrapResourceStatus>

export const BootstrapResourceTerminalStatus = z.enum([
  'retained',
  'removed',
  'archived',
  'needs-review',
])
export type BootstrapResourceTerminalStatus = z.infer<typeof BootstrapResourceTerminalStatus>

/**
 * release 策略:决定 releasing 阶段 worktree 终态如何选择。
 * - retain:总是保留(终态 'retained',不删 worktree)
 * - remove-if-clean:工作树无未提交改动 + 分支已合 / safe → 'removed';否则 'retained'(默认)
 * - prompt:provider 不自决,返回 'needs-review' 让 planner chatroom 问用户
 * - archive:打 tag/snapshot 后允许删 → 'archived'(sw 第一版未实现 → 退到 'needs-review')
 */
export const BootstrapReleasePolicy = z.enum(['retain', 'remove-if-clean', 'prompt', 'archive'])
export type BootstrapReleasePolicy = z.infer<typeof BootstrapReleasePolicy>

/** 项目/仓库级本地持久化默认配置 (~/.agent-team/projects/<id>/bootstrap.yaml)
 *  注:仓库根路径走 indexDb projects.repo_path,不在这里冗余。 */
export const TaskBootstrapConfig = z.object({
  provider: BootstrapProvider,
  mode: BootstrapMode.optional(),
  release: BootstrapReleasePolicy.default('remove-if-clean'),
  /** provider 特有参数(例如 sw 的 base ref / generic-pnpm 的 reuse 策略)*/
  options: z.record(z.unknown()).default({}),
})
export type TaskBootstrapConfig = z.infer<typeof TaskBootstrapConfig>

export const TaskBootstrapResource = z.object({
  id: z.string().min(1),
  taskId: TaskId,
  kind: BootstrapResourceKind,
  status: BootstrapResourceStatus,
  provider: BootstrapProvider,
  mode: BootstrapMode.optional(),
  path: z.string().optional(),
  branch: z.string().optional(),
  baseRef: z.string().optional(),
  summary: z.string().optional(),
  error: z.string().optional(),
  attempts: z.number().int().nonnegative().default(0),
  createdAt: Timestamp,
  updatedAt: Timestamp,
})
export type TaskBootstrapResource = z.infer<typeof TaskBootstrapResource>

/** task create response 中带的 bootstrap 初始化摘要 */
export const TaskBootstrapInit = z.object({
  config: TaskBootstrapConfig,
  /** orchestrator 是否启动了 prepare(none 时为 false)*/
  started: z.boolean(),
  /** 初始 resource 快照(creating 状态)*/
  resource: TaskBootstrapResource.optional(),
})
export type TaskBootstrapInit = z.infer<typeof TaskBootstrapInit>
