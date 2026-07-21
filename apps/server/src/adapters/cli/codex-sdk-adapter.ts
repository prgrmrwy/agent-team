import { EventEmitter } from 'node:events'
import type { Codex, CodexOptions, Thread, ThreadEvent, ThreadOptions } from '@openai/codex-sdk'
import type { CliAdapter, RuntimeProvider, SpawnOpts } from './cli-adapter.js'
import { toRuntimeErrorEvent } from './cli-adapter.js'
import { mapCodexEvent } from './codex-event-mapper.js'

interface CodexSessionState {
  sessionId: string
  thread: Thread
  abortController: AbortController | null
  killed: boolean
  /** 人类打断当前 turn(非 kill):abort 当前 prompt 但保留 session,可被后续 prompt 续 */
  interrupting: boolean
}

type CodexCtor = new (opts?: {
  codexPathOverride?: string
  config?: CodexOptions['config']
  env?: Record<string, string>
}) => Codex

export class CodexSdkAdapter extends EventEmitter implements CliAdapter {
  readonly provider: RuntimeProvider = 'codex-sdk'

  private sessions = new Map<string, CodexSessionState>()
  private codexCtor?: CodexCtor

  constructor(opts: { codexCtor?: CodexCtor } = {}) {
    super()
    this.codexCtor = opts.codexCtor
  }

  async spawn(opts: SpawnOpts): Promise<string> {
    const { Codex: ImportedCodex } = this.codexCtor
      ? { Codex: this.codexCtor }
      : await import('@openai/codex-sdk')
    const codex = new ImportedCodex({
      codexPathOverride: process.env['AGENT_TEAM_CODEX_BIN'],
      config: buildCodexConfig(opts.mcpServers),
      env: buildCodexEnv(opts.env),
    })
    const thread = codex.startThread(buildThreadOptions(opts))
    const sessionId = `codex-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    this.sessions.set(sessionId, {
      sessionId,
      thread,
      abortController: null,
      killed: false,
      interrupting: false,
    })
    if (opts.initialPrompt.trim()) {
      this.prompt(sessionId, opts.initialPrompt).catch((err) => {
        this.emit('runtime-error', toRuntimeErrorEvent(this.provider, err, { sessionId }))
      })
    }
    return sessionId
  }

  async prompt(sessionId: string, text: string): Promise<void> {
    const state = this.sessions.get(sessionId)
    if (!state || state.killed) {
      this.emit(
        'runtime-error',
        toRuntimeErrorEvent(this.provider, new Error(`session not found: ${sessionId}`), {
          sessionId,
          reason: 'session-not-found',
        })
      )
      return
    }

    const abortController = new AbortController()
    state.abortController = abortController
    try {
      const streamed = await state.thread.runStreamed(text, { signal: abortController.signal })
      for await (const event of streamed.events) {
        this.emit('update', { sessionId, update: event })
        const runtimeError = this.emitMappedEvent(sessionId, event)
        if (runtimeError) throw runtimeError
      }
    } catch (err) {
      if (state.interrupting) {
        // 人类打断:当前 turn 干净结束,session 保留(后续 prompt 可续),不报 error
        state.interrupting = false
        this.emit('done', { sessionId, stopReason: 'interrupted' })
      } else if (!state.killed) {
        this.emit('runtime-error', toRuntimeErrorEvent(this.provider, err, { sessionId }))
        throw err
      }
    } finally {
      state.abortController = null
    }
  }

  pause(_sessionId: string): void {
    // Codex SDK 无 per-thread SIGSTOP;真正的"停"走 interrupt(打断当前 turn)。
  }

  resume(_sessionId: string): void {
    // No-op; a later prompt continues the same thread.
  }

  /** 人类打断当前 turn:abort 在跑的 prompt,但保留 session(可被后续 prompt 续)。 */
  interrupt(sessionId: string): void {
    const state = this.sessions.get(sessionId)
    if (!state || !state.abortController) return
    state.interrupting = true
    state.abortController.abort()
  }

  async kill(sessionId: string): Promise<void> {
    const state = this.sessions.get(sessionId)
    if (!state) return
    state.killed = true
    state.abortController?.abort()
    this.sessions.delete(sessionId)
    this.emit('exit', { sessionId, code: 0, signal: null })
  }

  isAlive(sessionId: string): boolean {
    const state = this.sessions.get(sessionId)
    return Boolean(state && !state.killed)
  }

  private emitMappedEvent(sessionId: string, event: ThreadEvent): Error | null {
    const action = mapCodexEvent(event)
    if (!action) return null
    if (action.kind === 'text') {
      this.emit('text', { sessionId, text: action.text, kind: 'message' })
    } else if (action.kind === 'tool') {
      this.emit('tool', {
        sessionId,
        title: action.title,
        rawInput: action.rawInput,
        toolCallId: action.toolCallId,
      })
    } else if (action.kind === 'done') {
      this.emit('done', { sessionId, stopReason: action.stopReason, usage: action.usage })
    } else if (action.kind === 'runtime-error') {
      return new Error(action.message)
    }
    return null
  }
}

function buildThreadOptions(opts: SpawnOpts): ThreadOptions {
  return {
    model: opts.runtime?.model,
    modelReasoningEffort: opts.runtime?.reasoningEffort,
    workingDirectory: opts.workspace,
    additionalDirectories: opts.additionalDirectories,
    // 单用户本地应用,agent 跑用户自己的 task —— 沙箱安全收益低,破坏工具链成本高。
    // workspace-write(macOS Seatbelt)会挡 qa 起浏览器(Chrome spawn helper / 写
    // DevToolsActivePort socket 被拒)+ engineer 的 git pre-commit hook(rush/ps 受限)。
    // 改 danger-full-access 让 agent 能真实驱动浏览器 / 跑 hook / 部署。
    sandboxMode: 'danger-full-access',
    approvalPolicy: 'never',
    skipGitRepoCheck: true,
    networkAccessEnabled: true,
  }
}

function buildCodexConfig(mcpServers: SpawnOpts['mcpServers']): CodexOptions['config'] {
  const config: NonNullable<CodexOptions['config']> = {}
  const servers: NonNullable<CodexOptions['config']> = {}
  for (const server of mcpServers) {
    if (server.type === 'http') {
      const headers = Object.fromEntries(server.headers.map((h) => [h.name, h.value]))
      servers[server.name] = {
        url: server.url,
        http_headers: headers,
        default_tools_approval_mode: 'approve',
      }
    } else if (server.type === 'sse') {
      const headers = Object.fromEntries(server.headers.map((h) => [h.name, h.value]))
      servers[server.name] = {
        url: server.url,
        http_headers: headers,
        default_tools_approval_mode: 'approve',
      }
    } else {
      servers[server.name] = {
        command: server.command,
        args: server.args,
        env: server.env ?? {},
        default_tools_approval_mode: 'approve',
      }
    }
  }
  if (Object.keys(servers).length > 0) config['mcp_servers'] = servers
  return config
}

function buildCodexEnv(extraEnv?: Record<string, string>): Record<string, string> {
  const env = { ...process.env, ...extraEnv } as Record<string, string>
  for (const k of [
    'CLAUDECODE',
    'CLAUDE_CODE_ENTRYPOINT',
    'CLAUDE_CODE_CHILD_SESSION',
    'CLAUDE_CODE_SESSION_ID',
    'CLAUDE_CODE_SSE_PORT',
    'CLAUDE_AGENT_SDK_VERSION',
  ]) {
    delete env[k]
  }
  return env
}
