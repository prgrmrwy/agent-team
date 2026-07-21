import type WebSocket from 'ws'
import { isTerminalTaskState, type ClientToServer } from '@agent-team/protocol'
import type { Logger } from '../../util/logger.js'
import type { TaskProcessLauncher } from '../../process/task-process-launcher.js'
import type { DbClient } from '../../db/client.js'
import type { EnsureTaskProcess } from './human-message.js'

type ControlPayload = Extract<ClientToServer, { type: 'control' }>

/**
 * 处理前端控制指令(pause / resume / abort / complete / done)。
 * task-bootstrap-lifecycle phase 5.1:'done' 不再乐观置 done,而是进入 releasing
 *        — agents 仍在线,planner 产出 retro + archive-plan,resource 终态后才 done。
 *        indexDb 的 state 由 task-process 的 phase-change 广播带回更新。
 */
export async function handleControl(
  _ws: WebSocket,
  msg: ControlPayload,
  log: Logger,
  launcher?: TaskProcessLauncher,
  indexDb?: DbClient,
  ensureTaskProcess?: EnsureTaskProcess,
): Promise<void> {
  log.info({ taskId: msg.taskId, action: msg.action }, 'control received → forwarding to task-process')

  if (!launcher) {
    log.warn({ taskId: msg.taskId }, 'no launcher available, dropping control')
    return
  }

  if (msg.action === 'done' && isTerminalTask(indexDb, msg.taskId)) {
    log.info({ taskId: msg.taskId }, 'done control ignored — task is terminal')
    return
  }

  // 'done' 命中已死 process 时唤醒一次(让 planner 完成 releasing 阶段的复盘/归档建议)
  if (msg.action === 'done' && !launcher.hasActive(msg.taskId) && ensureTaskProcess) {
    log.info({ taskId: msg.taskId }, "done — auto-relaunch task-process to drive releasing")
    const result = await ensureTaskProcess(msg.taskId)
    if (result === 'unknown-task' || result === 'failed') {
      log.warn({ taskId: msg.taskId, result }, 'done control: relaunch failed')
      return
    }
  }

  const sent = launcher.send(msg.taskId, {
    type: 'user-input',
    subtype: 'control',
    taskId: msg.taskId,
    action: msg.action,
  })

  if (!sent) {
    log.warn({ taskId: msg.taskId, action: msg.action }, 'task-process not found for control')
  }
}

function isTerminalTask(indexDb: DbClient | undefined, taskId: string): boolean {
  if (!indexDb) return false
  try {
    const row = indexDb.prepare('SELECT state FROM tasks_meta WHERE id = ?').get(taskId) as
      | { state: string }
      | undefined
    return isTerminalTaskState(row?.state)
  } catch {
    return false
  }
}
