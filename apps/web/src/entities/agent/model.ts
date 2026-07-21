export type { Agent, AgentRunState } from '@agent-team/protocol'

import type { AgentRunState } from '@agent-team/protocol'

export const AGENT_STATE_LABEL: Record<AgentRunState, string> = {
  init: '启动中',
  idle: '待命',
  working: '工作中',
  offline: '休眠',
  terminated: '已结束',
}

export function agentStateVariant(
  state: AgentRunState,
): 'default' | 'success' | 'warning' | 'error' | 'muted' {
  switch (state) {
    case 'idle': return 'success'
    case 'working': return 'default'
    case 'offline': return 'muted'
    case 'terminated': return 'error'
    default: return 'default'
  }
}
