/**
 * 组 11: seat-repo.ts
 * SQLite 读写（per-task db）。
 */

import type { Seat } from '@agent-team/protocol'
import type { DbClient } from '../../db/client.js'

function fromRow(r: Record<string, unknown>): Seat {
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

function toRow(seat: Seat): Record<string, unknown> {
  return {
    id: seat.id,
    task_id: seat.taskId,
    role: seat.role,
    factory: seat.factory,
    status: seat.status,
    current_agent_id: seat.currentAgentId,
    queue: JSON.stringify(seat.queue),
    model_override: seat.modelOverride ? JSON.stringify(seat.modelOverride) : null,
    created_at: seat.createdAt,
  }
}

export interface SeatRepo {
  insert(seat: Seat): void
  findById(seatId: string): Seat | null
  findByTask(taskId: string): Seat[]
  updateQueue(seatId: string, queue: string[]): void
}

export function createSeatRepo(db: DbClient): SeatRepo {
  return {
    insert(seat: Seat) {
      const r = toRow(seat)
      db.prepare(
        `INSERT INTO seats (id, task_id, role, factory, status, current_agent_id, queue, model_override, created_at)
         VALUES (@id, @task_id, @role, @factory, @status, @current_agent_id, @queue, @model_override, @created_at)`
      ).run(r)
    },

    findById(seatId: string): Seat | null {
      const row = db.prepare('SELECT * FROM seats WHERE id = ?').get(seatId)
      if (!row) return null
      return fromRow(row as Record<string, unknown>)
    },

    findByTask(taskId: string): Seat[] {
      const rows = db.prepare('SELECT * FROM seats WHERE task_id = ? ORDER BY created_at').all(taskId)
      return (rows as Record<string, unknown>[]).map(fromRow)
    },

    updateQueue(seatId: string, queue: string[]) {
      db.prepare('UPDATE seats SET queue = ? WHERE id = ?').run(JSON.stringify(queue), seatId)
    },
  }
}
