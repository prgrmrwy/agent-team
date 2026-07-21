import type { RuntimeDoneEvent, RuntimeProvider } from '../adapters/cli/cli-adapter.js'
import type { DbClient } from '../db/client.js'
import { insertTokenUsageEvent } from '../db/token-usage-repo.js'
import { newTokenUsageId } from '../util/id.js'
import { normalizeCodexUsage } from './token-usage-normalizer.js'

export function persistRuntimeDoneUsage(opts: {
  db: DbClient
  taskId: string
  projectId?: string | null
  agentId: string
  provider: RuntimeProvider
  event: RuntimeDoneEvent
}): boolean {
  if (!opts.event.usage) return false
  const usage =
    opts.provider === 'codex-sdk' || opts.provider === 'codex-exec'
      ? normalizeCodexUsage(opts.event.usage)
      : null
  if (!usage) return false
  const row = opts.db
    .prepare('SELECT seat_id, factory, model_profile FROM agents WHERE id = ?')
    .get(opts.agentId) as { seat_id: string; factory: string; model_profile: string | null } | undefined
  let model = usage.model
  if (!model && row?.model_profile) {
    try {
      const profile = JSON.parse(row.model_profile) as { model?: string }
      model = profile.model
    } catch {
      // ignore malformed snapshot
    }
  }
  return insertTokenUsageEvent(opts.db, {
    id: newTokenUsageId(),
    taskId: opts.taskId,
    projectId: opts.projectId,
    agentId: opts.agentId,
    seatId: row?.seat_id,
    factory: row?.factory,
    provider: opts.provider,
    model,
    sessionId: opts.event.sessionId,
    source: 'runtime',
    inputTokens: usage.inputTokens,
    cacheCreationTokens: usage.cacheCreationTokens,
    cacheReadTokens: usage.cacheReadTokens,
    outputTokens: usage.outputTokens,
    reasoningTokens: usage.reasoningTokens,
    totalTokens: usage.totalTokens,
    rawUsage: opts.event.usage,
  })
}
