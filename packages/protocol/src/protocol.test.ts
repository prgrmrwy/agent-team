import { describe, expect, it } from 'vitest'
import {
  Task,
  Seat,
  Factory,
  SeatSpec,
  Message,
  CreateTaskInput,
  MCP_TOOL_NAMES,
  McpTools,
  ServerToClient,
  ClientToServer,
  RelPath,
  LocalProviderStatus,
  ListLocalProvidersResponse,
  TaskState,
  TaskBootstrapConfig,
  TaskBootstrapResource,
  CreateTaskResponse,
  AgentUsageResponse,
  FactoryUsageResponse,
  ProjectUsageResponse,
  TaskUsageResponse,
  TokenUsageEvent,
  TERMINAL_TASK_STATES,
  isTerminalTaskState,
} from './index.js'
import { sampleTask, sampleSeat, samplePlannerFactory, sampleMessage } from './fixtures.js'

describe('数据模型 fixtures 通过 schema 校验', () => {
  it('Task', () => expect(Task.parse(sampleTask)).toEqual(sampleTask))
  it('Seat', () => expect(Seat.parse(sampleSeat)).toEqual(sampleSeat))
  it('Factory', () => expect(Factory.parse(samplePlannerFactory)).toEqual(samplePlannerFactory))
  it('Factory preferredModelProfile 支持 provider model', () => {
    const parsed = Factory.parse({
      ...samplePlannerFactory,
      preferredModelProfile: { provider: 'codex-sdk', model: 'gpt-5.5', reasoningEffort: 'high' },
      fallbackModelProfiles: [{ provider: 'claude-acp', model: 'claude-sonnet-4.6' }],
    })
    expect(parsed.preferredModelProfile).toMatchObject({
      provider: 'codex-sdk',
      model: 'gpt-5.5',
      reasoningEffort: 'high',
    })
    expect(parsed.fallbackModelProfiles).toEqual([
      { provider: 'claude-acp', model: 'claude-sonnet-4.6' },
    ])
  })
  it('LocalProviderStatus 是新的 provider discovery 名称', () => {
    expect(
      LocalProviderStatus.parse({
        provider: 'codex-sdk',
        available: true,
        models: ['gpt-5.5'],
      }),
    ).toEqual({ provider: 'codex-sdk', available: true, models: ['gpt-5.5'] })
    expect(ListLocalProvidersResponse.parse([{ provider: 'claude-acp', available: true }])).toHaveLength(1)
  })
  it('SeatSpec modelOverride 可覆盖工厂默认', () => {
    const parsed = SeatSpec.parse({
      role: 'Engineer #1',
      factory: 'engineer',
      modelOverride: { provider: 'codex-sdk', model: 'gpt-5.5' },
    })
    expect(parsed.modelOverride).toEqual({ provider: 'codex-sdk', model: 'gpt-5.5' })
  })
  it('Message', () => expect(Message.parse(sampleMessage)).toEqual(sampleMessage))
})

describe('Task 业务约束', () => {
  // M3 调整:contextLinks 改可选(default []),旧"至少 1 条"约束放松。
  // planner 多轮交互里再从用户拿上下文链接。
  it('contextLinks 可空(M3 起放松)', () => {
    const ok = { ...sampleTask, contextLinks: [] }
    expect(() => Task.parse(ok)).not.toThrow()
  })
  it('CreateTaskInput 只需 description(M3 起 title/projectId 可选)', () => {
    // 最小输入
    const minimal = CreateTaskInput.parse({ description: '想到啥写啥' })
    expect(minimal.description).toBe('想到啥写啥')
    expect(minimal.contextLinks).toEqual([])
    expect(minimal.title).toBeUndefined()
  })
  it('CreateTaskInput 完整字段也通过', () => {
    const input = CreateTaskInput.parse(sampleTask)
    expect(input).not.toHaveProperty('state')
    expect(input).not.toHaveProperty('history')
    expect(input.title).toBeDefined()
  })
})

describe('RelPath 防越界', () => {
  it('接受任务内相对路径', () => expect(RelPath.parse('eng/test-report.md')).toBe('eng/test-report.md'))
  it('拒绝绝对路径', () => expect(() => RelPath.parse('/etc/passwd')).toThrow())
  it('拒绝 .. 越界', () => expect(() => RelPath.parse('../../secret')).toThrow())
})

describe('MCP 工具契约', () => {
  it('恰好 14 个工具（含 task_resource_get）', () => {
    expect(MCP_TOOL_NAMES).toHaveLength(14)
    expect(MCP_TOOL_NAMES).toContain('task_resource_get')
  })
  it('每个工具都有 input/output schema', () => {
    for (const name of MCP_TOOL_NAMES) {
      expect(McpTools[name].input).toBeDefined()
      expect(McpTools[name].output).toBeDefined()
    }
  })
  it('task_write 校验角色越界路径靠 RelPath', () => {
    const ok = McpTools.task_write.input.safeParse({
      taskId: 'nx-23ab',
      path: 'eng/x.md',
      content: 'hi',
    })
    expect(ok.success).toBe(true)
  })
  it('task_state_propose 默认 evidence.artifacts 为空数组', () => {
    const r = McpTools.task_state_propose.input.parse({
      taskId: 'nx-23ab',
      targetState: 'S2',
      evidence: {},
    })
    expect(r.evidence.artifacts).toEqual([])
  })
})

