import type { Task } from './domain/task.js'
import type { Seat } from './domain/seat.js'
import type { Factory } from './domain/factory.js'
import type { Message } from './domain/message.js'

/**
 * 校验通过的示例数据。供测试 + 前端 mock + 后端 seed 复用。
 */

export const sampleTask: Task = {
  id: 'nx-23ab',
  projectId: 'proj-demo',
  title: '修复登录态丢失',
  description: '刷新后偶发掉登录态，定位并修复。',
  contextLinks: [{ url: 'https://example.com/issues/123', label: '工单' }],
  state: 'S1',
  history: [{ from: 'S0', to: 'S1', at: '2026-06-23T10:00:00.000Z', event: 'human-start', by: 'human' }],
  stalled: false,
  createdAt: '2026-06-23T10:00:00.000Z',
  updatedAt: '2026-06-23T10:00:01.000Z',
}

export const sampleSeat: Seat = {
  id: 'eng-1',
  taskId: 'nx-23ab',
  role: 'Engineer #1',
  factory: 'engineer',
  status: 'idle',
  currentAgentId: 'engineer-nx23ab-01',
  queue: [],
  modelOverride: undefined,
  createdAt: '2026-06-23T10:00:05.000Z',
}

export const samplePlannerFactory: Factory = {
  name: 'planner',
  version: 1,
  persona: '统筹规划者',
  systemPromptTemplate: '你是 planner，遵循 agent.md 协作规约。{{context}}',
  defaultNamePool: ['诸葛亮', '张良', '房玄龄', '王猛', '刘伯温'],
  coreMcps: [{ name: 'chatroom-mcp', command: 'node', args: ['chatroom-mcp.js'] }],
  lifecycle: 'alwaysOn',
  recommendedSkills: [],
  recommendedCliTools: [],
  recommendedMcps: [],
  preferredModelProfile: { provider: 'claude-acp' },
  fallbackModelProfiles: [],
  defaultPermissions: { proposeTransitions: ['S1->S2', 'S11->done'] },
  workingHabits: [],
  deliverables: ['plan/task-plan.md'],
}

export const sampleMessage: Message = {
  id: 'msg-101',
  taskId: 'nx-23ab',
  channel: 'main',
  type: 'agent-text',
  sender: 'planner-nx23ab-01',
  content: '📋 任务理解：刷新掉登录态…',
  mention: [],
  refs: [],
  replyTo: null,
  createdAt: '2026-06-23T10:01:00.000Z',
}
