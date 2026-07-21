/**
 * 组 11: seat-queue.ts
 * offline / vacant 时 mention 入队；agent ready 后回放。
 * 设计：MessageId 存在 seat.queue（JSON array in SQLite），回放时广播给 chatroom。
 */

import type { SeatRepo } from './seat-repo.js'

export interface SeatQueueService {
  /** 把 messageId 追加到岗位队列（offline/vacant 时用）*/
  enqueue(seatId: string, messageId: string): void
  /** 清空并返回积压的 messageId 列表（agent ready 后调）*/
  drainQueue(seatId: string): string[]
  /** 查看积压（不清空）*/
  peekQueue(seatId: string): string[]
}

export function createSeatQueueService(repo: SeatRepo): SeatQueueService {
  return {
    enqueue(seatId: string, messageId: string) {
      const seat = repo.findById(seatId)
      if (!seat) throw new Error(`seat not found: ${seatId}`)
      const queue = [...seat.queue, messageId]
      repo.updateQueue(seatId, queue)
    },

    drainQueue(seatId: string): string[] {
      const seat = repo.findById(seatId)
      if (!seat) throw new Error(`seat not found: ${seatId}`)
      const queue = [...seat.queue]
      repo.updateQueue(seatId, [])
      return queue
    },

    peekQueue(seatId: string): string[] {
      const seat = repo.findById(seatId)
      if (!seat) return []
      return [...seat.queue]
    },
  }
}
