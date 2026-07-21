/**
 * apps/server 入口。
 * 启动顺序：
 *  1. 确保 .env 中有 AGENT_TEAM_TOKEN（首次生成，复启复用）
 *  2. 加载 .env 到 process.env
 *  3. 解析配置
 *  4. 打开全局索引 DB（自动 migration）
 *  5. 启动 Express HTTP server
 *  6. 附加 WS server（noServer 模式，通过 getLauncher getter 延迟绑定 launcher）
 *  7. 初始化 task-process launcher（Wave 2b）
 *  8. 监听端口
 */

import { readFileSync, existsSync } from 'node:fs'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import http from 'node:http'
import Database from 'better-sqlite3'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ENV_FILE = path.resolve(__dirname, '../.env')  // apps/server/.env（dev: __dirname=apps/server/src）

// Step 1: 确保 token
import { ensureToken } from './util/token.js'
const token = ensureToken(ENV_FILE)

// Step 2: 加载 .env（简单 key=value 解析，不引入 dotenv 依赖）
if (existsSync(ENV_FILE)) {
  const lines = readFileSync(ENV_FILE, 'utf-8').split('\n')
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const idx = trimmed.indexOf('=')
    if (idx === -1) continue
    const key = trimmed.slice(0, idx).trim()
    const val = trimmed.slice(idx + 1).trim()
    if (key && !process.env[key]) {
      process.env[key] = val
    }
  }
}

// 确保 token 在 env 中（ensureToken 写了文件，但 process.env 需手动设置）
if (!process.env['AGENT_TEAM_TOKEN']) {
  process.env['AGENT_TEAM_TOKEN'] = token
}

// Step 3: 配置
import { getConfig } from './config/index.js'
const config = getConfig()

// Step 4: 日志
import { logger } from './util/logger.js'
const log = logger.child({ module: 'main' })
log.info({ port: config.port, dataHome: config.dataHome }, 'starting agent-team server')

// Step 5: 数据库
import { openIndexDb, openTaskDb } from './db/index.js'
mkdirSync(config.dataHome, { recursive: true })
const indexDb = openIndexDb(config.indexDbPath, log)
log.info({ path: config.indexDbPath }, 'index DB ready')

// Step 5b: 加载工厂到内存 registry（GET /factories 依赖此；task-process 各自也会加载）
import { loadFactories } from './domain/factory/factory-loader.js'
loadFactories(path.join(__dirname, 'domain/factory/defaults'), log)

function syncIndexTaskState(taskId: string, state: string, reason: 'startup-reconcile' | 'phase-change'): void {
  indexDb.prepare('UPDATE tasks_meta SET state = ? WHERE id = ?').run(state, taskId)
  log.debug({ taskId, state, reason }, 'indexDb task state synced from task.db lifecycle')
}

// Step 5c: startup reconcile — server 重启后用 task.db 的真实 state 对账 indexDb
// (老 task 在 phase-change sync 之前完成的转换,indexDb 可能停留在创建初始值)
// 不阻塞 listen:把 N 次 task.db open/close 推到 setImmediate(httpServer 起好后再扫)。
function runStartupReconcile(): void {
  const rows = indexDb
    .prepare('SELECT id, project_id, state FROM tasks_meta')
    .all() as { id: string; project_id: string; state: string }[]
  let reconciled = 0
  for (const row of rows) {
    const taskDbPath = path.join(
      config.dataHome,
      'projects',
      row.project_id,
      'tasks',
      row.id,
      'task.db',
    )
    if (!existsSync(taskDbPath)) continue
    try {
      const tdb = new Database(taskDbPath, { readonly: true, fileMustExist: true })
      const inner = tdb
        .prepare('SELECT state FROM tasks_meta WHERE id = ?')
        .get(row.id) as { state: string } | undefined
      tdb.close()
      if (inner && inner.state !== row.state) {
        syncIndexTaskState(row.id, inner.state, 'startup-reconcile')
        reconciled++
      }
    } catch (err) {
      log.warn({ err, taskId: row.id }, 'startup reconcile: failed to read task.db')
    }
  }
  if (reconciled > 0) log.info({ reconciled }, 'startup reconcile: indexDb state synced')
}

// Step 6: 类型导入（提前 import，供 Step 7 callback 使用）
import { TaskProcessLauncher } from './process/task-process-launcher.js'
import type { TaskEvent } from './process/ipc-protocol.js'
import { broadcast, broadcastAll } from './ws/broadcast.js'
import { TERMINAL_TASK_STATES, type ServerToClient, type TaskState, type Presence, type Message } from '@agent-team/protocol'

