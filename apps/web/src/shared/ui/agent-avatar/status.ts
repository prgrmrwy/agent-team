import type { Agent, Presence, Seat } from '@agent-team/protocol'
import type { AvatarStatus } from '../avatar/avatar.js'

type SeatPresenceView = Partial<Seat> & { presence?: Presence }

/**
 * 把活进程派生的 seat presence 映射成 AvatarStatus(UI 用)。
 * 全局唯一 helper,所有 avatar 角标 / 文案 / 颜色 SHALL 通过此函数计算
 * (agent-presence-ui spec)。
 *
 * 优先级:
 *  1. seat 缺失 → 'vacant'
 *  2. presence/status='working' → 'working'
 *  3. presence/status='offline' → 'offline'
 *  4. presence='spawning' 或旧 status='init'/'switching' → 'init'
 *  5. presence/status='idle' → 'idle'
 *  6. 兜底 → 'vacant'
 */
export function computeAvatarStatus(seat?: SeatPresenceView, _agent?: Agent): AvatarStatus {
  if (!seat) return 'vacant'
  const presence = seat.presence ?? seat.status
  if (presence === 'working') return 'working'
  if (presence === 'offline') return 'offline'
  if (presence === 'spawning' || presence === 'init' || presence === 'switching') return 'init'
  if (presence === 'idle') return 'idle'
  return 'vacant'
}

/** AvatarStatus 中文文案 — hover popup 用 */
export const STATUS_LABEL: Record<AvatarStatus, string> = {
  working: '工作中',
  idle: '在线',
  init: '初始化中',
  offline: '离线',
  terminated: '归档',
  vacant: '空位',
}

/**
 * AvatarStatus → 状态色(CSS var)。与 role 色无关,只反映运行态。
 * 跟 Avatar StatusBadge 同一套语义:working=amber / idle=绿 / offline=红 / 其余=灰。
 */
export const STATUS_COLOR: Record<AvatarStatus, string> = {
  working: 'var(--amber)',
  idle: 'var(--link)',
  init: 'var(--link)',
  offline: 'var(--malice)',
  terminated: 'var(--ink-dim)',
  vacant: 'var(--ink-dim)',
}

/** 状态色对应的 glow(working/idle 有 glow,其余 none) */
export const STATUS_GLOW: Record<AvatarStatus, string> = {
  working: '0 0 6px var(--amber-glow)',
  idle: '0 0 4px var(--link-glow)',
  init: '0 0 4px var(--link-glow)',
  offline: 'none',
  terminated: 'none',
  vacant: 'none',
}

/**
 * 多 seat 同 role 时,挑出"最活跃"的 status 作为汇总(色点 hover 显)。
 * 优先级 working > switching/init > idle > offline > terminated > vacant。
 */
export function pickDominantStatus(statuses: AvatarStatus[]): AvatarStatus {
  const order: AvatarStatus[] = ['working', 'init', 'idle', 'offline', 'terminated', 'vacant']
  for (const s of order) {
    if (statuses.includes(s)) return s
  }
  return 'vacant'
}
