import { Router } from 'express'
import type { Request, Response } from 'express'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  CreateTaskRequest,
  TaskBootstrapResource,
  isUrgentSystemEvent,
  urgentKeyForContent,
} from '@agent-team/protocol'
import type {
  Message,
  TaskBootstrapResource as TaskBootstrapResourceT,
  TaskBootstrapConfig,
} from '@agent-team/protocol'
import { newTaskId } from '../../util/id.js'
import { getConfig } from '../../config/index.js'
import { resolveBootstrapConfig } from '../../config/bootstrap-config.js'
import type { DbClient } from '../../db/client.js'
import type { Logger } from '../../util/logger.js'
import type { TaskProcessLauncher } from '../../process/task-process-launcher.js'
import { getAgentUsage, getTaskUsage } from '../../db/token-usage-repo.js'

export type StartBootstrap = (opts: {
  taskId: string
  taskWorkdir: string
  taskDbPath: string
  projectId: string
}) => Promise<TaskBootstrapResourceT | null>

const __dirname = path.dirname(fileURLToPath(import.meta.url))

/** factoriesDir：apps/server/src/domain/factory/defaults 的绝对路径 */
const FACTORIES_DIR = path.resolve(__dirname, '../../domain/factory/defaults')
const TEXT_PREVIEW_LIMIT_BYTES = 256 * 1024

/** 从 description 推断 title:首行(剥前后空白),最长 60 字符,过长截断加省略号。 */
function deriveTitle(description: string): string {
  const firstLine =
    description
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line && !line.startsWith('[用户标的 skill hint')) ?? description.trim()
  if (firstLine.length <= 60) return firstLine
  return `${firstLine.slice(0, 57)}…`
}

function rollbackTaskCreate(indexDb: DbClient, taskId: string, taskWorkdir: string, log: Logger): void {
  try {
    indexDb.prepare('DELETE FROM tasks_meta WHERE id = ?').run(taskId)
    rmSync(taskWorkdir, { recursive: true, force: true })
  } catch (err) {
    log.warn({ err, taskId, taskWorkdir }, 'failed to rollback task create')
  }
}

function rowToMessage(r: Record<string, unknown>): Message {
  return {
    id: r['id'] as string,
    taskId: r['task_id'] as string,
    channel: r['channel'] as Message['channel'],
    type: r['type'] as Message['type'],
    sender: r['sender'] as string,
    content: r['content'] as string,
    mention: JSON.parse((r['mention'] as string) ?? '[]') as string[],
    refs: JSON.parse((r['refs'] as string) ?? '[]') as string[],
    replyTo: (r['reply_to'] as string | null) ?? null,
    urgentKey: (r['urgent_key'] as string | null) ?? null,
    acknowledgedAt: (r['acknowledged_at'] as string | null) ?? null,
    createdAt: r['created_at'] as string,
  }
}

function legacyAckIds(indexDb: DbClient, taskId: string): string[] {
  try {
    const rows = indexDb
      .prepare('SELECT message_id FROM urgent_acks WHERE task_id = ?')
      .all(taskId) as { message_id: string }[]
    return rows.map((r) => r.message_id)
  } catch {
    return []
  }
}

function ackUrgentMessage(db: DbClient, taskId: string, identifier: string, acknowledgedAt: string): string[] {
  const rows = db
    .prepare(
      `SELECT id, content, urgent_key
         FROM chatroom_messages
        WHERE task_id = ? AND type = 'system-event'`,
    )
    .all(taskId) as { id: string; content: string; urgent_key: string | null }[]
  const target = rows.find((row) => {
    if (row.id === identifier || row.urgent_key === identifier) return true
    return isUrgentSystemEvent(row.content) && urgentKeyForContent(row.content) === identifier
  })
  if (!target) return []

  const stableKey =
    target.urgent_key ?? (isUrgentSystemEvent(target.content) ? urgentKeyForContent(target.content) : null)
  const matched = rows.filter((row) => {
    if (row.id === target.id) return true
    if (stableKey && row.urgent_key === stableKey) return true
    return stableKey != null && isUrgentSystemEvent(row.content) && urgentKeyForContent(row.content) === stableKey
  })
  const update = db.prepare(
    `UPDATE chatroom_messages
        SET urgent_key = COALESCE(urgent_key, ?),
            acknowledged_at = COALESCE(acknowledged_at, ?)
      WHERE id = ?`,
  )
  const tx = db.transaction(() => {
    for (const row of matched) update.run(stableKey, acknowledgedAt, row.id)
  })
  tx()
  return matched.flatMap((row) => (stableKey ? [row.id, stableKey] : [row.id]))
}

