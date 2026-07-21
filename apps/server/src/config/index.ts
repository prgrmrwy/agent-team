import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import path from 'node:path'

/**
 * 全局运行时配置。由 main.ts 在 .env 加载后调用 getConfig() 获取。
 * 所有后续模块 import 本文件，不直接读 process.env。
 */
export interface AppConfig {
  port: number
  token: string
  dataHome: string
  indexDbPath: string
  /** at-hook 内部路径后缀（sha256(token+'hook').slice(0,16)）*/
  atHookSecret: string
  nodeEnv: 'development' | 'production' | 'test'
}

let _config: AppConfig | null = null

function computeAtHookSecret(token: string): string {
  return createHash('sha256').update(token + 'hook').digest('hex').slice(0, 16)
}

export function getConfig(): AppConfig {
  if (_config) return _config

  const token = process.env['AGENT_TEAM_TOKEN']
  if (!token) {
    throw new Error('AGENT_TEAM_TOKEN is not set — ensure main.ts runs token generation before getConfig()')
  }

  const port = Number(process.env['PORT'] ?? 3001)
  const dataHome = process.env['DATA_HOME'] ?? path.join(homedir(), '.agent-team')

  _config = {
    port,
    token,
    dataHome,
    indexDbPath: path.join(dataHome, 'index.db'),
    atHookSecret: computeAtHookSecret(token),
    nodeEnv: (process.env['NODE_ENV'] as AppConfig['nodeEnv']) ?? 'development',
  }

  return _config
}

/** 仅测试用：重置配置缓存 */
export function _resetConfigForTest(): void {
  _config = null
}
