/**
 * 组 16.1: task-process-launcher.ts
 * child_process.fork() 派生 task-process。
 *
 * agent-runtime spec "per-task subprocess 形态 D"：
 *   主 server 进程常驻，每个活跃 task 通过 fork() 派生一个 task-process。
 *   task 间 crash 隔离，主 server 永不被任务级错误带崩。
 */

import { fork } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ChildProcess } from 'node:child_process'
import { startHeartbeat } from './heartbeat.js'
import { ProcessPool } from './process-pool.js'
import { parseIpcMessage } from './ipc-protocol.js'
import type { TaskEvent } from './ipc-protocol.js'
import { pnpmLeanWorktreeEnv } from './worktree-deps.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ENTRY_PATH = path.join(__dirname, 'task-process-entry.js')

export interface LaunchOpts {
  taskId: string
  projectId?: string
  taskWorkdir: string
  taskDbPath: string
  /** task 标题（渲染到 planner system prompt）*/
  taskTitle?: string
  /** 任务表单初始 human-msg（S0 用户填写的描述、上下文链接等）*/
  initialHumanMsg?: string
  /** 工厂目录路径（task-process 加载工厂用）*/
  factoriesDir?: string
  /** 额外 env（继承 process.env）*/
  env?: Record<string, string>
}

export interface LaunchedProcess {
  taskId: string
  process: ChildProcess
  /** 停止心跳 */
  stopHeartbeat: () => void
}

export type TaskEventHandler = (evt: TaskEvent) => void
export type ProcessDeadHandler = (taskId: string, code: number | null, signal: string | null) => void

export interface LauncherOpts {
  /** M1 默认 2 */
  maxConcurrent?: number
  /** task-event IPC 消息处理（转 WS 广播）*/
  onTaskEvent: TaskEventHandler
  /** task-process 死亡回调（crash 或正常退出）*/
  onProcessDead: ProcessDeadHandler
  /** 心跳告警（3 次无响应）*/
  onHeartbeatDead: (taskId: string) => void
  /** task-process 成功拉起（derive-presence:推 alive=true 给前端）*/
  onProcessStarted?: (taskId: string) => void
}

/**
 * TaskProcessLauncher：管理所有 task-process 的生命周期。
 * - 限制并发（ProcessPool）
 * - 心跳监测
 * - IPC 消息转发
 */
export class TaskProcessLauncher {
  private pool: ProcessPool
  private processes = new Map<string, LaunchedProcess>()
  private opts: LauncherOpts

  constructor(opts: LauncherOpts) {
    this.pool = new ProcessPool({ maxConcurrent: opts.maxConcurrent ?? 2 })
    this.opts = opts
  }

  /** 是否还有容量 */
  get hasCapacity(): boolean {
    return this.pool.hasCapacity
  }

  /** 当前活跃 task 数 */
  get activeCount(): number {
    return this.pool.activeCount
  }

  /** 当前排队数 */
  get queuedCount(): number {
    return this.pool.queuedCount
  }

  /**
   * 派生新 task-process。
   * 若已达上限，返回 false（调用方告知前端并拒绝）。
   */
  async launch(opts: LaunchOpts): Promise<boolean> {
    if (!this.pool.hasCapacity) {
      return false
    }

    // 提交到 pool（立即开始，因为 hasCapacity=true）
    this.pool
      .submit(opts.taskId, async () => {
        await this._doLaunch(opts)
      })
      .catch((err) => {
        this.opts.onProcessDead(opts.taskId, null, String(err))
      })

    return true
  }

  private async _doLaunch(opts: LaunchOpts): Promise<void> {
    const {
      taskId,
      projectId,
      taskWorkdir,
      taskDbPath,
      taskTitle,
      initialHumanMsg,
      factoriesDir,
      env: extraEnv,
    } = opts

    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      ...pnpmLeanWorktreeEnv(),
      TASK_ID: taskId,
      ...(projectId ? { TASK_PROJECT_ID: projectId } : {}),
      TASK_WORKDIR: taskWorkdir,
      TASK_DB_PATH: taskDbPath,
      ...(taskTitle ? { TASK_TITLE: taskTitle } : {}),
      ...(initialHumanMsg ? { TASK_INITIAL_MSG: initialHumanMsg } : {}),
      ...(factoriesDir ? { FACTORIES_DIR: factoriesDir } : {}),
      ...extraEnv,
    }

    const child = fork(ENTRY_PATH, [], {
      env,
      // ESM 需要通过 --import 加载 tsx（或已编译为 .js）
      // M1 dev 模式下 tsx 转译；prod 用 tsup 编译后的 .js 直接跑
      execArgv: process.execArgv,
    })

    // 监听 IPC
    child.on('message', (raw: unknown) => {
      const msg = parseIpcMessage(raw)
      if (!msg) return

      if (msg.type === 'task-event') {
        this.opts.onTaskEvent(msg as TaskEvent)
      }
      // heartbeat pong 由 startHeartbeat 内部处理（直接监听 child）
    })

    // 监听退出
    child.on('exit', (code, signal) => {
      const entry = this.processes.get(taskId)
      entry?.stopHeartbeat()
      this.processes.delete(taskId)
      this.pool.forceRemove(taskId)
      this.opts.onProcessDead(taskId, code, signal)
    })

    // 启动心跳
    const { stop: stopHeartbeat } = startHeartbeat({
      taskId,
      process: child,
      onDead: (tid) => {
        this.opts.onHeartbeatDead(tid)
        // 强杀
        try {
          child.kill('SIGKILL')
        } catch {
          // ignore
        }
      },
    })

    this.processes.set(taskId, { taskId, process: child, stopHeartbeat })
    this.opts.onProcessStarted?.(taskId)
  }

  /**
   * 向 task-process 发送 IPC 消息。
   * 返回 false 若 task-process 不存在。
   */
  // biome-ignore lint/suspicious/noExplicitAny: IPC message must be Serializable, typed at call sites
  send(taskId: string, msg: any): boolean {
    const entry = this.processes.get(taskId)
    if (!entry) return false
    entry.process.send(msg)
    return true
  }

  /** 是否有 active task-process for this taskId */
  hasActive(taskId: string): boolean {
    return this.processes.has(taskId)
  }

  /**
   * 优雅关闭所有 task-process。
   */
  async shutdownAll(): Promise<void> {
    const promises: Promise<void>[] = []

    for (const [taskId, entry] of this.processes) {
      entry.stopHeartbeat()
      promises.push(
        new Promise<void>((resolve) => {
          entry.process.once('exit', () => resolve())
          entry.process.send({ type: 'lifecycle-control', action: 'shutdown' })
          // 5s 超时后强杀
          setTimeout(() => {
            entry.process.kill('SIGKILL')
            resolve()
          }, 5000)
        })
      )
      this.pool.release(taskId)
    }

    await Promise.all(promises)
    this.processes.clear()
  }
}