// getTaskDb：主 server 打开 per-task task.db（路径由 index.db 的 project_id 解析）。
// per-task DB 是 WAL 模式，task-process 与主 server 可并发读写；缓存连接复用。
const taskDbs = new Map<string, import('./db/client.js').DbClient>()
function getTaskDb(taskId: string): import('./db/client.js').DbClient | null {
  const cached = taskDbs.get(taskId)
  if (cached) return cached
  const row = indexDb.prepare('SELECT project_id FROM tasks_meta WHERE id = ?').get(taskId) as
    | { project_id: string }
    | undefined
  if (!row) return null
  const taskDbPath = path.join(config.dataHome, 'projects', row.project_id, 'tasks', taskId, 'task.db')
  if (!existsSync(taskDbPath)) return null
  try {
    const db = openTaskDb(taskDbPath, log)
    taskDbs.set(taskId, db)
    return db
  } catch (err) {
    log.warn({ err, taskId }, 'getTaskDb: 打开 task.db 失败')
    return null
  }
}

// Step 7: HTTP app
import { createApp } from './http/app.js'
import { launchBootstrap } from './process/bootstrap/index.js'
import { resolveBootstrapConfig } from './config/bootstrap-config.js'
import type { TaskBootstrapResource } from '@agent-team/protocol'

const startBootstrap = async (opts: {
  taskId: string
  taskWorkdir: string
  taskDbPath: string
  projectId: string
}): Promise<TaskBootstrapResource | null> => {
  const cfg = resolveBootstrapConfig(opts.projectId, undefined, log)
  // 仓库根:走 indexDb projects.repo_path(sw 需 Nexus 仓库;generic-pnpm 也按此目录开 worktree)
  const projRow = indexDb
    .prepare('SELECT repo_path FROM projects WHERE id = ?')
    .get(opts.projectId) as { repo_path: string | null } | undefined
  const repoRoot = projRow?.repo_path ?? process.cwd()
  return launchBootstrap({
    taskId: opts.taskId,
    taskWorkdir: opts.taskWorkdir,
    taskDbPath: opts.taskDbPath,
    repoRoot,
    config: cfg,
    log,
    emit: {
      systemEvent: () => {
        // Runner 已写入 task DB chatroom_messages;前端通过 GET /tasks/:id/messages
        // 和 task-process 的 chatroom-msg 广播看到。此处不重复广播。
      },
      resourceEvent: (taskId, resource) => {
        broadcast(connections, taskId, {
          type: 'bootstrap-resource',
          taskId,
          resourceId: resource.id,
          kind: resource.kind,
          status: resource.status,
          provider: resource.provider,
          ...(resource.mode ? { mode: resource.mode } : {}),
          ...(resource.summary ? { summary: resource.summary } : {}),
          ...(resource.error ? { error: resource.error } : {}),
        })
      },
    },
  })
}

// Step 8: HTTP server + WS
// getLauncher getter：launcher 在 Step 8b 后才赋值，getter 延迟求值解决时序问题。
import { createWsServer } from './ws/ws-server.js'
const FACTORIES_DIR = path.resolve(__dirname, './domain/factory/defaults')

/**
 * 通用唤醒 fn — task-process 死了时 fork 起来,等真进 processes map 才返回。
 * 给 WS human-message + HTTP /tasks/:id/bootstrap/retry 共用。
 */
