import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import readline from 'node:readline'
import type { ThreadEvent } from '@openai/codex-sdk'
import type { CliAdapter, RuntimeProvider, SpawnOpts } from './cli-adapter.js'
import { toRuntimeErrorEvent } from './cli-adapter.js'
import { mapCodexEvent } from './codex-event-mapper.js'

interface CodexExecSessionState {
  sessionId: string
  workspace: string
  additionalDirectories: string[]
  used: boolean
  child?: ReturnType<typeof spawn>
  killed: boolean
}

export class CodexExecAdapter extends EventEmitter implements CliAdapter {
  readonly provider: RuntimeProvider = 'codex-exec'

  private sessions = new Map<string, CodexExecSessionState>()

  async spawn(opts: SpawnOpts): Promise<string> {
    const sessionId = `codex-exec-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    this.sessions.set(sessionId, {
      sessionId,
      workspace: opts.workspace,
      additionalDirectories: opts.additionalDirectories,
      used: false,
      killed: false,
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
    if (state.used) {
      this.emit(
        'runtime-error',
        toRuntimeErrorEvent(
          this.provider,
          new Error('codex-exec is one-shot and unsuitable for alwaysOn multi-turn sessions'),
          { sessionId, recoverable: false, reason: 'runtime-failed' }
        )
      )
      return
    }
    state.used = true
    await this.runOneShot(state, text)
  }

  pause(sessionId: string): void {
    this.sessions.get(sessionId)?.child?.kill('SIGSTOP')
  }

  resume(sessionId: string): void {
    this.sessions.get(sessionId)?.child?.kill('SIGCONT')
  }

  /** 人类打断:exec 子进程 best-effort SIGSTOP 冻结(resume 时 SIGCONT 续)。 */
  interrupt(sessionId: string): void {
    this.sessions.get(sessionId)?.child?.kill('SIGSTOP')
  }

  async kill(sessionId: string): Promise<void> {
    const state = this.sessions.get(sessionId)
    if (!state) return
    state.killed = true
    state.child?.kill('SIGTERM')
    this.sessions.delete(sessionId)
    this.emit('exit', { sessionId, code: 0, signal: null })
  }

  isAlive(sessionId: string): boolean {
    const state = this.sessions.get(sessionId)
    return Boolean(state && !state.killed)
  }

  private async runOneShot(state: CodexExecSessionState, text: string): Promise<void> {
    const codexBin = process.env['AGENT_TEAM_CODEX_BIN'] ?? 'codex'
    const args = [
      'exec',
      '--json',
      // 同 codex-sdk-adapter:单用户本地应用,放开沙箱让 agent 能起浏览器 / 跑 git hook / 部署
      '--sandbox',
      'danger-full-access',
      '--config',
      'approval_policy="never"',
      '--cd',
      state.workspace,
      '--skip-git-repo-check',
    ]
    for (const dir of state.additionalDirectories) args.push('--add-dir', dir)
    args.push(text)
    const child = spawn(
      codexBin,
      args,
      { stdio: ['ignore', 'pipe', 'pipe'] }
    )
    state.child = child
    const stderr: Buffer[] = []
    child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk))
    const rl = readline.createInterface({ input: child.stdout!, crlfDelay: Infinity })
    try {
      for await (const line of rl) {
        if (!line.trim()) continue
        let event: ThreadEvent
        try {
          event = JSON.parse(line) as ThreadEvent
        } catch {
          continue
        }
        this.emit('update', { sessionId: state.sessionId, update: event })
        this.emitMappedEvent(state.sessionId, event)
      }
      const code = await new Promise<number | null>((resolve) => child.once('exit', resolve))
      if (code !== 0 && !state.killed) {
        this.emit(
          'runtime-error',
          toRuntimeErrorEvent(
            this.provider,
            new Error(`codex exec exited with code ${code}: ${Buffer.concat(stderr).toString('utf-8')}`),
            { sessionId: state.sessionId }
          )
        )
      }
    } finally {
      rl.close()
      state.child = undefined
    }
  }

  private emitMappedEvent(sessionId: string, event: ThreadEvent): void {
    const action = mapCodexEvent(event)
    if (!action) return
    if (action.kind === 'text') {
      this.emit('text', { sessionId, text: action.text, kind: 'message' })
    } else if (action.kind === 'tool') {
      this.emit('tool', { sessionId, title: action.title, rawInput: action.rawInput, toolCallId: action.toolCallId })
    } else if (action.kind === 'done') {
      this.emit('done', { sessionId, stopReason: action.stopReason, usage: action.usage })
    } else if (action.kind === 'runtime-error') {
      this.emit('runtime-error', toRuntimeErrorEvent(this.provider, new Error(action.message), { sessionId }))
    }
  }
}
