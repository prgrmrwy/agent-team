import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  TaskBootstrapResource,
  isUrgentSystemEvent,
  urgentKeyForContent,
  type BootstrapProvider as BootstrapProviderId,
  type BootstrapResourceStatus,
  type TaskBootstrapConfig,
  type TaskBootstrapResource as TaskBootstrapResourceT,
} from '@agent-team/protocol'
import { openDb, runMigrations, type DbClient } from '../../db/client.js'
import { newMessageId } from '../../util/id.js'
import { createGenericPnpmProvider } from './generic-pnpm.js'
import { createSwProvider } from './sw.js'
import type {
  BootstrapProvider,
  BootstrapProviderContext,
  RunnerEmit,
  RunnerOptions,
} from './types.js'

// apps/server/src/process/bootstrap → apps/server/src/db/migrations-task
const TASK_MIGRATIONS_DIR = fileURLToPath(new URL('../../db/migrations-task', import.meta.url))

const PRIMARY_WORKTREE_ID = 'primary-worktree'

/**
 * 编排 bootstrap provider 的运行时副作用 (D1 + D2)。
 * - prepare(): provider 跑完写 bootstrap_resources + chatroom system-event;同一 primary resource retry 时更新原行 (2.5)。
 * - status(): 读 DB,可选触发 provider 复查。
 * - release(): provider 给出终态,Runner 写 terminal_status,resource 不被删除。
 */
export class TaskBootstrapRunner {
  private readonly providers: Map<BootstrapProviderId, BootstrapProvider>
  private readonly db: DbClient
  private readonly ownsDb: boolean
  private readonly taskWorkdir: string
  private readonly repoRoot: string
  private readonly emit: RunnerEmit | undefined

  constructor(opts: RunnerOptions) {
    if (opts.db) {
      this.db = opts.db
      this.ownsDb = false
    } else if (opts.taskDbPath) {
      this.db = openDb(opts.taskDbPath)
      runMigrations(this.db, TASK_MIGRATIONS_DIR)
      this.ownsDb = true
    } else {
      throw new Error('TaskBootstrapRunner: must provide either `db` or `taskDbPath`')
    }
    this.taskWorkdir = opts.taskWorkdir
    this.repoRoot = opts.repoRoot ?? process.cwd()
    this.emit = opts.emit

    const provided = opts.providers ?? {}
    this.providers = new Map<BootstrapProviderId, BootstrapProvider>()
    this.providers.set('generic-pnpm', provided['generic-pnpm'] ?? createGenericPnpmProvider())
    this.providers.set('sw', provided['sw'] ?? createSwProvider())
    if (provided['generic']) this.providers.set('generic', provided['generic'])
  }

  close(): void {
    if (this.ownsDb) this.db.close()
  }

  /**
   * 启动 prepare;若已存在同 id 的 resource,更新 attempts/status (2.5 retry)。
   * config.provider === 'none' 直接返回 null,Runner 不创建 resource。
   */
  async prepare(taskId: string, config: TaskBootstrapConfig): Promise<TaskBootstrapResourceT | null> {
    if (config.provider === 'none') return null

    const provider = this.providers.get(config.provider)
    if (!provider) {
      throw new Error(`bootstrap provider not registered: ${config.provider}`)
    }

    const resourceId = PRIMARY_WORKTREE_ID
    const existing = this.readResource(taskId, resourceId)
    const attempts = (existing?.attempts ?? 0) + 1

    const creating = this.upsertResource({
      id: resourceId,
      taskId,
      kind: 'worktree',
      status: 'creating',
      provider: config.provider,
      mode: config.mode,
      path: existing?.path,
      branch: existing?.branch,
      baseRef: existing?.baseRef,
      summary: 'preparing…',
      error: undefined,
      attempts,
      createdAt: existing?.createdAt,
    })
    this.broadcast(creating, `bootstrap ${config.provider}/${config.mode ?? 'lean'} preparing (attempt ${attempts})`)
    // 持久化 release policy 到 resource 行 — release() 时不需要再传 config
    this.writeReleasePolicy(taskId, resourceId, config.release)

    const ctx: BootstrapProviderContext = {
      taskId,
      taskWorkdir: this.taskWorkdir,
      repoRoot: this.repoRoot,
      mode: config.mode,
      releasePolicy: config.release,
      options: config.options,
    }

    const result = await provider.prepare(ctx)

    if (result.ok) {
      const ready = this.upsertResource({
        id: resourceId,
        taskId,
        kind: 'worktree',
        status: 'ready',
        provider: config.provider,
        mode: config.mode,
        path: result.path,
        branch: result.branch,
        baseRef: result.baseRef,
        summary: result.summary,
        error: undefined,
        attempts,
        createdAt: existing?.createdAt,
      })
      this.broadcast(ready, `bootstrap ready: ${result.path}${result.branch ? ` @ ${result.branch}` : ''}`)
      return ready
    }

    const failed = this.upsertResource({
      id: resourceId,
      taskId,
      kind: 'worktree',
      status: 'failed',
      provider: config.provider,
      mode: config.mode,
      path: existing?.path,
      branch: existing?.branch,
      baseRef: existing?.baseRef,
      summary: result.summary,
      error: result.error,
      attempts,
      createdAt: existing?.createdAt,
    })
    this.broadcast(failed, `bootstrap failed (attempt ${attempts}): ${result.error}`)
    return failed
  }

