import { Router } from 'express'
import type { Request, Response } from 'express'
import { TaskBootstrapConfig } from '@agent-team/protocol'
import type { DbClient } from '../../db/client.js'
import {
  discoverDefaultProvider,
  readProjectBootstrapConfig,
  saveProjectBootstrapConfig,
} from '../../config/bootstrap-config.js'
import type { Logger } from '../../util/logger.js'
import { aggregateProjectUsage } from '../../db/token-usage-repo.js'

export function createProjectsRouter(
  indexDb: DbClient,
  log?: Logger,
  getTaskDb?: (taskId: string) => DbClient | null,
): Router {
  const router = Router()

  /** GET /projects — 列出所有项目 */
  router.get('/', (_req: Request, res: Response) => {
    const rows = indexDb.prepare('SELECT * FROM projects ORDER BY created_at DESC').all()
    const projects = rows.map((r) => {
      const row = r as { id: string; name: string; repo_path: string | null; created_at: string }
      return {
        id: row.id,
        name: row.name,
        repoPath: row.repo_path ?? undefined,
        createdAt: row.created_at,
      }
    })
    res.json(projects)
  })

  /**
   * GET /projects/:id/bootstrap-config — 返回项目 bootstrap.yaml,如缺失返回 discovery 建议。
   * 前端首次进入设置 / 任务创建时拉取;present=false 表示需要 picker 触发 save。
   */
  router.get('/:id/bootstrap-config', (req: Request, res: Response) => {
    const projectId = req.params['id'] as string
    const saved = readProjectBootstrapConfig(projectId, log)
    if (saved) {
      res.json({ present: true, config: saved })
      return
    }
    const discovered = discoverDefaultProvider()
    res.json({
      present: false,
      suggestion: {
        provider: discovered.provider,
        mode: discovered.provider === 'none' ? undefined : 'lean',
        options: {},
      },
      reason: discovered.reason,
    })
  })

  /** GET /projects/:id/usage — project runtime usage 聚合 */
  router.get('/:id/usage', (req: Request, res: Response) => {
    const projectId = req.params['id'] as string
    const rows = indexDb
      .prepare('SELECT id FROM tasks_meta WHERE project_id = ? ORDER BY created_at DESC')
      .all(projectId) as { id: string }[]
    const taskDbs = rows
      .map((row) => ({ taskId: row.id, db: getTaskDb?.(row.id) ?? null }))
      .filter((row): row is { taskId: string; db: DbClient } => Boolean(row.db))
    res.json(aggregateProjectUsage(projectId, taskDbs))
  })

  /** PUT /projects/:id/bootstrap-config — 前端 picker 选好后落盘 */
  router.put('/:id/bootstrap-config', (req: Request, res: Response) => {
    const parsed = TaskBootstrapConfig.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid bootstrap config', details: parsed.error.flatten() })
      return
    }
    saveProjectBootstrapConfig(req.params['id'] as string, parsed.data, log)
    res.json({ ok: true, config: parsed.data })
  })

  return router
}
