import { Router } from 'express'
import type { Request, Response } from 'express'
import { listLocalRuntimes } from '../../adapters/cli/local-runtime-discovery.js'
import type { Logger } from '../../util/logger.js'

export function createRuntimesRouter(log: Logger): Router {
  const router = Router()

  router.get('/local', async (_req: Request, res: Response) => {
    try {
      res.json(await listLocalRuntimes())
    } catch (err) {
      log.error({ err }, 'failed to list local providers')
      res.status(500).json({ error: 'failed to list local providers' })
    }
  })

  return router
}
