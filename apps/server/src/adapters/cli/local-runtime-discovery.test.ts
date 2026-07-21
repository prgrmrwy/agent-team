import { describe, expect, it } from 'vitest'
import { listLocalRuntimes } from './local-runtime-discovery.js'

describe('local provider discovery', () => {
  it('reports package and codex binary availability', async () => {
    const runtimes = await listLocalRuntimes({
      resolvePackage: (name) =>
        name === '@zed-industries/claude-code-acp' || name === '@openai/codex-sdk',
      runCommand: async () => ({ code: 0, stdout: 'codex 0.1.0', stderr: '' }),
    })

    expect(runtimes).toEqual([
      { provider: 'claude-acp', available: true, models: [] },
      { provider: 'codex-sdk', available: true, models: [] },
      { provider: 'codex-exec', available: true, models: [] },
    ])
  })

  it('reports unavailable providers with concise reasons', async () => {
    const runtimes = await listLocalRuntimes({
      resolvePackage: () => false,
      runCommand: async () => ({ code: 1, stdout: '', stderr: 'command not found: codex' }),
    })

    expect(runtimes.find((r) => r.provider === 'claude-acp')).toMatchObject({
      available: false,
      reason: '@zed-industries/claude-code-acp package not found',
    })
    expect(runtimes.find((r) => r.provider === 'codex-sdk')).toMatchObject({
      available: false,
      reason: '@openai/codex-sdk package not found',
    })
    expect(runtimes.find((r) => r.provider === 'codex-exec')).toMatchObject({
      available: false,
      reason: 'codex --version failed: command not found: codex',
    })
  })
})
