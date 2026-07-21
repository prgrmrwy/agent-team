import { Router } from 'express'
import type { Request, Response } from 'express'
import type { DbClient } from '../../db/client.js'
import { aggregateGlobalUsage } from '../../db/token-usage-repo.js'

/**
 * GET /usage — 系统级全局 token usage 聚合(跨所有 project / task)。
 * 用于 settings 面板 token 总览。一期 all-time,top 10 ranking,0 token 排除。
 */
export function createUsageRouter(
  indexDb: DbClient,
  getTaskDb: (taskId: string) => DbClient | null,
): Router {
  const router = Router()

  router.get('/', (_req: Request, res: Response) => {
    const rows = indexDb
      .prepare('SELECT id, title FROM tasks_meta ORDER BY created_at DESC')
      .all() as { id: string; title: string | null }[]
    const taskDbs = rows
      .map((row) => ({
        taskId: row.id,
        title: row.title ?? undefined,
        db: getTaskDb(row.id),
      }))
      .filter((x): x is { taskId: string; title: string | undefined; db: DbClient } =>
        x.db !== null,
      )
    res.json(aggregateGlobalUsage(taskDbs))
  })

  return router
}