function taskWorkdirFor(indexDb: DbClient, taskId: string): string | null {
  const row = indexDb.prepare('SELECT project_id FROM tasks_meta WHERE id = ?').get(taskId) as
    | { project_id: string }
    | undefined
  if (!row) return null
  const config = getConfig()
  return path.join(config.dataHome, 'projects', row.project_id, 'tasks', taskId)
}

function primaryWorktreePath(db: DbClient | null | undefined): string | null {
  if (!db) return null
  try {
    const row = db
      .prepare(
        `SELECT path
           FROM bootstrap_resources
          WHERE id = 'primary-worktree' AND status = 'ready' AND path IS NOT NULL
          LIMIT 1`,
      )
      .get() as { path: string | null } | undefined
    return row?.path ?? null
  } catch {
    return null
  }
}

function resolveInsideRoot(root: string, relPath: string): string | null {
  const resolved = path.resolve(root, relPath || '.')
  const relative = path.relative(root, resolved)
  if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) return resolved
  return null
}

function resolveTaskFile(opts: {
  workspaceRoot: string
  worktreeRoot: string | null
  relPath: string
}): { absPath: string; root: 'workspace' | 'worktree' } | 'forbidden' | null {
  const roots: Array<{ root: 'workspace' | 'worktree'; path: string }> = [
    { root: 'workspace', path: opts.workspaceRoot },
    ...(opts.worktreeRoot ? [{ root: 'worktree' as const, path: opts.worktreeRoot }] : []),
  ]
  let sawForbidden = false
  for (const candidate of roots) {
    const resolved = resolveInsideRoot(candidate.path, opts.relPath)
    if (!resolved) {
      sawForbidden = true
      continue
    }
    if (!existsSync(resolved)) continue
    const stat = statSync(resolved)
    if (!stat.isFile()) continue
    return { absPath: resolved, root: candidate.root }
  }
  return sawForbidden ? 'forbidden' : null
}

function isLikelyBinary(buf: Buffer): boolean {
  return buf.includes(0)
}

function normalizeExt(absPath: string): string {
  return path.extname(absPath).replace(/^\./, '').toLowerCase()
}

function readdirWorkspace(absDir: string): Array<{ name: string; type: 'dir' | 'file' }> {
  const hiddenNoise = new Set(['task.db', 'task.db-shm', 'task.db-wal', 'chatroom.jsonl'])
  return readdirSync(absDir, { withFileTypes: true })
    .filter((entry) => !hiddenNoise.has(entry.name))
    .filter((entry) => entry.isDirectory() || entry.isFile())
    .map((entry) => ({ name: entry.name, type: entry.isDirectory() ? ('dir' as const) : ('file' as const) }))
    .sort((a, b) => {
      if (a.type !== b.type) return a.type === 'dir' ? -1 : 1
      return a.name.localeCompare(b.name)
    })
}

