/**
 * 前端环境变量读取（从 rsbuild dev hook 注入的 .env.local）。
 * 生产环境由构建时外部注入。
 */

// 必须用静态 import.meta.env.VITE_X 访问：rsbuild/Rspack 的 define 只替换静态字面量，
// 动态 import.meta.env[key] 不会被替换（曾导致 token 注入失败 → 401）。
export const env = {
  /** 本地鉴权 token，来自 apps/server/.env 由 rsbuild define 注入 */
  token: (import.meta.env.VITE_AGENT_TEAM_TOKEN as string | undefined) ?? '',
  /** 后端 HTTP 地址（dev 同源经 proxy，留空即同源）*/
  apiBase: (import.meta.env.VITE_API_BASE as string | undefined) ?? 'http://localhost:3000',
  /** WebSocket 地址 */
  wsBase: (import.meta.env.VITE_WS_BASE as string | undefined) ?? 'ws://localhost:3000',
} as const

if (!env.token) {
  console.warn('[env] VITE_AGENT_TEAM_TOKEN 未注入，WS/REST 将 401。确认 apps/server/.env 存在且 rsbuild 已重启。')
}
