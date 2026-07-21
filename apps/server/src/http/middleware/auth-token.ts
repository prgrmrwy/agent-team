import type { Request, Response, NextFunction } from 'express'
import { getConfig } from '../../config/index.js'

/**
 * Bearer / ?token= 鉴权中间件（local-auth spec）。
 * 校验失败返回 401 { error: "missing or invalid token" }。
 */
export function authToken(req: Request, res: Response, next: NextFunction): void {
  const { token } = getConfig()

  // Authorization: Bearer <token>
  const authHeader = req.headers['authorization']
  if (authHeader?.startsWith('Bearer ')) {
    const supplied = authHeader.slice(7).trim()
    if (supplied === token) {
      next()
      return
    }
  }

  // ?token=<token>
  const queryToken = req.query['token']
  if (typeof queryToken === 'string' && queryToken === token) {
    next()
    return
  }

  res.status(401).json({ error: 'missing or invalid token' })
}