async function ensureTaskProcess(
  taskId: string,
): Promise<'ready' | 'launched' | 'unknown-task' | 'failed'> {
  if (!launcher) return 'failed'
  if (launcher.hasActive(taskId)) return 'ready'

  const row = indexDb
    .prepare('SELECT * FROM tasks_meta WHERE id = ?')
    .get(taskId) as
    | {
        id: string
        project_id: string
        title: string
        description: string
        context_links: string
      }
    | undefined
  if (!row) return 'unknown-task'

  const projectId = row.project_id
  const taskWorkdir = path.join(config.dataHome, 'projects', projectId, 'tasks', taskId)
  const taskDbPath = path.join(taskWorkdir, 'task.db')

  // 拼 initialHumanMsg(同 POST /tasks 的逻辑;auto-relaunch 时 task-process
  // boot 已经会幂等跳过重写 chatroom 首条,所以这里只是给 system prompt 还原上下文)
  let initialHumanMsg = row.description ?? ''
  try {
    const links = JSON.parse(row.context_links ?? '[]') as Array<{ url: string; label?: string }>
    const linkLines = links
      .filter((l) => l.url)
      .map((l) => (l.label ? `- [${l.label}](${l.url})` : `- ${l.url}`))
      .join('\n')
    if (linkLines) initialHumanMsg = `${initialHumanMsg}\n\n上下文链接：\n${linkLines}`
  } catch {
    // ignore — old row may not have valid JSON
  }

  log.info({ taskId, taskWorkdir }, 'auto-relaunching task-process')
  const launched = await launcher.launch({
    taskId,
    projectId,
    taskWorkdir,
    taskDbPath,
    taskTitle: row.title,
    initialHumanMsg,
    factoriesDir: FACTORIES_DIR,
  })
  if (!launched) return 'failed'
  // launcher.launch 只 submit 到 pool;实际 fork + 写 processes map 是 async,
  // 后续 launcher.send 时 processes.get 还是 undefined → 消息会被静默丢。
  // poll 等 hasActive 真起来再返回 'launched',让 send 能命中。
  const start = Date.now()
  while (!launcher.hasActive(taskId)) {
    if (Date.now() - start > 5_000) {
      log.warn({ taskId }, 'ensureTaskProcess: launched but hasActive still false after 5s')
      return 'failed'
    }
    await new Promise((r) => setTimeout(r, 50))
  }
  return 'launched'
}

const app = createApp({
  indexDb,
  getTaskDb,
  log,
  getLauncher: () => launcher,
  startBootstrap,
  ensureTaskProcess,
})

type PresenceSnapshot = {
  seatId: string
  presence: Presence
  agentId: string | null
  displayName: string | null
}

// derive-presence:presence 内存 relay 缓存(taskId → seatId → presence snapshot)。
// 不落库。由 task-process 推来的 seat-state 更新,新订阅时回放(快照),进程死时清。
const presenceCache = new Map<string, Map<string, PresenceSnapshot>>()

/** 新订阅回放:返回该 task 当前缓存的全 seat presence 快照 */
function getPresenceSnapshot(taskId: string): PresenceSnapshot[] {
  const m = presenceCache.get(taskId)
  if (!m) return []
  return [...m.values()]
}

const httpServer = http.createServer(app)
const { connections } = createWsServer({
  httpServer,
  log,
  indexDb,
  getLauncher: () => launcher,
  ensureTaskProcess,
  getPresenceSnapshot,
})

// Step 8b: 初始化 task-process launcher（Wave 2b 运行时层）
let launcher: TaskProcessLauncher

function buildTaskEventToWsEvent(evt: TaskEvent): ServerToClient | null {
  const taskId = evt.taskId

  switch (evt.subtype) {
    case 'phase-change':
      return {
        type: 'phase-change',
        taskId,
        from: evt.from as TaskState,
        to: evt.to as TaskState,
      }
    case 'chatroom-msg':
      return {
        type: 'chatroom-msg',
        taskId,
        message: evt.message as unknown as Message,
      }
    case 'chatroom-msg-delta':
      return {
        type: 'chatroom-msg-delta',
        taskId,
        agentId: evt.agentId,
        channel: evt.channel,
        content: evt.content,
      }
    case 'seat-state':
      return {
        type: 'seat-state',
        taskId,
        seatId: evt.seatId,
        presence: evt.presence,
        agentId: evt.agentId,
        displayName: evt.displayName,
      }
    case 'notification':
      return {
        type: 'notification',
        level: evt.level,
        content: evt.content,
      }
    case 'propose-rejected':
      return {
        type: 'propose-rejected',
        taskId,
        reason: evt.reason,
      }
    default:
      return null
  }
}

