import type {
  AgentUsageResponse,
  FactoryUsageResponse,
  GlobalUsageResponse,
  ProjectUsageResponse,
  RuntimeProvider,
  TaskUsageResponse,
  TokenUsageRankingItem,
  TokenUsageSource,
  TokenUsageTotals,
} from '@agent-team/protocol'
import type { DbClient } from './client.js'
import { emptyTotals, estimateTextTokens, sumTotals, withComputedTotal } from '../util/token-usage.js'

export interface TokenUsageInsert {
  id: string
  taskId: string
  projectId?: string | null
  agentId?: string | null
  seatId?: string | null
  factory?: string | null
  provider?: RuntimeProvider | null
  model?: string | null
  sessionId?: string | null
  externalRequestId?: string | null
  source: TokenUsageSource
  channel?: string | null
  inputTokens?: number
  cacheCreationTokens?: number
  cacheReadTokens?: number
  outputTokens?: number
  reasoningTokens?: number
  totalTokens?: number
  rawUsage?: unknown
  createdAt?: string
}

interface TotalsRow {
  input_tokens: number | null
  cache_creation_tokens: number | null
  cache_read_tokens: number | null
  output_tokens: number | null
  reasoning_tokens: number | null
  total_tokens: number | null
}

interface RankingRow extends TotalsRow {
  id: string | null
  label: string | null
}

export function hasTokenUsageTable(db: DbClient): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='token_usage_events'")
    .get() as { name: string } | undefined
  return Boolean(row)
}

