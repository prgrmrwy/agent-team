import { Router } from 'express'
import type { Request, Response } from 'express'
import { z } from 'zod'
import { getConfig } from '../../../config/index.js'
import type { DbClient } from '../../../db/client.js'

// at-hook POST body schema（tools/at-hook/bin.mjs 发的 payload）
const AtHookPayload = z.object({
  taskId: z.string().min(1),
  agentId: z.string().min(1),
  action: z.enum(['read-file', 'websearch', 'webfetch', 'run-cmd', 'mcp-call', 'skill-load']),
  ref: z.string().min(1),
  ts: z.string().datetime().optional(),
})

/**
 * POST /internal/at-hook/:secret
 * 路径含 unguessable 段（sha256(token+'hook').slice(0,16)），防本机其他进程伪造。
 * 接收 at-hook 二进制上报，写入对应 task 的 context_access_log。
 *
 * NOTE: 因 task DB 是 per-task 的，M1 阶段 at-hook 路由暂时无法直接拿到 task DB。
 * 先写入日志并返回 200；Wave 2 接入 task-process IPC 后再真正落 task DB。
 */
export function createAtHookRouter(getTaskDb: (taskId: string) => DbClient | null): Router {
  const router = Router()

  router.post('/:secret', (req: Request, res: Response) => {
    const { atHookSecret } = getConfig()
    const { secret } = req.params

    if (secret !== atHookSecret) {
      res.status(404).json({ error: 'not found' })
      return
    }

    const parsed = AtHookPayload.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid payload', details: parsed.error.flatten() })
      return
    }

    const { taskId, agentId, action, ref, ts } = parsed.data
    const now = ts ?? new Date().toISOString()

    const taskDb = getTaskDb(taskId)
    if (taskDb) {
      taskDb
        .prepare(
          `INSERT INTO context_access_log(task_id, agent_id, action, ref, ts)
           VALUES (?, ?, ?, ?, ?)`
        )
        .run(taskId, agentId, action, ref, now)
    }
    // task DB 不存在时 silent success（task 可能已结束）

    res.status(200).json({ ok: true })
  })

  return router
}
