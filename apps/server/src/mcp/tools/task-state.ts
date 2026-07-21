/**
 * 组 13: task_state_get + task_state_propose
 * propose 转发到 orchestrator（三层校验 + transition table + effects）。
 *
 * Caller 身份：从 extra.sessionId → getAgentIdByMcpSession → DB agents 表 → factory name
 * 获取真实 callerRole 和工厂配置，替换旧的写死 'system' 占位。
 */

import type { StateTransition, TaskState } from '@agent-team/protocol'
import {
  TaskStateGetInput,
  TaskStateProposeInput,
} from '@agent-team/protocol'
import { validatePropose } from '../../domain/orchestrator/propose-handler.js'
import { checkProposalPermission } from '../../domain/orchestrator/permission.js'
import { findTransition } from '../../domain/orchestrator/state-machine.js'
import { applyTransitionEffects } from '../../domain/orchestrator/transition-effects.js'
import { getFactory } from '../../domain/factory/factory-loader.js'
import type { Factory } from '@agent-team/protocol'
import type { McpToolContext } from '../context.js'
import {
  humanConfirmationBlockReason,
  plannerBlockedByHumanConfirmation,
} from './human-confirmation-gate.js'

/** 从 extra.sessionId 解析 caller agentId、factory name，返回 role 和工厂定义 */
function resolveCallerFactory(
  ctx: McpToolContext,
  extra: { sessionId?: string }
): { callerRole: string; callerFactory: Factory | undefined; callerAgentId: string } {
  let callerAgentId = 'system'
  let callerRole = 'system'
  let callerFactory: Factory | undefined

  // stateless:优先 ctx.callerAgentId(URL 路径身份);回退旧 session 反查(单测/legacy)
  const agentId =
    ctx.callerAgentId ?? (extra.sessionId ? ctx.getAgentIdByMcpSession(extra.sessionId) : undefined)
  if (agentId) {
    callerAgentId = agentId
    // agents 表 factory 列存工厂名（spawn 时写入）
    const agentRow = ctx.db
      .prepare('SELECT factory FROM agents WHERE id = ?')
      .get(agentId) as { factory: string } | undefined
    if (agentRow?.factory) {
      callerRole = agentRow.factory
      callerFactory = getFactory(agentRow.factory)
    }
  }

  return { callerRole, callerFactory, callerAgentId }
}

