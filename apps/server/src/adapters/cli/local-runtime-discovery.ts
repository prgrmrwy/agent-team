import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import type { ListLocalProvidersResponse, LocalProviderStatus, RuntimeProvider } from '@agent-team/protocol'

const require = createRequire(import.meta.url)
const PROVIDERS: RuntimeProvider[] = ['claude-acp', 'codex-sdk', 'codex-exec']
const CACHE_TTL_MS = 10_000

interface CommandResult {
  code: number
  stdout: string
  stderr: string
}

export interface RuntimeDiscoveryDeps {
  resolvePackage?: (packageName: string) => boolean
  runCommand?: (command: string, args: string[], timeoutMs: number) => Promise<CommandResult>
}

let cache: { expiresAt: number; value: ListLocalProvidersResponse } | null = null

export async function listLocalRuntimes(
  deps: RuntimeDiscoveryDeps = {},
): Promise<ListLocalProvidersResponse> {
  if (!deps.resolvePackage && !deps.runCommand && cache && cache.expiresAt > Date.now()) {
    return cache.value
  }

  const value = await Promise.all(PROVIDERS.map((provider) => discoverProvider(provider, deps)))
  if (!deps.resolvePackage && !deps.runCommand) {
    cache = { expiresAt: Date.now() + CACHE_TTL_MS, value }
  }
  return value
}

export function clearLocalRuntimeDiscoveryCache(): void {
  cache = null
}

async function discoverProvider(
  provider: RuntimeProvider,
  deps: RuntimeDiscoveryDeps,
): Promise<LocalProviderStatus> {
  if (provider === 'claude-acp') {
    return discoverPackageProvider(provider, '@zed-industries/claude-code-acp', deps)
  }

  // codex-sdk:Node SDK 直连 OpenAI API,不需 codex 二进制;只判 package 装没装
  if (provider === 'codex-sdk') {
    return discoverPackageProvider(provider, '@openai/codex-sdk', deps)
  }

  // codex-exec:走 codex CLI 二进制 → 必须本机装 codex 命令
  const codexBin = process.env['AGENT_TEAM_CODEX_BIN'] ?? 'codex'
  const version = await (deps.runCommand ?? runCommand)(codexBin, ['--version'], 5_000)
  if (version.code !== 0) {
    return {
      provider,
      available: false,
      models: [],
      reason: `codex --version failed: ${firstNonEmpty(version.stderr, version.stdout)}`,
    }
  }

  return { provider, available: true, models: [] }
}

function discoverPackageProvider(
  provider: RuntimeProvider,
  packageName: string,
  deps: RuntimeDiscoveryDeps,
): LocalProviderStatus {
  const resolvePackage = deps.resolvePackage ?? defaultResolvePackage
  if (resolvePackage(packageName)) return { provider, available: true, models: [] }
  return { provider, available: false, models: [], reason: `${packageName} package not found` }
}

function defaultResolvePackage(packageName: string): boolean {
  // 1) 标准 require.resolve(pkg/package.json):对老式 cjs / exports 允许 subpath 的包 OK
  try {
    require.resolve(`${packageName}/package.json`)
    return true
  } catch {
    // ignore — 现代 esm 包常用 "exports": { ".": ... } 不暴露 ./package.json
  }
  // 2) require.resolve(pkg):exports 里有 main/default 时可命中
  try {
    require.resolve(packageName)
    return true
  } catch {
    // ignore — exports 不可解析(如 @openai/codex-sdk 0.142 那种)
  }
  // 3) fs 兜底:遍历候选 node_modules 找 <pkg>/package.json 文件存不存在
  //    这是"装没装"的最直接判断,不受 exports 黑魔法影响
  const candidates = require.resolve.paths(packageName) ?? []
  for (const base of candidates) {
    if (existsSync(join(base, packageName, 'package.json'))) return true
  }
  return false
}

function runCommand(command: string, args: string[], timeoutMs: number): Promise<CommandResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    const timeout = setTimeout(() => {
      child.kill('SIGKILL')
    }, timeoutMs)
    child.stdout?.on('data', (chunk: Buffer) => stdout.push(chunk))
    child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk))
    child.on('error', (err) => {
      clearTimeout(timeout)
      resolve({ code: 1, stdout: '', stderr: err.message })
    })
    child.on('exit', (code) => {
      clearTimeout(timeout)
      resolve({
        code: code ?? 1,
        stdout: Buffer.concat(stdout).toString('utf-8'),
        stderr: Buffer.concat(stderr).toString('utf-8'),
      })
    })
  })
}

function firstNonEmpty(a: string, b: string): string {
  return (a.trim() || b.trim() || 'unknown error').slice(0, 240)
}
