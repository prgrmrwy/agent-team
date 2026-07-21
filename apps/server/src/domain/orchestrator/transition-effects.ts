/**
 * 组 12: transition-effects.ts
 * 每条 transition 关联的副作用（recruit / release / notify / phase-change 广播）。
 *
 * 纪律：domain 层不 import 传输层（http/ws/mcp）。
 * 广播通过注入的 EffectEmitter（EventEmitter 接口）上抛给 mcp/ws 层订阅。
 *
 * TODO(wave2b): SpawnEffect / KillEffect 在 Wave 2b process 层注入实现。
 */

import { EventEmitter } from 'node:events'
import type { TaskState } from '@agent-team/protocol'

/** phase-change 事件载荷 */
export interface PhaseChangeEvent {
  taskId: string
  from: TaskState
  to: TaskState
  at: string
  by: string
}

/** 招募请求（S2 入态时发出，Wave 2b process 层订阅后 spawn）*/
export interface RecruitEvent {
  taskId: string
  seatIds: string[]
}

/** 释放请求（done 时发出，Wave 2b process 层订阅后 SIGTERM）*/
export interface ReleaseEvent {
  taskId: string
  reason: 'done' | 'aborted'
}

/** 复盘开始请求（S11 入态时发出，process 层订阅后唤醒 planner）*/
export interface RetroStartEvent {
  taskId: string
}

/** 桌面通知请求（S10' 进入时发出，WS 层订阅后推前端）*/
export interface NotifyEvent {
  taskId: string
  level: 'info' | 'warn' | 'error'
  content: string
}

/**
 * EffectEmitter：domain 层用 EventEmitter 上抛副作用事件。
 * mcp/ws/process 层通过 on() 订阅响应。
 *
 * 事件清单：
 *   'phase-change'   → PhaseChangeEvent
 *   'recruit'        → RecruitEvent
 *   'release'        → ReleaseEvent
 *   'notify'         → NotifyEvent
 *   'retro-start'    → RetroStartEvent
 */
export class EffectEmitter extends EventEmitter {
  emitPhaseChange(evt: PhaseChangeEvent): void {
    this.emit('phase-change', evt)
  }

  emitRecruit(evt: RecruitEvent): void {
    this.emit('recruit', evt)
  }

  emitRelease(evt: ReleaseEvent): void {
    this.emit('release', evt)
  }

  emitNotify(evt: NotifyEvent): void {
    this.emit('notify', evt)
  }

  emitRetroStart(evt: RetroStartEvent): void {
    this.emit('retro-start', evt)
  }
}

/**
 * 根据 transition（from → to）触发对应副作用。
 * 调用方在状态写入 DB 之后调用此函数。
 */
export function applyTransitionEffects(
  taskId: string,
  from: TaskState,
  to: TaskState,
  by: string,
  emitter: EffectEmitter,
  seatIds: string[] = []
): void {
  const at = new Date().toISOString()

  // 所有 transition 都广播 phase-change
  // phase-driven-orchestration:进态驱动唤醒(spawn/wake driver)由 process 层的
  // phase-change dispatcher 据 driversForState 统一处理,domain 层不再 emit recruit /
  // retro-start。此处只保留"非 agent-wake"的系统副作用:notify-human(S10')+ release(终态)。
  emitter.emitPhaseChange({ taskId, from, to, at, by })
  void seatIds // seatIds 不再用于 recruit(保留签名兼容,避免改全部 caller)

  switch (to) {
    case "S10'":
      // 进入等待阶段：桌面通知人类
      emitter.emitNotify({
        taskId,
        level: 'info',
        content: `任务 ${taskId} 实现完成，请人类点击"完成"进入复盘`,
      })
      break

    case 'done':
      // 任务完成：释放全员
      emitter.emitRelease({ taskId, reason: 'done' })
      break

    case 'aborted':
      // 任务 abort：释放全员
      emitter.emitRelease({ taskId, reason: 'aborted' })
      break

    default:
      break
  }
}
