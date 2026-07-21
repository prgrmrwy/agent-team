import type { CliAdapter, RuntimeProvider } from './cli-adapter.js'
import { AcpAdapter } from './acp-adapter.js'
import { CodexExecAdapter } from './codex-exec-adapter.js'
import { CodexSdkAdapter } from './codex-sdk-adapter.js'

export class UnsupportedRuntimeProviderError extends Error {
  constructor(readonly provider: string) {
    super(`unsupported runtime provider: ${provider}`)
  }
}

export function resolveRuntimeProvider(env: NodeJS.ProcessEnv = process.env): RuntimeProvider {
  const raw = env['AGENT_TEAM_ADAPTER']?.trim()
  if (!raw) return 'claude-acp'
  if (raw === 'claude-acp' || raw === 'codex-sdk' || raw === 'codex-exec') return raw
  throw new UnsupportedRuntimeProviderError(raw)
}

export function createCliAdapter(provider: RuntimeProvider = resolveRuntimeProvider()): CliAdapter {
  if (provider === 'claude-acp') return new AcpAdapter()
  if (provider === 'codex-sdk') return new CodexSdkAdapter()
  if (provider === 'codex-exec') return new CodexExecAdapter()
  throw new UnsupportedRuntimeProviderError(provider)
}
