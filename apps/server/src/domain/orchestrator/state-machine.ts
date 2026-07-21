/**
 * 组 12: state-machine.ts
 * 显式 transition table（design.md D14 + m2-qa-role + m2-ci-factory）。
 * 覆盖 S0/S1/S2/S6/S7/S9/S10'/S11/done。
 *
 * M1 实现的 5+1 态：
 *   S0 → S1 (human-start)
 *   S1 → S2 (planner-propose-S2)
 *   S2 → S6 (all-idle，M1 跳过 S3/S4/S5)
 *   S6 → S10' (engineer-propose-S10)  ← M1 直通，保留兼容(无 qa seat 时)
 *   S10' → S11 (human-complete)
 *   S11 → done (planner-propose-done)
 *
 * M2 m2-qa-role 加入 S7 qa 验收态：
 *   S6 → S7  (engineer-propose-S7)    ← engineer 完成实现，进 qa 验收
 *   S7 → S10' (qa-propose-S10)        ← qa PASS 且无 ci seat（兼容路径）
 *   S7 → S6  (qa-propose-repair)      ← qa FAIL，回 engineer repair
 *
 * M2 m2-ci-factory 加入 S9 ci 监控态：
 *   S7 → S9   (qa-propose-S9)              ← qa PASS 且有 ci seat
 *   S9 → S10' (ci-propose-ready2merge)     ← ci 完成 MR/CI/comment 流程
 */

import type { TaskState } from '@agent-team/protocol'

/** 单条 transition 描述 */
export interface TransitionDef {
  from: TaskState
  event: string
  to: TaskState
  /** 允许发起该事件的角色（'human'|'system'|工厂名）*/
  allowedBy: string[]
}

/** 显式 transition table（M1 范围）*/
export const TRANSITION_TABLE: TransitionDef[] = [
  {
    from: 'S0',
    event: 'human-start',
    to: 'S1',
    allowedBy: ['human', 'system'],
  },
  {
    from: 'S1',
    event: 'planner-propose-S2',
    to: 'S2',
    allowedBy: ['planner'],
  },
  {
    from: 'S2',
    event: 'all-idle',
    to: 'S6',
    allowedBy: ['system'],
  },
  {
    from: 'S6',
    event: 'engineer-propose-S10',
    to: "S10'",
    allowedBy: ['engineer'],
  },
  {
    from: 'S6',
    event: 'engineer-propose-S7',
    to: 'S7',
    allowedBy: ['engineer'],
  },
  {
    from: 'S7',
    event: 'qa-propose-S10',
    to: "S10'",
    allowedBy: ['qa'],
  },
  {
    from: 'S7',
    event: 'qa-propose-repair',
    to: 'S6',
    allowedBy: ['qa'],
  },
  {
    from: 'S7',
    event: 'qa-propose-S9',
    to: 'S9',
    allowedBy: ['qa'],
  },
  {
    from: 'S9',
    event: 'ci-propose-ready2merge',
    to: "S10'",
    allowedBy: ['ci'],
  },
  {
    from: "S10'",
    event: 'human-complete',
    to: 'S11',
    allowedBy: ['human', 'system'],
  },
  {
    from: 'S11',
    event: 'planner-propose-done',
    to: 'done',
    allowedBy: ['planner'],
  },
  // task-bootstrap-lifecycle phase 5: 用户点 done → releasing(收尾编排,agents 仍在线)
  // releasing → done 由 planner propose,需 retro/retrospective.md + retro/archive-plan.md
  // 与 bootstrap resources 终态(由 orchestrator 调用 runner.release 写入)。
  {
    from: "S10'",
    event: 'human-done',
    to: 'releasing',
    allowedBy: ['human', 'system'],
  },
  {
    from: 'releasing',
    event: 'planner-propose-done',
    to: 'done',
    allowedBy: ['planner'],
  },
]

/**
 * 通过 targetState 查找合法 transition。
 * 给定当前状态 + 目标状态 → 找到对应的 event（若有）。
 */
export function findTransition(
  currentState: TaskState,
  targetState: TaskState
): TransitionDef | undefined {
  return TRANSITION_TABLE.find((t) => t.from === currentState && t.to === targetState)
}

/**
 * 检查从 current 到 target 是否合法（不校验权限）。
 */
export function isValidTransition(current: TaskState, target: TaskState): boolean {
  return findTransition(current, target) !== undefined
}

/**
 * 检查某角色是否有权发起该 transition。
 */
export function isAllowed(current: TaskState, target: TaskState, role: string): boolean {
  const t = findTransition(current, target)
  if (!t) return false
  return t.allowedBy.includes(role)
}

/** 获取某状态下所有合法的目标状态 */
export function validTargets(current: TaskState): TaskState[] {
  return TRANSITION_TABLE.filter((t) => t.from === current).map((t) => t.to)
}

/**
 * 派生某角色的"活跃阶段" = 它能 propose 的转移的所有 from 状态(去重)。
 * phase-driven-orchestration: factory-system "活跃阶段从 proposeTransitions 派生"。
 * 入参是 factory 的 proposeTransitions(形如 ["S6->S7","S6->S10'"])。
 */
export function activePhasesOf(proposeTransitions: string[]): TaskState[] {
  const froms = new Set<string>()
  for (const t of proposeTransitions) {
    const from = t.split('->')[0]?.trim()
    if (from) froms.add(from)
  }
  return [...froms] as TaskState[]
}

/**
 * 反向:给定状态 + 一组 factory(name + proposeTransitions),返回活跃于该状态的角色名。
 * 进态驱动唤醒据此判定 driver(见 task-lifecycle 进态驱动唤醒)。
 */
export function driversForState(
  state: TaskState,
  factories: { name: string; proposeTransitions: string[] }[],
): string[] {
  return factories
    .filter((f) => activePhasesOf(f.proposeTransitions).includes(state))
    .map((f) => f.name)
}
