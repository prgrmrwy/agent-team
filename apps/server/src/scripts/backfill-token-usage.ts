import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'
import { openIndexDb, openTaskDb, type DbClient } from '../db/index.js'
import { insertTokenUsageEvent } from '../db/token-usage-repo.js'
import { newTokenUsageId } from '../util/id.js'
import { normalizeClaudeUsage, normalizeCodexUsage } from '../process/token-usage-normalizer.js'
import { parseAgentTeamCwd } from '../process/usage-importers.js'

interface BackfillResult {
  files: number
  scanned: number
  imported: number
  skipped: number
}

interface TaskAttribution {
  projectId: string
  taskId: string
  agentId: string
}

const dataHome = process.env['DATA_HOME'] ?? path.join(os.homedir(), '.agent-team')
const indexDb = openIndexDb(path.join(dataHome, 'index.db'))
const taskDbs = new Map<string, DbClient>()

try {
  const claude = await backfillClaude()
  const codex = await backfillCodex()
  console.log(
    JSON.stringify(
      {
        dataHome,
        claude,
        codex,
        total: {
          files: claude.files + codex.files,
          scanned: claude.scanned + codex.scanned,
          imported: claude.imported + codex.imported,
          skipped: claude.skipped + codex.skipped,
        },
      },
      null,
      2,
    ),
  )
} finally {
  for (const db of taskDbs.values()) db.close()
  indexDb.close()
}

async function backfillClaude(): Promise<BackfillResult> {
  const roots = [path.join(os.homedir(), '.claude', 'projects')]
  const files = roots.flatMap(findJsonlFiles)
  const result: BackfillResult = { files: files.length, scanned: 0, imported: 0, skipped: 0 }
  const seen = new Set<string>()

  for (const file of files) {
    const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity })
    for await (const line of rl) {
      if (!line.trim()) continue
      result.scanned += 1
      const parsed = parseLine(line)
      if (!parsed) {
        result.skipped += 1
        continue
      }
      const cwd = typeof parsed['cwd'] === 'string' ? parsed['cwd'] : ''
      const attribution = parseAgentTeamCwd(cwd)
      if (!attribution) {
        result.skipped += 1
        continue
      }
      const usage = normalizeClaudeUsage(parsed)
      if (!usage) {
        result.skipped += 1
        continue
      }
      const taskDb = getTaskDb(attribution.projectId, attribution.taskId)
      if (!taskDb) {
        result.skipped += 1
        continue
      }
      const dedupeKey =
        usage.externalRequestId ??
        `${parsed['sessionId'] ?? 'unknown'}:${messageId(parsed) ?? parsed['timestamp'] ?? line.length}`
      if (seen.has(`claude:${dedupeKey}`)) {
        result.skipped += 1
        continue
      }
      seen.add(`claude:${dedupeKey}`)
      const inserted = insertTokenUsageEvent(taskDb, {
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

async function backfillCodex(): Promise<BackfillResult> {
  const roots = [
    path.join(os.homedir(), '.codex', 'archived_sessions'),
    path.join(os.homedir(), '.codex', 'sessions'),
  ]
  const files = roots.flatMap(findJsonlFiles)
  const result: BackfillResult = { files: files.length, scanned: 0, imported: 0, skipped: 0 }

  for (const file of files) {
    let currentAttribution: TaskAttribution | null = null
    let currentSessionId: string | undefined
    let currentModel: string | undefined
    const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity })
    for await (const line of rl) {
      if (!line.trim()) continue
      result.scanned += 1
      const parsed = parseLine(line)
      if (!parsed) {
        result.skipped += 1
        continue
      }
      const payload = asRecord(parsed['payload'])
      const context =
        payload && (parsed['type'] === 'session_meta' || parsed['type'] === 'turn_context')
          ? payload
          : null
      const cwd = typeof context?.['cwd'] === 'string' ? context['cwd'] : undefined
      if (cwd) {
        currentAttribution = parseAgentTeamCwd(cwd)
        currentSessionId = stringOf(context?.['session_id'] ?? context?.['id']) ?? currentSessionId
        currentModel = stringOf(context?.['model']) ?? currentModel
        if (!currentAttribution) result.skipped += 1
        continue
      }
      if (payload?.['type'] !== 'token_count') {
        result.skipped += 1
        continue
      }
      if (!currentAttribution) {
        result.skipped += 1
        continue
      }
      const info = asRecord(payload['info'])
      const usage = normalizeCodexUsage(info?.['last_token_usage'])
      if (!usage) {
        result.skipped += 1
        continue
      }
      const taskDb = getTaskDb(currentAttribution.projectId, currentAttribution.taskId)
      if (!taskDb) {
        result.skipped += 1
        continue
      }
      const inserted = insertTokenUsageEvent(taskDb, {
        id: newTokenUsageId(),
        taskId: currentAttribution.taskId,
        projectId: currentAttribution.projectId,
        agentId: currentAttribution.agentId,
        provider: 'codex-exec',
        model: usage.model ?? currentModel,
        sessionId: currentSessionId,
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

function getTaskDb(projectId: string, taskId: string): DbClient | null {
  const key = `${projectId}/${taskId}`
  const cached = taskDbs.get(key)
  if (cached) return cached
  const known = indexDb
    .prepare('SELECT id FROM tasks_meta WHERE id = ? AND project_id = ?')
    .get(taskId, projectId) as { id: string } | undefined
  if (!known) return null
  const taskDbPath = path.join(dataHome, 'projects', projectId, 'tasks', taskId, 'task.db')
  if (!fs.existsSync(taskDbPath)) return null
  const db = openTaskDb(taskDbPath)
  taskDbs.set(key, db)
  return db
}

function findJsonlFiles(root: string): string[] {
  if (!fs.existsSync(root)) return []
  const out: string[] = []
  const walk = (dir: string, depth: number): void => {
    if (depth > 8) return
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full, depth + 1)
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) out.push(full)
    }
  }
  walk(root, 0)
  return out
}

function parseLine(line: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(line)
    return asRecord(parsed)
  } catch {
    return null
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function messageId(record: Record<string, unknown>): string | undefined {
  return stringOf(asRecord(record['message'])?.['id'])
}

function stringOf(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}
