import { isUrgentSystemEvent, urgentKeyForContent, type Message } from '@agent-team/protocol'

export function mergeMessagesById(prev: Message[], incoming: Message[]): Message[] {
  const indexById = new Map(prev.map((message, index) => [message.id, index]))
  const next = [...prev]
  for (const message of incoming) {
    const index = indexById.get(message.id)
    if (index == null) {
      indexById.set(message.id, next.length)
      next.push(message)
    } else {
      next[index] = { ...next[index], ...message }
    }
  }
  return next
}

export function markUrgentAcknowledged(
  prev: Message[],
  identifiers: string[],
  acknowledgedAt: string,
): Message[] {
  const ids = new Set(identifiers)
  return prev.map((message) => {
    const key = message.urgentKey ?? (isUrgentSystemEvent(message.content) ? urgentKeyForContent(message.content) : null)
    if (!ids.has(message.id) && (!key || !ids.has(key))) return message
    return { ...message, urgentKey: key, acknowledgedAt }
  })
}
