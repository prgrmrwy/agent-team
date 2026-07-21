import express from 'express'
import type { Express, Request, Response, NextFunction } from 'express'
import { authToken } from './middleware/auth-token.js'
import { createTasksRouter, type StartBootstrap } from './routes/tasks.js'
import { createProjectsRouter } from './routes/projects.js'
import { createFactoriesRouter } from './routes/factories.js'
import { createSkillsRouter } from './routes/skills.js'
import { createRuntimesRouter } from './routes/runtimes.js'
import { createUsageRouter } from './routes/usage.js'
import { createAtHookRouter } from './routes/internal/at-hook.js'
import type { DbClient } from '../db/client.js'
import type { Logger } from '../util/logger.js'
import type { TaskProcessLauncher } from '../process/task-process-launcher.js'

export interface AppDeps {
  indexDb: DbClient
  getTaskDb: (taskId: string) => DbClient | null
  log: Logger
  /** 延迟绑定 launcher getter，与 ws-server 保持同样的时序模式 */
  getLauncher?: () => TaskProcessLauncher | undefined
  /** Phase 3.1: 与 task-process 并行启动 bootstrap runner */
  startBootstrap?: StartBootstrap
  /** bootstrap retry 等场景里同时唤起 task-process(同 ws/handlers/human-message 的实现) */
  ensureTaskProcess?: (taskId: string) => Promise<'ready' | 'launched' | 'unknown-task' | 'failed'>
}

export function createApp(deps: AppDeps): Express {
  const { indexDb, getTaskDb, log, getLauncher, startBootstrap, ensureTaskProcess } = deps
  const app = express()

  app.use(express.json())

  // 健康检查（公开，无需鉴权）
  app.get('/__health', (_req: Request, res: Response) => {
    res.json({ ok: true, ts: new Date().toISOString() })
  })

  // at-hook 内部端点（只有 secret 段鉴权，不走 authToken 中间件）
  app.use('/internal/at-hook', createAtHookRouter(getTaskDb))

  // 其余路由全部鉴权
  app.use(authToken)
  app.use('/tasks', createTasksRouter(indexDb, log, getLauncher, getTaskDb, startBootstrap, ensureTaskProcess))
  app.use('/projects', createProjectsRouter(indexDb, log, getTaskDb))
  app.use('/factories', createFactoriesRouter(indexDb, getTaskDb))
  app.use('/skills', createSkillsRouter(log))
  app.use('/runtimes', createRuntimesRouter(log))
  app.use('/usage', createUsageRouter(indexDb, getTaskDb))

  // 兜底 404
  app.use((_req: Request, res: Response) => {
    res.status(404).json({ error: 'not found' })
  })

  // 全局错误处理
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    log.error({ err }, 'unhandled error')
    res.status(500).json({ error: 'internal server error' })
  })

  return app
}
