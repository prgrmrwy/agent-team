import pino from 'pino'

/**
 * pino 日志器。token redact 防止 AGENT_TEAM_TOKEN 泄进日志。
 * 用 child logger 为不同模块加 context。
 */

function makeRedactPaths(): string[] {
  return [
    'token',
    'authorization',
    '*.token',
    '*.authorization',
    'headers.authorization',
    'query.token',
  ]
}

export const logger = pino({
  level: process.env['LOG_LEVEL'] ?? 'info',
  redact: {
    paths: makeRedactPaths(),
    censor: '[REDACTED]',
  },
  transport:
    process.env['NODE_ENV'] !== 'production'
      ? { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss.l' } }
      : undefined,
})

export type Logger = typeof logger
