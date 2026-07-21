/**
 * 组 11: seat.ts
 * Seat entity + 状态机 transitions（chatroom-protocol spec）。
 * 状态：init / idle / working / switching / offline / vacant
 */

import type { Seat } from '@agent-team/protocol'
import type { SeatStatus } from '@agent-team/protocol'

export type { Seat }

/** 合法的状态转移表 */
const VALID_TRANSITIONS: Record<SeatStatus, SeatStatus[]> = {
  init: ['idle', 'switching', 'vacant'],
  idle: ['working', 'switching', 'offline', 'vacant'],
  working: ['idle', 'switching', 'vacant'],
  switching: ['init', 'idle', 'vacant'],
  offline: ['idle', 'switching', 'vacant'],
  vacant: ['init'],
}

/**
 * 检查从 from 转移到 to 是否合法。
 * 若不合法抛出 Error（调用方决定是否记日志）。
 */
export function assertTransition(from: SeatStatus, to: SeatStatus): void {
  const allowed = VALID_TRANSITIONS[from]
  if (!allowed.includes(to)) {
    throw new Error(`invalid seat transition: ${from} → ${to}`)
  }
}

/**
 * 对 Seat 对象执行状态转移（纯函数，不修改原对象）。
 * 会先校验合法性。
 */
export function transitionSeat(seat: Seat, to: SeatStatus): Seat {
  assertTransition(seat.status as SeatStatus, to)
  return { ...seat, status: to }
}

/** offline 是否需要 SIGCONT（从 offline 恢复时）*/
export function needsSigcont(status: SeatStatus): boolean {
  return status === 'offline'
}
