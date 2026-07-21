import { z } from 'zod'
import { AgentLifecycle, FactoryRole, RuntimeProvider } from './enums.js'

/**
 * 单个 MCP server 声明（注入 agent 的 mcp.json）。
 */
export const McpServerDecl = z.object({
  name: z.string().min(1),
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  env: z.record(z.string(), z.string()).optional(),
})
export type McpServerDecl = z.infer<typeof McpServerDecl>

/** agent 模型配置。可挂在 factory 默认，也可被 SeatSpec 按任务覆盖。*/
export const AgentModelProfile = z.object({
  provider: RuntimeProvider,
  /** provider 原生模型名，如 Codex 的 gpt-5.5 / Claude 的 sonnet 系列。*/
  model: z.string().min(1).optional(),
  /** provider CLI/bridge 二进制覆盖，如 codex/claude-code-acp 的绝对路径。*/
  cliBinary: z.string().min(1).optional(),
  /** Codex 等 provider 支持的推理强度；不支持的 provider 可忽略。*/
  reasoningEffort: z.enum(['minimal', 'low', 'medium', 'high', 'xhigh']).optional(),
})
export type AgentModelProfile = z.infer<typeof AgentModelProfile>

/** 本机模型 provider discovery 结果（server 同机检测，只读展示）。*/
export const LocalProviderStatus = z.object({
  provider: RuntimeProvider,
  available: z.boolean(),
  models: z.array(z.string().min(1)).default([]),
  reason: z.string().min(1).optional(),
})
export type LocalProviderStatus = z.infer<typeof LocalProviderStatus>

export const ListLocalProvidersResponse = z.array(LocalProviderStatus)
export type ListLocalProvidersResponse = z.infer<typeof ListLocalProvidersResponse>

/**
 * 工厂定义（factory-system spec）。
 * 配置权三层：core（必装，用户不可删）/ recommended（工厂默认，用户可改）/
 * task-level mcpInjections（planner 按任务注入，见 SeatSpec）。
 */
export const Factory = z.object({
  name: FactoryRole,
  version: z.number().int().positive(),
  persona: z.string().min(1),
  systemPromptTemplate: z.string().min(1),
  /**
   * 系统层指令(对用户不可见,工厂管理 UI 不暴露)。渲染进 system prompt 最前、最高优先级。
   * 不设置时用 DEFAULT_SYSTEM_DIRECTIVE(推进本能契约)。各 factory 可覆盖做 per-role 强化。
   * phase-driven-orchestration: factory-system "Factory.systemDirective 系统层指令"
   */
  systemDirective: z.string().optional(),
  defaultNamePool: z.array(z.string().min(1)).min(1),
  /** 架构必装，典型仅 chatroom-mcp，前端锁定不可删 */
  coreMcps: z.array(McpServerDecl).min(1),
  lifecycle: AgentLifecycle,
  // --- 以下为可选推荐项（用户可在工厂管理页增删）---
  recommendedSkills: z.array(z.string()).default([]),
  recommendedCliTools: z.array(z.string()).default([]),
  recommendedMcps: z.array(McpServerDecl).default([]),
  /** 工厂默认模型配置；spawn 到 agent 时锁定，可被 seat/task 覆盖。*/
  preferredModelProfile: AgentModelProfile.optional(),
  /** 工厂模型配置 fallback，有序尝试；仅在 primary provider 不可用或 provider availability failure 时使用。*/
  fallbackModelProfiles: z.array(AgentModelProfile).default([]),
  /** 工厂默认 computer（执行基底 id）；可被 seat.computer 覆盖。默认 'local'。*/
  preferredComputer: z.string().min(1).optional(),
  defaultPermissions: z
    .object({
      /** 该工厂可提议的状态转移集，如 ["S1->S2"] */
      proposeTransitions: z.array(z.string()).default([]),
    })
    .default({ proposeTransitions: [] }),
  workingHabits: z.array(z.string()).default([]),
  deliverables: z.array(z.string()).default([]),
})
export type Factory = z.infer<typeof Factory>
