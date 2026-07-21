import { defineConfig, loadEnv } from '@rsbuild/core'
import type { ProxyOptions } from '@rsbuild/core'
import { pluginReact } from '@rsbuild/plugin-react'
import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'

/**
 * 从 apps/server/.env 读取 AGENT_TEAM_TOKEN，注入为前端 VITE_AGENT_TEAM_TOKEN。
 * dev 模式下 server 先跑（会生成 .env），rsbuild dev 启动时读取。
 */
function readServerToken(): string {
  const envPath = path.resolve(__dirname, '../server/.env')
  if (!existsSync(envPath)) return ''
  const content = readFileSync(envPath, 'utf-8')
  for (const line of content.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.startsWith('AGENT_TEAM_TOKEN=')) {
      return trimmed.slice('AGENT_TEAM_TOKEN='.length).trim()
    }
  }
  return ''
}

const token = readServerToken()
const backendTarget = 'http://localhost:3001'

function wantsHtmlDocument(req: Parameters<NonNullable<ProxyOptions['bypass']>>[0]): boolean {
  const method = req.method ?? 'GET'
  if (method !== 'GET' && method !== 'HEAD') return false

  const acceptHeader = req.headers.accept
  const accept = Array.isArray(acceptHeader) ? acceptHeader.join(',') : (acceptHeader ?? '')
  return accept.includes('text/html') && !accept.includes('application/json')
}

function apiProxyWithSpaFallback(): ProxyOptions {
  return {
    target: backendTarget,
    bypass(req) {
      if (wantsHtmlDocument(req)) return '/index.html'
      return undefined
    },
  }
}

export default defineConfig({
  plugins: [pluginReact()],
  html: {
    template: './index.html',
  },
  source: {
    entry: {
      index: './src/app/main.tsx',
    },
    define: {
      'import.meta.env.VITE_AGENT_TEAM_TOKEN': JSON.stringify(token),
      // dev：同源（经下方 proxy 转发到后端 3001），避免跨源 CORS
      'import.meta.env.VITE_API_BASE': JSON.stringify(''),
      // WS 直连后端（跨源 WS 无需 CORS，后端只校验 token）；REST 仍走下方 proxy 同源
      'import.meta.env.VITE_WS_BASE': JSON.stringify('ws://localhost:3001'),
    },
  },
  server: {
    port: 5173,
    historyApiFallback: true,
    proxy: {
      '/ws': { target: backendTarget, ws: true },
      '/tasks': apiProxyWithSpaFallback(),
      '/projects': backendTarget,
      '/factories': apiProxyWithSpaFallback(),
      '/skills': backendTarget,
      '/runtimes': backendTarget,
      '/usage': backendTarget,
      '/internal': backendTarget,
      '/__health': backendTarget,
    },
  },
})

// SPA routes (/tasks/$taskId, /factories/$name) share prefixes with REST APIs.
// Browser document navigation sends Accept:text/html, while rest-client requests
// send Accept:application/json, so the proxy can keep API calls on the backend and
// let direct page refreshes fall through to the SPA entry.
