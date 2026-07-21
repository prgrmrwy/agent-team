export type {
  Task,
  CreateTaskInput,
  TaskState,
  StateTransition,
  ContextLink,
} from '@agent-team/protocol'

import type { TaskState } from '@agent-team/protocol'

/** 状态到中文标签的映射 */
export const TASK_STATE_LABEL: Record<TaskState, string> = {
  S0: '填写信息',
  S1: 'Planner 规划',
  S2: '招募团队',
  S6: 'Engineer 实现',
  S7: 'QA 验收',
  S9: 'CI 监控',
  "S10'": '等待确认',
  S11: '复盘',
  releasing: '收尾中',
  done: '已完成',
  aborted: '已中止',
  'process-crashed': '进程崩溃',
}

/** 状态对应的 Chip variant */
export function taskStateVariant(state: TaskState): 'default' | 'success' | 'warning' | 'error' | 'muted' {
  switch (state) {
    case 'done': return 'success'
    case 'aborted': return 'error'
    case 'process-crashed': return 'error'
    case "S10'": return 'warning'
    case 'releasing': return 'warning'
    default: return 'default'
  }
}
