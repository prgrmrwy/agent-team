import { describe, expect, it } from 'vitest'
import type { Message } from '@agent-team/protocol'
import { markUrgentAcknowledged, mergeMessagesById } from './message-cache.js'

const baseMessage = (overrides: Partial<Message>): Message => ({
  id: 'msg-1',
  taskId: 'task-1',
  channel: 'main',
  type: 'system-event',
  sender: 'system',
  content: '⚠️ 任务卡住:releasing 阶段超 10min 无任何进展。当前阶段无人推进,请人类介入。',
  mention: [],
  refs: [],
  replyTo: null,
  urgentKey: 'urgent-key',
  acknowledgedAt: null,
  createdAt: '2026-06-29T00:00:00.000Z',
  ...overrides,
})

describe('mergeMessagesById', () => {
  it('updates existing messages instead of only appending new ones', () => {
    const prev = [baseMessage({ acknowledgedAt: null })]
    const incoming = [baseMessage({ acknowledgedAt: '2026-06-29T00:01:00.000Z' })]

    expect(mergeMessagesById(prev, incoming)).toEqual(incoming)
  })

  it('keeps existing order and appends unseen messages', () => {
    const prev = [baseMessage({ id: 'msg-1' })]
    const incoming = [baseMessage({ id: 'msg-2', urgentKey: 'urgent-2' })]

    expect(mergeMessagesById(prev, incoming).map((message) => message.id)).toEqual(['msg-1', 'msg-2'])
  })
})

describe('markUrgentAcknowledged', () => {
  it('marks messages by id or stable urgent key', () => {
    const acknowledgedAt = '2026-06-29T00:02:00.000Z'
    const result = markUrgentAcknowledged(
      [
        baseMessage({ id: 'msg-1', urgentKey: 'urgent-key' }),
        baseMessage({ id: 'msg-2', urgentKey: 'urgent-key' }),
      ],
      ['urgent-key'],
      acknowledgedAt,
    )

    expect(result.map((message) => message.acknowledgedAt)).toEqual([acknowledgedAt, acknowledgedAt])
  })
})
