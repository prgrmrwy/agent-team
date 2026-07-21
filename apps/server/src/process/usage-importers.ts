import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'
import type { DbClient } from '../db/client.js'
import { insertTokenUsageEvent } from '../db/token-usage-repo.js'
import { newTokenUsageId } from '../util/id.js'
import { normalizeClaudeUsage, normalizeCodexUsage } from './token-usage-normalizer.js'

export interface ImportResult {
  scanned: number
  imported: number
  skipped: number
}

export async function importClaudeTranscriptUsage(opts: {
  db: DbClient
  taskId?: string
  roots?: string[]
}): Promise<ImportResult> {
  const roots = opts.roots ?? [path.join(os.homedir(), '.claude', 'projects')]
  const files = roots.flatMap((root) => findJsonlFiles(root))
  const seen = new Set<string>()
  const result: ImportResult = { scanned: 0, imported: 0, skipped: 0 }
  for (const file of files) {
    const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity })
    for await (const line of rl) {
      if (!line.trim()) continue
      result.scanned += 1
      let parsed: Record<string, unknown>
      try {
        parsed = JSON.parse(line) as Record<string, unknown>
      } catch {
        result.skipped += 1
        continue
      }
      const cwd = typeof parsed['cwd'] === 'string' ? parsed['cwd'] : ''
      const attribution = parseAgentTeamCwd(cwd)
      if (!attribution || (opts.taskId && attribution.taskId !== opts.taskId)) {
        result.skipped += 1
        continue
      }
      const usage = normalizeClaudeUsage(parsed)
      if (!usage) {
        result.skipped += 1
        continue
      }
      const dedupeKey =
        usage.externalRequestId ??
        `${parsed['sessionId'] ?? 'unknown'}:${(parsed['message'] as { id?: string } | undefined)?.id ?? parsed['timestamp'] ?? line.length}`
      if (seen.has(dedupeKey)) {
        result.skipped += 1
        continue
      }
      seen.add(dedupeKey)
      const inserted = insertTokenUsageEvent(opts.db, {
        id: newTokenUsageId(),
        taskId: attribution.taskId,
        projectId: attribution.projectId,
        agentId: attribution.agentId,
        provider: 'claude-acp',
        model: usage.model,
        sessionId: typeof parsed['sessionId'] === 'string' ? parsed['sessionId'] : undefined,
        externalRequestId: usage.externalRequestId ?? dedupeKey,
        source: 'fallback-transcript',
        inputTokens: usage.inputTokens,
        cacheCreationTokens: usage.cacheCreationTokens,
        cacheReadTokens: usage.cacheReadTokens,
        outputTokens: usage.outputTokens,
        totalTokens: usage.totalTokens,
        rawUsage: usage.rawUsage,
        createdAt: typeof parsed['timestamp'] === 'string' ? parsed['timestamp'] : undefined,
      })
      if (inserted) result.imported += 1
      else result.skipped += 1
    }
  }
  return result
}

export async function importCodexTokenCountUsage(opts: {
  db: DbClient
  taskId: string
  agentId?: string
  roots?: string[]
}): Promise<ImportResult> {
  const roots = opts.roots ?? [path.join(os.homedir(), '.codex', 'archived_sessions')]
  const files = roots.flatMap((root) => findJsonlFiles(root))
  const result: ImportResult = { scanned: 0, imported: 0, skipped: 0 }
  for (const file of files) {
    const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity })
    for await (const line of rl) {
      if (!line.trim()) continue
      result.scanned += 1
      let parsed: Record<string, unknown>
      try {
        parsed = JSON.parse(line) as Record<string, unknown>
      } catch {
        result.skipped += 1
        continue
      }
      const payload = parsed['payload'] as Record<string, unknown> | undefined
      if (payload?.['type'] !== 'token_count') {
        result.skipped += 1
        continue
      }
      const info = payload['info'] as Record<string, unknown> | undefined
      const usage = normalizeCodexUsage(info?.['last_token_usage'])
      if (!usage) {
        result.skipped += 1
        continue
      }
      const inserted = insertTokenUsageEvent(opts.db, {
        id: newTokenUsageId(),
        taskId: opts.taskId,
        agentId: opts.agentId,
        provider: 'codex-exec',
        source: 'fallback-transcript',
        externalRequestId: `${path.basename(file)}:${parsed['timestamp'] ?? result.scanned}`,
        inputTokens: usage.inputTokens,
        cacheReadTokens: usage.cacheReadTokens,
        outputTokens: usage.outputTokens,
        reasoningTokens: usage.reasoningTokens,
        totalTokens: usage.totalTokens,
        rawUsage: usage.rawUsage,
        createdAt: typeof parsed['timestamp'] === 'string' ? parsed['timestamp'] : undefined,
      })
      if (inserted) result.imported += 1
      else result.skipped += 1
    }
  }
  return result
}

export function parseAgentTeamCwd(cwd: string): { projectId: string; taskId: string; agentId: string } | null {
  const match = cwd.match(/\/\.agent-team\/projects\/([^/]+)\/tasks\/([^/]+)\/agents\/([^/]+)/)
  if (!match) return null
  return { projectId: match[1]!, taskId: match[2]!, agentId: match[3]! }
}

function findJsonlFiles(root: string): string[] {
  if (!fs.existsSync(root)) return []
  const out: string[] = []
  const walk = (dir: string, depth: number): void => {
    if (depth > 6) return
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full, depth + 1)
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) out.push(full)
    }
  }
  walk(root, 0)
  return out
}