export function registerTaskStateTools(ctx: McpToolContext): void {
  // 10. task_state_get
  ctx.mcpServer.tool(
    'task_state_get',
    'Get current task state and transition history',
    TaskStateGetInput.shape,
    async (args) => {
      const input = TaskStateGetInput.parse(args)

      const stateRow = ctx.db
        .prepare('SELECT state FROM tasks_meta WHERE id = ?')
        .get(input.taskId) as { state: string } | undefined

      const currentState: TaskState = (stateRow?.state ?? 'S0') as TaskState

      const historyRows = ctx.db
        .prepare(
          'SELECT from_state, to_state, event, by, at FROM state_history WHERE task_id = ? ORDER BY at'
        )
        .all(input.taskId) as Record<string, unknown>[]

      const history: StateTransition[] = historyRows.map((r) => ({
        from: r['from_state'] as TaskState,
        to: r['to_state'] as TaskState,
        event: r['event'] as string,
        by: r['by'] as string,
        at: r['at'] as string,
      }))

      return ok({ state: currentState, history })
    }
  )

  // 11. task_state_propose
  ctx.mcpServer.tool(
    'task_state_propose',
    'Propose a task state transition (subject to 3-layer validation)',
    TaskStateProposeInput.shape,
    async (args, extra) => {
      const input = TaskStateProposeInput.parse(args)
      const { taskId, targetState, evidence } = input

      // 获取当前状态
      const stateRow = ctx.db
        .prepare('SELECT state FROM tasks_meta WHERE id = ?')
        .get(taskId) as { state: string } | undefined
      const currentState: TaskState = (stateRow?.state ?? 'S0') as TaskState

      // 从 HTTP MCP session 解析 caller 身份
      const { callerRole, callerFactory, callerAgentId } = resolveCallerFactory(ctx, extra)
      if (plannerBlockedByHumanConfirmation(ctx, callerRole)) {
        const reason = humanConfirmationBlockReason(`propose ${targetState}`)
        emitProposeRejected(ctx, taskId, reason)
        return ok({ accepted: false, reason })
      }

      // 权限校验
      const permResult = checkProposalPermission(
        currentState,
        targetState,
        callerRole,
        callerFactory
      )
      if (!permResult.ok) {
        emitProposeRejected(ctx, taskId, permResult.reason ?? 'permission denied')
        return ok({ accepted: false, reason: permResult.reason })
      }

      // task-bootstrap-lifecycle phase 5.3: releasing→done 时,orchestrator 在校验前
      // 先把所有 non-terminal bootstrap resource 推到终态(provider 决定 retained/
      // needs-review/...)。校验再读 DB 确认终态写入。
      if (currentState === 'releasing' && targetState === 'done' && ctx.releaseBootstrapResources) {
        try {
          await ctx.releaseBootstrapResources(taskId)
        } catch (err) {
          ctx.log.warn({ err, taskId }, 'releaseBootstrapResources failed; propose may be rejected')
        }
      }

      const resourceTerminalChecker = (tid: string) => {
        const rows = ctx.db
          .prepare(`SELECT id, terminal_status FROM bootstrap_resources WHERE task_id = ?`)
          .all(tid) as { id: string; terminal_status: string | null }[]
        const nonTerminalIds = rows.filter((r) => !r.terminal_status).map((r) => r.id)
        return {
          allTerminal: nonTerminalIds.length === 0,
          nonTerminalIds,
          total: rows.length,
        }
      }

      // 三层校验（使用 callerFactory 的 deliverables）
      const validateResult = callerFactory
        ? await validatePropose(
            ctx.taskWorkdir,
            targetState,
            callerFactory,
            { artifacts: evidence.artifacts, note: evidence.note },
            ctx.log,
            currentState,
            { taskId, resourceTerminalChecker },
          )
        : { ok: true }

      if (!validateResult.ok) {
        const reason = (validateResult as { ok: false; reason: string }).reason
        emitProposeRejected(ctx, taskId, reason)
        return ok({ accepted: false, reason })
      }

      // 乐观锁：读当前 version
      const versionRow = ctx.db
        .prepare('SELECT MAX(version) as v FROM state_history WHERE task_id = ?')
        .get(taskId) as { v: number | null }
      const nextVersion = (versionRow.v ?? 0) + 1

      // 写 state_history
      const at = new Date().toISOString()
      const transition = findTransition(currentState, targetState)!
      ctx.db
        .prepare(
          `INSERT INTO state_history (task_id, from_state, to_state, event, by, version, at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .run(taskId, currentState, targetState, transition.event, callerAgentId, nextVersion, at)

      // 更新 tasks_meta 状态
      ctx.db.prepare('UPDATE tasks_meta SET state = ? WHERE id = ?').run(targetState, taskId)

      // 触发副作用(phase-change / notify / release)。
      // phase-driven-orchestration:spawn/wake 不再走 recruit + 这里的 seatId 过滤;
      // process 层 phase-change dispatcher 据 driversForState 统一懒 spawn/唤醒。
      applyTransitionEffects(taskId, currentState, targetState, callerAgentId, ctx.emitter)

      ctx.log.info(
        { taskId, from: currentState, to: targetState, by: callerAgentId },
        'state transition accepted'
      )
      return ok({ accepted: true, newState: targetState })
    }
  )
}

function emitProposeRejected(ctx: McpToolContext, taskId: string, reason: string): void {
  ctx.emitter.emit('propose-rejected', { taskId, reason })
  ctx.log.warn({ taskId, reason }, 'propose rejected')
}

function ok(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data) }] }
}