launcher = new TaskProcessLauncher({
  maxConcurrent: Number(process.env['MAX_CONCURRENT_TASKS'] ?? 10),

  onTaskEvent(evt) {
    // M3 polish:phase-change 同时 sync indexDb tasks_meta.state(否则前端
    // GET /tasks 拉到的列表 state 永远是创建时的初始值,sidebar state pill /
    // active-done 过滤都失效)。
    if (evt.subtype === 'phase-change') {
      try {
        syncIndexTaskState(evt.taskId, evt.to, 'phase-change')
      } catch (err) {
        log.warn({ err, taskId: evt.taskId }, 'indexDb phase-change sync failed')
      }
    }

    // 防静默:stalled 同步 index.db(供 GET /tasks → sidebar 高亮)
    if (evt.subtype === 'stalled') {
      try {
        indexDb
          .prepare('UPDATE tasks_meta SET stalled = ?, stalled_reason = ?, stalled_at = ? WHERE id = ?')
          .run(
            evt.stalled ? 1 : 0,
            evt.stalled ? (evt.reason ?? null) : null,
            evt.stalled ? new Date().toISOString() : null,
            evt.taskId,
          )
      } catch (err) {
        log.warn({ err, taskId: evt.taskId }, 'indexDb stalled sync failed')
      }
    }

    // IPC task-event → WS broadcast 给订阅该 task 的前端
    const wsEvent = buildTaskEventToWsEvent(evt)
    if (!wsEvent) return

    // derive-presence:seat presence 进内存 relay 缓存(供新订阅回放快照)
    if (wsEvent.type === 'seat-state') {
      let m = presenceCache.get(evt.taskId)
      if (!m) {
        m = new Map()
        presenceCache.set(evt.taskId, m)
      }
      m.set(wsEvent.seatId, {
        seatId: wsEvent.seatId,
        presence: wsEvent.presence,
        agentId: wsEvent.agentId ?? null,
        displayName: wsEvent.displayName ?? null,
      })
    }

    if (wsEvent.type === 'notification') {
      broadcastAll(connections, wsEvent)
    } else {
      broadcast(connections, evt.taskId, wsEvent)
    }
  },

  onProcessStarted(taskId) {
    // derive-presence D3:进程拉起 → 推 alive=true,前端恢复显示真实 presence。
    // 清旧 presence 缓存:新进程会重新派生+推全量,旧的(上个进程的)作废。
    presenceCache.delete(taskId)
    broadcast(connections, taskId, { type: 'task-process-state', taskId, alive: true })
  },

  onProcessDead(taskId, code, signal) {
    log.warn({ taskId, code, signal }, 'task-process exited')
    // derive-presence D3:进程死 → 清 presence 缓存 + 推 alive=false,前端全 seat 渲染 offline
    presenceCache.delete(taskId)
    broadcast(connections, taskId, { type: 'task-process-state', taskId, alive: false })
    broadcastAll(connections, {
      type: 'notification',
      level: 'warn',
      content: `任务 ${taskId} 进程已退出（code=${code}, signal=${signal}），请检查`,
    })
  },

  onHeartbeatDead(taskId) {
    log.error({ taskId }, 'task-process heartbeat dead — killed')
    presenceCache.delete(taskId)
    broadcast(connections, taskId, { type: 'task-process-state', taskId, alive: false })
    broadcastAll(connections, {
      type: 'notification',
      level: 'error',
      content: `任务 ${taskId} 心跳超时，进程已强杀，请 abort 或重启该任务`,
    })
  },
})

// Step 9: 监听
httpServer.listen(config.port, () => {
  log.info({ port: config.port }, `server listening on http://localhost:${config.port}`)
  log.info(
    { secret: config.atHookSecret },
    `at-hook endpoint: POST /internal/at-hook/${config.atHookSecret}`
  )
  // listen 起来后再做 reconcile,不阻塞端口可达
  setImmediate(runStartupReconcile)
  setImmediate(reviveActiveTasks)
})

/**
 * server 重启后,扫所有**非终态**任务(S1-S9 / S10' / S11 / releasing),主动 ensureTaskProcess
 * 把 task-process 拉回 —— 否则 server 一重启,在途任务的 task-process 就死了,但 UI 仍显示
 * "active"(僵尸):agent 不再干活、控制指令(pause/message)发过去 launcher 找不到进程而丢弃。
 * boot 路径按各 state 重新拉起对应 driver(resumeFromState / releasing planner)续工作。
 */
function reviveActiveTasks(): void {
  const terminalPlaceholders = TERMINAL_TASK_STATES.map(() => '?').join(',')
  const rows = indexDb
    .prepare(
      `SELECT id, state FROM tasks_meta WHERE state != 'S0' AND state NOT IN (${terminalPlaceholders})`,
    )
    .all(...TERMINAL_TASK_STATES) as { id: string; state: string }[]
  if (rows.length === 0) return
  log.info({ count: rows.length, states: rows.map((r) => r.state) }, 'reviving active tasks on startup')
  for (const row of rows) {
    ensureTaskProcess(row.id).catch((err) => {
      log.warn({ err, taskId: row.id, state: row.state }, 'revive active task failed (manual retry needed)')
    })
  }
}

// Step 10: 优雅关闭
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)

async function shutdown() {
  log.info('shutdown signal received')
  await launcher.shutdownAll()
  httpServer.close(() => {
    indexDb.close()
    log.info('server closed')
    process.exit(0)
  })
}

export { connections, launcher }
