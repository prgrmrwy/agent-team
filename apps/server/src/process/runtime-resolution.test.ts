import { describe, expect, it } from 'vitest'
import { isRuntimeAvailabilityError, resolveRuntimeCandidates } from './runtime-resolution.js'
import type { LocalProviderStatus } from '@agent-team/protocol'

const allAvailable: LocalProviderStatus[] = [
  { provider: 'claude-acp', available: true, models: [] },
  { provider: 'codex-sdk', available: true, models: [] },
  { provider: 'codex-exec', available: true, models: [] },
]

describe('resolveRuntimeCandidates', () => {
  it('uses factory primary when available', () => {
    const resolved = resolveRuntimeCandidates({
      factory: {
        preferredModelProfile: { provider: 'claude-acp', model: 'claude-sonnet-4.6' },
        fallbackModelProfiles: [{ provider: 'codex-sdk', model: 'gpt-5.4' }],
      },
      localRuntimes: allAvailable,
    })

    expect(resolved.source).toBe('factory')
    expect(resolved.candidates[0]).toEqual({
      provider: 'claude-acp',
      model: 'claude-sonnet-4.6',
    })
  })

  it('skips unavailable primary and selects fallback', () => {
    const resolved = resolveRuntimeCandidates({
      factory: {
        preferredModelProfile: { provider: 'claude-acp', model: 'claude-sonnet-4.6' },
        fallbackModelProfiles: [{ provider: 'codex-sdk', model: 'gpt-5.4' }],
      },
      localRuntimes: [
        { provider: 'claude-acp', available: false, models: [], reason: 'package not found' },
        { provider: 'codex-sdk', available: true, models: [] },
      ],
    })

    expect(resolved.candidates).toEqual([{ provider: 'codex-sdk', model: 'gpt-5.4' }])
    expect(resolved.skipped).toHaveLength(1)
  })

  it('seat override bypasses factory candidates', () => {
    const resolved = resolveRuntimeCandidates({
      modelOverride: JSON.stringify({ provider: 'codex-sdk', model: 'gpt-5.5' }),
      factory: {
        preferredModelProfile: { provider: 'claude-acp' },
        fallbackModelProfiles: [{ provider: 'codex-exec' }],
      },
      localRuntimes: [],
    })

    expect(resolved.source).toBe('seat-override')
    expect(resolved.candidates).toEqual([{ provider: 'codex-sdk', model: 'gpt-5.5' }])
    expect(resolved.skipped).toEqual([])
  })

  it('returns no candidates when all factory model profiles are unavailable', () => {
    const resolved = resolveRuntimeCandidates({
      factory: {
        preferredModelProfile: { provider: 'claude-acp' },
        fallbackModelProfiles: [{ provider: 'codex-sdk' }],
      },
      localRuntimes: [
        { provider: 'claude-acp', available: false, models: [], reason: 'missing claude' },
        { provider: 'codex-sdk', available: false, models: [], reason: 'missing codex' },
      ],
    })

    expect(resolved.candidates).toEqual([])
    expect(resolved.skipped).toHaveLength(2)
  })

  it('falls back to environment/default when factory has no model profile config', () => {
    const resolved = resolveRuntimeCandidates({
      factory: { fallbackModelProfiles: [] },
      localRuntimes: [],
      env: { AGENT_TEAM_ADAPTER: 'codex-sdk' },
    })

    expect(resolved.source).toBe('env-default')
    expect(resolved.candidates).toEqual([{ provider: 'codex-sdk' }])
  })

})

describe('isRuntimeAvailabilityError', () => {
  it('recognizes missing binary and auth style errors', () => {
    expect(isRuntimeAvailabilityError(new Error('spawn codex ENOENT'))).toBe(true)
    expect(isRuntimeAvailabilityError(new Error('unauthorized provider auth'))).toBe(true)
    expect(isRuntimeAvailabilityError(new Error('provider rate limit exceeded'))).toBe(true)
    expect(isRuntimeAvailabilityError(new Error('ordinary bug'))).toBe(false)
  })
})
