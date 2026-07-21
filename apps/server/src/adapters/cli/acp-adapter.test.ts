/**
 * 组 14.5 单测：adapter 接口契约（用 FakeCliAdapter，不启动真实 bridge）
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EventEmitter } from 'node:events'
import type { CliAdapter, SpawnOpts } from './cli-adapter.js'
import { toRuntimeErrorEvent } from './cli-adapter.js'
import { createCliAdapter, resolveRuntimeProvider, UnsupportedRuntimeProviderError } from './adapter-factory.js'
import { mapCodexEvent } from './codex-event-mapper.js'
import { CodexSdkAdapter } from './codex-sdk-adapter.js'
import { parseCodexExecJsonl } from './codex-preflight.js'
import { mapAcpUpdate, TextAccumulator } from './event-mapper.js'

// -------- FakeCliAdapter：满足 CliAdapter 接口契约 --------
class FakeCliAdapter extends EventEmitter implements CliAdapter {
  readonly provider = 'claude-acp' as const

  private sessions = new Set<string>()
  private paused = new Set<string>()

  async spawn(opts: SpawnOpts): Promise<string> {
    const sessionId = `fake-session-${Date.now()}`
    this.sessions.add(sessionId)
    // 模拟 initialPrompt 触发 done
    setTimeout(() => {
      this.emit('done', { sessionId, stopReason: 'end_turn' })
    }, 0)
    return sessionId
  }

  async prompt(sessionId: string, text: string): Promise<void> {
    if (!this.sessions.has(sessionId)) throw new Error(`session not found: ${sessionId}`)
    this.emit('chunk', { sessionId, text: `echo: ${text}` })
    this.emit('done', { sessionId, stopReason: 'end_turn' })
  }

  pause(sessionId: string): void {
    this.paused.add(sessionId)
  }

  resume(sessionId: string): void {
    this.paused.delete(sessionId)
  }

  interrupt(sessionId: string): void {
    this.paused.add(sessionId)
  }

  async kill(sessionId: string): Promise<void> {
    this.sessions.delete(sessionId)
    this.emit('exit', { sessionId, code: 0, signal: null })
  }

  isAlive(sessionId: string): boolean {
    return this.sessions.has(sessionId) && !this.paused.has(sessionId)
  }

  isPaused(sessionId: string): boolean {
    return this.paused.has(sessionId)
  }
}

describe('CliAdapter contract (FakeCliAdapter)', () => {
  let adapter: FakeCliAdapter

  beforeEach(() => {
    adapter = new FakeCliAdapter()
  })

  it('spawn 返回 sessionId，触发 done 事件（happy）', async () => {
    const doneEvents: unknown[] = []
    adapter.on('done', (e) => doneEvents.push(e))

    const sessionId = await adapter.spawn({
      workspace: '/tmp/test-workspace',
      additionalDirectories: ['/tmp/test-worktree'],
      mcpServers: [],
      initialPrompt: 'hello',
    })

    expect(sessionId).toMatch(/fake-session-/)
    expect(adapter.isAlive(sessionId)).toBe(true)

    // 等待异步 done
    await new Promise((r) => setTimeout(r, 10))
    expect(doneEvents).toHaveLength(1)
  })

  it('prompt 触发 chunk + done（happy）', async () => {
    const sessionId = await adapter.spawn({
      workspace: '/tmp/ws',
      additionalDirectories: [],
      mcpServers: [],
      initialPrompt: 'init',
    })
    await new Promise((r) => setTimeout(r, 10)) // 等 spawn done

    const chunks: string[] = []
    adapter.on('chunk', (e: { sessionId: string; text: string }) => chunks.push(e.text))

    await adapter.prompt(sessionId, 'what is 2+2')
    expect(chunks).toContain('echo: what is 2+2')
  })

  it('pause/resume 改变 isAlive（happy）', async () => {
    const sessionId = await adapter.spawn({
      workspace: '/tmp/ws',
      additionalDirectories: [],
      mcpServers: [],
      initialPrompt: 'init',
    })

    adapter.pause(sessionId)
    expect(adapter.isPaused(sessionId)).toBe(true)

    adapter.resume(sessionId)
    expect(adapter.isPaused(sessionId)).toBe(false)
  })

  it('kill 后 isAlive=false，触发 exit 事件（happy）', async () => {
    const exitEvents: unknown[] = []
    adapter.on('exit', (e) => exitEvents.push(e))

    const sessionId = await adapter.spawn({
      workspace: '/tmp/ws',
      additionalDirectories: [],
      mcpServers: [],
      initialPrompt: 'init',
    })

    await adapter.kill(sessionId)
    expect(adapter.isAlive(sessionId)).toBe(false)
    expect(exitEvents).toHaveLength(1)
  })

  it('prompt 不存在的 session 抛出错误（reject）', async () => {
    await expect(adapter.prompt('nonexistent', 'hello')).rejects.toThrow('session not found')
  })
})

describe('runtime adapter helpers', () => {
  it('resolveRuntimeProvider defaults to claude-acp', () => {
    expect(resolveRuntimeProvider({} as NodeJS.ProcessEnv)).toBe('claude-acp')
  })

  it('resolveRuntimeProvider accepts codex-sdk', () => {
    expect(resolveRuntimeProvider({ AGENT_TEAM_ADAPTER: 'codex-sdk' } as NodeJS.ProcessEnv)).toBe('codex-sdk')
  })

  it('resolveRuntimeProvider rejects unknown provider', () => {
    expect(() =>
      resolveRuntimeProvider({ AGENT_TEAM_ADAPTER: 'bad-provider' } as NodeJS.ProcessEnv)
    ).toThrow(UnsupportedRuntimeProviderError)
  })

  it('createCliAdapter creates codex-exec provider', () => {
    expect(createCliAdapter('codex-exec').provider).toBe('codex-exec')
  })

  it('toRuntimeErrorEvent classifies usage limits as quota', () => {
    const event = toRuntimeErrorEvent('claude-acp', new Error("You've hit your limit"))
    expect(event).toMatchObject({ provider: 'claude-acp', reason: 'quota', recoverable: true })
  })
})

describe('codex-event-mapper mapCodexEvent', () => {
  it('agent message item → text event', () => {
    const result = mapCodexEvent({
      type: 'item.completed',
      item: { id: 'item-1', type: 'agent_message', text: 'hello from codex' },
    })
    expect(result).toEqual({ kind: 'text', text: 'hello from codex' })
  })

  it('mcp tool item → tool event', () => {
    const result = mapCodexEvent({
      type: 'item.started',
      item: {
        id: 'tool-1',
        type: 'mcp_tool_call',
        server: 'chatroom',
        tool: 'chatroom_send',
        arguments: { content: 'hi' },
        status: 'in_progress',
      },
    })
    expect(result).toMatchObject({
      kind: 'tool',
      title: 'chatroom.chatroom_send:in_progress',
      rawInput: { arguments: { content: 'hi' } },
    })
  })

  it('mcp tool item preserves Codex error details', () => {
    const result = mapCodexEvent({
      type: 'item.completed',
      item: {
        id: 'tool-1',
        type: 'mcp_tool_call',
        server: 'chatroom',
        tool: 'chatroom_send',
        arguments: { type: 'agent-text' },
        error: { message: 'Invalid enum value' },
        status: 'failed',
      },
    })
    expect(result).toMatchObject({
      kind: 'tool',
      title: 'chatroom.chatroom_send:failed',
      rawInput: {
        arguments: { type: 'agent-text' },
        error: { message: 'Invalid enum value' },
      },
    })
  })

  it('turn completed → done event', () => {
    const result = mapCodexEvent({
      type: 'turn.completed',
      usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 },
    })
    expect(result).toMatchObject({ kind: 'done', stopReason: 'turn_completed' })
  })

  it('Codex reconnecting error is nonfatal tool trace', () => {
    const result = mapCodexEvent({
      type: 'error',
      message: 'Reconnecting... 2/5 (request timed out)',
    })
    expect(result).toEqual({
      kind: 'tool',
      title: 'nonfatal-error',
      rawInput: { message: 'Reconnecting... 2/5 (request timed out)' },
    })
  })
})

describe('codex preflight JSONL parsing', () => {
  it('extracts text from codex exec JSONL', () => {
    const parsed = parseCodexExecJsonl(
      [
        JSON.stringify({ type: 'thread.started', thread_id: 't1' }),
        JSON.stringify({
          type: 'item.completed',
          item: { id: 'msg-1', type: 'agent_message', text: 'CODEX_OK' },
        }),
      ].join('\n')
    )
    expect(parsed).toEqual({ text: 'CODEX_OK', errors: [] })
  })
})

describe('CodexSdkAdapter', () => {
  it('spawn starts a thread and later prompt reuses the same thread', async () => {
    const prompts: string[] = []
    class FakeThread {
      id = 'thread-1'
      async runStreamed(input: string) {
        prompts.push(input)
        async function* events() {
          yield {
            type: 'thread.started',
            thread_id: 'thread-1',
          }
          yield {
            type: 'item.completed',
            item: { id: 'msg-1', type: 'agent_message', text: `echo:${input}` },
          }
          yield {
            type: 'turn.completed',
            usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 },
          }
        }
        return { events: events() }
      }
    }
    const fakeThread = new FakeThread()
    const threadOptions: unknown[] = []
    class FakeCodex {
      startThread(opts: unknown) {
        threadOptions.push(opts)
        return fakeThread
      }
    }

    const adapter = new CodexSdkAdapter({ codexCtor: FakeCodex as never })
    const texts: string[] = []
    adapter.on('text', (evt: { text: string }) => texts.push(evt.text))
    const sessionId = await adapter.spawn({
      workspace: '/tmp/ws',
      additionalDirectories: ['/tmp/wt'],
      mcpServers: [],
      initialPrompt: 'init',
      runtime: { provider: 'codex-sdk', model: 'gpt-5.5', reasoningEffort: 'high' },
    })
    await new Promise((r) => setTimeout(r, 10))
    await adapter.prompt(sessionId, 'follow-up')

    expect(prompts).toEqual(['init', 'follow-up'])
    expect(threadOptions[0]).toMatchObject({ model: 'gpt-5.5', modelReasoningEffort: 'high' })
    expect(texts).toContain('echo:init')
    expect(texts).toContain('echo:follow-up')
    expect(adapter.isAlive(sessionId)).toBe(true)
    await adapter.kill(sessionId)
    expect(adapter.isAlive(sessionId)).toBe(false)
  })

  it('rejects prompt when Codex stream emits runtime-error', async () => {
    class FakeThread {
      async runStreamed() {
        async function* events() {
          yield {
            type: 'turn.failed',
            error: { message: 'model unavailable' },
          }
        }
        return { events: events() }
      }
    }
    class FakeCodex {
      startThread() {
        return new FakeThread()
      }
    }

    const adapter = new CodexSdkAdapter({ codexCtor: FakeCodex as never })
    const errors: Array<{ reason: string; message: string }> = []
    adapter.on('runtime-error', (evt: { reason: string; message: string }) => errors.push(evt))
    const sessionId = await adapter.spawn({
      workspace: '/tmp/ws',
      additionalDirectories: [],
      mcpServers: [],
      initialPrompt: '',
      runtime: { provider: 'codex-sdk', model: 'gpt-5.5' },
    })

    await expect(adapter.prompt(sessionId, 'probe')).rejects.toThrow('model unavailable')
    expect(errors).toHaveLength(1)
    expect(errors[0]?.reason).toBe('runtime-failed')
    expect(errors[0]?.message).toBe('model unavailable')
  })
})

// -------- event-mapper 单测 --------
describe('event-mapper mapAcpUpdate', () => {
  // 真实 ACP 形状：判别字段是 sessionUpdate，文本在 content（spike + SDK schema 实测）
  it('agent_message_chunk text → append-text（happy）', () => {
    const result = mapAcpUpdate('agent-1', {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'hello world' },
    })
    expect(result).toEqual({ kind: 'append-text', agentId: 'agent-1', text: 'hello world' })
  })

  it('空 text chunk → null（不产生动作）', () => {
    const result = mapAcpUpdate('agent-1', {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: '' },
    })
    expect(result).toBeNull()
  })

  it('tool_call → tool-trace（happy）', () => {
    const result = mapAcpUpdate('agent-1', {
      sessionUpdate: 'tool_call',
      toolCallId: 'tc-1',
      title: 'chatroom_send',
      rawInput: { channel: 'main', content: 'hi' },
    })
    expect(result).toMatchObject({ kind: 'tool-trace', title: 'chatroom_send', toolCallId: 'tc-1' })
  })

  it('agent_thought_chunk → append-thought', () => {
    const result = mapAcpUpdate('agent-1', {
      sessionUpdate: 'agent_thought_chunk',
      content: { type: 'text', text: '思考中' },
    })
    expect(result).toEqual({ kind: 'append-thought', agentId: 'agent-1', text: '思考中' })
  })

  it('未知 sessionUpdate 类型 → other（仍记录）', () => {
    const result = mapAcpUpdate('agent-1', { sessionUpdate: 'usage_update' })
    expect(result).toMatchObject({ kind: 'other', updateKind: 'usage_update' })
  })

  it('无 sessionUpdate 字段 → null', () => {
    const result = mapAcpUpdate('agent-1', { foo: 'bar' })
    expect(result).toBeNull()
  })
})

// -------- TextAccumulator 单测 --------
describe('TextAccumulator', () => {
  it('append + flush（happy）', () => {
    const acc = new TextAccumulator()
    acc.append('hello ')
    acc.append('world')
    expect(acc.current).toBe('hello world')
    expect(acc.flush()).toBe('hello world')
    expect(acc.isEmpty).toBe(true)
  })

  it('flush 后清空（happy）', () => {
    const acc = new TextAccumulator()
    acc.append('test')
    acc.flush()
    expect(acc.current).toBe('')
    expect(acc.isEmpty).toBe(true)
  })
})
