/**
 * 组 14.4: event-mapper.ts
 * ACP sessionUpdate 事件 → chatroom 动作 / 日志（拿回 agent 行为可见性）
 *
 * 真实 ACP 形状（spike + SDK schema 实测）：
 *   - 判别字段是 `sessionUpdate`（不是 `type`）
 *   - agent_message_chunk / agent_thought_chunk：`content` 是 ContentBlock（text 在 content.text）
 *   - tool_call：含 toolCallId / title / kind / status / rawInput
 *
 * 纪律：不 import 传输层（ws/http/mcp），纯函数。
 */

/** 宽松类型（接收任意 ACP update，按 sessionUpdate 字段判别）*/
export type AcpUpdate = Record<string, unknown>

/** 映射后的 chatroom 动作 */
export type ChatroomAction =
  | { kind: 'append-text'; agentId: string; text: string }
  | { kind: 'append-thought'; agentId: string; text: string }
  | { kind: 'tool-trace'; agentId: string; toolCallId: string; title: string; rawInput: unknown }
  | { kind: 'tool-status'; agentId: string; toolCallId: string; status: string }
  | { kind: 'plan'; agentId: string; entries: unknown }
  | { kind: 'other'; agentId: string; updateKind: string }

function textOf(content: unknown): string {
  if (content && typeof content === 'object') {
    const c = content as Record<string, unknown>
    if (typeof c['text'] === 'string') return c['text']
  }
  return ''
}

/**
 * 将 ACP update 映射为 chatroom 动作。
 * 返回 null 表示无需下游处理（但调用方仍应记日志）。
 */
export function mapAcpUpdate(agentId: string, update: AcpUpdate): ChatroomAction | null {
  const kind = update['sessionUpdate']
  if (typeof kind !== 'string') return null

  switch (kind) {
    case 'agent_message_chunk': {
      const text = textOf(update['content'])
      return text ? { kind: 'append-text', agentId, text } : null
    }
    case 'agent_thought_chunk': {
      const text = textOf(update['content'])
      return text ? { kind: 'append-thought', agentId, text } : null
    }
    case 'tool_call': {
      return {
        kind: 'tool-trace',
        agentId,
        toolCallId: String(update['toolCallId'] ?? ''),
        title: String(update['title'] ?? ''),
        rawInput: update['rawInput'],
      }
    }
    case 'tool_call_update': {
      return {
        kind: 'tool-status',
        agentId,
        toolCallId: String(update['toolCallId'] ?? ''),
        status: String(update['status'] ?? ''),
      }
    }
    case 'plan': {
      return { kind: 'plan', agentId, entries: update['entries'] }
    }
    default:
      return { kind: 'other', agentId, updateKind: kind }
  }
}

/** 文本累积器：流式 text chunk 累积成完整消息，turn 结束 flush。*/
export class TextAccumulator {
  private buffer = ''
  append(text: string): void {
    this.buffer += text
  }
  flush(): string {
    const result = this.buffer
    this.buffer = ''
    return result
  }
  get current(): string {
    return this.buffer
  }
  get isEmpty(): boolean {
    return this.buffer.length === 0
  }
}
