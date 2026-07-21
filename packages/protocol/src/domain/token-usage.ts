import { z } from 'zod'
import { AgentId, ProjectId, SeatId, TaskId, Timestamp } from './common.js'
import { Channel, FactoryRole, RuntimeProvider } from './enums.js'

export const TokenUsageSource = z.enum([
  'runtime',
  'fallback-transcript',
  'chatroom-read',
  'chatroom-corpus',
])
export type TokenUsageSource = z.infer<typeof TokenUsageSource>

export const TokenUsageTotals = z.object({
  inputTokens: z.number().int().nonnegative().default(0),
  cacheCreationTokens: z.number().int().nonnegative().default(0),
  cacheReadTokens: z.number().int().nonnegative().default(0),
  outputTokens: z.number().int().nonnegative().default(0),
  reasoningTokens: z.number().int().nonnegative().default(0),
  totalTokens: z.number().int().nonnegative().default(0),
})
export type TokenUsageTotals = z.infer<typeof TokenUsageTotals>

export const TokenUsageEvent = TokenUsageTotals.extend({
  id: z.string().min(1),
  taskId: TaskId,
  projectId: ProjectId.optional(),
  agentId: AgentId.optional(),
  seatId: SeatId.optional(),
  factory: FactoryRole.optional(),
  provider: RuntimeProvider.optional(),
  model: z.string().min(1).optional(),
  sessionId: z.string().min(1).optional(),
  externalRequestId: z.string().min(1).optional(),
  source: TokenUsageSource,
  channel: Channel.optional(),
  rawUsage: z.unknown().optional(),
  createdAt: Timestamp,
})
export type TokenUsageEvent = z.infer<typeof TokenUsageEvent>

export const TokenUsageRankingItem = TokenUsageTotals.extend({
  id: z.string().min(1),
  label: z.string().min(1),
})
export type TokenUsageRankingItem = z.infer<typeof TokenUsageRankingItem>

export const UsageBreakdown = z.object({
  runtime: TokenUsageTotals,
  chatroomCorpus: TokenUsageTotals,
  chatroomRead: TokenUsageTotals,
})
export type UsageBreakdown = z.infer<typeof UsageBreakdown>

export const TaskUsageResponse = z.object({
  taskId: TaskId,
  totals: UsageBreakdown,
  agents: z.array(TokenUsageRankingItem).default([]),
})
export type TaskUsageResponse = z.infer<typeof TaskUsageResponse>

export const ProjectUsageResponse = z.object({
  projectId: ProjectId,
  runtime: TokenUsageTotals,
  tasks: z.array(TokenUsageRankingItem).default([]),
  factories: z.array(TokenUsageRankingItem).default([]),
})
export type ProjectUsageResponse = z.infer<typeof ProjectUsageResponse>

export const FactoryUsageResponse = z.object({
  factory: FactoryRole,
  runtime: TokenUsageTotals,
  tasks: z.array(TokenUsageRankingItem).default([]),
})
export type FactoryUsageResponse = z.infer<typeof FactoryUsageResponse>

export const AgentUsageResponse = z.object({
  taskId: TaskId,
  agentId: AgentId,
  runtime: TokenUsageTotals,
})
export type AgentUsageResponse = z.infer<typeof AgentUsageResponse>

/** 系统级 token usage 聚合(GET /usage)— 跨所有 project/task。 */
export const GlobalUsageResponse = z.object({
  runtime: TokenUsageTotals,
  tasks: z.array(TokenUsageRankingItem).default([]),
  factories: z.array(TokenUsageRankingItem).default([]),
})
export type GlobalUsageResponse = z.infer<typeof GlobalUsageResponse>

export function emptyTokenUsageTotals(): TokenUsageTotals {
  return {
    inputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
  }
}
