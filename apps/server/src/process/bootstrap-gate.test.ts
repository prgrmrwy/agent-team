import { describe, expect, it } from 'vitest'
import { classifyWorktreeGate } from './bootstrap-gate.js'

describe('classifyWorktreeGate (Phase 4.3/4.5)', () => {
  it("ready → ok (engineer spawn proceeds with worktree)", () => {
    expect(classifyWorktreeGate('ready')).toBe('ok')
  })

  it('creating → wait (engineer spawn delays until ready or timeout)', () => {
    expect(classifyWorktreeGate('creating')).toBe('wait')
  })

  it('failed → fail (engineer surfaces error + retry hint, no spawn)', () => {
    expect(classifyWorktreeGate('failed')).toBe('fail')
  })

  it('null (no resource / provider=none) → ok (agent works in task workdir)', () => {
    expect(classifyWorktreeGate(null)).toBe('ok')
  })

  it('terminal post-release statuses → wait (orchestrator should not recruit on top of released worktree)', () => {
    expect(classifyWorktreeGate('retained')).toBe('wait')
    expect(classifyWorktreeGate('removed')).toBe('wait')
    expect(classifyWorktreeGate('archived')).toBe('wait')
    expect(classifyWorktreeGate('needs-review')).toBe('wait')
  })
})
