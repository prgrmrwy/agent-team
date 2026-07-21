import type { TaskBootstrapConfig, TaskBootstrapResource } from '@agent-team/protocol'
import { TaskBootstrapRunner } from './runner.js'
import type { RunnerEmit } from './types.js'
import type { Logger } from '../../util/logger.js'

export interface LaunchBootstrapOpts {
  taskId: string
  taskWorkdir: string
  taskDbPath: string
  repoRoot: string
  config: TaskBootstrapConfig
  emit?: RunnerEmit
  log?: Logger
}

/**
 * Phase 3.1：与 task-process 并行运行 bootstrap。
 * 失败不抛出（resource 已写 failed 状态 + chatroom system-event），
 * 调用方按 fire-and-forget 处理。
 */
export async function launchBootstrap(opts: LaunchBootstrapOpts): Promise<TaskBootstrapResource | null> {
  const runner = new TaskBootstrapRunner({
    taskDbPath: opts.taskDbPath,
    taskWorkdir: opts.taskWorkdir,
    repoRoot: opts.repoRoot,
    emit: opts.emit,
  })
  try {
    return await runner.prepare(opts.taskId, opts.config)
  } catch (err) {
    opts.log?.error({ err, taskId: opts.taskId }, 'bootstrap runner crashed')
    return null
  } finally {
    runner.close()
  }
}
