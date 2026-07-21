export type { Seat, SeatSpec, SeatStatus } from '@agent-team/protocol'

import type { Agent, Seat, SeatStatus } from '@agent-team/protocol'

type DurableSeatRow = Pick<Seat, 'id' | 'taskId' | 'role' | 'factory' | 'createdAt'> &
  Partial<Pick<Seat, 'status' | 'currentAgentId' | 'queue' | 'modelOverride'>>

export function normalizeSeats(rows: DurableSeatRow[]): Seat[] {
  return rows.map((row) => ({
    ...row,
    status: row.status ?? 'vacant',
    currentAgentId: row.currentAgentId ?? null,
    queue: row.queue ?? [],
  }))
}

export function attachSeatAgents(seats: Seat[], agents: Agent[]): Seat[] {
  const liveAgentIds = new Set(agents.map((agent) => agent.id))
  return seats.map((seat) => ({
    ...seat,
    currentAgentId:
      seat.currentAgentId && liveAgentIds.has(seat.currentAgentId) ? seat.currentAgentId : null,
  }))
}

export const SEAT_STATUS_LABEL: Record<SeatStatus, string> = {
  init: '初始化',
  idle: '待命',
  working: '工作中',
  switching: '切换模型中',
  offline: '休眠',
  vacant: '重新招募中',
}

export function seatStatusVariant(
  status: SeatStatus,
): 'default' | 'success' | 'warning' | 'error' | 'muted' {
  switch (status) {
    case 'idle': return 'success'
    case 'working': return 'info' as 'default'
    case 'switching': return 'warning'
    case 'offline': return 'muted'
    case 'vacant': return 'warning'
    case 'init': return 'default'
    default: return 'default'
  }
}
