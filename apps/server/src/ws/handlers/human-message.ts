import type WebSocket from 'ws'
import type { ClientToServer } from '@agent-team/protocol'
import type { Logger } from '../../util/logger.js'
import type { TaskProcessLauncher } from '../../process/task-process-launcher.js'

type HumanMessagePayload = Extract<ClientToServer, { type: 'human-message' }>

/**
 * 若 task-process 当前不 alive,尝试唤醒一次再投递人类消息。
 * 实现由 main.ts 注入(它有 indexDb + config + factoriesDir 上下文)。
 * 返回:
 *  - 'ready' = 进程已 alive(可直接 send)
 *  - 'launched' = 刚 fork 出来(send 入 IPC 队列;child 启动后会消费)
 *  - 'unknown-task' = indexDb 找不到该 task(前端 taskId 非法)
 *  - 'failed' = launcher 容量满 / 启动错误等
 */
export type EnsureTaskProcessResult =
  | 'ready'
  | 'launched'
  | 'unknown-task'
  | 'failed'

export type EnsureTaskProcess = (taskId: string) => Promise<EnsureTaskProcessResult>

/**
 * 处理前端人类消息。
 * Wave 2b:通过 IPC 转发到对应 task-process,task-process 写 chatroom。
 * M3 T10:若 task-process 已死(server 重启 / 主动 abort),用 ensureTaskProcess
 *        callback 自动唤醒一次再投递。
 */
export async function handleHumanMessage(
  _ws: WebSocket,
  msg: HumanMessagePayload,
  log: Logger,
  launcher?: TaskProcessLauncher,
  ensureTaskProcess?: EnsureTaskProcess,
): Promise<void> {
  log.info(
    { taskId: msg.taskId, channel: msg.channel, mentionCount: msg.mention?.length ?? 0 },
    'human-message received → forwarding to task-process',
  )

  if (!launcher) {
    log.warn({ taskId: msg.taskId }, 'no launcher available, dropping human-message')
    return
  }

  // 若 process 不 alive 且能 ensure,先唤醒
  if (!launcher.hasActive(msg.taskId) && ensureTaskProcess) {
    log.info({ taskId: msg.taskId }, 'task-process not active — auto-relaunch attempt')
    const result = await ensureTaskProcess(msg.taskId)
    if (result === 'unknown-task') {
      log.warn({ taskId: msg.taskId }, 'human-message for unknown task — dropped')
      return
    }
    if (result === 'failed') {
      log.warn({ taskId: msg.taskId }, 'auto-relaunch failed — message dropped')
      return
    }
    log.info({ taskId: msg.taskId, result }, 'task-process ensured for human-message')
  }

  const sent = launcher.send(msg.taskId, {
    type: 'user-input',
    subtype: 'message',
    taskId: msg.taskId,
    channel: msg.channel,
    content: msg.content,
    mention: msg.mention ?? [],
    refs: msg.refs ?? [],
  })

  if (!sent) {
    // 仍失败(可能 fork 还没完成,IPC 通道未建立):前端乐观 UI 已显示,
    // 用户重试发送时大概率已 ready
    log.warn(
      { taskId: msg.taskId },
      'task-process still not reachable after ensure — message queued only in optimistic UI',
    )
  }
}