export function createTasksRouter(
  indexDb: DbClient,
  log: Logger,
  getLauncher?: () => TaskProcessLauncher | undefined,
  getTaskDb?: (taskId: string) => DbClient | null,
  startBootstrap?: StartBootstrap,
  ensureTaskProcess?: (taskId: string) => Promise<'ready' | 'launched' | 'unknown-task' | 'failed'>,
): Router {
  const router = Router()

  /** GET /tasks/:id/messages — 历史 chatroom 消息（读 per-task DB）*/
  router.get('/:id/messages', (req: Request, res: Response) => {
    const taskId = req.params['id'] as string
    const db = getTaskDb?.(taskId)
    if (!db) {
      res.json([])
      return
    }
    const after = typeof req.query['after'] === 'string' ? req.query['after'] : null
    const rawLimit = typeof req.query['limit'] === 'string' ? Number.parseInt(req.query['limit'], 10) : null
    const limit = rawLimit && Number.isFinite(rawLimit) ? Math.max(1, Math.min(rawLimit, 500)) : null
    const rows = after
      ? (db
          .prepare('SELECT * FROM chatroom_messages WHERE task_id = ? AND created_at > ? ORDER BY created_at')
          .all(taskId, after) as Record<string, unknown>[])
      : limit
        ? (db
            .prepare(
              `SELECT * FROM (
                 SELECT * FROM chatroom_messages
                  WHERE task_id = ?
                  ORDER BY created_at DESC
                  LIMIT ?
               ) ORDER BY created_at`,
            )
            .all(taskId, limit) as Record<string, unknown>[])
        : (db
            .prepare('SELECT * FROM chatroom_messages WHERE task_id = ? ORDER BY created_at')
            .all(taskId) as Record<string, unknown>[])
    res.json(rows.map(rowToMessage))
  })

  /** GET /tasks/:id/urgent-acks — legacy:人类已 ack 的 urgent system-event message id/key 列表 */
  router.get('/:id/urgent-acks', (req: Request, res: Response) => {
    const taskId = req.params['id'] as string
    const ids = new Set(legacyAckIds(indexDb, taskId))
    const db = getTaskDb?.(taskId)
    if (db) {
      const rows = db
        .prepare(
          `SELECT id, urgent_key
             FROM chatroom_messages
            WHERE task_id = ? AND acknowledged_at IS NOT NULL`,
        )
        .all(taskId) as { id: string; urgent_key: string | null }[]
      for (const row of rows) {
        ids.add(row.id)
        if (row.urgent_key) ids.add(row.urgent_key)
      }
    }
    res.json([...ids])
  })

  /** POST /tasks/:id/messages/:msgId/ack — 标记某条 urgent message 已读(我知道了) */
  router.post('/:id/messages/:msgId/ack', (req: Request, res: Response) => {
    const taskId = req.params['id'] as string
    const messageId = req.params['msgId'] as string
    const acknowledgedAt = new Date().toISOString()
    const db = getTaskDb?.(taskId)
    const ackedIds = db ? ackUrgentMessage(db, taskId, messageId, acknowledgedAt) : []
    try {
      const legacyIds = ackedIds.length > 0 ? ackedIds : [messageId]
      const insert = indexDb.prepare(
        `INSERT OR IGNORE INTO urgent_acks (task_id, message_id, acked_at)
         VALUES (?, ?, ?)`,
      )
      const tx = indexDb.transaction(() => {
        for (const id of legacyIds) insert.run(taskId, id, acknowledgedAt)
      })
      tx()
    } catch {
      // legacy table is best-effort; chatroom_messages is the source of truth.
    }
    res.json({ ok: true, acknowledgedAt, ids: ackedIds })
  })

  /** GET /tasks/:id/resources — bootstrap resources（读 per-task DB）*/
  router.get('/:id/resources', (req: Request, res: Response) => {
    const db = getTaskDb?.(req.params['id'] as string)
    if (!db) {
      res.json([])
      return
    }
    let rows: Record<string, unknown>[] = []
    try {
      rows = db
        .prepare('SELECT * FROM bootstrap_resources ORDER BY created_at')
        .all() as Record<string, unknown>[]
    } catch {
      // 早期 task 的 db 可能没有 bootstrap_resources 表(legacy);返回空 = 前端展示 unknown/legacy
      rows = []
    }
    res.json(
      rows.map((r) =>
        TaskBootstrapResource.parse({
          id: r['id'],
          taskId: r['task_id'],
          kind: r['kind'],
          status: r['status'],
          provider: r['provider'],
          mode: r['mode'] ?? undefined,
          path: r['path'] ?? undefined,
          branch: r['branch'] ?? undefined,
          baseRef: r['base_ref'] ?? undefined,
          summary: r['summary'] ?? undefined,
          error: r['error'] ?? undefined,
          attempts: r['attempts'] ?? 0,
          createdAt: r['created_at'],
          updatedAt: r['updated_at'],
        }),
      ),
    )
  })

  /** GET /tasks/:id/file?path=rel[&raw=1] — 预览 workspace/worktree 文件 */
  router.get('/:id/file', (req: Request, res: Response) => {
    const taskId = req.params['id'] as string
    const relPath = typeof req.query['path'] === 'string' ? req.query['path'] : ''
    if (!relPath) {
      res.status(400).json({ error: 'path required' })
      return
    }
    const workspaceRoot = taskWorkdirFor(indexDb, taskId)
    if (!workspaceRoot) {
      res.status(404).json({ error: 'task not found' })
      return
    }
    const db = getTaskDb?.(taskId)
    const hit = resolveTaskFile({
      workspaceRoot,
      worktreeRoot: primaryWorktreePath(db),
      relPath,
    })
    if (hit === 'forbidden') {
      res.status(403).json({ error: 'path outside workspace' })
      return
    }
    if (!hit) {
      res.status(404).json({ error: 'file not found' })
      return
    }

    const ext = normalizeExt(hit.absPath)
    if (req.query['raw'] === '1') {
      res.type(ext || 'application/octet-stream')
      res.send(readFileSync(hit.absPath))
      return
    }

    const buf = readFileSync(hit.absPath)
    const truncated = buf.length > TEXT_PREVIEW_LIMIT_BYTES
    const preview = truncated ? buf.subarray(0, TEXT_PREVIEW_LIMIT_BYTES) : buf
    if (isLikelyBinary(preview)) {
      res.json({
        path: relPath,
        ext,
        root: hit.root,
        content: '',
        truncated,
        binary: true,
      })
      return
    }
    res.json({
      path: relPath,
      ext,
      root: hit.root,
      content: preview.toString('utf-8'),
      truncated,
      binary: false,
    })
  })

  /** GET /tasks/:id/workspace/ls?path=dir — task workdir 单层目录列表 */
  router.get('/:id/workspace/ls', (req: Request, res: Response) => {
    const taskId = req.params['id'] as string
    const relPath = typeof req.query['path'] === 'string' ? req.query['path'] : ''
    const workspaceRoot = taskWorkdirFor(indexDb, taskId)
    if (!workspaceRoot) {
      res.status(404).json({ error: 'task not found' })
      return
    }
    const dir = resolveInsideRoot(workspaceRoot, relPath)
    if (!dir) {
      res.status(403).json({ error: 'path outside workspace' })
      return
    }
    if (!existsSync(dir) || !statSync(dir).isDirectory()) {
      res.status(404).json({ error: 'directory not found' })
      return
    }
    const entries = readdirWorkspace(dir)
    res.json({ path: relPath, entries })
  })

  /** POST /tasks/:id/bootstrap/retry — 失败时重新触发 bootstrap prepare(同 primary resource id) */
  router.post('/:id/bootstrap/retry', async (req: Request, res: Response) => {
    const taskId = req.params['id'] as string
    const row = indexDb.prepare('SELECT project_id FROM tasks_meta WHERE id = ?').get(taskId) as
      | { project_id: string }
      | undefined
    if (!row) {
      res.status(404).json({ error: 'task not found' })
      return
    }
    if (!startBootstrap) {
      res.status(503).json({ error: 'bootstrap runner not available' })
      return
    }
    const config = getConfig()
    const taskWorkdir = path.join(config.dataHome, 'projects', row.project_id, 'tasks', taskId)
    const taskDbPath = path.join(taskWorkdir, 'task.db')
    try {
      // 同时:re-run bootstrap + 唤起 task-process(若死了 planner 也会重新 spawn)。
      // 两条线并行,符合 D4 设计 — retry 应该把整 task 重新拉活,不只修 bootstrap。
      const [resource] = await Promise.all([
        startBootstrap({ taskId, taskWorkdir, taskDbPath, projectId: row.project_id }),
        ensureTaskProcess
          ? ensureTaskProcess(taskId).catch((err) => {
              log.warn({ err, taskId }, 'bootstrap retry: ensureTaskProcess failed (bootstrap still ran)')
              return null
            })
          : Promise.resolve(null),
      ])
      res.json({ ok: true, resource })
    } catch (err) {
      log.error({ err, taskId }, 'bootstrap retry failed')
      res.status(500).json({ error: 'bootstrap retry failed' })
    }
  })

  /** GET /tasks/:id/seats — 岗位列表（读 per-task DB）*/
  router.get('/:id/seats', (req: Request, res: Response) => {
    const db = getTaskDb?.(req.params['id'] as string)
    if (!db) {
      res.json([])
      return
    }
    const rows = db.prepare('SELECT * FROM seats ORDER BY created_at').all() as Record<string, unknown>[]
    const liveAgents = db
      .prepare(
        `SELECT id, seat_id, state, display_name
           FROM agents
          WHERE terminated_at IS NULL
            AND state != 'terminated'
          ORDER BY spawned_at`,
      )
      .all() as { id: string; seat_id: string; state: string; display_name: string }[]
    const liveAgentBySeat = new Map<string, { id: string; state: string; display_name: string }>()
    for (const agent of liveAgents) {
      liveAgentBySeat.set(agent.seat_id, {
        id: agent.id,
        state: agent.state,
        display_name: agent.display_name,
      })
    }
    res.json(
      rows.map((r) => {
        const seatId = r['id'] as string
        const liveAgent = liveAgentBySeat.get(seatId)
        return {
          id: seatId,
          taskId: r['task_id'],
          role: r['role'],
          factory: r['factory'],
          status: liveAgent ? seatStatusFromAgentState(liveAgent.state) : (r['status'] ?? 'vacant'),
          currentAgentId: liveAgent?.id ?? null,
          queue: parseJsonArray(r['queue']),
          modelOverride: parseAgentModelProfile(r['model_override']),
          createdAt: r['created_at'],
        }
      })
    )
  })

  /** GET /tasks/:id/agents — agent 列表（读 per-task DB）*/
  router.get('/:id/agents', (req: Request, res: Response) => {
    const db = getTaskDb?.(req.params['id'] as string)
    if (!db) {
      res.json([])
      return
    }
    const rows = db.prepare('SELECT * FROM agents ORDER BY spawned_at').all() as Record<string, unknown>[]
    res.json(
      rows.map((r) => {
        const modelProfile = parseAgentModelProfile(r['model_profile'])
        return {
          id: r['id'],
          taskId: r['task_id'],
          seatId: r['seat_id'],
          factory: r['factory'],
          displayName: r['display_name'],
          state: r['state'],
          factoryVersion: r['factory_version'],
          modelProfile,
          spawnedAt: r['spawned_at'],
          terminatedAt: r['terminated_at'] ?? null,
        }
      })
    )
  })

  /** GET /tasks/:id/usage — task/chatroom usage 聚合 */
  router.get('/:id/usage', (req: Request, res: Response) => {
    const taskId = req.params['id'] as string
    const db = getTaskDb?.(taskId)
    if (!db) {
      res.json(getTaskUsageFallback(taskId))
      return
    }
    res.json(getTaskUsage(db, taskId))
  })

  /** GET /tasks/:id/agents/:agentId/usage — 单 agent usage */
  router.get('/:id/agents/:agentId/usage', (req: Request, res: Response) => {
    const taskId = req.params['id'] as string
    const agentId = req.params['agentId'] as string
    const db = getTaskDb?.(taskId)
    if (!db) {
      res.json({ taskId, agentId, runtime: zeroTotals() })
      return
    }
    res.json(getAgentUsage(db, taskId, agentId))
  })

  /** POST /tasks — 创建任务（S0 表单提交）并 fork task-process */
  router.post('/', async (req: Request, res: Response) => {
    const parsed = CreateTaskRequest.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid request', details: parsed.error.flatten() })
      return
    }

    const input = parsed.data
    const now = new Date().toISOString()
    const id = newTaskId()

    // M3 调整:title / projectId 可选,server 补默认。
    // - projectId 不传 → 'default'
    // - title 不传 → 从 description 推断(首行,最长 60 字符;过长截断加省略号)
    const projectId = input.projectId ?? 'default'
    const title = input.title ?? deriveTitle(input.description)

    indexDb
      .prepare(
        `INSERT INTO tasks_meta
          (id, project_id, title, description, context_links, state, history, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'S0', '[]', ?, ?)`
      )
      .run(id, projectId, title, input.description, JSON.stringify(input.contextLinks), now, now)

    const task = {
      id,
      projectId,
      title,
      description: input.description,
      contextLinks: input.contextLinks,
      state: 'S0' as const,
      history: [],
      createdAt: now,
      updatedAt: now,
    }

    // 建任务目录骨架
    const config = getConfig()
    const projectSegment = projectId
    const taskWorkdir = path.join(config.dataHome, 'projects', projectSegment, 'tasks', id)
    const taskDbPath = path.join(taskWorkdir, 'task.db')

    // 3.2: 不再 mkdir 空 worktree — 真实 worktree 必须由 bootstrap provider 创建并写 resource。
    try {
      for (const sub of ['agents', 'plan', 'eng', 'retro']) {
        mkdirSync(path.join(taskWorkdir, sub), { recursive: true })
      }
    } catch (err) {
      log.error({ err, taskId: id }, 'failed to create task workdir')
      rollbackTaskCreate(indexDb, id, taskWorkdir, log)
      res.status(500).json({ error: 'failed to create task workdir' })
      return
    }

    // 构建 initialHumanMsg：description + contextLinks(若有)拼接
    const linkLines = input.contextLinks
      .filter((l) => l.url)
      .map((l) => (l.label ? `- [${l.label}](${l.url})` : `- ${l.url}`))
      .join('\n')
    const initialHumanMsg = linkLines
      ? `${input.description}\n\n上下文链接：\n${linkLines}`
      : input.description

    // 3.1: bootstrap runner 与 task-process 并行启动 — 两者都向 chatroom + WS 推进度。
    // bootstrap 是 fire-and-forget,失败时 resource 标 failed,不阻塞 planner。
    const resolvedConfig: TaskBootstrapConfig = resolveBootstrapConfig(projectId, undefined, log)
    const bootstrapStarted = Boolean(startBootstrap) && resolvedConfig.provider !== 'none'
    if (startBootstrap) {
      void startBootstrap({ taskId: id, taskWorkdir, taskDbPath, projectId }).catch((err) => {
        log.error({ err, taskId: id }, 'startBootstrap rejected')
      })
    }

    // fork task-process
    const launcher = getLauncher?.()
    if (launcher) {
      let launched = false
      try {
        launched = await launcher.launch({
          taskId: id,
          projectId,
          taskWorkdir,
          taskDbPath,
          taskTitle: title,
          initialHumanMsg,
          factoriesDir: FACTORIES_DIR,
        })
      } catch (err) {
        log.error({ err, taskId: id }, 'failed to launch task-process')
        rollbackTaskCreate(indexDb, id, taskWorkdir, log)
        res.status(500).json({ error: 'failed to launch task-process' })
        return
      }

      if (!launched) {
        log.warn({ taskId: id }, 'launcher at capacity, returning 409')
        rollbackTaskCreate(indexDb, id, taskWorkdir, log)
        res.status(409).json({
          error: '并发任务已达上限，请等待其他任务完成后再试',
        })
        return
      }

      log.info({ taskId: id, taskWorkdir }, 'task-process launched')
    } else {
      log.warn({ taskId: id }, 'no launcher available, returning 503')
      rollbackTaskCreate(indexDb, id, taskWorkdir, log)
      res.status(503).json({ error: 'task launcher unavailable' })
      return
    }

    res.status(201).json({
      ...task,
      bootstrap: {
        config: resolvedConfig,
        started: bootstrapStarted,
      },
    })
  })

  /** GET /tasks — 列出所有任务 */
  router.get('/', (_req: Request, res: Response) => {
    const rows = indexDb.prepare('SELECT * FROM tasks_meta ORDER BY created_at DESC').all()
    const tasks = rows.map(rowToTask)
    res.json(tasks)
  })

  /** GET /tasks/:id — 获取单个任务 */
  router.get('/:id', (req: Request, res: Response) => {
    const row = indexDb.prepare('SELECT * FROM tasks_meta WHERE id = ?').get(req.params['id'])
    if (!row) {
      res.status(404).json({ error: 'task not found' })
      return
    }
    res.json(rowToTask(row as RawTaskRow))
  })

  return router
}