  /** 读 DB,若 provider 实现了在线复查,Runner 同步状态 */
  async status(taskId: string, resourceId = PRIMARY_WORKTREE_ID): Promise<TaskBootstrapResourceT | null> {
    const current = this.readResource(taskId, resourceId)
    if (!current) return null
    const provider = this.providers.get(current.provider)
    if (!provider) return current
    const live = await provider.status(this.contextFor(taskId, current.mode, {}), current)
    if (
      live.status === current.status &&
      live.path === current.path &&
      live.branch === current.branch
    ) {
      return current
    }
    return this.upsertResource({
      ...current,
      status: live.status,
      path: live.path ?? current.path,
      branch: live.branch ?? current.branch,
      summary: live.summary ?? current.summary,
      error: live.error ?? current.error,
    })
  }

  async release(taskId: string, resourceId = PRIMARY_WORKTREE_ID): Promise<TaskBootstrapResourceT | null> {
    const current = this.readResource(taskId, resourceId)
    if (!current) return null
    const provider = this.providers.get(current.provider)
    if (!provider) return current
    const releasePolicy = this.readReleasePolicy(taskId, resourceId)
    const ctx: BootstrapProviderContext = {
      ...this.contextFor(taskId, current.mode, {}),
      releasePolicy,
    }
    const outcome = await provider.release(ctx, current)
    const updated = this.upsertResource({
      ...current,
      status: outcome.terminalStatus,
      summary: outcome.summary ?? current.summary,
      error: outcome.error ?? current.error,
    }, outcome.terminalStatus)
    this.broadcast(updated, `bootstrap release → ${outcome.terminalStatus}${outcome.summary ? `: ${outcome.summary}` : ''}`)
    return updated
  }

  private contextFor(
    taskId: string,
    mode: TaskBootstrapResourceT['mode'],
    options: Record<string, unknown>,
  ): BootstrapProviderContext {
    // release / status 调用复用此方法,但本身不来自 prepare 的 config;
    // 没有现成的 release policy → 默认 remove-if-clean(与 schema default 一致)
    return {
      taskId,
      taskWorkdir: this.taskWorkdir,
      repoRoot: this.repoRoot,
      mode,
      releasePolicy: 'remove-if-clean',
      options,
    }
  }

  private writeReleasePolicy(taskId: string, resourceId: string, policy: string): void {
    this.db
      .prepare(
        'UPDATE bootstrap_resources SET release_policy = ? WHERE task_id = ? AND id = ?',
      )
      .run(policy, taskId, resourceId)
  }

  private readReleasePolicy(
    taskId: string,
    resourceId: string,
  ): 'retain' | 'remove-if-clean' | 'prompt' | 'archive' {
    const row = this.db
      .prepare('SELECT release_policy FROM bootstrap_resources WHERE task_id = ? AND id = ?')
      .get(taskId, resourceId) as { release_policy?: string } | undefined
    const v = row?.release_policy
    if (v === 'retain' || v === 'remove-if-clean' || v === 'prompt' || v === 'archive') return v
    return 'remove-if-clean'
  }

