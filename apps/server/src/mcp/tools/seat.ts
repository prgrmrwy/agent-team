/**
 * 组 13: seat 工具（seat_create / seat_list / seat_status_get）
 */

import type { Seat } from '@agent-team/protocol'
import {
  SeatCreateInput,
  SeatListInput,
  SeatStatusGetInput,
} from '@agent-team/protocol'
import { newSeatId } from '../../util/id.js'
import type { McpToolContext } from '../context.js'
import {
  humanConfirmationBlockReason,
  plannerBlockedByHumanConfirmation,
} from './human-confirmation-gate.js'

function resolveCallerRole(ctx: McpToolContext, extra: { sessionId?: string }): string {
  const agentId =
    ctx.callerAgentId ?? (extra.sessionId ? ctx.getAgentIdByMcpSession(extra.sessionId) : undefined)
  return agentId ? (ctx.getRoleByAgentId(agentId) ?? 'unknown') : 'unknown'
}

export function registerSeatTools(ctx: McpToolContext): void {
  // 7. seat_create
  ctx.mcpServer.tool(
    'seat_create',
    'Create a new seat (role position) in a task',
    SeatCreateInput.shape,
    async (args, extra) => {
      const input = SeatCreateInput.parse(args)
      const callerRole = resolveCallerRole(ctx, extra)
      if (plannerBlockedByHumanConfirmation(ctx, callerRole)) {
        return err(humanConfirmationBlockReason('create seats'))
      }
      const seatId = newSeatId()
      const now = new Date().toISOString()

      ctx.db
        .prepare(
          `INSERT INTO seats (id, task_id, role, factory, status, current_agent_id, queue, model_override, created_at)
           VALUES (?, ?, ?, ?, 'vacant', NULL, '[]', ?, ?)`
        )
        .run(
          seatId,
          input.taskId,
          input.role,
          input.factory,
          input.modelOverride ? JSON.stringify(input.modelOverride) : null,
          now,
        )

      // seat-created:供 process 层补触发 S2 gate(防 planner 先 propose S2 再建 seat 的死锁)
      ctx.emitter.emit('seat-created', {
        taskId: ctx.taskId,
        seatId,
        factory: input.factory,
      })

      return ok({ seatId })
    }
  )

  // 8. seat_list
  ctx.mcpServer.tool(
    'seat_list',
    'List all seats for a task',
    SeatListInput.shape,
    async (args) => {
      const input = SeatListInput.parse(args)
      const rows = ctx.db
        .prepare('SELECT * FROM seats WHERE task_id = ? ORDER BY created_at')
        .all(input.taskId) as Record<string, unknown>[]
      const seats = rows.map(rowToSeat)
      return ok({ seats })
    }
  )

  // 9. seat_status_get
  ctx.mcpServer.tool(
    'seat_status_get',
    'Get current status of a specific seat',
    SeatStatusGetInput.shape,
    async (args) => {
      const input = SeatStatusGetInput.parse(args)
      const row = ctx.db
        .prepare('SELECT * FROM seats WHERE id = ?')
        .get(input.seatId) as Record<string, unknown> | undefined

      if (!row) {
        return err(`seat not found: ${input.seatId}`)
      }

      return ok({ seat: rowToSeat(row) })
    }
  )
}

function rowToSeat(r: Record<string, unknown>): Seat {
  return {
    id: r['id'] as string,
    taskId: r['task_id'] as string,
    role: r['role'] as string,
    factory: r['factory'] as Seat['factory'],
    status: r['status'] as Seat['status'],
    currentAgentId: (r['current_agent_id'] as string | null) ?? null,
    queue: JSON.parse((r['queue'] as string) ?? '[]') as string[],
    modelOverride: r['model_override']
      ? (JSON.parse(r['model_override'] as string) as Seat['modelOverride'])
      : undefined,
    createdAt: r['created_at'] as string,
  }
}

function ok(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data) }] }
}

function err(reason: string) {
  return { content: [{ type: 'text' as const, text: JSON.stringify({ error: reason }) }] }
}