interface RawTaskRow {
  id: string
  project_id: string
  title: string
  description: string
  context_links: string
  state: string
  history: string
  created_at: string
  updated_at: string
  stalled?: number | null
  stalled_reason?: string | null
}

function rowToTask(row: unknown) {
  const r = row as RawTaskRow
  return {
    id: r.id,
    projectId: r.project_id,
    title: r.title,
    description: r.description,
    contextLinks: JSON.parse(r.context_links) as unknown[],
    state: r.state,
    history: JSON.parse(r.history) as unknown[],
    stalled: r.stalled === 1,
    ...(r.stalled_reason ? { stalledReason: r.stalled_reason } : {}),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}

function zeroTotals() {
  return {
    inputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
  }
}

function getTaskUsageFallback(taskId: string) {
  return {
    taskId,
    totals: {
      runtime: zeroTotals(),
      chatroomCorpus: zeroTotals(),
      chatroomRead: zeroTotals(),
    },
    agents: [],
  }
}

function parseAgentModelProfile(raw: unknown): unknown {
  if (typeof raw !== 'string' || raw.length === 0) return undefined
  try {
    return JSON.parse(raw)
  } catch {
    return undefined
  }
}

function parseJsonArray(raw: unknown): unknown[] {
  if (typeof raw !== 'string' || raw.length === 0) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function seatStatusFromAgentState(state: string): 'init' | 'idle' | 'working' | 'offline' | 'vacant' {
  if (state === 'working') return 'working'
  if (state === 'idle') return 'idle'
  if (state === 'offline') return 'offline'
  return 'init'
}