  private readResource(taskId: string, id: string): TaskBootstrapResourceT | null {
    const row = this.db
      .prepare(
        `SELECT * FROM bootstrap_resources WHERE task_id = ? AND id = ?`,
      )
      .get(taskId, id) as Record<string, unknown> | undefined
    if (!row) return null
    return rowToResource(row)
  }

  /** UPSERT — Phase 2.5: retry 复用同一行,attempts 累加。 */
  private upsertResource(
    input: Omit<TaskBootstrapResourceT, 'createdAt' | 'updatedAt'> & {
      createdAt?: string
      updatedAt?: string
    },
    terminalStatus?: TaskBootstrapResourceT['status'],
  ): TaskBootstrapResourceT {
    const now = new Date().toISOString()
    const createdAt = input.createdAt ?? now
    const terminal = terminalStatus && isTerminal(terminalStatus) ? terminalStatus : null

    this.db
      .prepare(
        `INSERT INTO bootstrap_resources
           (id, task_id, kind, status, provider, mode, path, branch, base_ref, summary, error, attempts, terminal_status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(task_id, id) DO UPDATE SET
           kind = excluded.kind,
           status = excluded.status,
           provider = excluded.provider,
           mode = excluded.mode,
           path = excluded.path,
           branch = excluded.branch,
           base_ref = excluded.base_ref,
           summary = excluded.summary,
           error = excluded.error,
           attempts = excluded.attempts,
           terminal_status = COALESCE(excluded.terminal_status, bootstrap_resources.terminal_status),
           updated_at = excluded.updated_at`,
      )
      .run(
        input.id,
        input.taskId,
        input.kind,
        input.status,
        input.provider,
        input.mode ?? null,
        input.path ?? null,
        input.branch ?? null,
        input.baseRef ?? null,
        input.summary ?? null,
        input.error ?? null,
        input.attempts,
        terminal,
        createdAt,
        now,
      )

    const reloaded = this.readResource(input.taskId, input.id)
    if (!reloaded) throw new Error('failed to reload bootstrap resource after upsert')
    return reloaded
  }

  private broadcast(resource: TaskBootstrapResourceT, content: string): void {
    this.writeSystemEvent(resource.taskId, content)
    this.emit?.systemEvent(resource.taskId, content)
    this.emit?.resourceEvent?.(resource.taskId, resource)
  }

  private writeSystemEvent(taskId: string, content: string): void {
    const now = new Date().toISOString()
    const urgentKey = isUrgentSystemEvent(content) ? urgentKeyForContent(content) : null
    this.db
      .prepare(
        `INSERT INTO chatroom_messages
           (id, task_id, channel, type, sender, content, mention, refs, reply_to, urgent_key, acknowledged_at, created_at)
         VALUES (?, ?, 'main', 'system-event', 'system', ?, '[]', '[]', NULL, ?, NULL, ?)`,
      )
      .run(newMessageId(), taskId, content, urgentKey, now)
  }
}

function rowToResource(row: Record<string, unknown>): TaskBootstrapResourceT {
  const parsed = TaskBootstrapResource.parse({
    id: row['id'],
    taskId: row['task_id'],
    kind: row['kind'],
    status: row['status'],
    provider: row['provider'],
    mode: row['mode'] ?? undefined,
    path: row['path'] ?? undefined,
    branch: row['branch'] ?? undefined,
    baseRef: row['base_ref'] ?? undefined,
    summary: row['summary'] ?? undefined,
    error: row['error'] ?? undefined,
    attempts: row['attempts'] ?? 0,
    createdAt: row['created_at'],
    updatedAt: row['updated_at'],
  })
  return parsed
}

function isTerminal(s: BootstrapResourceStatus): boolean {
  return s === 'retained' || s === 'removed' || s === 'archived' || s === 'needs-review'
}

export { PRIMARY_WORKTREE_ID }