export function insertTokenUsageEvent(db: DbClient, input: TokenUsageInsert): boolean {
  if (!hasTokenUsageTable(db)) return false
  const totals = withComputedTotal({
    inputTokens: input.inputTokens,
    cacheCreationTokens: input.cacheCreationTokens,
    cacheReadTokens: input.cacheReadTokens,
    outputTokens: input.outputTokens,
    reasoningTokens: input.reasoningTokens,
    totalTokens: input.totalTokens,
  })
  const info = db.prepare(
    `INSERT OR IGNORE INTO token_usage_events (
      id, task_id, project_id, agent_id, seat_id, factory, provider, model, session_id,
      external_request_id, source, channel, input_tokens, cache_creation_tokens,
      cache_read_tokens, output_tokens, reasoning_tokens, total_tokens, raw_usage_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.id,
    input.taskId,
    input.projectId ?? null,
    input.agentId ?? null,
    input.seatId ?? null,
    input.factory ?? null,
    input.provider ?? null,
    input.model ?? null,
    input.sessionId ?? null,
    input.externalRequestId ?? null,
    input.source,
    input.channel ?? null,
    totals.inputTokens,
    totals.cacheCreationTokens,
    totals.cacheReadTokens,
    totals.outputTokens,
    totals.reasoningTokens,
    totals.totalTokens,
    input.rawUsage === undefined ? null : JSON.stringify(input.rawUsage),
    input.createdAt ?? new Date().toISOString(),
  )
  return info.changes > 0
}

export function getTaskUsage(db: DbClient, taskId: string): TaskUsageResponse {
  if (!hasTokenUsageTable(db)) {
    return {
      taskId,
      totals: { runtime: emptyTotals(), chatroomCorpus: emptyTotals(), chatroomRead: emptyTotals() },
      agents: [],
    }
  }
  const runtime = sumRuntimeUsage(db, taskId)
  const chatroomCorpus = computeChatroomCorpus(db, taskId)
  const chatroomRead = sumBySource(db, taskId, 'chatroom-read')
  return {
    taskId,
    totals: { runtime, chatroomCorpus, chatroomRead },
    agents: rankingByAgent(db, taskId),
  }
}

export function getAgentUsage(db: DbClient, taskId: string, agentId: string): AgentUsageResponse {
  if (!hasTokenUsageTable(db)) return { taskId, agentId, runtime: emptyTotals() }
  const row = db
    .prepare(
      `SELECT
        SUM(input_tokens) input_tokens,
        SUM(cache_creation_tokens) cache_creation_tokens,
        SUM(cache_read_tokens) cache_read_tokens,
        SUM(output_tokens) output_tokens,
        SUM(reasoning_tokens) reasoning_tokens,
        SUM(total_tokens) total_tokens
       FROM token_usage_events
       WHERE task_id = ? AND agent_id = ? AND source IN ('runtime', 'fallback-transcript')`,
    )
    .get(taskId, agentId) as TotalsRow | undefined
  return { taskId, agentId, runtime: rowToTotals(row) }
}

export function aggregateProjectUsage(
  projectId: string,
  taskDbs: Array<{ taskId: string; db: DbClient }>,
): ProjectUsageResponse {
  const runtimeTotals: TokenUsageTotals[] = []
  const taskItems: TokenUsageRankingItem[] = []
  const factoryTotals = new Map<string, TokenUsageTotals>()
  for (const { taskId, db } of taskDbs) {
    if (!hasTokenUsageTable(db)) continue
    const taskTotal = sumRuntimeUsage(db, taskId)
    runtimeTotals.push(taskTotal)
    taskItems.push({ id: taskId, label: taskId, ...taskTotal })
    for (const item of rankingByFactory(db, taskId)) {
      factoryTotals.set(item.id, sumTotals(factoryTotals.get(item.id) ?? emptyTotals(), item))
    }
  }
  return {
    projectId,
    runtime: sumTotals(...runtimeTotals),
    tasks: sortRanking(taskItems),
    factories: sortRanking(
      Array.from(factoryTotals.entries()).map(([id, totals]) => ({ id, label: id, ...totals })),
    ),
  }
}

/**
 * 系统级 token usage 聚合 — 跨所有 project/task。
 * 0 token 的 task / factory 不进 ranking;tasks 用 task.title 作 label(回退到 taskId);
 * tasks / factories 各 top 10 desc。
 */
export function aggregateGlobalUsage(
  taskDbs: Array<{ taskId: string; title?: string; db: DbClient }>,
): GlobalUsageResponse {
  const runtimeTotals: TokenUsageTotals[] = []
  const taskItems: TokenUsageRankingItem[] = []
  const factoryTotals = new Map<string, TokenUsageTotals>()
  for (const { taskId, title, db } of taskDbs) {
    if (!hasTokenUsageTable(db)) continue
    const taskTotal = sumRuntimeUsage(db, taskId)
    runtimeTotals.push(taskTotal)
    if (taskTotal.totalTokens > 0) {
      taskItems.push({ id: taskId, label: title ?? taskId, ...taskTotal })
    }
    for (const item of rankingByFactory(db, taskId)) {
      factoryTotals.set(item.id, sumTotals(factoryTotals.get(item.id) ?? emptyTotals(), item))
    }
  }
  return {
    runtime: sumTotals(...runtimeTotals),
    tasks: sortRanking(taskItems).slice(0, 10),
    factories: sortRanking(
      Array.from(factoryTotals.entries())
        .filter(([, t]) => t.totalTokens > 0)
        .map(([id, t]) => ({ id, label: id, ...t })),
    ).slice(0, 10),
  }
}

export function aggregateFactoryUsage(
  factory: string,
  taskDbs: Array<{ taskId: string; title?: string; db: DbClient }>,
): FactoryUsageResponse {
  const taskItems: TokenUsageRankingItem[] = []
  for (const { taskId, title, db } of taskDbs) {
    if (!hasTokenUsageTable(db)) continue
    const row = db
      .prepare(
        `SELECT
          SUM(input_tokens) input_tokens,
          SUM(cache_creation_tokens) cache_creation_tokens,
          SUM(cache_read_tokens) cache_read_tokens,
          SUM(output_tokens) output_tokens,
          SUM(reasoning_tokens) reasoning_tokens,
          SUM(total_tokens) total_tokens
         FROM token_usage_events e
         LEFT JOIN agents a ON a.id = e.agent_id
         WHERE e.task_id = ?
           AND COALESCE(e.factory, a.factory) = ?
           AND e.source IN ('runtime', 'fallback-transcript')`,
      )
      .get(taskId, factory) as TotalsRow | undefined
    const totals = rowToTotals(row)
    if (totals.totalTokens > 0) {
      taskItems.push({ id: taskId, label: title ?? taskId, ...totals })
    }
  }
  const sortedTasks = sortRanking(taskItems)
  return {
    factory: factory as FactoryUsageResponse['factory'],
    runtime: sumTotals(...sortedTasks),
    tasks: sortedTasks.slice(0, 10),
  }
}

function sumBySource(db: DbClient, taskId: string, source: TokenUsageSource): TokenUsageTotals {
  const row = db
    .prepare(
      `SELECT
        SUM(input_tokens) input_tokens,
        SUM(cache_creation_tokens) cache_creation_tokens,
        SUM(cache_read_tokens) cache_read_tokens,
        SUM(output_tokens) output_tokens,
        SUM(reasoning_tokens) reasoning_tokens,
        SUM(total_tokens) total_tokens
       FROM token_usage_events
       WHERE task_id = ? AND source = ?`,
    )
    .get(taskId, source) as TotalsRow | undefined
  return rowToTotals(row)
}

function sumRuntimeUsage(db: DbClient, taskId: string): TokenUsageTotals {
  const row = db
    .prepare(
      `SELECT
        SUM(input_tokens) input_tokens,
        SUM(cache_creation_tokens) cache_creation_tokens,
        SUM(cache_read_tokens) cache_read_tokens,
        SUM(output_tokens) output_tokens,
        SUM(reasoning_tokens) reasoning_tokens,
        SUM(total_tokens) total_tokens
       FROM token_usage_events
       WHERE task_id = ? AND source IN ('runtime', 'fallback-transcript')`,
    )
    .get(taskId) as TotalsRow | undefined
  return rowToTotals(row)
}

function rankingByAgent(db: DbClient, taskId: string): TokenUsageRankingItem[] {
  const rows = db
    .prepare(
      `SELECT
        COALESCE(agent_id, 'unknown-agent') id,
        COALESCE(agent_id, 'unknown-agent') label,
        SUM(input_tokens) input_tokens,
        SUM(cache_creation_tokens) cache_creation_tokens,
        SUM(cache_read_tokens) cache_read_tokens,
        SUM(output_tokens) output_tokens,
        SUM(reasoning_tokens) reasoning_tokens,
        SUM(total_tokens) total_tokens
       FROM token_usage_events
       WHERE task_id = ? AND source IN ('runtime', 'fallback-transcript', 'chatroom-read')
       GROUP BY COALESCE(agent_id, 'unknown-agent')`,
    )
    .all(taskId) as RankingRow[]
  return sortRanking(rows.map(rowToRankingItem))
}

function rankingByFactory(db: DbClient, taskId: string): TokenUsageRankingItem[] {
  const rows = db
    .prepare(
      `SELECT
        COALESCE(e.factory, a.factory, 'unknown') id,
        COALESCE(e.factory, a.factory, 'unknown') label,
        SUM(input_tokens) input_tokens,
        SUM(cache_creation_tokens) cache_creation_tokens,
        SUM(cache_read_tokens) cache_read_tokens,
        SUM(output_tokens) output_tokens,
        SUM(reasoning_tokens) reasoning_tokens,
        SUM(total_tokens) total_tokens
       FROM token_usage_events e
       LEFT JOIN agents a ON a.id = e.agent_id
       WHERE e.task_id = ? AND e.source IN ('runtime', 'fallback-transcript')
       GROUP BY COALESCE(e.factory, a.factory, 'unknown')`,
    )
    .all(taskId) as RankingRow[]
  return sortRanking(rows.map(rowToRankingItem))
}

function computeChatroomCorpus(db: DbClient, taskId: string): TokenUsageTotals {
  const hasMessages = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='chatroom_messages'")
    .get() as { name: string } | undefined
  if (!hasMessages) return emptyTotals()
  const rows = db
    .prepare('SELECT content FROM chatroom_messages WHERE task_id = ?')
    .all(taskId) as { content: string }[]
  return withComputedTotal({
    totalTokens: rows.reduce((sum, row) => sum + estimateTextTokens(row.content), 0),
  })
}

function rowToTotals(row?: TotalsRow): TokenUsageTotals {
  return {
    inputTokens: row?.input_tokens ?? 0,
    cacheCreationTokens: row?.cache_creation_tokens ?? 0,
    cacheReadTokens: row?.cache_read_tokens ?? 0,
    outputTokens: row?.output_tokens ?? 0,
    reasoningTokens: row?.reasoning_tokens ?? 0,
    totalTokens: row?.total_tokens ?? 0,
  }
}

function rowToRankingItem(row: RankingRow): TokenUsageRankingItem {
  return {
    id: row.id ?? 'unknown',
    label: row.label ?? row.id ?? 'unknown',
    ...rowToTotals(row),
  }
}

function sortRanking<T extends TokenUsageRankingItem>(items: T[]): T[] {
  return [...items].sort((a, b) => b.totalTokens - a.totalTokens || a.label.localeCompare(b.label))
}
