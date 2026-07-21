import { Router } from 'express'
import type { Request, Response } from 'express'
import { getAllFactories } from '../../domain/factory/factory-loader.js'
import type { DbClient } from '../../db/client.js'
import { aggregateFactoryUsage } from '../../db/token-usage-repo.js'

export function createFactoriesRouter(
  indexDb?: DbClient,
  getTaskDb?: (taskId: string) => DbClient | null,
): Router {
  const router = Router()

  /** GET /factories — 列出所有工厂（M1 只读，从内存 registry 读取）*/
  router.get('/', (_req: Request, res: Response) => {
    res.json(getAllFactories())
  })

  /** GET /factories/:name/usage — factory profile usage */
  router.get('/:name/usage', (req: Request, res: Response) => {
    const name = req.params['name'] as string
    if (!indexDb || !getTaskDb) {
      res.json({ factory: name, runtime: zeroTotals(), tasks: [] })
      return
    }
    const rows = indexDb
      .prepare('SELECT id, title FROM tasks_meta ORDER BY created_at DESC')
      .all() as { id: string; title: string }[]
    const taskDbs = rows
      .map((row) => ({ taskId: row.id, title: row.title, db: getTaskDb(row.id) }))
      .filter((row): row is { taskId: string; title: string; db: DbClient } => Boolean(row.db))
    res.json(aggregateFactoryUsage(name, taskDbs))
  })

  return router
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
