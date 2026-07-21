import type { ThreadEvent, ThreadItem } from '@openai/codex-sdk'

export type CodexRuntimeAction =
  | { kind: 'text'; text: string }
  | { kind: 'tool'; title: string; rawInput?: unknown; toolCallId?: string }
  | { kind: 'done'; stopReason: string; usage?: unknown }
  | { kind: 'runtime-error'; message: string }
  | null

export function mapCodexEvent(event: ThreadEvent): CodexRuntimeAction {
  if (event.type === 'turn.completed') {
    return { kind: 'done', stopReason: 'turn_completed', usage: event.usage }
  }
  if (event.type === 'turn.failed') {
    return { kind: 'runtime-error', message: event.error.message }
  }
  if (event.type === 'error') {
    if (/^Reconnecting\.\.\./.test(event.message)) {
      return { kind: 'tool', title: 'nonfatal-error', rawInput: { message: event.message } }
    }
    return { kind: 'runtime-error', message: event.message }
  }
  if (event.type !== 'item.completed' && event.type !== 'item.started' && event.type !== 'item.updated') {
    return null
  }
  return mapCodexItem(event.item)
}

function mapCodexItem(item: ThreadItem): CodexRuntimeAction {
  if (item.type === 'agent_message') {
    return item.text ? { kind: 'text', text: item.text } : null
  }
  if (item.type === 'command_execution') {
    return {
      kind: 'tool',
      title: `command:${item.status}`,
      rawInput: { command: item.command, output: item.aggregated_output, exitCode: item.exit_code },
      toolCallId: item.id,
    }
  }
  if (item.type === 'mcp_tool_call') {
    return {
      kind: 'tool',
      title: `${item.server}.${item.tool}:${item.status}`,
      rawInput: {
        arguments: item.arguments,
        result: item.result,
        error: item.error,
      },
      toolCallId: item.id,
    }
  }
  if (item.type === 'file_change') {
    return {
      kind: 'tool',
      title: `file_change:${item.status}`,
      rawInput: item.changes,
      toolCallId: item.id,
    }
  }
  if (item.type === 'error') {
    return { kind: 'tool', title: 'nonfatal-error', rawInput: { message: item.message }, toolCallId: item.id }
  }
  return null
}
