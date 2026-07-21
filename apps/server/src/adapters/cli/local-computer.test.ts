import { describe, expect, it } from 'vitest'
import { resolveComputerId, UnsupportedComputerError } from './computer.js'
import { getLocalComputer, LocalComputer, resolveComputer } from './local-computer.js'

describe('resolveComputerId — 按 agent 级四级解析', () => {
  it('全空 → 默认 local', () => {
    expect(resolveComputerId({ env: {} })).toBe('local')
  })
  it('env AGENT_TEAM_COMPUTER 生效', () => {
    expect(resolveComputerId({ env: { AGENT_TEAM_COMPUTER: 'remote-1' } })).toBe('remote-1')
  })
  it('factory preferred 高于 env', () => {
    expect(
      resolveComputerId({ factoryPreferredComputer: 'fac', env: { AGENT_TEAM_COMPUTER: 'env' } }),
    ).toBe('fac')
  })
  it('seat override 最高优先级', () => {
    expect(
      resolveComputerId({
        seatComputer: 'seat',
        factoryPreferredComputer: 'fac',
        env: { AGENT_TEAM_COMPUTER: 'env' },
      }),
    ).toBe('seat')
  })
})

describe('resolveComputer', () => {
  it('local → LocalComputer 单例', () => {
    const c = resolveComputer({ env: {} })
    expect(c).toBe(getLocalComputer())
    expect(c.id).toBe('local')
  })
  it('未知 id → UnsupportedComputerError（RemoteComputer 未实现）', () => {
    expect(() => resolveComputer({ seatComputer: 'remote-x' })).toThrow(UnsupportedComputerError)
  })
})

describe('LocalComputer', () => {
  const lc = new LocalComputer()

  it('createCliAdapter 透传 provider', () => {
    expect(lc.createCliAdapter('claude-acp').provider).toBe('claude-acp')
    expect(lc.createCliAdapter('codex-sdk').provider).toBe('codex-sdk')
  })

  it('exec 在本机执行并返回 {code,stdout,stderr}', async () => {
    const ok = await lc.exec([process.execPath, '-e', 'process.stdout.write("ok")'])
    expect(ok.code).toBe(0)
    expect(ok.stdout).toBe('ok')
  })

  it('exec 非零退出码如实返回', async () => {
    const fail = await lc.exec([process.execPath, '-e', 'process.exit(3)'])
    expect(fail.code).toBe(3)
  })
})
