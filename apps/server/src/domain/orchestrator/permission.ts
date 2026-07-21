/**
 * 组 12: permission.ts
 * propose 权限校验：工厂级 defaultPermissions + transition table 双校验。
 */

import type { Factory, TaskState } from '@agent-team/protocol'
import { isAllowed, findTransition } from './state-machine.js'

export interface PermissionResult {
  ok: boolean
  reason?: string
}

/**
 * 校验 proposer（role: factory name 或 'human'/'system'）是否有权
 * 将状态从 currentState 推进到 targetState。
 *
 * 双校验：
 * 1. transition table 里 allowedBy 包含该 role
 * 2. 工厂 defaultPermissions.proposeTransitions 包含该转移（仅 agent 角色，human/system 跳过）
 */
export function checkProposalPermission(
  currentState: TaskState,
  targetState: TaskState,
  role: string,
  factory?: Factory
): PermissionResult {
  // 第一层：transition table 合法性
  const transition = findTransition(currentState, targetState)
  if (!transition) {
    return {
      ok: false,
      reason: `no valid transition from ${currentState} to ${targetState}`,
    }
  }

  // 第二层：role 是否在 transition allowedBy
  if (!isAllowed(currentState, targetState, role)) {
    return {
      ok: false,
      reason: `permission denied: ${role} cannot propose ${currentState}→${targetState}`,
    }
  }

  // 第三层：工厂级 defaultPermissions（仅 agent，human/system 跳过）
  if (role !== 'human' && role !== 'system' && factory) {
    const transitionKey = `${currentState}->${targetState}`
    if (!factory.defaultPermissions.proposeTransitions.includes(transitionKey)) {
      return {
        ok: false,
        reason: `factory ${role} defaultPermissions does not include ${transitionKey}`,
      }
    }
  }

  return { ok: true }
}
