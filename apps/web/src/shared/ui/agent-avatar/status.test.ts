import { describe, expect, it } from 'vitest'
import type { Agent, Seat } from '@agent-team/protocol'
import { computeAvatarStatus, pickDominantStatus } from './status.js'

const baseSeat = (overrides: Partial<Seat> = {}): Seat =>
  ({
    id: 'seat-1',
    taskId: 'task-1',
    role: 'Engineer #1',
    factory: 'engineer',
    status: 'idle',
    currentAgentId: 'agent-1',
    queue: [],
    createdAt: '2026-06-26T00:00:00.000Z',
    ...overrides,
  }) as Seat

const baseAgent = (overrides: Partial<Agent> = {}): Agent =>
  ({
    id: 'agent-1',
    taskId: 'task-1',
    seatId: 'seat-1',
    factory: 'engineer',
    displayName: 'A',
    state: 'idle',
    factoryVersion: 1,
    spawnedAt: '2026-06-26T00:00:00.000Z',
    terminatedAt: null,
    ...overrides,
  }) as Agent

describe('computeAvatarStatus', () => {
  it('无 seat → vacant', () => {
    expect(computeAvatarStatus(undefined, undefined)).toBe('vacant')
    expect(computeAvatarStatus(undefined, baseAgent())).toBe('vacant')
  })

  it('vacant → vacant', () => {
    expect(computeAvatarStatus(baseSeat({ status: 'vacant' as Seat['status'] }))).toBe('vacant')
  })

  it('working 来自 seat presence/status,不读 agent.state', () => {
    expect(computeAvatarStatus(baseSeat({ status: 'working' }), baseAgent({ state: 'idle' }))).toBe(
      'working',
    )
    expect(
      computeAvatarStatus(baseSeat({ status: 'idle' }), baseAgent({ state: 'working' })),
    ).toBe('idle')
  })

  it('offline 来自 seat presence/status,不读 agent.state', () => {
    expect(
      computeAvatarStatus(baseSeat({ status: 'offline' }), baseAgent({ state: 'idle' })),
    ).toBe('offline')
    expect(
      computeAvatarStatus(baseSeat({ status: 'idle' }), baseAgent({ state: 'offline' })),
    ).toBe('idle')
  })

  it('init/spawning 表示拉起中', () => {
    expect(computeAvatarStatus(baseSeat({ status: 'init' }), baseAgent({ state: 'idle' }))).toBe(
      'init',
    )
    expect(computeAvatarStatus({ ...baseSeat(), presence: 'spawning' })).toBe('init')
    expect(computeAvatarStatus(baseSeat({ status: 'switching' as Seat['status'] }))).toBe('init')
  })

  it('idle 是兜底', () => {
    expect(computeAvatarStatus(baseSeat({ status: 'idle' }), baseAgent({ state: 'idle' }))).toBe(
      'idle',
    )
  })
})

describe('pickDominantStatus', () => {
  it('working 最高', () => {
    expect(pickDominantStatus(['idle', 'working', 'offline'])).toBe('working')
  })

  it('working > init > idle > offline > terminated > vacant', () => {
    expect(pickDominantStatus(['vacant', 'terminated', 'offline', 'idle', 'init'])).toBe('init')
    expect(pickDominantStatus(['vacant', 'terminated', 'offline', 'idle'])).toBe('idle')
    expect(pickDominantStatus(['vacant', 'terminated', 'offline'])).toBe('offline')
    expect(pickDominantStatus(['vacant', 'terminated'])).toBe('terminated')
    expect(pickDominantStatus(['vacant'])).toBe('vacant')
    expect(pickDominantStatus([])).toBe('vacant')
  })
})
