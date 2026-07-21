import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

/**
 * 启动时确保 .env 中存在 AGENT_TEAM_TOKEN。
 * 首次生成 32 字节随机 hex token，写入 .env（0600 权限）。
 * 后续复用已有 token，不重新生成。
 *
 * 返回最终生效的 token 字符串。
 */
export function ensureToken(envFilePath: string): string {
  // 尝试读取现有 .env
  if (fs.existsSync(envFilePath)) {
    const content = fs.readFileSync(envFilePath, 'utf-8')
    const match = content.match(/^AGENT_TEAM_TOKEN=(.+)$/m)
    if (match?.[1]?.trim()) {
      return match[1].trim()
    }
  }

  // 首次生成
  const token = randomBytes(32).toString('hex')
  const envDir = path.dirname(envFilePath)
  if (!fs.existsSync(envDir)) {
    fs.mkdirSync(envDir, { recursive: true })
  }

  // 追加或创建 .env
  const line = `AGENT_TEAM_TOKEN=${token}\n`
  if (fs.existsSync(envFilePath)) {
    fs.appendFileSync(envFilePath, line, 'utf-8')
  } else {
    fs.writeFileSync(envFilePath, line, { encoding: 'utf-8', mode: 0o600 })
  }

  // 确保权限 0600（appendFileSync 继承已有权限，需显式 chmod）
  fs.chmodSync(envFilePath, 0o600)

  return token
}
