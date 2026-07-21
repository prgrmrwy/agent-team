import { describe, it, expect } from 'vitest'
import { Factory } from '@agent-team/protocol'
import { DEFAULT_SYSTEM_DIRECTIVE } from './system-directive.js'

describe('systemDirective', () => {
  it('DEFAULT_SYSTEM_DIRECTIVE 含推进本能核心要素', () => {
    // 核心动力学:完成即推进 + 阻塞即催不静默
    expect(DEFAULT_SYSTEM_DIRECTIVE).toContain('完成即推进')
    expect(DEFAULT_SYSTEM_DIRECTIVE).toContain('task_state_propose')
    expect(DEFAULT_SYSTEM_DIRECTIVE).toContain('绝不')
    expect(DEFAULT_SYSTEM_DIRECTIVE).toMatch(/静默/)
  })

  it('DEFAULT_SYSTEM_DIRECTIVE 含越界护栏(禁止绕过 MCP 工具自救)', () => {
    // 防 planner 暴走:工具调不动就喊人,不是自己跑 node/curl 绕过编排
    expect(DEFAULT_SYSTEM_DIRECTIVE).toMatch(/越权|红线|编排边界/)
    expect(DEFAULT_SYSTEM_DIRECTIVE).toMatch(/严禁|绝不能/)
    expect(DEFAULT_SYSTEM_DIRECTIVE).toContain('curl')
  })

  it('Factory schema 接受可选 systemDirective', () => {
    const base = {
      name: 'qa' as const,
      version: 1,
      persona: 'p',
      systemPromptTemplate: 't',
      defaultNamePool: ['包拯'],
      coreMcps: [{ name: 'chatroom-mcp', command: 'node', args: [] as string[] }],
      lifecycle: 'alwaysOn' as const,
    }
    // 不设 systemDirective → 解析通过,字段 undefined
    const without = Factory.parse(base)
    expect(without.systemDirective).toBeUndefined()
    // 设了 → 保留
    const withDir = Factory.parse({ ...base, systemDirective: 'custom directive' })
    expect(withDir.systemDirective).toBe('custom directive')
  })
})