describe('Task bootstrap 协议', () => {
  it('TaskState 含 releasing', () => {
    expect(TaskState.parse('releasing')).toBe('releasing')
  })
  it('终态集合由 protocol 统一定义', () => {
    expect(TERMINAL_TASK_STATES).toEqual(['done', 'aborted', 'process-crashed'])
    expect(isTerminalTaskState('done')).toBe(true)
    expect(isTerminalTaskState('aborted')).toBe(true)
    expect(isTerminalTaskState('process-crashed')).toBe(true)
    expect(isTerminalTaskState('releasing')).toBe(false)
  })
  it('TaskBootstrapConfig 接受 none / generic-pnpm / sw + lean/full', () => {
    expect(TaskBootstrapConfig.parse({ provider: 'none' }).options).toEqual({})
    const cfg = TaskBootstrapConfig.parse({ provider: 'sw', mode: 'lean' })
    expect(cfg).toMatchObject({ provider: 'sw', mode: 'lean' })
  })
  it('TaskBootstrapResource 默认 attempts 为 0', () => {
    const r = TaskBootstrapResource.parse({
      id: 'primary-worktree',
      taskId: 'nx-23ab',
      kind: 'worktree',
      status: 'creating',
      provider: 'generic-pnpm',
      createdAt: '2026-06-25T10:00:00.000Z',
      updatedAt: '2026-06-25T10:00:00.000Z',
    })
    expect(r.attempts).toBe(0)
  })
  it('CreateTaskResponse 必须含 bootstrap 字段', () => {
    const ok = CreateTaskResponse.safeParse({
      ...sampleTask,
      bootstrap: { config: { provider: 'none', options: {} }, started: false },
    })
    expect(ok.success).toBe(true)
  })
  it('task_resource_get 校验 input/output', () => {
    expect(
      McpTools.task_resource_get.input.parse({ taskId: 'nx-23ab' }),
    ).toMatchObject({ taskId: 'nx-23ab' })
    expect(McpTools.task_resource_get.output.parse({ resources: [] })).toEqual({
      resources: [],
    })
  })
  it('ServerToClient: bootstrap-resource 事件通过', () => {
    const ev = {
      type: 'bootstrap-resource' as const,
      taskId: 'nx-23ab',
      resourceId: 'primary-worktree',
      kind: 'worktree' as const,
      status: 'ready' as const,
      provider: 'generic-pnpm' as const,
      mode: 'lean' as const,
      summary: 'worktree at /tmp/wt',
    }
    expect(ServerToClient.parse(ev)).toEqual(ev)
  })
})

describe('Token usage 协议', () => {
  it('usage event 和 profile responses 不包含 cost 字段', () => {
    const event = TokenUsageEvent.parse({
      id: 'usage-1',
      taskId: 'task-1',
      projectId: 'proj-1',
      agentId: 'agent-1',
      factory: 'engineer',
      provider: 'codex-exec',
      source: 'runtime',
      inputTokens: 10,
      outputTokens: 20,
      totalTokens: 30,
      createdAt: '2026-06-26T00:00:00.000Z',
      cost: 99,
    })
    expect(event).not.toHaveProperty('cost')

    const taskUsage = TaskUsageResponse.parse({
      taskId: 'task-1',
      totals: {
        runtime: { totalTokens: 30 },
        chatroomCorpus: { totalTokens: 4 },
        chatroomRead: { totalTokens: 5 },
      },
      agents: [{ id: 'agent-1', label: 'agent-1', totalTokens: 35 }],
      cost: 99,
    })
    expect(taskUsage).not.toHaveProperty('cost')
    expect(taskUsage.agents[0]).not.toHaveProperty('cost')

    expect(ProjectUsageResponse.parse({ projectId: 'proj-1', runtime: { totalTokens: 30 } })).not.toHaveProperty('cost')
    expect(FactoryUsageResponse.parse({ factory: 'engineer', runtime: { totalTokens: 30 } })).not.toHaveProperty('cost')
    expect(AgentUsageResponse.parse({ taskId: 'task-1', agentId: 'agent-1', runtime: { totalTokens: 30 } })).not.toHaveProperty('cost')
  })
})

describe('WS 协议判别联合', () => {
  it('ServerToClient: phase-change', () => {
    const ev = { type: 'phase-change', taskId: 'nx-23ab', from: 'S1', to: 'S2' }
    expect(ServerToClient.parse(ev)).toEqual(ev)
  })
  it('ClientToServer: human-message 默认 mention/refs', () => {
    const msg = ClientToServer.parse({
      type: 'human-message',
      taskId: 'nx-23ab',
      channel: 'main',
      content: 'hi',
    })
    expect(msg).toMatchObject({ mention: [], refs: [] })
  })
  it('拒绝未知 type', () => {
    expect(() => ServerToClient.parse({ type: 'nope' })).toThrow()
  })
})
