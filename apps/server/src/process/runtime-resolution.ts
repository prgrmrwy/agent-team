import type { AgentModelProfile, LocalProviderStatus } from '@agent-team/protocol'
import { resolveRuntimeProvider } from '../adapters/cli/adapter-factory.js'

export interface RuntimeCandidateResolution {
  candidates: AgentModelProfile[]
  skipped: Array<{ modelProfile: AgentModelProfile; reason: string }>
  source: 'seat-override' | 'factory' | 'env-default'
}

interface ModelProfileFactoryConfig {
  preferredModelProfile?: AgentModelProfile
  fallbackModelProfiles?: AgentModelProfile[]
}

export function resolveRuntimeCandidates(opts: {
  factory: ModelProfileFactoryConfig
  localRuntimes: LocalProviderStatus[]
  modelOverride?: string | null
  env?: NodeJS.ProcessEnv
}): RuntimeCandidateResolution {
  const override = parseModelOverride(opts.modelOverride)
  if (override) return { candidates: [override], skipped: [], source: 'seat-override' }

  const factoryCandidates = [
    opts.factory.preferredModelProfile,
    ...(opts.factory.fallbackModelProfiles ?? []),
  ].filter((r): r is AgentModelProfile => Boolean(r))

  if (factoryCandidates.length > 0) {
    const candidates: AgentModelProfile[] = []
    const skipped: RuntimeCandidateResolution['skipped'] = []
    for (const modelProfile of factoryCandidates) {
      const status = opts.localRuntimes.find((r) => r.provider === modelProfile.provider)
      if (status?.available) {
        candidates.push(modelProfile)
      } else {
        skipped.push({
          modelProfile,
          reason: status?.reason ?? `provider ${modelProfile.provider} is not available locally`,
        })
      }
    }
    return { candidates, skipped, source: 'factory' }
  }

  return {
    candidates: [{ provider: resolveRuntimeProvider(opts.env) }],
    skipped: [],
    source: 'env-default',
  }
}

export function isRuntimeAvailabilityError(err: unknown): boolean {
  const text = err instanceof Error ? `${err.name}\n${err.message}\n${err.stack ?? ''}` : String(err)
  return [
    'unsupported runtime provider',
    'not found',
    'command not found',
    'ENOENT',
    'auth',
    'unauthorized',
    'quota',
    'rate limit',
    'limit',
    'exceeded',
    'usage-limit',
    'missing',
  ].some((needle) => text.toLowerCase().includes(needle.toLowerCase()))
}

function parseModelOverride(raw?: string | null): AgentModelProfile | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as AgentModelProfile
    return parsed && typeof parsed.provider === 'string' ? parsed : null
  } catch {
    return null
  }
}
